const events = new Set(["client_loaded", "version_mismatch", "worker_ready", "update_blocked", "recovery_reload", "recovery_success", "bridge_navigation", "cache_retired", "api_contract_error", "client_error", "auth_boot_failed"]);
const id = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8,64}$/i.test(value) ? value : undefined;

export async function POST(request: Request) {
  let body: any;
  try { const raw = await request.text(); if (raw.length > 2048) return Response.json({ ok: false }, { status: 413 }); body = JSON.parse(raw); } catch { return Response.json({ ok: false }, { status: 400 }); }
  if (!body || !events.has(body.event)) return Response.json({ ok: false }, { status: 400 });
  const generation = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1000 ? Number(value) : undefined;
  const status = Number.isInteger(body.status) && body.status >= 100 && body.status <= 599 ? body.status : undefined;
  const contentType = typeof body.contentType === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(body.contentType) ? body.contentType.toLowerCase() : undefined;
  const errorNames = new Set(["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError", "EvalError", "SecurityError", "AbortError"]);
  const errorName = ["client_error", "auth_boot_failed"].includes(body.event) && errorNames.has(body.errorName) ? body.errorName : undefined;
  const authBootStages = new Set(["config_fetch", "config_response", "config_json", "config_invalid", "session_restore"]);
  const stage = body.event === "auth_boot_failed" && authBootStages.has(body.stage) ? body.stage : undefined;
  const supportRef = body.event === "auth_boot_failed" && typeof body.supportRef === "string" && /^[a-z0-9-]{8,16}$/i.test(body.supportRef) ? body.supportRef : undefined;
  const authErrorCodes = new Set(["refresh_token_not_found", "session_not_found", "session_expired", "invalid_grant", "invalid_token", "unauthorized"]);
  const authErrorCode = body.event === "auth_boot_failed" && authErrorCodes.has(body.authErrorCode) ? body.authErrorCode : undefined;
  const timestamp = body.event === "auth_boot_failed" && typeof body.timestamp === "string" && Number.isFinite(Date.parse(body.timestamp)) ? new Date(body.timestamp).toISOString() : undefined;
  const elapsedMs = body.event === "auth_boot_failed" && Number.isInteger(body.elapsedMs) && body.elapsedMs >= 0 && body.elapsedMs <= 600_000 ? body.elapsedMs : undefined;
  const source = body.event === "client_error" && typeof body.source === "string" && /^[A-Za-z0-9._-]{1,160}\.js$/.test(body.source) ? body.source : undefined;
  const line = body.event === "client_error" && Number.isInteger(body.line) && body.line > 0 && body.line <= 10_000_000 ? body.line : undefined;
  const column = body.event === "client_error" && Number.isInteger(body.column) && body.column > 0 && body.column <= 10_000_000 ? body.column : undefined;
  const safeReport = JSON.stringify({ event: body.event, clientBuild: id(body.clientBuild), serverBuild: id(body.serverBuild), workerBuild: id(body.workerBuild), clientGeneration: generation(body.clientGeneration), serverGeneration: generation(body.serverGeneration), status, contentType, errorName, stage, supportRef, authErrorCode, timestamp, elapsedMs, source, line, column });
  if (body.event === "auth_boot_failed") console.error("folio_pwa", safeReport);
  else console.info("folio_pwa", safeReport);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
