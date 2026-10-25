import { loadAssistantVerificationKeys } from './assistant-verification-keys.ts';
import { assistantV2Operation, enrichAssistantStateV2 } from "./assistant-v2-service.ts";
import { NOTIFICATION_DEFAULTS } from "./delivery-policy.ts";
import { normalizeAssistantExpectedRefund, validateAssistantWatch } from "./assistant-watch-policy.ts";
import { loadAssistantRefundWatchEvidence } from "./assistant-refund-evidence.ts";
import {
  beginAssistantTurn, ensureAssistantThread, getAssistantMessage, getAssistantThread,
  insertTrustedAssistantMessage, listAssistantMessages, listAssistantWatches,
  updateAssistantMessageLifecycle,
} from "./assistant-storage.ts";
import type { AssistantLifecycle, AssistantOwner } from "./assistant-storage.ts";

type Context = { householdId: string; userId: string };
type Row = Record<string, any>;
const ASSISTANT_DEFAULTS = {
  assistant_proactive_enabled: false,
  assistant_daily_check_enabled: false,
  assistant_daily_check_time: "08:00",
  assistant_weekly_review_enabled: false,
  assistant_weekly_review_day: 0,
  assistant_weekly_review_time: "09:00",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REVIEW_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

export class AssistantServiceError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function fail(message: string, status = 400): never { throw new AssistantServiceError(message, status); }
function isRecord(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function only(body: Row, keys: string[]) { if (Object.keys(body).some(key => !keys.includes(key))) fail("Unknown Assistant request field."); }
function owner(context: Context): AssistantOwner { return { householdId: context.householdId, userId: context.userId }; }
function check(result: any, message: string, status = 503): any {
  if (result?.error) {
    const text = String(result.error.message || "");
    const mapped = /access denied|membership/i.test(text) ? 403 : /changed|conflict|already|expired|maximum|capacity|not found|stale/i.test(text) ? 409 : status;
    fail(message, mapped);
  }
  return result?.data;
}
function b64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 12000) fail("Assistant signature is invalid.", 401);
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64), out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
function opaqueCursor(row: Row) {
  return b64url(encoder.encode(JSON.stringify({ created_at: row.created_at, message_id: row.message_id })));
}
function decodeCursor(value: unknown): { created_at: string; message_id: string } | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 500) fail("Assistant page cursor is invalid.");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(value)));
    if (!isRecord(parsed) || typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at)) || !isUuid(parsed.message_id)) fail("Assistant page cursor is invalid.");
    return { created_at: new Date(parsed.created_at).toISOString(), message_id: parsed.message_id };
  } catch { fail("Assistant page cursor is invalid."); }
}
function toMessage(row: Row) {
  return {
    message_id: row.message_id, thread_id: row.thread_id, role: row.role, source: row.source,
    content: row.content, created_at: row.created_at, updated_at: row.updated_at,
    request_id: row.request_id ?? null, reply_to_message_id: row.reply_to_message_id ?? null,
    generation_status: row.generation_status, lifecycle: row.lifecycle, lifecycle_version: row.lifecycle_version ?? null,
    event_id: row.event_id ?? null, event_version: row.event_version ?? null,
    snoozed_until: row.snoozed_until ?? null, read_at: row.read_at ?? null,
    superseded_by: row.superseded_by ?? null, watch_ids: Array.isArray(row.watch_ids) ? row.watch_ids : [],
    ...(Array.isArray(row.pending_action_summaries) && row.pending_action_summaries.length ? { pending_action_summaries: row.pending_action_summaries } : {}),
    ...(Array.isArray(row.pending_action_tools) && row.pending_action_tools.length ? { pending_action_tools: row.pending_action_tools } : {}),
    ...(Array.isArray(row.pending_action_proposal_ids) && row.pending_action_proposal_ids.length ? { pending_action_proposal_ids: row.pending_action_proposal_ids } : {}),
    ...(Array.isArray(row.pending_action_fingerprints) && row.pending_action_fingerprints.length ? { pending_action_fingerprints: row.pending_action_fingerprints } : {}),
    ...(Array.isArray(row.decision_receipts) && row.decision_receipts.length ? { decision_receipts: row.decision_receipts } : {}),
  };
}
function toThread(row: Row) { return { thread_id: row.thread_id, updated_at: row.updated_at, archived_before: row.archived_before ?? null }; }
function toWatch(row: Row) {
  return {
    watch_id: row.watch_id, template: row.template, ...(row.category_name ? { category_name: row.category_name } : {}),
    ...(row.schedule ? { schedule: row.schedule } : {}), ...(row.follow_up ? { follow_up: row.follow_up } : {}),
    ...(row.refund ? { refund: row.refund } : {}), ...(row.delivery ? { delivery: row.delivery } : {}),
    label: row.label, status: row.status, version: row.version,
    snoozed_until: row.snoozed_until ?? null, expires_at: row.expires_at ?? null,
    created_at: row.created_at, updated_at: row.updated_at,
    ...(row.template === "one_time_follow_up" || row.template === "expected_refund" ? {
      next_check_at: row.next_check_at ?? null, last_checked_at: row.last_checked_at ?? null,
      last_outcome: row.last_outcome ?? null, completed_at: row.completed_at ?? null,
    } : {}),
  };
}
async function preferenceSettings(db: any, c: Context) {
  const result = await db.from("finance_notification_preferences").select("settings").eq("household_id", c.householdId).eq("user_id", c.userId).maybeSingle();
  if (result.error) fail("Assistant preferences could not be loaded.", 503);
  const saved = isRecord(result.data?.settings) ? result.data.settings : {};
  return { ...NOTIFICATION_DEFAULTS, ...ASSISTANT_DEFAULTS, ...saved };
}

async function getState(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "cursor", "limit", "message_id"]);
  const requestedLimit = body.limit === undefined ? 40 : body.limit;
  if (!Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 100) fail("Assistant page size must be between 1 and 100.");
  if (body.message_id !== undefined && !isUuid(body.message_id)) fail("Assistant message is unavailable.");
  const cursor = decodeCursor(body.cursor), threadRow = await getAssistantThread(db, owner(c)), thread = threadRow ? toThread(threadRow) : null;
  let pageRows: Row[] = [], next: string | null = null;
  if (thread) {
    let query = db.from("finance_assistant_messages")
      .select("message_id,thread_id,role,source,content,created_at,updated_at,request_id,reply_to_message_id,generation_status,lifecycle,lifecycle_version,event_id,event_version,snoozed_until,read_at,superseded_by,watch_ids,pending_action_summaries,pending_action_tools,pending_action_proposal_ids,pending_action_fingerprints")
      .eq("household_id", c.householdId).eq("user_id", c.userId).eq("thread_id", thread.thread_id);
    if (thread.archived_before) query = query.gt("created_at", thread.archived_before);
    if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},message_id.lt.${cursor.message_id})`);
    const rows = check(await query.order("created_at", { ascending: false }).order("message_id", { ascending: false }).limit(Number(requestedLimit) + 1), "Assistant conversation could not be loaded.");
    pageRows = (rows || []).slice(0, Number(requestedLimit));
    const hasMore = (rows || []).length > Number(requestedLimit);
    next = hasMore && pageRows.length ? opaqueCursor(pageRows[pageRows.length - 1]) : null;
  }
  let unavailable = false;
  if (body.message_id) {
    const exact = thread ? await getAssistantMessage(db, owner(c), body.message_id) : null;
    if (!exact || !thread || exact.thread_id !== thread.thread_id || (thread.archived_before && Date.parse(exact.created_at) <= Date.parse(thread.archived_before))) unavailable = true;
    else if (!pageRows.some((row: Row) => row.message_id === exact.message_id)) pageRows.push(exact);
  }
  pageRows.sort((a: Row, b: Row) => Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.message_id).localeCompare(String(b.message_id)));
  const exactTarget = body.message_id ? pageRows.find((row: Row) => row.message_id === body.message_id) : null;
  const referencedWatchIds: string[] = [];
  const addMessageWatchIds = (row: Row | null | undefined) => {
    if (!Array.isArray(row?.watch_ids)) return;
    for (const id of row.watch_ids) if (isUuid(id)) referencedWatchIds.push(id);
  };
  // Prefer the explicitly opened message's watch details before other page references,
  // while remaining bounded by the page-size and per-message watch-ID contracts.
  addMessageWatchIds(exactTarget);
  for (const row of pageRows) if (row !== exactTarget) addMessageWatchIds(row);
  const [watches, preferences, taskRows] = await Promise.all([
    listAssistantWatches(db, owner(c), referencedWatchIds), preferenceSettings(db, c),
    db.from("finance_assistant_scheduled_tasks").select("task_id,instruction,cadence,weekday,local_time,timezone,enabled,version,created_at,updated_at,starts_at").eq("household_id", c.householdId).eq("user_id", c.userId).order("enabled", { ascending: false }).order("updated_at", { ascending: false }).limit(20),
  ]);
  if (taskRows?.error || !Array.isArray(taskRows?.data)) fail("Scheduled Folio tasks could not be loaded.", 503);
  return {
    thread, messages: pageRows.map(toMessage), next_cursor: next,
    // Issue commitments have their richer, independently loadable view in
    // commitments[]. Keep legacy watches[] to legacy watch templates only.
    watches: watches.filter((watch: Row) => watch.template !== "issue_follow_through").map(toWatch), preferences,
    scheduled_tasks: taskRows.data.map((task: Row) => ({ task_id: task.task_id, instruction: task.instruction, cadence: task.cadence, weekday: task.weekday, local_time: task.local_time, timezone: task.timezone, enabled: task.enabled, version: task.version, created_at: task.created_at, updated_at: task.updated_at, starts_at: task.starts_at })),
    ...(unavailable ? { unavailable: true } : {}),
  };
}

async function beginTurn(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "request_id", "content", "reply_to_message_id"]);
  if (!isUuid(body.request_id) || typeof body.content !== "string" || !body.content.trim() || body.content.length > 8000 ||
      (body.reply_to_message_id !== undefined && !isUuid(body.reply_to_message_id))) fail("Enter a question of up to 8,000 characters.");
  const result = await beginAssistantTurn(db, owner(c), body.request_id, body.content, body.reply_to_message_id ?? null);
  if (!isRecord(result) || !isRecord(result.user_message) || !isRecord(result.assistant_message) || !isRecord(result.thread)) fail("Assistant turn could not be saved.", 503);
  const replayed = result.replayed === true;
  if (replayed && result.assistant_message.generation_status === "pending") fail("This question is still being answered. Refresh the conversation before trying again.", 409);
  if (replayed && result.assistant_message.generation_status === "interrupted") fail("This question was interrupted. Start a fresh question after reviewing the saved conversation.", 409);
  const historyRows=Array.isArray(result.history)?result.history.filter(isRecord):[];
  const visibleAssistantRows=[...historyRows,...(isRecord(result.reply_context)?[result.reply_context]:[])].filter((row:Row)=>row.role==='assistant'&&isUuid(row.message_id));
  const receiptMessageIds=[...new Set(visibleAssistantRows.map((row:Row)=>row.message_id))].slice(-21);
  const [memoryResult,receiptResult]=await Promise.all([
    db.from('finance_user_preferences').select('ask_folio_memories').eq('user_id',c.userId).maybeSingle(),
    receiptMessageIds.length?db.from('finance_assistant_decision_receipts').select('receipt_id,proposal_id,message_id,outcome,tool,evidence_kind,evidence_id,verified_at,created_at,updated_at').eq('household_id',c.householdId).eq('user_id',c.userId).in('message_id',receiptMessageIds).order('updated_at',{ascending:false}).limit(100):Promise.resolve({data:[],error:null}),
  ]);
  const receiptByMessage=new Map<string,Row[]>();
  let decision_receipts_unavailable=false;
  if(receiptResult?.error||!Array.isArray(receiptResult?.data)){decision_receipts_unavailable=true;}else for(const row of receiptResult.data.slice(0,100)){
    if(!isRecord(row)||!isUuid(row.message_id)||!isUuid(row.proposal_id)||!['applied','declined','failed','unknown'].includes(String(row.outcome)))continue;
    const rows=receiptByMessage.get(row.message_id)||[];if(rows.length<20)rows.push({receipt_id:row.receipt_id,proposal_id:row.proposal_id,message_id:row.message_id,outcome:row.outcome,tool:row.tool,evidence_kind:row.evidence_kind,evidence_id:row.evidence_id,verified_at:row.verified_at,created_at:row.created_at,updated_at:row.updated_at});receiptByMessage.set(row.message_id,rows);
  }
  const attachReceipts=(row:Row)=>{const receipts=receiptByMessage.get(String(row.message_id));return receipts?.length?{...row,decision_receipts:receipts}:row;};
  const history=historyRows.map((row:Row)=>toMessage(attachReceipts(row)));
  const replyContext=isRecord(result.reply_context)?toMessage(attachReceipts(result.reply_context)):null;
  const memories=memoryResult?.error?null:memoryResult?.data?.ask_folio_memories===null||memoryResult?.data?.ask_folio_memories===undefined?[]:memoryResult.data.ask_folio_memories;
  const personal_memories_unavailable=!Array.isArray(memories)||memories.length>24;
  return {
    thread: toThread(result.thread),
    user_message: toMessage(result.user_message),
    assistant_message: toMessage(result.assistant_message),
    history,
    ...(replyContext ? { reply_context: replyContext } : {}),
    ...(personal_memories_unavailable?{personal_memories_unavailable:true}:{personal_memories:memories}),
    ...(decision_receipts_unavailable?{decision_receipts_unavailable:true}:{}),
    ...(isUuid(result.assistant_message.generation_lease_token) ? { attempt_token: result.assistant_message.generation_lease_token } : {}),
    replayed,
  };
}

// The verification registry comes from FOLIO_ASSISTANT_VERIFY_KEYS_JSON.
// Missing or unknown keys fail closed.
const ASSISTANT_SIGNING_PUBLIC_KEYS = loadAssistantVerificationKeys();
const MAX_PROOF_AGE_SECONDS = 15 * 60;
async function verifyFinalizationProof(proof: unknown, c: Context, input: Row): Promise<"legacy" | "v2"> {
  if (typeof proof !== "string" || proof.length > 16000) fail("Assistant reply could not be verified for saving.", 401);
  const [encodedHeader, encodedPayload, encodedSignature, extra] = proof.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra !== undefined) fail("Assistant reply could not be verified for saving.", 401);
  let header: Row, claims: Row;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(encodedHeader)));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(encodedPayload)));
  } catch { fail("Assistant reply could not be verified for saving.", 401); }
  if (!isRecord(header) || !isRecord(claims) || header.alg !== "ES256" || header.typ !== "JWT" ||
      typeof header.kid !== "string" || !UUID.test(String(claims.jti || ""))) fail("Assistant reply could not be verified for saving.", 401);
  const jwk = ASSISTANT_SIGNING_PUBLIC_KEYS[header.kid];
  if (!jwk) fail("Assistant reply saving is not configured.", 503);
  let publicKey: CryptoKey, signature: Uint8Array;
  try {
    publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    signature = fromB64url(encodedSignature);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, encoder.encode(`${encodedHeader}.${encodedPayload}`));
    if (!valid) fail("Assistant reply could not be verified for saving.", 401);
  } catch (error) {
    if (error instanceof AssistantServiceError) throw error;
    fail("Assistant reply could not be verified for saving.", 401);
  }
  const now = Math.floor(Date.now() / 1000), issued = Number(claims.iat), expires = Number(claims.exp);
  const claimHasTools = Object.prototype.hasOwnProperty.call(claims, "pending_action_tools");
  const claimHasFingerprints = Object.prototype.hasOwnProperty.call(claims, "pending_action_fingerprints");
  const requestHasTools = Object.prototype.hasOwnProperty.call(input, "pending_action_tools");
  const requestHasFingerprints = Object.prototype.hasOwnProperty.call(input, "pending_action_fingerprints");
  const bindingFieldsAbsent = !claimHasTools && !claimHasFingerprints && !requestHasTools && !requestHasFingerprints;
  const bindingFieldsComplete = claimHasTools && claimHasFingerprints && requestHasTools && requestHasFingerprints &&
    Array.isArray(claims.pending_action_tools) && Array.isArray(claims.pending_action_fingerprints) &&
    Array.isArray(input.pending_action_tools) && Array.isArray(input.pending_action_fingerprints);
  if (!bindingFieldsAbsent && !bindingFieldsComplete) fail("Assistant reply could not be verified for saving.", 401);
  const baseClaimKeys = ["aud", "household_id", "user_id", "request_id", "attempt_token", "content_sha256", "generation_status", "pending_action_summaries", "iat", "exp", "jti"];
  const expectedClaimKeys = bindingFieldsAbsent ? baseClaimKeys : [...baseClaimKeys, "pending_action_tools", "pending_action_fingerprints"];
  if (Object.keys(claims).length !== expectedClaimKeys.length || expectedClaimKeys.some((key) => !Object.prototype.hasOwnProperty.call(claims, key))) {
    fail("Assistant reply could not be verified for saving.", 401);
  }
  if (bindingFieldsComplete && (
      claims.pending_action_tools.length !== (claims.pending_action_summaries ?? []).length ||
      claims.pending_action_fingerprints.length !== (claims.pending_action_summaries ?? []).length ||
      input.pending_action_tools.length !== (input.pending_action_summaries ?? []).length ||
      input.pending_action_fingerprints.length !== (input.pending_action_summaries ?? []).length)) fail("Assistant reply could not be verified for saving.", 401);
  if (claims.aud !== "folio-assistant-finish" || claims.household_id !== c.householdId || claims.user_id !== c.userId ||
      claims.request_id !== input.request_id || claims.content_sha256 !== await sha256Hex(input.content) ||
      claims.attempt_token !== input.attempt_token || !isUuid(input.attempt_token) ||
      claims.generation_status !== input.generation_status ||
      JSON.stringify(claims.pending_action_summaries ?? []) !== JSON.stringify(input.pending_action_summaries ?? []) ||
      (bindingFieldsComplete && (JSON.stringify(claims.pending_action_tools) !== JSON.stringify(input.pending_action_tools) ||
        JSON.stringify(claims.pending_action_fingerprints) !== JSON.stringify(input.pending_action_fingerprints))) ||
      !Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || issued > now + 30 ||
      now - issued > MAX_PROOF_AGE_SECONDS || expires < now || expires - issued > MAX_PROOF_AGE_SECONDS) {
    fail("Assistant reply could not be verified for saving.", 401);
  }
  return bindingFieldsAbsent ? "legacy" : "v2";
}

async function finishTurn(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "request_id", "attempt_token", "content", "generation_status", "pending_action_summaries", "pending_action_tools", "pending_action_fingerprints", "proof"]);
  if (!isUuid(body.request_id) || !isUuid(body.attempt_token) || typeof body.content !== "string" || !body.content.trim() || body.content.length > 20000 ||
      !["complete", "failed", "interrupted"].includes(body.generation_status)) fail("Assistant reply is invalid.");
  const summaries = body.pending_action_summaries === undefined ? [] : body.pending_action_summaries;
  const hasV2Bindings = Object.prototype.hasOwnProperty.call(body, "pending_action_tools") || Object.prototype.hasOwnProperty.call(body, "pending_action_fingerprints");
  const tools = body.pending_action_tools === undefined ? [] : body.pending_action_tools;
  const fingerprints = body.pending_action_fingerprints === undefined ? [] : body.pending_action_fingerprints;
  if (!Array.isArray(summaries) || summaries.length > 20 || summaries.some((item: unknown) => typeof item !== "string" || item.length > 280) ||
      !Array.isArray(tools) || !Array.isArray(fingerprints) ||
      (hasV2Bindings && (tools.length !== summaries.length || fingerprints.length !== summaries.length ||
        tools.some((item: unknown) => typeof item !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(item)) ||
        fingerprints.some((item: unknown) => typeof item !== "string" || !/^[0-9a-f]{64}$/.test(item)))) ||
      (!hasV2Bindings && (body.pending_action_tools !== undefined || body.pending_action_fingerprints !== undefined))) fail("Assistant action proposals are invalid.");
  const proofInput = { ...body, pending_action_summaries: summaries };
  const proofMode = await verifyFinalizationProof(body.proof, c, proofInput);
  if (proofMode === "legacy") {
    const legacy = check(await db.rpc("finance_finish_assistant_turn", {
      p_household_id: c.householdId, p_user_id: c.userId, p_request_id: body.request_id,
      p_content: body.content, p_generation_status: body.generation_status,
      p_pending_action_summaries: summaries, p_attempt_token: body.attempt_token,
    }), "Assistant reply could not be saved.", 409);
    if (!isRecord(legacy) || !Array.isArray(legacy.pending_action_summaries) || JSON.stringify(legacy.pending_action_summaries) !== JSON.stringify(summaries) ||
        (Array.isArray(legacy.pending_action_tools) && legacy.pending_action_tools.length !== 0) ||
        (Array.isArray(legacy.pending_action_proposal_ids) && legacy.pending_action_proposal_ids.length !== 0) ||
        (Array.isArray(legacy.pending_action_fingerprints) && legacy.pending_action_fingerprints.length !== 0)) fail("Assistant reply could not be saved safely.", 409);
    // v347 signed only summaries. Preserve them for history, but expose no V2
    // proposal bindings, so they cannot be executed or receive V2 receipts.
    return { ...legacy, pending_action_tools: [], pending_action_proposal_ids: [], pending_action_fingerprints: [] };
  }
  const result = check(await db.rpc("finance_finish_assistant_turn_v2", {
    p_household_id: c.householdId, p_user_id: c.userId, p_request_id: body.request_id,
    p_content: body.content, p_generation_status: body.generation_status,
    p_pending_action_summaries: summaries, p_pending_action_tools: tools, p_pending_action_fingerprints: fingerprints, p_attempt_token: body.attempt_token,
  }), "Assistant reply could not be saved.", 409);
  if (!isRecord(result) || !Array.isArray(result.pending_action_proposal_ids) || !Array.isArray(result.pending_action_tools) || !Array.isArray(result.pending_action_fingerprints) ||
      result.pending_action_proposal_ids.length !== summaries.length || result.pending_action_tools.length !== tools.length || result.pending_action_fingerprints.length !== fingerprints.length ||
      result.pending_action_proposal_ids.some((id: unknown) => !isUuid(id)) || JSON.stringify(result.pending_action_tools) !== JSON.stringify(tools) || JSON.stringify(result.pending_action_fingerprints) !== JSON.stringify(fingerprints)) fail("Assistant reply proposal links could not be verified.", 503);
  return result;
}

async function markRead(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "message_id"]);
  if (!isUuid(body.message_id)) fail("Assistant message is unavailable.", 404);
  const message = await getAssistantMessage(db, owner(c), body.message_id);
  if (!message) fail("Assistant message is unavailable.", 404);
  const readAt = message.read_at || new Date().toISOString();
  const saved = check(await db.from("finance_assistant_messages").update({ read_at: readAt }).eq("household_id", c.householdId).eq("user_id", c.userId).eq("message_id", body.message_id).select("*").maybeSingle(), "Assistant message could not be marked as read.");
  if (!saved) fail("Assistant message is unavailable.", 404);
  if (saved.event_id && saved.event_version) {
    const event = check(await db.from("finance_agent_events").select("event_id,event_version,event_type").eq("household_id", c.householdId).eq("event_id", saved.event_id).eq("event_version", saved.event_version).maybeSingle(), "Assistant event receipt could not be updated.");
    if (event) {
      const delivery = await db.from("finance_agent_deliveries").update({ opened_at: readAt }).eq("household_id", c.householdId).eq("user_id", c.userId).eq("event_id", event.event_id);
      if (delivery.error) fail("Assistant event receipt could not be updated.", 503);
      const upsert = await db.from("finance_agent_deliveries").upsert({
        household_id: c.householdId, user_id: c.userId, event_id: event.event_id,
        event_version: event.event_version, event_type: event.event_type, severity: 0,
        channel: "assistant_inbox", status: "sent", opened_at: readAt,
      }, { onConflict: "user_id,event_id,event_version,channel" });
      if (upsert.error) fail("Assistant event receipt could not be updated.", 503);
    }
  }
  return { message: toMessage(saved) };
}

async function archiveHistory(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "expected_updated_at"]);
  if (typeof body.expected_updated_at !== "string" || !Number.isFinite(Date.parse(body.expected_updated_at))) fail("Refresh the conversation before clearing its view.");
  const updated = check(await db.rpc("finance_archive_assistant_history", {
    p_household_id: c.householdId, p_user_id: c.userId, p_expected_updated_at: body.expected_updated_at,
  }), "Conversation changed. Refresh before clearing its view.", 409);
  if (!isRecord(updated)) fail("Conversation changed. Refresh before clearing its view.", 409);
  return { thread: toThread(updated) };
}

async function restoreAssistantHistory(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "expected_updated_at"]);
  if (typeof body.expected_updated_at !== "string" || !Number.isFinite(Date.parse(body.expected_updated_at))) fail("Refresh the conversation before restoring its view.");
  const updated = check(await db.rpc("finance_restore_assistant_history", {
    p_household_id: c.householdId, p_user_id: c.userId, p_expected_updated_at: body.expected_updated_at,
  }), "Conversation changed. Refresh before restoring its view.", 409);
  if (!isRecord(updated)) fail("Conversation changed. Refresh before restoring its view.", 409);
  return { thread: toThread(updated) };
}

function randomToken() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return b64url(bytes);
}
function watchReviewConfig(row: Row) {
  return {
    template: row.template,
    category_name: row.category_name ?? null,
    schedule: row.schedule ?? null,
    follow_up: row.follow_up ?? null,
    refund: row.refund ?? null,
    delivery: row.delivery ?? "chat",
    label: row.label,
    expires_at: row.expires_at ?? null,
    replaces_watch_id: row.replaces_watch_id ?? null,
    replaces_version: row.replaces_version ?? null,
  };
}
async function watchReviewHash(token: string, c: Context, version: number, config: Row) {
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return sha256Hex(JSON.stringify(stable({ aud: "folio-assistant-watch-review", household_id: c.householdId, user_id: c.userId, version, token, config })));
}
const ASSISTANT_TIMING_NOTE = "Folio checks due follow-ups about every 15 minutes. Delivery can be delayed by connectivity, quiet hours, notification limits, or your device. Missed checks remain visible in chat.";
async function assistantPushAvailable(db: any, c: Context) {
  const settings = await preferenceSettings(db, c);
  if (settings.in_app_enabled === false || settings.push_enabled !== true) return false;
  const result = await db.from("finance_push_subscriptions").select("subscription_id")
    .eq("household_id", c.householdId).eq("user_id", c.userId).eq("enabled", true).eq("permission", "granted").limit(1).maybeSingle();
  if (result.error) fail("Assistant notification settings could not be checked.", 503);
  return !!result.data;
}
async function reviewWatch(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "template", "category_name", "expires_at", "watch_id", "expected_version", "schedule", "follow_up", "refund", "delivery"]);
  let catalog: any[] = [];
  if (body.template === "budget" || (body.template === "one_time_follow_up" && body.follow_up?.check === "budget")) {
    const result = await db.from("finance_categories").select("category_name,category_type,active,excluded_from_budget")
      .eq("household_id", c.householdId).eq("category_type", "expense").eq("active", true).eq("excluded_from_budget", false);
    catalog = check(result, "Active budget categories are unavailable.").map((row: Row) => ({ name: row.category_name, active: row.active === true }));
  }
  let normalized: any;
  try { normalized = validateAssistantWatch({ template: body.template, category_name: body.category_name, expires_at: body.expires_at, watch_id: body.watch_id, expected_version: body.expected_version, schedule: body.schedule, follow_up: body.follow_up, refund: body.refund, delivery: body.delivery }, catalog); }
  catch (error) { fail(error instanceof Error ? error.message : "Choose a supported Folio watch.", 400); }
  if (normalized.template === "expected_refund") {
    const proposal = normalized.refund;
    const evidence = await loadAssistantRefundWatchEvidence(db, c, proposal.original_transaction_id);
    try {
      normalized.refund = normalizeAssistantExpectedRefund(proposal, evidence);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already meet this expectation")) {
        const received = Array.isArray(evidence.posted_refunds) ? evidence.posted_refunds.reduce((total: number, row: Row) => total + Number(row.amount_minor || 0), 0) : 0;
        return { already_received: true, refund: { original_transaction_id: proposal.original_transaction_id, amount_minor: received }, summary: "Current verified posted refunds already meet this expectation." };
      }
      fail(error instanceof Error ? error.message : "Current purchase evidence is unavailable.", 409);
    }
  }
  const token = randomToken(), now = Date.now();
  const reviewExpires = new Date(now + MAX_REVIEW_MS).toISOString();
  const proposalExpires = normalized.expires_at ?? null;
  const config = {
    template: normalized.template, category_name: normalized.category_name ?? null,
    schedule: normalized.schedule ?? null, follow_up: normalized.follow_up ?? null,
    refund: normalized.refund ?? null, delivery: normalized.delivery ?? "chat",
    label: normalized.label, expires_at: proposalExpires,
    replaces_watch_id: normalized.watch_id ?? null, replaces_version: normalized.expected_version ?? null,
  };
  const tokenHash = await watchReviewHash(token, c, 1, config);
  const result = await db.rpc("finance_review_assistant_watch", {
    p_household_id: c.householdId, p_user_id: c.userId, p_template: normalized.template,
    p_category_name: normalized.category_name ?? null, p_label: normalized.label,
    p_expires_at: proposalExpires, p_review_token_hash: tokenHash, p_review_token_expires_at: reviewExpires,
    p_replaces_watch_id: normalized.watch_id ?? null, p_replaces_version: normalized.expected_version ?? null,
    p_schedule: normalized.schedule ?? null, p_follow_up: normalized.follow_up ?? null,
    p_refund: normalized.refund ?? null, p_delivery: normalized.delivery ?? "chat",
  });
  const watch = check(result, "Assistant watch review could not be saved.", 409);
  const pushAvailable = normalized.delivery === "chat_and_push" ? await assistantPushAvailable(db, c) : false;
  const timingNote = normalized.schedule ? ASSISTANT_TIMING_NOTE : undefined;
  return {
    watch: toWatch(watch), review_token: token, review_expires_at: reviewExpires,
    push_available: pushAvailable, ...(timingNote ? { timing_note: timingNote } : {}),
    summary: normalized.schedule ? `${normalized.label} for ${normalized.schedule.local_date} at ${normalized.schedule.local_time} (${normalized.schedule.timezone}).` : proposalExpires ? `${normalized.label} until ${proposalExpires.slice(0, 10)}. It matches existing Folio alerts only; it does not create new financial thresholds.` : `${normalized.label}. It matches existing Folio alerts only; it does not create new financial thresholds.`,
  };
}

async function confirmWatch(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "watch_id", "review_token", "expected_version", "confirm"]);
  if (!isUuid(body.watch_id) || typeof body.review_token !== "string" || body.review_token.length < 40 || body.review_token.length > 128 ||
      !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1 || body.confirm !== true) fail("Confirm this specific watch proposal to activate it.");
  const draftResult = await db.from("finance_assistant_watches").select("*")
    .eq("household_id", c.householdId).eq("user_id", c.userId).eq("watch_id", body.watch_id).maybeSingle();
  const draft = check(draftResult, "Assistant watch could not be confirmed.", 409);
  if (!draft) fail("Assistant watch could not be confirmed.", 404);
  const hash = await watchReviewHash(body.review_token, c, Number(draft.review_version), watchReviewConfig(draft));
  const result = await db.rpc("finance_confirm_assistant_watch", {
    p_household_id: c.householdId, p_user_id: c.userId, p_watch_id: body.watch_id,
    p_review_token_hash: hash, p_expected_version: body.expected_version,
  });
  const value = check(result, "Assistant watch could not be confirmed.", 409);
  if (!isRecord(value) || !isRecord(value.watch) || value.saved !== true) fail("Assistant watch could not be confirmed.", 409);
  const pushAvailable = value.watch.delivery === "chat_and_push" ? await assistantPushAvailable(db, c) : false;
  return { watch: toWatch(value.watch), saved: true, push_available: pushAvailable };
}

async function taskReviewKey() {
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) fail("Assistant schedule review is unavailable.", 503);
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function taskLocalParts(date: Date, timezone: string, formatter?: Intl.DateTimeFormat) {
  const parts = (formatter ?? new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).formatToParts(date);
  const get = (name: string) => parts.find(part => part.type === name)?.value || "";
  return { weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday")), date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
function nextTaskOccurrence(cadence: string, weekday: number | null, localTime: string, timezone: string, after: Date) {
  // Pick the first matching local minute after confirmation. During a repeated DST hour
  // this selects its first occurrence; a nonexistent local minute moves to the next day.
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const days = cadence === "daily" ? 3 : 10;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let minute = 0; minute <= days * 1440; minute++) {
    const at = new Date(start + minute * 60_000), local = taskLocalParts(at, timezone, formatter);
    if (local.time !== localTime || cadence === "weekly" && local.weekday !== weekday) continue;
    let earlierDuplicate = false;
    for (let back = 1; back <= 180; back++) {
      const prior = taskLocalParts(new Date(at.getTime() - back * 60_000), timezone, formatter);
      if (prior.date !== local.date) break;
      if (prior.time === localTime && (cadence === "daily" || prior.weekday === weekday)) { earlierDuplicate = true; break; }
    }
    if (!earlierDuplicate) return at.toISOString();
  }
  fail("A next scheduled time could not be calculated for this time zone.", 400);
}
async function reviewAssistantTask(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "task_id", "expected_version", "instruction", "cadence", "weekday", "time", "timezone", "enabled"]);
  const isNew = body.task_id === undefined;
  const taskId = isNew ? crypto.randomUUID() : body.task_id;
  if (!isUuid(taskId)) fail("Choose a valid scheduled task.");
  if (!isNew && (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1)) fail("Refresh the scheduled task and review the change again.", 409);
  if (isNew && body.expected_version !== undefined) fail("Refresh the scheduled task and review the change again.", 409);
  if (typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.trim().length > 1500) fail("Enter an instruction of up to 1,500 characters.");
  if (!(["daily", "weekly"].includes(String(body.cadence)))) fail("Choose daily or weekly cadence.");
  if (body.cadence === "weekly" ? (!Number.isSafeInteger(body.weekday) || Number(body.weekday) < 0 || Number(body.weekday) > 6) : body.weekday !== undefined && body.weekday !== null) fail("Choose a valid weekday for this schedule.");
  if (typeof body.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) fail("Choose a valid local time.");
  const timezone = body.timezone;
  if (typeof timezone !== "string" || timezone.length > 80) fail("Choose a valid IANA time zone.");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); } catch { fail("Choose a valid IANA time zone."); }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") fail("Choose whether this task should be active.");
  let current: Row | null = null;
  if (!isNew) current = check(await db.from("finance_assistant_scheduled_tasks").select("task_id,version,instruction,cadence,weekday,local_time,timezone,enabled").eq("task_id", taskId).eq("household_id", c.householdId).eq("user_id", c.userId).maybeSingle(), "Scheduled task is unavailable.", 409);
  if (!isNew && !current) fail("Scheduled task is unavailable.", 404);
  if (current && current.version !== body.expected_version) fail("Scheduled task changed. Review it again.", 409);
  const patch = { instruction: body.instruction.trim(), cadence: body.cadence, weekday: body.cadence === "weekly" ? Number(body.weekday) : null, local_time: body.time, timezone, enabled: body.enabled !== false };
  const nextRun = patch.enabled ? nextTaskOccurrence(patch.cadence, patch.weekday, patch.local_time, patch.timezone, new Date()) : null;
  const expectedVersion = current ? current.version : null;
  const now = Date.now();
  const payload = b64url(encoder.encode(JSON.stringify({ aud: "folio-assistant-task", household_id: c.householdId, user_id: c.userId, exp: now + MAX_REVIEW_MS, task_id: taskId, expected_version: expectedVersion, patch, next_run_at: nextRun })));
  const key = await taskReviewKey();
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayLabel = patch.cadence === "weekly" ? ` every ${days[patch.weekday!]}` : " every day";
  const inAppEnabled = (await preferenceSettings(db, c)).in_app_enabled !== false;
  const summary = `${isNew ? "Create" : "Update"} a ${patch.cadence} scheduled Folio task${dayLabel} at ${patch.local_time} (${patch.timezone}). Instruction: “${patch.instruction}”${patch.enabled ? ` Next run: ${nextRun}.` : " It will be paused."} Runs use fresh read-only Folio financial data and cannot change accounts, budgets, or transactions. Delivery is chat-only in the private Folio Assistant conversation; this task does not send push, email, or other notifications. ${inAppEnabled ? "In-app delivery is on." : "In-app delivery is off, so this task will remain saved but will not run until in-app delivery is enabled in Settings."} No notification or device setting will change. At most 10 tasks can be active, with 20 saved tasks total. If the requested local time does not occur because of a daylight-saving change, that occurrence is skipped; a repeated local time uses its first occurrence.`;
  return { review_token: `${payload}.${b64url(signature)}`, summary, task: { ...patch, task_id: taskId, version: expectedVersion, next_run_at: nextRun } };
}
async function confirmAssistantTask(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "review_token", "confirm"]);
  if (body.confirm !== true || typeof body.review_token !== "string" || body.review_token.length > 10000) fail("Confirm this exact scheduled task review.");
  const [payload, supplied] = body.review_token.split(".");
  if (!payload || !supplied) fail("Scheduled task review is invalid.", 401);
  const key = await taskReviewKey();
  let valid = false;
  try { valid = await crypto.subtle.verify("HMAC", key, fromB64url(supplied), encoder.encode(payload)); } catch {}
  if (!valid) fail("Scheduled task review is invalid.", 401);
  let review: Row;
  try { review = JSON.parse(new TextDecoder().decode(fromB64url(payload))); } catch { fail("Scheduled task review is invalid.", 401); }
  if (review.aud !== "folio-assistant-task" || review.household_id !== c.householdId || review.user_id !== c.userId || !Number.isFinite(review.exp) || Date.now() > review.exp || !isUuid(review.task_id) || (review.expected_version !== null && !Number.isSafeInteger(review.expected_version)) || !isRecord(review.patch)) fail("Scheduled task review expired. Review it again.", 409);
  if (review.patch.enabled === true && (typeof review.next_run_at !== "string" || !Number.isFinite(Date.parse(review.next_run_at)) || Date.parse(review.next_run_at) <= Date.now())) fail("The reviewed next run time has passed. Review the schedule again.", 409);
  const p = review.patch;
  const saved = check(await db.rpc("finance_confirm_assistant_task", { p_household_id: c.householdId, p_user_id: c.userId, p_task_id: review.task_id, p_expected_version: review.expected_version, p_instruction: p.instruction, p_cadence: p.cadence, p_weekday: p.weekday, p_local_time: p.local_time, p_timezone: p.timezone, p_enabled: p.enabled }), "Scheduled task changed. Review it again.", 409);
  if (!isRecord(saved) || saved.saved !== true || !isRecord(saved.task)) fail("Scheduled task changed. Review it again.", 409);
  return { saved: true, task: saved.task };
}

async function setWatchState(db: any, c: Context, body: Row) {
  only(body, ["action", "household_id", "watch_id", "expected_version", "status", "snoozed_until"]);
  if (!isUuid(body.watch_id) || !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      !["active", "snoozed", "resolved"].includes(body.status)) fail("Choose a valid watch state.");
  const snoozedUntil = body.snoozed_until === undefined ? null : body.snoozed_until;
  if (body.status === "snoozed" && (typeof snoozedUntil !== "string" || !Number.isFinite(Date.parse(snoozedUntil)))) fail("Choose a valid snooze time.");
  if (body.status !== "snoozed" && body.snoozed_until !== undefined) fail("Snooze time is valid only for a snoozed watch.");
  const result = await db.rpc("finance_set_assistant_watch_state", {
    p_household_id: c.householdId, p_user_id: c.userId, p_watch_id: body.watch_id,
    p_expected_version: body.expected_version, p_status: body.status, p_snoozed_until: snoozedUntil,
  });
  return toWatch(check(result, "Assistant watch could not be updated.", 409));
}

function legacyTaskReviewToken(value:unknown){
 if(typeof value!=='string'||value.length>12000)return false;
 try{const encoded=value.split('.')[0];const payload=JSON.parse(new TextDecoder().decode(fromB64url(encoded)));return isRecord(payload)&&payload.aud==='folio-assistant-task';}catch{return false;}
}

export async function assistantServiceOperation(action: string, body: Row, context: Context, db: any, deps: Row = {}) {
  if (action === "get_assistant_state") return enrichAssistantStateV2(db, context, await getState(db, context, body));
  if (action === "begin_assistant_turn") return beginTurn(db, context, body);
  if (action === "finish_assistant_turn") return finishTurn(db, context, body);
  if (action === "mark_assistant_message_read") return markRead(db, context, body);
  if (action === "archive_assistant_history") return archiveHistory(db, context, body);
  if (action === "restore_assistant_history") return restoreAssistantHistory(db, context, body);
  if (action === "review_assistant_watch") return reviewWatch(db, context, body);
  if (action === "confirm_assistant_watch") return confirmWatch(db, context, body);
  if (action === "review_assistant_task") {
    if(body.delivery!==undefined){const v2=await assistantV2Operation(action,body,context,db,deps);if(v2!==undefined)return v2;}
    return reviewAssistantTask(db, context, body);
  }
  if (action === "confirm_assistant_task") {
    if(!legacyTaskReviewToken(body.review_token)){const v2=await assistantV2Operation(action,body,context,db,deps);if(v2!==undefined)return v2;}
    return confirmAssistantTask(db, context, body);
  }
  if (action === "set_assistant_watch_state") return setWatchState(db, context, body);
  const v2 = await assistantV2Operation(action, body, context, db, deps);
  if (v2 !== undefined) return v2;
  fail("Unsupported Assistant operation.", 400);
}

export const assistantStorageHelpers = {
  getAssistantThread, ensureAssistantThread, listAssistantMessages, listAssistantWatches,
  insertTrustedAssistantMessage, updateAssistantMessageLifecycle,
};
export type { AssistantLifecycle, AssistantOwner };
