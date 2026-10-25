type LegacyMessage = { role?: unknown; content?: unknown };

/** Accept old installed PWA payloads without trusting their local transcript. */
export function latestLegacyAskQuestion(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as LegacyMessage | null;
    if (!message || message.role !== "user" || typeof message.content !== "string") continue;
    const question = message.content.trim();
    if (!question || question.length > 8000) return null;
    return question;
  }
  return null;
}
