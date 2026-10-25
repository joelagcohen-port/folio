type AssistantOwner = { householdId: string; userId: string };
type AssistantSource = "user" | "reply" | "event" | "weekly_review" | "watch" | "scheduled_task" | "system";
type AssistantLifecycle = "active" | "snoozed" | "resolved" | "superseded";
type AssistantMessageRecord = Record<string, any> & { source_key: string };
type MessageFilters = { source?: AssistantSource; source_key?: string; event_id?: string; limit?: number };
type TrustedMessageInput = {
  source: "event" | "weekly_review";
  source_key: string;
  content: string;
  event_id?: string;
  event_version?: number;
  watch_ids?: string[];
};

function fail(message: string): never { throw new Error(message); }
function check(result: any, message = "Assistant storage is temporarily unavailable."): any {
  if (result?.error) fail(message);
  return result?.data;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function ownerFilter(query: any, owner: AssistantOwner) {
  return query.eq("household_id", owner.householdId).eq("user_id", owner.userId);
}

const watchOutcomeStatuses = ["pending", "completed", "received", "partial", "not_received", "needs_review", "unavailable", "missed", "worsened", "unchanged", "improved", "data_unavailable"] as const;
type WatchOutcomeStatus = typeof watchOutcomeStatuses[number];
type WatchRunOutcome = { status: WatchOutcomeStatus | "worsened" | "unchanged" | "improved" | "data_unavailable"; dedupe_key?: string; message_content?: string; failure?: string; final_failure?: boolean; value_minor?: number; low_date?: string; source_revision?: string };
type WatchRunCompletion = {
  run_id: string; claim_token: string; watch_version: number; outcome: WatchRunOutcome;
  message_id?: string; next_check_at?: string | null; terminal: boolean; template?: string;
};

function isoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.length <= 64;
}
function validWatchDedupeKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 140 && (
    /^(once:(completed|unavailable)|received|not_received|missed)$/.test(value) ||
    /^issue:[0-9a-f-]{36}:v[1-9][0-9]*:[0-9a-f]{64}$/i.test(value) ||
    /^partial:[0-9]{1,16}$/.test(value) || /^candidate_set:[a-f0-9]{64}$/.test(value) ||
    /^unavailable:20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(value)
  );
}

export async function getAssistantThread(db: any, owner: AssistantOwner) {
  return check(await ownerFilter(db.from("finance_assistant_threads").select("thread_id,household_id,user_id,created_at,updated_at,archived_before").maybeSingle(), owner), "Assistant conversation could not be loaded.");
}

export async function ensureAssistantThread(db: any, owner: AssistantOwner) {
  let row = check(await ownerFilter(db.from("finance_assistant_threads").select("thread_id,household_id,user_id,created_at,updated_at,archived_before").maybeSingle(), owner));
  if (row) return row;
  const now = new Date().toISOString();
  const inserted = await db.from("finance_assistant_threads").insert({
    household_id: owner.householdId, user_id: owner.userId, created_at: now, updated_at: now,
  }).select("thread_id,household_id,user_id,created_at,updated_at,archived_before").single();
  if (!inserted.error) return inserted.data;
  if (inserted.error.code !== "23505") check(inserted, "Assistant conversation could not be opened.");
  row = check(await ownerFilter(db.from("finance_assistant_threads").select("thread_id,household_id,user_id,created_at,updated_at,archived_before").maybeSingle(), owner), "Assistant conversation could not be opened.");
  if (!row) fail("Assistant conversation could not be opened.");
  return row;
}

export async function listAssistantMessages(db: any, owner: AssistantOwner, filters: MessageFilters = {}): Promise<AssistantMessageRecord[]> {
  let query = ownerFilter(
    db.from("finance_assistant_messages").select("message_id,thread_id,household_id,user_id,role,source,source_key,content,created_at,updated_at,request_id,reply_to_message_id,generation_status,lifecycle,lifecycle_version,event_id,event_version,snoozed_until,read_at,superseded_by,watch_ids,pending_action_summaries,pending_action_tools,pending_action_proposal_ids,pending_action_fingerprints"),
    owner,
  );
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.source_key) query = query.eq("source_key", filters.source_key);
  if (filters.event_id) query = query.eq("event_id", filters.event_id);
  const limit = Number.isInteger(filters.limit) ? Math.max(1, Math.min(500, Number(filters.limit))) : 100;
  const data = check(await query.order("created_at", { ascending: false }).order("message_id", { ascending: false }).limit(limit));
  return Array.isArray(data) ? data : [];
}

export async function insertTrustedAssistantMessage(db: any, owner: AssistantOwner, input: TrustedMessageInput): Promise<AssistantMessageRecord> {
  if (!["event", "weekly_review"].includes(input.source) || typeof input.source_key !== "string" || input.source_key.length > 180 ||
      typeof input.content !== "string" || !input.content.trim() || input.content.length > 6000 ||
      (input.source === "event" && (!uuid(input.event_id) || !Number.isSafeInteger(input.event_version) || Number(input.event_version) < 1)) ||
      (input.source === "weekly_review" && (input.event_id !== undefined || input.event_version !== undefined)) ||
      (input.watch_ids !== undefined && (!Array.isArray(input.watch_ids) || input.watch_ids.length > 20 || input.watch_ids.some((id) => !uuid(id))))) {
    fail("Assistant message is not valid.");
  }
  const existing = check(await ownerFilter(
    db.from("finance_assistant_messages").select("*").eq("source_key", input.source_key).maybeSingle(), owner,
  ), "Assistant message could not be saved.");
  if (existing) {
    if (existing.content !== input.content || existing.source !== input.source || existing.event_id !== (input.event_id ?? null) || existing.event_version !== (input.event_version ?? null)) fail("Assistant message idempotency conflict.");
    return existing as AssistantMessageRecord;
  }
  const thread = await ensureAssistantThread(db, owner);
  const timestampResult = await db.rpc("finance_next_assistant_message_time", { p_household_id: owner.householdId, p_user_id: owner.userId });
  const createdAt = check(timestampResult, "Assistant message could not be saved.");
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) fail("Assistant message could not be saved.");
  const row = {
    thread_id: thread.thread_id, household_id: owner.householdId, user_id: owner.userId,
    role: "assistant", source: input.source, source_key: input.source_key, content: input.content,
    request_id: null, reply_to_message_id: null, created_at: createdAt, updated_at: createdAt, generation_status: "complete", lifecycle: "active",
    event_id: input.event_id ?? null, event_version: input.event_version ?? null,
    snoozed_until: null, read_at: null, superseded_by: null, watch_ids: input.watch_ids ?? [],
    pending_action_summaries: [],
  };
  const inserted = await db.from("finance_assistant_messages").insert(row).select("*").single();
  if (!inserted.error) return inserted.data as AssistantMessageRecord;
  if (inserted.error.code !== "23505") check(inserted, "Assistant message could not be saved.");
  const duplicate = check(await ownerFilter(
    db.from("finance_assistant_messages").select("*").eq("source_key", input.source_key).maybeSingle(), owner,
  ), "Assistant message could not be saved.");
  if (!duplicate) fail("Assistant message could not be saved.");
  if (duplicate.content !== input.content || duplicate.source !== input.source || duplicate.event_id !== (input.event_id ?? null) || duplicate.event_version !== (input.event_version ?? null)) {
    fail("Assistant message idempotency conflict.");
  }
  return duplicate as AssistantMessageRecord;
}

export async function listAssistantWatches(db: any, owner: AssistantOwner, referencedWatchIds: unknown[] = []) {
  const fields = "watch_id,household_id,user_id,template,category_name,schedule,follow_up,refund,delivery,label,status,version,snoozed_until,expires_at,created_at,updated_at,next_check_at,last_checked_at,last_outcome,completed_at,commitment,origin_event_id,origin_event_version,last_failure";
  // getState may return up to 100 page rows plus one exact deep-link target.
  const maxReferenced = 101 * 20;
  const referenceIds = [...new Set(Array.isArray(referencedWatchIds) ? referencedWatchIds.filter(uuid) : [])].slice(0, maxReferenced);
  const queryStatus = async (statuses: string[], limit: number) => {
    const query = ownerFilter(db.from("finance_assistant_watches").select(fields), owner)
      .in("status", statuses).order("created_at", { ascending: false }).limit(limit);
    const data = check(await query, "Assistant watch list is unavailable.");
    return Array.isArray(data) ? data : [];
  };
  // The active slot constraint guarantees at most 20 rows, so load that set
  // separately before any recency-bounded inactive history can hide it.
  const active = await queryStatus(["active", "snoozed"], 20);
  const referenced = referenceIds.length ? check(await ownerFilter(
    db.from("finance_assistant_watches").select(fields), owner,
  ).in("watch_id", referenceIds).limit(referenceIds.length), "Referenced Assistant watch details are unavailable.") : [];
  const recent = await queryStatus(["draft", "resolved", "superseded"], 100);
  const byId = new Map<string, any>();
  for (const row of active) if (uuid(row?.watch_id)) byId.set(row.watch_id, row);
  for (const row of Array.isArray(referenced) ? referenced : []) if (uuid(row?.watch_id)) byId.set(row.watch_id, row);
  for (const row of recent) if (uuid(row?.watch_id) && !byId.has(row.watch_id)) byId.set(row.watch_id, row);
  return [...byId.values()];
}

/** Bounded indexed scan for the existing authenticated schedule worker's due-only mode. */
export async function listDueAssistantWatches(db: any, now = new Date().toISOString(), limit = 50) {
  if (!isoInstant(now) || !Number.isInteger(limit) || limit < 1 || limit > 50) fail("Assistant watch scan is invalid.");
  const data = check(await db.rpc("finance_list_due_assistant_watches", { p_now: now, p_limit: limit }), "Due Assistant watches are unavailable.");
  return Array.isArray(data) ? data : [];
}

/** Owners with due push outbox work must be revisited even after a watch resolves. */
export async function listAssistantWatchPushOwners(db: any, now = new Date().toISOString(), limit = 50) {
  if (!isoInstant(now) || !Number.isInteger(limit) || limit < 1 || limit > 50) fail("Assistant push-owner scan is invalid.");
  const value = check(await db.rpc("finance_list_assistant_watch_push_owners", { p_now: now, p_limit: limit }), "Assistant push-owner scan is unavailable.");
  if (!Array.isArray(value) || value.length > limit) fail("Assistant push-owner scan is unavailable.");
  return value.filter((item: any) => item && uuid(item.household_id) && uuid(item.user_id));
}

export async function claimAssistantWatchRun(db: any, owner: AssistantOwner, input: {
  watch_id: string; watch_version: number; run_key: string; due_at: string;
}, now = new Date().toISOString()) {
  if (!uuid(input.watch_id) || !Number.isSafeInteger(input.watch_version) || input.watch_version < 1 ||
      typeof input.run_key !== "string" || input.run_key.length < 1 || input.run_key.length > 160 || !/^[A-Za-z0-9:_-]+$/.test(input.run_key) ||
      !isoInstant(input.due_at) || !isoInstant(now)) fail("Assistant watch claim is invalid.");
  const result = await db.rpc("finance_claim_assistant_watch_run", {
    p_household_id: owner.householdId, p_user_id: owner.userId, p_watch_id: input.watch_id,
    p_watch_version: input.watch_version, p_run_key: input.run_key, p_due_at: input.due_at, p_now: now,
  });
  const value = check(result, "Assistant watch could not be claimed.");
  if (value === null) return null;
  if (!value || typeof value !== "object" || !uuid(value.run_id) || !uuid(value.claim_token) || !value.watch) fail("Assistant watch claim is invalid.");
  return value;
}

export async function completeAssistantWatchRun(db: any, owner: AssistantOwner, input: WatchRunCompletion, now = new Date().toISOString()) {
  if (!uuid(input.run_id) || !uuid(input.claim_token) || !Number.isSafeInteger(input.watch_version) || input.watch_version < 1 ||
      !watchOutcomeStatuses.includes(input.outcome?.status) || typeof input.terminal !== "boolean" || !isoInstant(now) ||
      (input.message_id !== undefined && !uuid(input.message_id)) ||
      (input.next_check_at !== undefined && input.next_check_at !== null && !isoInstant(input.next_check_at))) fail("Assistant watch completion is invalid.");
  const outcome = input.outcome;
  if (outcome.status === "pending") {
    if (outcome.dedupe_key !== undefined || outcome.message_content !== undefined || input.message_id !== undefined) fail("A no-op watch completion cannot publish a message.");
  } else if (input.template === "issue_follow_through") {
    const quiet = outcome.message_content === undefined && outcome.dedupe_key === undefined && input.message_id === undefined;
    const failureOk = typeof outcome.failure === "string" && outcome.failure.trim().length >= 8 && outcome.failure.length <= 500;
    if (["unchanged", "improved"].includes(outcome.status)) {
      if (!quiet || outcome.failure !== undefined || outcome.final_failure === true) fail("A quiet commitment comparison cannot publish a message.");
    } else if (outcome.status === "completed") {
      if (!input.terminal || !quiet || outcome.failure !== undefined || outcome.final_failure === true) fail("A completed commitment must be a quiet terminal result.");
    } else if (outcome.status === "missed") {
      if (!input.terminal || !quiet || !failureOk || outcome.final_failure === true) fail("A missed commitment must be a quiet terminal result with a reason.");
    } else if (outcome.status === "data_unavailable") {
      if (!failureOk) fail("An unavailable commitment result requires a bounded reason.");
      if (outcome.final_failure === true) {
        if (!input.terminal || !validWatchDedupeKey(outcome.dedupe_key) || typeof outcome.message_content !== "string" || !outcome.message_content.trim() || outcome.message_content.length > 6000) fail("A final unavailable commitment result requires one inspectable terminal message.");
      } else if (input.terminal || !quiet) fail("A retryable unavailable commitment result cannot publish or terminate.");
    } else if (outcome.status === "worsened") {
      if (!validWatchDedupeKey(outcome.dedupe_key) || typeof outcome.message_content !== "string" || !outcome.message_content.trim() || outcome.message_content.length > 6000 ||
          !Number.isSafeInteger(outcome.value_minor) || typeof outcome.source_revision !== "string" || outcome.source_revision.length < 1 || outcome.failure !== undefined || outcome.final_failure === true) fail("A worsened commitment result requires linked, inspectable evidence.");
    } else fail("Assistant commitment result is invalid.");
  } else if (outcome.status === "completed" || outcome.status === "missed") {
    // Legacy scheduled watches continue to publish their historical messages.
    if (!validWatchDedupeKey(outcome.dedupe_key) || typeof outcome.message_content !== "string" || !outcome.message_content.trim() || outcome.message_content.length > 6000) fail("Assistant watch result is invalid.");
  } else {
    if (!validWatchDedupeKey(outcome.dedupe_key) || typeof outcome.message_content !== "string" ||
        !outcome.message_content.trim() || outcome.message_content.length > 6000) fail("Assistant watch result is invalid.");
  }
  const result = await db.rpc("finance_complete_assistant_watch_run", {
    p_household_id: owner.householdId, p_user_id: owner.userId, p_run_id: input.run_id,
    p_claim_token: input.claim_token, p_watch_version: input.watch_version, p_outcome: outcome,
    p_message_id: input.message_id ?? null, p_next_check_at: input.next_check_at ?? null,
    p_terminal: input.terminal, p_now: now,
  });
  return check(result, "Assistant watch result could not be saved.");
}

export async function claimAssistantWatchPushJobs(db: any, owner: AssistantOwner, now = new Date().toISOString(), deferUntil: string | null = null, limit = 20) {
  if (!isoInstant(now) || !Number.isInteger(limit) || limit < 1 || limit > 20 || (deferUntil !== null && !isoInstant(deferUntil))) fail("Assistant push claim is invalid.");
  const result = await db.rpc("finance_claim_assistant_watch_push_jobs", {
    p_household_id: owner.householdId, p_user_id: owner.userId, p_now: now, p_limit: limit, p_defer_until: deferUntil,
  });
  const value = check(result, "Assistant push jobs are unavailable.");
  if (!Array.isArray(value)) fail("Assistant push jobs are unavailable.");
  return value;
}

export async function completeAssistantWatchPush(db: any, owner: AssistantOwner, input: {
  run_id: string; claim_token: string; status: "sent" | "failed" | "uncertain" | "deferred" | "cancelled";
  results: unknown; attempted_at?: string;
}) {
  if (!uuid(input.run_id) || !uuid(input.claim_token) || !["sent", "failed", "uncertain", "deferred", "cancelled"].includes(input.status) ||
      (input.attempted_at !== undefined && !isoInstant(input.attempted_at))) fail("Assistant push result is invalid.");
  return check(await db.rpc("finance_complete_assistant_watch_push", {
    p_household_id: owner.householdId, p_user_id: owner.userId, p_run_id: input.run_id,
    p_claim_token: input.claim_token, p_status: input.status, p_results: input.results,
    p_attempted_at: input.attempted_at ?? new Date().toISOString(),
  }), "Assistant push result could not be saved.");
}

export async function updateAssistantMessageLifecycle(
  db: any, owner: AssistantOwner,
  input: { message_id: string; lifecycle: AssistantLifecycle; snoozed_until?: string | null; superseded_by?: string | null; watch_ids?: string[] },
) {
  if (!uuid(input.message_id) || !["active", "snoozed", "resolved", "superseded"].includes(input.lifecycle)) fail("Assistant message lifecycle change is invalid.");
  if (input.superseded_by != null && !uuid(input.superseded_by)) fail("Assistant message lifecycle change is invalid.");
  if (input.watch_ids !== undefined && (!Array.isArray(input.watch_ids) || input.watch_ids.length > 20 || input.watch_ids.some((id) => !uuid(id)))) fail("Assistant message watch list is invalid.");
  const changes: Record<string, unknown> = { lifecycle: input.lifecycle, updated_at: new Date().toISOString() };
  if (input.lifecycle === "snoozed") {
    if (typeof input.snoozed_until !== "string" || !Number.isFinite(Date.parse(input.snoozed_until))) fail("Choose a valid snooze time.");
    changes.snoozed_until = input.snoozed_until;
  } else {
    changes.snoozed_until = null;
  }
  if (input.lifecycle === "superseded") changes.superseded_by = input.superseded_by ?? null;
  else if (input.lifecycle !== "superseded") changes.superseded_by = null;
  if (input.watch_ids !== undefined) changes.watch_ids = [...new Set(input.watch_ids)];
  const row = check(await ownerFilter(
    db.from("finance_assistant_messages").update(changes).eq("message_id", input.message_id).select("*").maybeSingle(), owner,
  ), "Assistant message could not be updated.");
  if (!row) fail("Assistant message was not found.");
  return row as AssistantMessageRecord;
}

export async function beginAssistantTurn(db: any, owner: AssistantOwner, requestId: string, content: string, replyToMessageId: string | null = null) {
  if (replyToMessageId !== null && !uuid(replyToMessageId)) fail("Assistant reply target is invalid.");
  const result = await db.rpc("finance_begin_assistant_turn", {
    p_household_id: owner.householdId, p_user_id: owner.userId, p_request_id: requestId, p_content: content,
    p_reply_to_message_id: replyToMessageId,
  });
  if (result.error) fail(result.error.message || "Assistant turn could not be saved.");
  return result.data;
}

export async function finishAssistantTurn(db: any, owner: AssistantOwner, input: {
  request_id: string; attempt_token: string; content: string; generation_status: "complete" | "failed" | "interrupted"; pending_action_summaries?: string[];
}) {
  if (!uuid(input.attempt_token)) fail("Assistant reply reservation is invalid.");
  const result = await db.rpc("finance_finish_assistant_turn", {
    p_household_id: owner.householdId, p_user_id: owner.userId, p_request_id: input.request_id,
    p_content: input.content, p_generation_status: input.generation_status,
    p_pending_action_summaries: input.pending_action_summaries ?? [], p_attempt_token: input.attempt_token,
  });
  if (result.error) fail(result.error.message || "Assistant reply could not be saved.");
  return result.data;
}

export async function getAssistantMessage(db: any, owner: AssistantOwner, messageId: string) {
  if (!uuid(messageId)) return null;
  return check(await ownerFilter(
    db.from("finance_assistant_messages").select("*").eq("message_id", messageId).maybeSingle(), owner,
  ));
}

export type { AssistantLifecycle, AssistantMessageRecord, AssistantOwner, MessageFilters, TrustedMessageInput, WatchOutcomeStatus, WatchRunCompletion, WatchRunOutcome };
