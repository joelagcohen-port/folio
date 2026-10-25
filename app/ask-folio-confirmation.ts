type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfirmedAction(value: unknown): boolean {
  return isRecord(value) && typeof value.tool === "string" && Boolean(value.tool.trim()) && isRecord(value.args);
}

export function classifyConfirmedActionEnvelope(body: unknown): "none" | "invalid" | "single" | "batch" {
  if (!isRecord(body)) return "invalid";
  const hasSingle = Object.prototype.hasOwnProperty.call(body, "confirmedAction");
  const hasBatch = Object.prototype.hasOwnProperty.call(body, "confirmedActions");
  if (!hasSingle && !hasBatch) return "none";
  if (hasSingle && hasBatch) return "invalid";
  if (hasSingle) return isConfirmedAction(body.confirmedAction) ? "single" : "invalid";
  if (!Array.isArray(body.confirmedActions) || body.confirmedActions.length < 1 || body.confirmedActions.length > 80 ||
      body.confirmedActions.some((action) => !isConfirmedAction(action))) return "invalid";
  return "batch";
}
