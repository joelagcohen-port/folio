const ERROR_NAMES = new Set(["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError", "EvalError", "SecurityError", "AbortError"]);

export type SafeClientError = { errorName: string; source?: string; line?: number; column?: number };

export function safeClientError(error: unknown, origin: string): SafeClientError {
  const value = error && typeof error === "object" ? error as { name?: unknown; stack?: unknown } : {};
  const name = typeof value.name === "string" && ERROR_NAMES.has(value.name) ? value.name : "Error";
  if (typeof value.stack !== "string") return { errorName: name };

  for (const line of value.stack.slice(0, 12000).split("\n").slice(0, 40)) {
    const match = line.match(/(?:((?:https?:\/\/[^/\s)]+)?))\/_next\/static\/(?:chunks\/)?([A-Za-z0-9._-]{1,160}\.js)(?:\?[^\s):]*)?:(\d{1,8}):(\d{1,8})/);
    if (!match) continue;
    if (match[1]) {
      try { if (new URL(match[1], origin).origin !== origin) continue; }
      catch { continue; }
    }
    return { errorName: name, source: match[2], line: Number(match[3]), column: Number(match[4]) };
  }
  return { errorName: name };
}
