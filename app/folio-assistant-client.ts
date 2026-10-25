import { isRecord, parseAssistantState, type AssistantState } from "./folio-assistant-contract";

export const FOLIO_REQUEST_TIMEOUT_MS = 15_000;

function requestAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Folio request was canceled.", "AbortError");
}

/** Bounds both response headers and body parsing, while allowing callers to cancel on close/account change. */
export async function fetchJsonWithDeadline(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ response: Response; data: Record<string, unknown> }> {
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw requestAbortError(callerSignal);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Number(options.timeoutMs)) : FOLIO_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let response: Response | null = null;
  let timedOut = false;
  const cancelResponseBody = () => {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  };
  let rejectTimeout: ((error: Error) => void) | undefined;
  let rejectCallerAbort: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const abortPromise = callerSignal ? new Promise<never>((_, reject) => { rejectCallerAbort = reject; }) : null;
  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason);
    cancelResponseBody();
    rejectCallerAbort?.(callerSignal ? requestAbortError(callerSignal) : new DOMException("Folio request was canceled.", "AbortError"));
  };
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    const error = new Error("Folio request took too long. Please try again.");
    controller.abort(error);
    // A browser fetch cancels its response body when its signal aborts. This
    // best-effort cancel also releases synthetic/custom bodies if they ignore it.
    cancelResponseBody();
    rejectTimeout?.(error);
  }, timeoutMs);
  const request = (async () => {
    const fetched = await fetch(url, { ...init, signal: controller.signal });
    response = fetched;
    if (controller.signal.aborted) { cancelResponseBody(); throw controller.signal.reason || new DOMException("Folio request was canceled.", "AbortError"); }
    let data: unknown;
    try { data = await fetched.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("Folio returned an invalid response.");
    }
    if (!isRecord(data)) throw new Error("Folio returned an invalid response.");
    return { response: fetched, data };
  })();
  try {
    return await Promise.race(abortPromise ? [request, timeoutPromise, abortPromise] : [request, timeoutPromise]) as { response: Response; data: Record<string, unknown> };
  } catch (error) {
    if (timedOut) throw new Error("Folio request took too long. Please try again.");
    if (callerSignal?.aborted) throw requestAbortError(callerSignal);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export const FOLIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFolioAssistantMessageId(value: unknown): value is string {
  return typeof value === "string" && FOLIO_UUID_RE.test(value);
}

export async function folioAssistantRequest<T = unknown>(
  token: string,
  operation: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const { response, data } = await fetchJsonWithDeadline("/api/folio", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-folio-api-generation": String(process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || 1),
    },
    body: JSON.stringify({ tool: operation, args }),
    cache: "no-store",
  }, { signal });
  if (!response.ok) {
    const raw = data && typeof data.error === "string" ? data.error : "";
    throw new Error(/stale|version changed|conflict/i.test(raw)
      ? "This Assistant data changed. Refresh and review it again."
      : raw || "Folio Assistant could not load right now.");
  }
  return data as T;
}

export async function loadFolioAssistantState(token: string, messageId?: string, signal?: AbortSignal): Promise<AssistantState> {
  const args: Record<string, unknown> = { limit: 40 };
  if (messageId && isFolioAssistantMessageId(messageId)) args.message_id = messageId;
  const data = await folioAssistantRequest(token, "get_assistant_state", args, signal);
  const state = parseAssistantState(data);
  if (!state) throw new Error("Folio returned an incomplete Assistant conversation.");
  return state;
}
