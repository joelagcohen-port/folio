function stableHash(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

class LifecycleInfrastructureError extends Error {
  status = 503;
  constructor(message: string) { super(message); }
}

function lifecycleRpcError(error: any, fallback: string) {
  const code = String(error?.code || "");
  const status = code === "42501" ? 403 : ["40001", "23505", "P0001"].includes(code) ? 409 : code === "22023" ? 400 : 503;
  return Object.assign(new Error(String(error?.message || fallback)), { status });
}
function lifecycleConflict(message: string, status = 409) { return Object.assign(new Error(message), { status }); }

function resolvedStream(streams: any[], requestedKey: string) {
  const found = streams.filter(stream => stream.stream_key === requestedKey || stream.lifecycle_stream_key === requestedKey);
  if (found.length !== 1 || found[0].lifecycle_unavailable === true) throw lifecycleConflict("Recurring identity is missing or ambiguous; review the stream again.");
  const stream = found[0];
  if (!stream.canonical_account_id && !stream.account_id || !["inflow", "outflow"].includes(stream.flow_type) || !/^[A-Z]{3}$/.test(String(stream.currency_code ?? "USD"))) {
    throw lifecycleConflict("Recurring identity is incomplete; review the stream again.");
  }
  if (!Array.isArray(stream.transaction_ids) && !stream.manual_stream_id) throw lifecycleConflict("Recurring identity is incomplete; review the stream again.");
  return stream;
}

function lifecycleEvidence(stream: any, occurrences: any[]) {
  const transactionIds = [...new Set((stream.transaction_ids || []).filter((id: any) => typeof id === "string" && id.length > 0))].sort();
  const identity = {
    manual_stream_id: stream.manual_stream_id ?? null,
    canonical_account_id: String(stream.canonical_account_id ?? stream.account_id),
    flow_type: stream.flow_type,
    currency_code: String(stream.currency_code ?? "USD"),
    transaction_ids: transactionIds,
  };
  const schedule = {
    expected_amount: stream.expected_amount == null ? null : Number(stream.expected_amount),
    frequency: stream.frequency ?? null,
    predicted_next_date: stream.predicted_next_date ?? null,
    is_active: stream.is_active === true,
    include_in_forecast: stream.include_in_forecast !== false,
    recurring_kind: stream.recurring_kind ?? null,
    occurrences: occurrences.filter(row => row.stream_key === stream.stream_key).map(row => [row.date, row.amount, row.flow_type]),
  };
  return { identity, schedule, identityFingerprint: stableHash(identity), scheduleFingerprint: stableHash(schedule), transactionIds };
}

async function sourceToken(db: any, householdId: string) {
  let result: any;
  try { result = await db.rpc("finance_recurring_lifecycle_source_token", { p_household_id: householdId }); }
  catch { throw new LifecycleInfrastructureError("Recurring source evidence is unavailable; reload before continuing."); }
  if (result.error || typeof result.data !== "string") throw new LifecycleInfrastructureError("Recurring source evidence is unavailable; reload before continuing.");
  return result.data;
}

async function loadCurrent(db: any, context: any, streamKey: string, recurringResponse: Function, timezone: string) {
  const before = await sourceToken(db, context.householdId);
  // Lifecycle review needs the next eligible date even when it falls outside
  // the user-facing 30-day report. Keep this bounded but long enough to cover
  // annual cadence; ordinary recurring reads retain their 30-day contract.
  let model: any;
  try { model = await recurringResponse(context, undefined, undefined, { timeZone: timezone, lifecycleHorizonDays: 400 }); }
  catch { throw new LifecycleInfrastructureError("The current recurring schedule is unavailable; reload before continuing."); }
  const stream = resolvedStream(model.streams || [], streamKey);
  const evidence = lifecycleEvidence(stream, model.schedule?.occurrences || []);
  const after = await sourceToken(db, context.householdId);
  if (before !== after) throw lifecycleConflict("Recurring source changed while reviewing; reload and try again.");
  return { model, stream, evidence, token: after };
}

function requestFingerprint(event: any) {
  try { return JSON.parse(event.request_fingerprint); } catch { return null; }
}

async function replayReceipt(db: any, context: any, body: any, streamKey: string) {
  let result: any;
  try { result = await db.rpc("finance_recurring_lifecycle_receipt", { p_household_id: context.householdId, p_idempotency_key: body.idempotency_key, p_actor_user_id: context.userId }); }
  catch { throw new LifecycleInfrastructureError("Recurring lifecycle receipt is unavailable."); }
  if (result.error) throw new LifecycleInfrastructureError("Recurring lifecycle receipt is unavailable.");
  const receipt = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!receipt) return null;
  const fp = requestFingerprint(receipt);
  const same = receipt.actor_user_id === context.userId && receipt.command === body.command &&
    fp?.stream_key === streamKey && fp?.actor === context.userId && fp?.command === body.command &&
    fp?.occurrence_date === (body.occurrence_date ?? null) && fp?.undo_event_id === (body.undo_event_id ?? null) &&
    Number(fp?.expected_revision) === Number(body.expected_revision) &&
    fp?.reviewed_identity === body.reviewed_identity_fingerprint && fp?.reviewed_schedule === body.reviewed_schedule_fingerprint;
  if (!same) throw lifecycleConflict("Idempotency key was already used for a different recurring action.");
  return { event_id: receipt.event_id, revision: receipt.revision, state: receipt.resulting_state, idempotent_replay: true };
}

export async function reviewRecurringLifecycle(db: any, context: any, body: any, recurringResponse: Function, timezone: string, calendarDate: Function) {
  const key = String(body.stream_key || "");
  if (!key || key.length > 240) throw lifecycleConflict("Choose a recurring stream to review.", 400);
  const { model, stream, evidence, token } = await loadCurrent(db, context, key, recurringResponse, timezone);
  const today = calendarDate(new Date(), timezone);
  const stateKey = stream.lifecycle_stream_key ?? stream.stream_key;
  const state = stream.lifecycle_revision == null ? null : { revision: Number(stream.lifecycle_revision), paused: stream.lifecycle_paused === true, skipped_dates: stream.lifecycle_skipped_dates || [] };
  const skipped = new Set(state?.skipped_dates.map(String) || []);
  const next = (model.schedule?.occurrences || []).find((row: any) => row.stream_key === stream.stream_key && row.date >= today && !skipped.has(row.date)) || null;
  let latestResult: any;
  try { latestResult = state ? await db.rpc("finance_recurring_lifecycle_latest_event", { p_household_id: context.householdId, p_stream_key: stateKey }) : { data: [], error: null }; }
  catch { throw new LifecycleInfrastructureError("Recurring lifecycle history is unavailable; reload before continuing."); }
  if (latestResult.error) throw new LifecycleInfrastructureError("Recurring lifecycle history is unavailable; reload before continuing.");
  const latestEvent = (Array.isArray(latestResult.data) ? latestResult.data[0] : latestResult.data) ?? null;
  return {
    stream_key: stateKey,
    canonical_account_id: evidence.identity.canonical_account_id,
    flow_type: evidence.identity.flow_type,
    currency_code: evidence.identity.currency_code,
    transaction_ids: evidence.transactionIds,
    identity_fingerprint: evidence.identityFingerprint,
    schedule_fingerprint: evidence.scheduleFingerprint,
    source_token: token,
    expected_revision: state?.revision ?? 0,
    paused: state?.paused ?? false,
    next_occurrence: next?.date ?? null,
    undo_event_id: latestEvent && latestEvent.command !== "undo" && Number(latestEvent.revision) === Number(state?.revision) ? latestEvent.event_id : null,
    latest_event: latestEvent ? { event_id: latestEvent.event_id, revision: Number(latestEvent.revision), command: latestEvent.command, occurrence_date: latestEvent.occurrence_date ?? null } : null,
  };
}

export async function applyRecurringLifecycle(db: any, context: any, body: any, recurringResponse: Function, timezone: string, calendarDate: Function) {
  const key = String(body.stream_key || ""), idem = String(body.idempotency_key || "");
  if (!key || key.length > 240 || idem.length < 8 || idem.length > 200) throw lifecycleConflict("Recurring action evidence is incomplete.", 400);
  const replay = await replayReceipt(db, context, body, key);
  if (replay) return replay;

  const current = await loadCurrent(db, context, key, recurringResponse, timezone);
  const { stream, evidence, token, model } = current;
  const reviewedIdentity = String(body.reviewed_identity_fingerprint || "");
  const reviewedSchedule = String(body.reviewed_schedule_fingerprint || "");
  if (!reviewedIdentity || !reviewedSchedule || reviewedIdentity !== evidence.identityFingerprint || reviewedSchedule !== evidence.scheduleFingerprint || body.source_token !== token) {
    throw lifecycleConflict("Recurring source or schedule changed; review it again before applying this action.");
  }
  const expectedRevision = Number(body.expected_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw lifecycleConflict("Recurring lifecycle revision is invalid.", 400);
  const command = String(body.command || "");
  if (!["pause", "resume", "skip", "undo"].includes(command)) throw lifecycleConflict("Unsupported recurring lifecycle action.", 400);
  const stateKey = stream.lifecycle_stream_key ?? stream.stream_key;
  let serverNext: string | null = null;
  if (command === "skip") {
    const today = calendarDate(new Date(), timezone), skipped = new Set((stream.lifecycle_skipped_dates || []).map(String));
    serverNext = (model.schedule?.occurrences || []).find((row: any) => row.stream_key === stream.stream_key && row.date >= today && !skipped.has(row.date))?.date ?? null;
    if (!serverNext || body.occurrence_date !== serverNext) throw lifecycleConflict("Skip must match the next eligible recurring date.");
  }
  let result: any;
  try { result = await db.rpc("finance_apply_recurring_lifecycle", {
    p_household_id: context.householdId,
    p_stream_key: stateKey,
    p_actor_user_id: context.userId,
    p_command: command,
    p_expected_revision: expectedRevision,
    p_idempotency_key: idem,
    p_reviewed_identity_fingerprint: reviewedIdentity,
    p_current_identity_fingerprint: evidence.identityFingerprint,
    p_reviewed_schedule_fingerprint: reviewedSchedule,
    p_current_schedule_fingerprint: evidence.scheduleFingerprint,
    p_expected_source_token: token,
    p_current_canonical_account_id: evidence.identity.canonical_account_id,
    p_current_flow_type: evidence.identity.flow_type,
    p_current_currency_code: evidence.identity.currency_code,
    p_current_transaction_ids: evidence.transactionIds,
    p_occurrence_date: body.occurrence_date ?? null,
    p_server_next_date: serverNext,
    p_undo_event_id: body.undo_event_id ?? null,
    p_today: calendarDate(new Date(), timezone),
  }); } catch (error) { throw new LifecycleInfrastructureError(error instanceof Error ? error.message : "Recurring lifecycle action outcome is unknown."); }
  if (result.error) throw lifecycleRpcError(result.error, "Recurring lifecycle action failed.");
  return result.data;
}
