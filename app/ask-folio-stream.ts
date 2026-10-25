export const ASK_FOLIO_STREAM_IDLE_TIMEOUT_MS = 20_000;
export const ASK_FOLIO_STREAM_TOTAL_TIMEOUT_MS = 90_000;

type AskFolioStreamOptions = {
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
};

export async function consumeAskFolioStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReset: () => void = () => {},
  options: AskFolioStreamOptions = {},
): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? ASK_FOLIO_STREAM_IDLE_TIMEOUT_MS;
  const totalDeadline = Date.now() + (options.totalTimeoutMs ?? ASK_FOLIO_STREAM_TOTAL_TIMEOUT_MS);
  let buffer = "";
  let complete: Record<string, unknown> | null = null;
  try {
    while (true) {
      const totalRemaining = totalDeadline - Date.now();
      if (totalRemaining <= 0) throw new Error("Ask Folio took too long to respond. Your partial answer is still available; please try again.");
      const waitMs = Math.min(idleTimeoutMs, totalRemaining);
      const totalTimeoutWins = totalRemaining <= idleTimeoutMs;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(totalTimeoutWins
              ? "Ask Folio took too long to respond. Your partial answer is still available; please try again."
              : "Ask Folio stopped responding. Your partial answer is still available; please try again.")), waitMs);
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
      if (Date.now() >= totalDeadline) throw new Error("Ask Folio took too long to respond. Your partial answer is still available; please try again.");
      const { value, done } = result;
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary).replace(/\r/g, "");
        buffer = buffer.slice(boundary + 2);
        const eventName = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
        const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!payload) continue;
        let data: unknown;
        try { data = JSON.parse(payload); } catch { throw new Error("Ask Folio returned an invalid stream event."); }
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        const event = data as Record<string, unknown>;
        if (eventName === "delta" && typeof event.delta === "string") onDelta(event.delta);
        else if (eventName === "reset") onReset();
        else if (eventName === "complete") { complete = event; break; }
        else if (eventName === "error") throw new Error(typeof event.error === "string" ? event.error : "Ask Folio could not answer right now.");
      }
      if (done || complete) break;
    }
  } finally {
    // Do not let a stalled underlying source hold the UI hostage while cleanup waits.
    try {
      const cancellation = reader.cancel();
      await Promise.race([cancellation.catch(() => {}), new Promise(resolve => setTimeout(resolve, 100))]);
    } catch {
      // A pending read can make releaseLock throw until cancellation settles.
    }
    try { reader.releaseLock(); } catch { /* Cancellation may still be settling after the bounded cleanup wait. */ }
  }
  if (!complete) throw new Error("Ask Folio's response was interrupted before it completed. Please retry your question.");
  return complete;
}
