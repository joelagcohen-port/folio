"use client";

import { Check, ChevronDown, Copy, Eye, History, LoaderCircle, MoreHorizontal, RefreshCw, Reply, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { FormEvent, Fragment, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { askFolioViewportRect } from "./ask-folio-viewport";
import { askFolioStorageKey, clearAskFolioHistory, scrollAskFolioToLatest } from "./ask-folio-history";
import { FolioCompactSheet } from "./folio-compact-sheet";
import { ASK_FOLIO_STREAM_TOTAL_TIMEOUT_MS, consumeAskFolioStream } from "./ask-folio-stream";
import { isAssistantCommitment, isRecord, parseAssistantState, type AssistantCommitment, type AssistantDecisionReceipt, type AssistantMessage, type AssistantState, type AssistantWatch, type AssistantWatchPreview } from "./folio-assistant-contract";
import { folioAssistantRequest, isFolioAssistantMessageId, loadFolioAssistantState } from "./folio-assistant-client";
import { assistantWatchOutcomeLabel, formatAssistantClock, formatAssistantDate, formatAssistantInstant, formatAssistantMinorAmount, formatAssistantOffset, isAssistantTransactionId, parseAssistantWatchPreview } from "./folio-assistant-display";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  pendingAction?: PendingAction;
  pendingActions?: PendingAction[];
  operationStatus?: "outcome_unknown" | "reconciled" | "completed";
  actionError?: string;
  actionErrorType?: "memory" | "decline";
  decisionError?: string;
  savedState?: "pending" | "unknown";
  requestId?: string;
  assistant?: AssistantMessage;
  historicalActionSummaries?: string[];
};

function assistantMessageForView(message: AssistantMessage, actions?: PendingAction[]): Message {
  return {
    id: message.message_id,
    role: message.role,
    content: message.content,
    assistant: message,
    pendingActions: actions,
    historicalActionSummaries: actions?.length ? undefined : message.pending_action_summaries,
  };
}

type PendingAction = {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  destructive: boolean;
  rentalPreview?: { rows: RentalPreviewRow[]; total_count: number };
  watchPreview?: AssistantWatchPreview;
  watchStatePreview?: Record<string, unknown>;
  taskPreview?: Record<string, unknown>;
  commitmentPreview?: Record<string, unknown>;
};
type AssistantTaskPreview = { instruction: string; cadence: "daily" | "weekly"; weekday: number | null; local_time: string; timezone: string; next_run_at: string | null; delivery: "chat" | "chat_and_push"; push_available: boolean; task_id?: string; enabled?: boolean; review_expires_at?: string };
type AssistantCommitmentPreview = AssistantCommitment & { push_available: boolean; acknowledge_origin?: { message_id?: string; event_id?: string; event_version?: number; will_resolve?: boolean }; review_expires_at?: string };
type AssistantMemoryReview = { key: string; kind: "goal" | "decision"; summary: string; effectiveFrom?: string; effectiveUntil?: string };
type AssistantWatchStatePreview = { watch_id: string; label: string; template: string; status: "active" | "snoozed" | "resolved"; current_version: number; next_check_at: string | null; proposed_status: "active" | "snoozed" | "resolved"; snoozed_until: string | null; review_expires_at: string; timezone: string | null };
type WatchPauseChoice = { instant: number; snoozed_until: string; offset: number };
type WatchPauseForm = { watch_id: string; version: number; label: string; template: string; date: string; time: string; timezone: string; choices: WatchPauseChoice[]; selectedInstant: number | null; error: string };
type SelectedWatchContext = { watch_id: string; expected_version: number; intent: "pause" | "resume" | "stop"; snoozed_until?: string };
type SelectedTaskContext = { task_id: string; expected_version: number; intent: "pause" | "resume" | "edit"; instruction: string; schedule: string };
function isPendingAction(value: unknown): value is PendingAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return typeof action.tool === "string" && !!action.args && typeof action.args === "object" && !Array.isArray(action.args) && typeof action.summary === "string" && typeof action.destructive === "boolean";
}
function parseTaskPreview(value: unknown): AssistantTaskPreview | null {
  if (!isRecord(value) || typeof value.instruction !== "string" || !value.instruction.trim() ||
      (value.cadence !== "daily" && value.cadence !== "weekly") ||
      (value.weekday !== null && !Number.isSafeInteger(value.weekday)) ||
      value.weekday !== null && (Number(value.weekday) < 0 || Number(value.weekday) > 6) ||
      typeof value.local_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.local_time) ||
      typeof value.timezone !== "string" || !["chat", "chat_and_push"].includes(String(value.delivery)) || typeof value.push_available !== "boolean" ||
      (value.next_run_at !== null && (typeof value.next_run_at !== "string" || !Number.isFinite(Date.parse(value.next_run_at)))) ||
      value.cadence === "weekly" && value.weekday === null || value.cadence === "daily" && value.weekday !== null) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); } catch { return null; }
  return value as unknown as AssistantTaskPreview;
}
function parseWatchStatePreview(value: unknown): AssistantWatchStatePreview | null {
  if (!isRecord(value) || !isFolioAssistantMessageId(value.watch_id) || typeof value.label !== "string" || !value.label.trim() || typeof value.template !== "string" ||
      !["active", "snoozed", "resolved"].includes(String(value.status)) || !Number.isSafeInteger(value.current_version) || Number(value.current_version) < 1 ||
      !(value.next_check_at === null || typeof value.next_check_at === "string" && Number.isFinite(Date.parse(value.next_check_at))) ||
      !["active", "snoozed", "resolved"].includes(String(value.proposed_status)) ||
      !(value.snoozed_until === null || typeof value.snoozed_until === "string" && Number.isFinite(Date.parse(value.snoozed_until)) && Date.parse(value.snoozed_until) > Date.now()) ||
      typeof value.review_expires_at !== "string" || !Number.isFinite(Date.parse(value.review_expires_at)) || Date.parse(value.review_expires_at) <= Date.now() ||
      !(value.timezone === null || typeof value.timezone === "string")) return null;
  if (value.proposed_status === "snoozed" ? typeof value.snoozed_until !== "string" : value.snoozed_until !== null) return null;
  if (value.proposed_status === "snoozed" && typeof value.timezone !== "string") return null;
  if (typeof value.timezone === "string") try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); } catch { return null; }
  return value as unknown as AssistantWatchStatePreview;
}
function parseCommitmentPreview(value: unknown): AssistantCommitmentPreview | null {
  if (!isRecord(value) || typeof value.push_available !== "boolean" || !isAssistantCommitment(value) || value.status !== "draft") return null;
  if (value.acknowledge_origin !== undefined) {
    if (!isRecord(value.acknowledge_origin) || value.acknowledge_origin.will_resolve !== true) return null;
    const ack = value.acknowledge_origin;
    if (Object.keys(ack).some(key => !["message_id", "event_id", "event_version", "will_resolve", "disposition"].includes(key)) ||
        ack.message_id !== undefined && (value.origin.kind !== "message" || ack.message_id !== value.origin.message_id) ||
        ack.event_id !== undefined && (value.origin.kind !== "message" || ack.message_id !== value.origin.message_id || typeof ack.event_id !== "string" || !ack.event_id || !Number.isSafeInteger(ack.event_version) || Number(ack.event_version) < 1 || ack.disposition !== "expected") ||
        ack.event_id === undefined && (ack.event_version !== undefined || ack.disposition !== undefined)) return null;
    if (ack.message_id === undefined && ack.event_id === undefined) return null;
  }
  return value as unknown as AssistantCommitmentPreview;
}
function parseMemoryReview(value: unknown): AssistantMemoryReview | null {
  if (!isRecord(value)) return null;
  const source = isRecord(value.memory) ? value.memory : value;
  if (typeof source.key !== "string" || !/^[a-z0-9:_-]{1,80}$/.test(source.key) ||
      (source.kind !== "goal" && source.kind !== "decision") || typeof source.summary !== "string" || source.summary.trim().length < 8 || source.summary.length > 280) return null;
  const validDate = (date: unknown) => date === undefined || typeof date === "string" && /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
  const effectiveFrom = source.effective_from ?? source.effectiveFrom;
  const effectiveUntil = source.effective_until ?? source.effectiveUntil;
  if (!validDate(effectiveFrom) || !validDate(effectiveUntil) || typeof effectiveFrom === "string" && typeof effectiveUntil === "string" && effectiveFrom > effectiveUntil) return null;
  return { key: source.key, kind: source.kind, summary: source.summary.trim(), ...(typeof effectiveFrom === "string" ? { effectiveFrom } : {}), ...(typeof effectiveUntil === "string" ? { effectiveUntil } : {}) };
}
function zonedWallParts(instant: number, timezone: string) {
  const entries = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const value = (key: string) => entries.find(part => part.type === key)?.value || "";
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}
function zonedOffsetMinutes(instant: number, timezone: string) {
  const wall = zonedWallParts(instant, timezone);
  return (Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day), Number(wall.hour), Number(wall.minute)) - Math.floor(instant / 60_000) * 60_000) / 60_000;
}
function watchPauseChoices(date: string, time: string, timezone: string): WatchPauseChoice[] {
  if (!/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return [];
  try { new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { return []; }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(target).toISOString().slice(0, 10) !== date) return [];
  const candidates = new Map<number, WatchPauseChoice>();
  for (let delta = -36; delta <= 36; delta += 6) {
    const offset = zonedOffsetMinutes(target + delta * 60 * 60_000, timezone);
    const instant = target - offset * 60_000;
    if (instant <= Date.now()) continue;
    const local = zonedWallParts(instant, timezone);
    if (`${local.year}-${local.month}-${local.day}` !== date || `${local.hour}:${local.minute}` !== time) continue;
    const sign = offset < 0 ? "-" : "+";
    const magnitude = Math.abs(offset);
    const offsetString = `${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
    candidates.set(instant, { instant, offset, snoozed_until: `${date}T${time}:00${offsetString}` });
  }
  return [...candidates.values()].sort((a, b) => a.instant - b.instant);
}
type RentalPreviewRow = { transaction_id: string; merchant: string; date: string; amount: number; currency: string; account: string; treatment: string; category: string; reference: string };
type UserMemory = { key: string; summary: string; kind: "goal" | "decision" | "completed_change"; effectiveFrom?: string; effectiveUntil?: string };

const suggestions = [
  "How is our cash flow this month?",
  "Create a $500 monthly dining budget",
  "How are we tracking against our budgets?",
  "Set up a weekly spending and budget report",
  "Help me follow through on a current financial issue",
];
const ASK_FOLIO_CONFIRMATION_TIMEOUT_MS = 90_000;

function SparkChatIcon({ size = 24 }: { size?: number }) {
  return <svg
    className="spark-chat-icon"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      className="spark-chat-bubble"
      d="M8 4.25h8.3A4.7 4.7 0 0 1 21 8.95v4.3a4.7 4.7 0 0 1-4.7 4.7H11l-5.7 3.25v-5.55A4.7 4.7 0 0 1 3 12V8.95a4.7 4.7 0 0 1 5-4.7Z"
    />
    <path
      className="spark-chat-sparkle"
      d="M12 7.55c.4 1.98 1.6 3.18 3.58 3.58-1.98.4-3.18 1.6-3.58 3.58-.4-1.98-1.6-3.18-3.58-3.58 1.98-.4 3.18-1.6 3.58-3.58Z"
    />
  </svg>;
}

function rentalPreviewFor(action: PendingAction): { rows: RentalPreviewRow[]; total_count: number } | null {
  const preview = action.rentalPreview;
  if (preview && Array.isArray(preview.rows) && preview.rows.every(row => row && typeof row.transaction_id === "string" && typeof row.merchant === "string" && typeof row.date === "string" && Number.isFinite(Number(row.amount)))) return preview;
  const envelope = action.args?._folio_rental_confirmation as { expected?: unknown } | undefined;
  if (!Array.isArray(envelope?.expected) || envelope.expected.length < 1) return null;
  const treatmentLabels: Record<string, string> = { rental_income: "Rental income", operating_expense: "Operating expense", capital_improvement: "Capital improvement", mortgage_principal: "Mortgage principal", mortgage_payment: "Mortgage payment — split required", transfer: "Transfer", owner_contribution: "Owner contribution", owner_draw: "Owner draw", personal_exclude: "Personal / exclude" };
  const rows = envelope.expected.flatMap((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.transaction_id !== "string" || typeof item.merchant !== "string" || typeof item.date !== "string" || !Number.isFinite(Number(item.amount)) || typeof item.treatment !== "string" || typeof item.category !== "string") return [];
    return [{ transaction_id: item.transaction_id, merchant: item.merchant, date: item.date, amount: Math.abs(Number(item.amount)), currency: "USD", account: "Selected rental account", treatment: treatmentLabels[item.treatment] || item.treatment, category: item.category.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase()), reference: typeof item.reference === "string" && item.reference.trim() ? item.reference : item.merchant }];
  });
  return rows.length === envelope.expected.length ? { rows, total_count: rows.length } : null;
}

function rentalDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date) : value;
}

function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function rentalAmount(value: number, currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD" }).format(Math.abs(value)); }
  catch { return `${currency} ${Math.abs(value).toFixed(2)}`; }
}

const assistantWatchCheckLabels: Record<string, string> = {
  reminder: "Reminder",
  cash_flow: "Cash-flow check",
  budget: "Budget check",
  recurring: "Recurring-payment check",
  account_health: "Account-connection check",
};

function deviceNotificationPermission() {
  if (typeof Notification === "undefined") return "not available in this browser";
  return Notification.permission === "default" ? "not granted" : Notification.permission;
}
function commitmentOutcomeLabel(value: AssistantCommitment["last_outcome"]) {
  if (!value) return "Not checked yet";
  return ({ worsened: "Worsened", unchanged: "No material change", improved: "Improved", data_unavailable: "Couldn’t verify current data" } as Record<string, string>)[value] || assistantWatchOutcomeLabel(value);
}
function assistantStateLabel(status: AssistantWatch["status"]) {
  return status === "active" ? "Active" : status === "snoozed" ? "Paused" : status === "draft" ? "Draft" : "Completed";
}
function assistantEndConditionLabel(value: AssistantCommitment["end_condition"]) {
  return ({ one_check: "One check", verified_payday: "Until payday is verified", budget_period_end: "Through the end of this budget period", issue_resolved: "Until the issue is resolved" } as Record<string, string>)[value.kind] || "As reviewed";
}
function commitmentRuleDescription(value: AssistantCommitment["condition"], baseline?: AssistantCommitment["baseline"]) {
  const comparator = value.comparator;
  if (value.metric === "cash_buffer") {
    const baselineValue = baseline?.metric === "cash_buffer" ? ` of the absolute accepted forecast-low amount (${formatAssistantMinorAmount(Math.abs(baseline.value_minor), baseline.currency)})` : " of the absolute accepted forecast-low amount";
    return `Only notify if the ${comparator.horizon_days}-day forecast low crosses below the ${formatAssistantMinorAmount(comparator.floor_minor, "USD")} floor, declines by at least the greater of ${formatAssistantMinorAmount(comparator.min_decline_minor, "USD")} and ${comparator.relative_percent}%${baselineValue}, or the low date moves at least ${comparator.earlier_low_date_days} days earlier. Scope: ${comparator.account_scope}. After a delivered alert, later decline/date comparisons re-anchor to the absolute delivered forecast-low amount and date; issue identity and scope stay bound to this reviewed baseline.`;
  }
  return `Only notify if projected overage for ${value.category_name} increases by at least the greater of ${formatAssistantMinorAmount(comparator.min_increase_minor, "USD")} and ${comparator.relative_percent}% of the budget target (${formatAssistantMinorAmount(comparator.target_minor, "USD")}) in ${comparator.budget_month}.`;
}
function commitmentPeriodDescription(value: AssistantCommitment["baseline"]["period"]) {
  return value.kind === "forecast"
    ? `Forecast low ${formatAssistantDate(value.low_date)} · ${value.horizon_days}-day horizon · ${value.account_scope}`
    : `${value.category_name} · ${value.month} budget period · target ${formatAssistantMinorAmount(value.target_minor, "USD")}`;
}
function taskScheduleLabel(task: AssistantState["scheduled_tasks"][number]) {
  const weekday = task.weekday === null ? "" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][task.weekday] || "";
  return `${task.cadence === "weekly" ? `Every ${weekday}` : "Daily"} at ${formatAssistantClock(task.local_time)} ${task.timezone}`;
}
function isDecisionReceipt(value: unknown): value is AssistantDecisionReceipt {
  if (!isRecord(value)) return false;
  return typeof value.receipt_id === "string" && typeof value.proposal_id === "string" && typeof value.message_id === "string" &&
    ["applied", "declined", "failed", "unknown"].includes(String(value.outcome)) &&
    (value.evidence_kind === null || ["agent_action", "assistant_watch", "assistant_task", "assistant_memory", "signed_server_result"].includes(String(value.evidence_kind))) &&
    (value.evidence_id === null || typeof value.evidence_id === "string") &&
    (value.verified_at === null || typeof value.verified_at === "string") && typeof value.created_at === "string" && typeof value.updated_at === "string";
}
function persistedDecisionReceipt(value: unknown): AssistantDecisionReceipt | null {
  if (isDecisionReceipt(value)) return value;
  if (isRecord(value) && value.saved === true && isDecisionReceipt(value.receipt)) return value.receipt;
  return null;
}
function decisionOutcomeLabel(value: AssistantDecisionReceipt["outcome"]) {
  return ({ applied: "Applied", declined: "Declined", failed: "Not completed", unknown: "Outcome not verified" } as Record<string, string>)[value];
}

function AssistantWatchReviewCard({ preview }: { preview: AssistantWatchPreview }) {
  const schedule = preview.schedule;
  const scheduleLabel = schedule ? `${formatAssistantDate(schedule.local_date)} at ${formatAssistantClock(schedule.local_time)} ${schedule.timezone} (${formatAssistantOffset(schedule.utc_offset_minutes)})` : null;
  const expiryLabel = preview.expires_at ? formatAssistantInstant(preview.expires_at, schedule?.timezone || "UTC") : null;
  const refund = preview.refund;
  const originalAmount = refund ? formatAssistantMinorAmount(refund.original_amount_minor, refund.currency) : null;
  const expectedAmount = refund ? formatAssistantMinorAmount(refund.expected_amount_minor, refund.currency) : null;
  const receivedAmount = refund ? formatAssistantMinorAmount(refund.baseline_received_minor, refund.currency) : null;
  const remainingAmount = refund ? formatAssistantMinorAmount(refund.expected_amount_minor - refund.baseline_received_minor, refund.currency) : null;

  const title = preview.template === "one_time_follow_up" ? "One-time follow-up" : preview.template === "expected_refund" ? "Expected refund watch" : "Bounded Folio watch";
  return <section className="ask-folio-watch-review" aria-label="Review Folio watch">
    <div className="ask-folio-watch-review-title"><strong>{title}</strong>{preview.delivery && <span>{preview.delivery === "chat_and_push" ? "Chat + push requested" : "Chat only"}</span>}</div>
    {(preview.template !== "one_time_follow_up" && preview.template !== "expected_refund") && <div className="ask-folio-watch-review-detail">
      <span><strong>Watch</strong>{preview.label}{preview.category_name ? ` · ${preview.category_name}` : ""}</span>
      {preview.expires_at && <span><strong>Expires</strong>{expiryLabel || "Not available"}</span>}
    </div>}
    {preview.template === "one_time_follow_up" && preview.follow_up && <div className="ask-folio-watch-review-detail">
      <span><strong>What Folio will check</strong>{assistantWatchCheckLabels[preview.follow_up.check] || "Follow-up"}{preview.follow_up.category_name ? ` · ${preview.follow_up.category_name}` : ""}</span>
      {preview.follow_up.reminder_text && <span><strong>Reminder text</strong>{preview.follow_up.reminder_text}<small>Saved as an inert reminder, not an instruction to take action.</small></span>}
      {scheduleLabel && <span><strong>Due</strong>{scheduleLabel}<small>Folio starts the check at or shortly after this time.</small></span>}
      <span><strong>Catch-up window ends</strong>{expiryLabel || "Not available"}</span>
    </div>}
    {preview.template === "expected_refund" && refund && <div className="ask-folio-watch-review-detail">
      <span><strong>Original purchase</strong>{refund.original_merchant} · {formatAssistantDate(refund.original_date)} · {originalAmount || "Amount unavailable"}</span>
      {scheduleLabel && <span><strong>Expected by</strong>{scheduleLabel}<small>Folio watches for verified posted refunds after activation and continues checking at or after this deadline.</small></span>}
      <span><strong>Expected total refund</strong>{expectedAmount || "Amount unavailable"}</span>
      <span><strong>Already verified at setup</strong>{receivedAmount || "Amount unavailable"}</span>
      <span><strong>Remaining to verify</strong>{remainingAmount || "Amount unavailable"}</span>
      <span><strong>Checks begin</strong>After this watch is confirmed. Folio will keep checking through the catch-up window.</span>
      <span><strong>Catch-up window ends</strong>{expiryLabel || "Not available"}</span>
    </div>}
    <p className="ask-folio-watch-timing">{preview.timing_note}</p>
    {preview.delivery === "chat_and_push" && !preview.push_available && <p className="ask-folio-watch-push-note">Chat will still be saved. This device is not currently enabled for push; this will not request permission or enable notifications.</p>}
    {preview.delivery === "chat_and_push" && preview.push_available && <p className="ask-folio-watch-push-note">Push may be sent to an enabled device. Delivery time is not guaranteed, and this does not change device permissions or notification settings.</p>}
  </section>;
}

function AssistantWatchStateReviewCard({ preview, defaultTimezone }: { preview: AssistantWatchStatePreview; defaultTimezone: string }) {
  const timezone = preview.timezone || defaultTimezone;
  const current = preview.status === "active" ? "Active" : preview.status === "snoozed" ? "Paused" : "Completed";
  const proposed = preview.proposed_status === "active" ? "Active" : preview.proposed_status === "snoozed" ? "Paused" : "Stopped";
  const next = preview.next_check_at ? formatAssistantInstant(preview.next_check_at, timezone) : "No next check scheduled";
  const snooze = preview.snoozed_until ? formatAssistantInstant(preview.snoozed_until, timezone) : null;
  return <section className="ask-folio-watch-review ask-folio-watch-state-review" aria-label="Review watch status change">
    <div className="ask-folio-watch-review-title"><strong>{preview.label}</strong><span>{preview.template.replaceAll("_", " ")}</span></div>
    <div className="ask-folio-watch-review-detail">
      <span><strong>Status</strong>{current} → {proposed}</span>
      <span><strong>Current next check</strong>{next}</span>
      {snooze && <span><strong>Pause until</strong>{snooze}</span>}
      <span><strong>Time zone</strong>{timezone}</span>
      <span><strong>Review expires</strong>{formatAssistantInstant(preview.review_expires_at, timezone) || "Unavailable"}</span>
    </div>
    <p className="ask-folio-watch-timing">Nothing changes until you confirm this exact status review.</p>
  </section>;
}

function AssistantCommitmentReviewCard({ preview, sourceMessage, summary, pushPreference, permission }: { preview: AssistantCommitmentPreview; sourceMessage?: string; summary: string; pushPreference: boolean; permission: string }) {
  const zone = "timezone" in preview.schedule ? preview.schedule.timezone
    : preview.end_condition.kind === "verified_payday" ? preview.end_condition.timezone
      : preview.baseline.metric === "category_budget" ? preview.baseline.period.timezone : "UTC";
  const due = "timezone" in preview.schedule ? `${formatAssistantDate(preview.schedule.local_date)} at ${formatAssistantClock(preview.schedule.local_time)} ${zone} (${formatAssistantOffset(preview.schedule.utc_offset_minutes)})` : "When verified Folio data changes";
  const baseline = formatAssistantMinorAmount(preview.baseline.value_minor, preview.baseline.currency);
  const reference = formatAssistantMinorAmount(preview.baseline.reference_minor, preview.baseline.currency);
  const expires = preview.expires_at ? formatAssistantInstant(preview.expires_at, zone) : "No separate expiry";
  const reviewExpires = preview.review_expires_at ? formatAssistantInstant(preview.review_expires_at, zone) : null;
  return <section className="ask-folio-watch-review ask-folio-commitment-review" aria-label="Review conditional issue follow-up">
    <div className="ask-folio-watch-review-title"><strong>Issue-bound follow-up</strong><span>{preview.delivery === "chat_and_push" ? "Chat + push requested" : "Chat only"}</span></div>
    <div className="ask-folio-watch-review-detail">
      <span><strong>Same issue</strong>{sourceMessage ? `“${sourceMessage.slice(0, 240)}${sourceMessage.length > 240 ? "…" : ""}”` : preview.label}{preview.acknowledge_origin?.will_resolve ? <small>Confirming this review will mark this exact issue as expected and activate the follow-up together.</small> : null}</span>
      <span><strong>Server-verified review</strong>{summary}</span>
      <span><strong>Accepted baseline</strong>{baseline} · captured {formatAssistantInstant(preview.baseline.captured_at, zone) || "time unavailable"}<small>{commitmentPeriodDescription(preview.baseline.period)} · reference {reference}</small></span>
      <span><strong>Worsening rule</strong>{commitmentRuleDescription(preview.condition, preview.baseline)}</span>
      <span><strong>Check time</strong>{due}</span>
      <span><strong>Stop condition</strong>{assistantEndConditionLabel(preview.end_condition)}{preview.end_condition.kind === "verified_payday" ? <small>Expected {formatAssistantDate(preview.end_condition.expected_date)} in {preview.end_condition.timezone}. This check closes only after exact posted income evidence matches the selected source named above and this date.</small> : preview.end_condition.kind === "budget_period_end" ? <small>Uses the canonical budget period time zone: {zone}.</small> : null}</span>
      <span><strong>Expiry</strong>{expires}</span>
      <span><strong>Delivery</strong>{preview.delivery === "chat_and_push" ? `Push uses existing Folio settings only. Folio push is ${pushPreference ? "on" : "off"}; this browser permission is ${permission}.` : "Saved to private chat only; push is not requested."}<small>This review never requests browser permission or enrolls a device.</small></span>
      {reviewExpires && <span><strong>Review valid until</strong>{reviewExpires}</span>}
    </div>
    {preview.delivery === "chat_and_push" && !preview.push_available && <p className="ask-folio-watch-push-note">No enabled push device is currently available. Folio will still save the result in chat.</p>}
  </section>;
}

function AssistantTaskReviewCard({ preview, pushPreference, permission }: { preview: AssistantTaskPreview; pushPreference: boolean; permission: string }) {
  const weekday = preview.weekday === null ? "" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][preview.weekday] || "";
  const schedule = `${preview.cadence === "weekly" ? `Every ${weekday}` : "Daily"} at ${formatAssistantClock(preview.local_time)} ${preview.timezone}`;
  const next = preview.next_run_at ? formatAssistantInstant(preview.next_run_at, preview.timezone) : "Not scheduled";
  return <section className="ask-folio-watch-review ask-folio-task-review" aria-label="Review scheduled task">
    <div className="ask-folio-watch-review-title"><strong>Recurring Folio task</strong><span>{preview.delivery === "chat_and_push" ? "Chat + push requested" : "Chat only"}</span></div>
    <div className="ask-folio-watch-review-detail">
      <span><strong>Instruction</strong>{preview.instruction}</span>
      <span><strong>Schedule</strong>{schedule}</span>
      <span><strong>Next run</strong>{next}</span>
      <span><strong>Delivery</strong>{preview.delivery === "chat_and_push" ? `Push uses existing Folio settings only. Folio push is ${pushPreference ? "on" : "off"}; this browser permission is ${permission}.` : "Saved to private chat only; push is not requested."}<small>This review never requests browser permission or enrolls a device.</small></span>
    </div>
    {preview.delivery === "chat_and_push" && !preview.push_available && <p className="ask-folio-watch-push-note">No enabled push device is currently available. The report will still be saved in chat.</p>}
  </section>;
}

function AssistantMemoryReviewCard({ memory }: { memory: AssistantMemoryReview }) {
  const topic = memory.key.replace(/[_:-]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
  const window = memory.effectiveFrom && memory.effectiveUntil ? `From ${memory.effectiveFrom} through ${memory.effectiveUntil}`
    : memory.effectiveFrom ? `From ${memory.effectiveFrom}; no end date was supplied`
      : memory.effectiveUntil ? `Through ${memory.effectiveUntil}`
        : "No effective dates supplied; this stays until you update or remove it";
  return <section className="ask-folio-watch-review ask-folio-memory-review" aria-label="Review personal memory">
    <div className="ask-folio-watch-review-title"><strong>{memory.kind === "goal" ? "Personal goal" : "Financial decision"}</strong><span>Private to your account</span></div>
    <div className="ask-folio-watch-review-detail"><span><strong>Topic</strong>{topic} <small>Saved under {memory.key}</small></span><span><strong>What Folio will remember</strong>{memory.summary}</span><span><strong>Effective window</strong>{window}</span></div>
    <p className="ask-folio-watch-timing">Nothing is saved until you confirm. A dated end stays part of the saved context.</p>
  </section>;
}

function AssistantWatchOutcomeCard({ watch, onReviewRefund }: { watch: AssistantWatch; onReviewRefund?: (transactionId: string) => void }) {
  const scheduleZone = watch.schedule?.timezone || "UTC";
  const checked = watch.last_checked_at ? formatAssistantInstant(watch.last_checked_at, scheduleZone) : null;
  const nextCheck = watch.next_check_at ? formatAssistantInstant(watch.next_check_at, scheduleZone) : null;
  const originalId = watch.template === "expected_refund" ? watch.refund?.original_transaction_id : undefined;
  const canReviewRefund = watch.template === "expected_refund" && watch.last_outcome === "needs_review" && isAssistantTransactionId(originalId);
  return <div className="ask-folio-watch-outcome" role="status">
    <strong>{watch.label}: {assistantWatchOutcomeLabel(watch.last_outcome)}</strong>
    {checked && <small>Last checked {checked}</small>}
    {nextCheck && <small>Next check {nextCheck}</small>}
    {canReviewRefund && onReviewRefund && <button type="button" onClick={() => onReviewRefund(originalId!)}>Review refund</button>}
  </div>;
}

function inlineMarkdown(value: string, onOpenGoal?: (goalId: string, activityId?: string) => void): ReactNode[] {
  const tokens = value.split(/(\[\[folio-goal:[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, index) => {
    const goalLink = /^\[\[folio-goal:([0-9a-f-]{36})(?::([0-9a-f-]{36}))?\|([^\]]+)\]\]$/i.exec(token);
    if (goalLink) return onOpenGoal
      ? <button className="ask-folio-goal-link" type="button" key={index} onClick={() => onOpenGoal(goalLink[1], goalLink[2])}>{goalLink[3]}</button>
      : <Fragment key={index}>{goalLink[3]}</Fragment>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    return <Fragment key={index}>{token}</Fragment>;
  });
}

function tableCells(row: string) {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function isTableDivider(row: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(row);
}

function AssistantMarkdown({ content, onOpenGoal }: { content: string; onOpenGoal?: (goalId: string, activityId?: string) => void }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(tableCells(lines[index++]));
      blocks.push(<div className="ask-folio-table-wrap" key={`table-${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell,onOpenGoal)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] || "",onOpenGoal)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const Tag = (`h${heading[1].length}` as "h1" | "h2" | "h3");
      blocks.push(<Tag key={`heading-${index}`}>{inlineMarkdown(heading[2],onOpenGoal)}</Tag>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*]\s+/, ""));
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item,onOpenGoal)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+[.)]\s+/, ""));
      blocks.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item,onOpenGoal)}</li>)}</ol>);
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push(<blockquote key={`quote-${index}`}>{inlineMarkdown(line.slice(2),onOpenGoal)}</blockquote>);
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].startsWith("```") && !/^(#{1,3})\s+|^[-*]\s+|^\d+[.)]\s+|^> /.test(lines[index]) && !(lines[index].includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1]))) paragraph.push(lines[index++]);
    blocks.push(<p key={`paragraph-${index}`}>{paragraph.map((part, partIndex) => <Fragment key={partIndex}>{partIndex > 0 && <br />}{inlineMarkdown(part,onOpenGoal)}</Fragment>)}</p>);
  }
  return <div className="ask-folio-markdown">{blocks}</div>;
}

export function AskFolioPanel({ accessToken, userId, memories, onSaveMemory, onAdoptCanonicalMemories, onOpenGoal, onOpenEvent, onOpenTransaction, initialMessageId, onAssistantMessageHandled, folio2 = false }: { accessToken: string; userId: string; memories: Array<UserMemory & { id: string; createdAt: string }>; onSaveMemory: (memory: UserMemory, canonicalMemories: Array<UserMemory & { id: string; createdAt: string }>) => Promise<boolean>; onAdoptCanonicalMemories?: (canonicalMemories: unknown) => Promise<boolean>; onOpenGoal?: (goalId: string, activityId?: string) => void; onOpenEvent?: (eventId: string) => void; onOpenTransaction?: (transactionId: string) => void; initialMessageId?: string | null; onAssistantMessageHandled?: (available: boolean) => void; folio2?: boolean }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [deviceMessages, setDeviceMessages] = useState<Message[]>([]);
  const [deviceOwnerId, setDeviceOwnerId] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState<"cloud" | "device">("cloud");
  const [assistantState, setAssistantState] = useState<AssistantState | null>(null);
  const [assistantOwnerId, setAssistantOwnerId] = useState<string | null>(null);
  const [assistantLoadStatus, setAssistantLoadStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [assistantNotice, setAssistantNotice] = useState("");
  const [managementNotice, setManagementNotice] = useState("");
  const [managementBusyId, setManagementBusyId] = useState("");
  const [lifecycleBusyMessageId, setLifecycleBusyMessageId] = useState("");
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [replyTargetMessageId, setReplyTargetMessageId] = useState<string | null>(null);
  const [selectedTaskContext, setSelectedTaskContext] = useState<SelectedTaskContext | null>(null);
  const [watchPauseForm, setWatchPauseForm] = useState<WatchPauseForm | null>(null);
  const [commitmentsOpen, setCommitmentsOpen] = useState(false);
  const [messageVisibilityPulse, setMessageVisibilityPulse] = useState(0);
  const [showLatest, setShowLatest] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [needsAskReconciliation, setNeedsAskReconciliation] = useState(false);
  const assistantLoadGeneration = useRef(0);
  const assistantLoadAbort = useRef<AbortController | null>(null);
  const readMessageIds = useRef(new Set<string>());
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [waitingOnAction, setWaitingOnAction] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const currentUserId = useRef(userId);
  useLayoutEffect(() => { currentUserId.current = userId; }, [userId]);
  const handledTarget = useRef<string | null>(null);
  const freshActionsByMessage = useRef(new Map<string, PendingAction[]>());
  const completedActionMessageIds = useRef(new Set<string>());
  const askAbort = useRef<AbortController | null>(null);
  const askTimeout = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const headerMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const managementBackRef = useRef<HTMLButtonElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollTop = useRef(0);
  const messagesNearBottom = useRef(true);
  const conversationGeneration = useRef(0);
  const wasOpen = useRef(false);
  const activeBusyToken = useRef<symbol | null>(null);
  const confirmationInFlight = useRef(new Set<string>());
  const unknownConfirmationIds = useRef(new Set<string>());
  const decisionErrors = useRef(new Map<string, string>());
  const visibleMessages = historyMode === "cloud" ? assistantOwnerId === userId ? messages : [] : deviceOwnerId === userId ? messages : [];
  const decisionReceiptsUnavailable = historyMode === "cloud" && assistantOwnerId === userId && assistantState?.management_unavailable?.includes("decision_receipts") === true;
  const hasUnknownConfirmation = visibleMessages.some(message => message.operationStatus === "outcome_unknown");
  const hasUnresolvedAsk = needsAskReconciliation || visibleMessages.some(message => message.role === "user" && message.savedState === "unknown");
  useEffect(() => {
    unknownConfirmationIds.current = new Set(messages.filter(message => message.operationStatus === "outcome_unknown").map(message => message.id));
  }, [messages]);
  const cancelAsk = useCallback(() => {
    const controller = askAbort.current;
    if (!controller) return;
    askAbort.current = null;
    if (askTimeout.current !== null) { window.clearTimeout(askTimeout.current); askTimeout.current = null; }
    conversationGeneration.current += 1;
    activeBusyToken.current = null;
    controller.abort(new DOMException("Ask Folio response canceled.", "AbortError"));
    setMessages(current => current.map(message => message.requestId && message.savedState === "pending" ? { ...message, savedState: "unknown" } : message));
    setNeedsAskReconciliation(true);
    setAssistantNotice("Stopped waiting. Refresh to confirm whether this question was saved before retrying.");
    setAsking(false);
    setLoading(false);
  }, []);
  const closePanel = useCallback(() => {
    if (asking) cancelAsk();
    assistantLoadGeneration.current += 1;
    assistantLoadAbort.current?.abort();
    assistantLoadAbort.current = null;
    freshActionsByMessage.current.clear();
    completedActionMessageIds.current.clear();
    setHeaderMenuOpen(false);
    setCommitmentsOpen(false);
    setReplyTargetMessageId(null);
    setSelectedTaskContext(null);
    setShowLatest(false);
    setTargetMessageId(null);
    setOpen(false);
  }, [asking, cancelAsk]);
  const attachMessages = useCallback((element: HTMLDivElement | null) => {
    messagesRef.current = element;
    if (!element || !open || wasOpen.current) return;
    if (messages.length > 0 && !targetMessageId) scrollAskFolioToLatest(element);
    messagesScrollTop.current = element.scrollTop;
    messagesNearBottom.current = true;
    setShowLatest(false);
    wasOpen.current = true;
  }, [open, messages.length, targetMessageId]);
  const storageKey = askFolioStorageKey(userId);
  const pendingConfirmation = historyMode === "cloud" && visibleMessages.some(message => !message.operationStatus && (message.pendingActions?.length ?? (message.pendingAction ? 1 : 0)) > 0);
  const useCompactSheet = folio2 && !pendingConfirmation;

  useEffect(() => {
    if (!headerMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) setHeaderMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [headerMenuOpen]);

  useEffect(() => { if (commitmentsOpen) managementBackRef.current?.focus(); }, [commitmentsOpen]);
  useEffect(() => { if (!commitmentsOpen) setWatchPauseForm(null); }, [commitmentsOpen]);

  useEffect(() => {
    conversationGeneration.current += 1;
    assistantLoadGeneration.current += 1;
    assistantLoadAbort.current?.abort();
    assistantLoadAbort.current = null;
    activeBusyToken.current = null;
    askAbort.current?.abort();
    askAbort.current = null;
    if (askTimeout.current !== null) { window.clearTimeout(askTimeout.current); askTimeout.current = null; }
    freshActionsByMessage.current.clear();
    completedActionMessageIds.current.clear();
    unknownConfirmationIds.current.clear();
    decisionErrors.current.clear();
    readMessageIds.current.clear();
    let savedMessages: Message[] = [];
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) savedMessages = parsed.slice(-40);
      }
    } catch {
      // A private-browsing storage failure should not block chat.
    }
    queueMicrotask(() => {
      if (currentUserId.current !== userId) return;
      setAssistantState(null);
      setAssistantOwnerId(null);
      setDeviceOwnerId(userId);
      setAssistantLoadStatus("loading");
      setAssistantNotice("");
      setManagementNotice("");
      setCommitmentsOpen(false);
      setReplyTargetMessageId(null);
      setSelectedTaskContext(null);
      setHeaderMenuOpen(false);
      setShowLatest(false);
      setNeedsAskReconciliation(false);
      setHistoryMode("cloud");
      setMessages([]);
      setDeviceMessages(savedMessages);
      setDraft("");
      setLoading(false);
      setAsking(false);
      setWaitingOnAction(false);
    });
    return () => askAbort.current?.abort();
  }, [storageKey, userId]);

  const refreshAssistantState = useCallback(async (messageId?: string) => {
    const requestUserId = userId;
    const generation = ++assistantLoadGeneration.current;
    assistantLoadAbort.current?.abort();
    const controller = new AbortController();
    assistantLoadAbort.current = controller;
    setAssistantLoadStatus("loading");
    try {
      const state = await loadFolioAssistantState(accessToken, messageId, controller.signal);
      if (controller.signal.aborted || currentUserId.current !== requestUserId || generation !== assistantLoadGeneration.current) return null;
      const decisionReceiptsUnavailable = state.management_unavailable?.includes("decision_receipts") === true;
      for (const row of state.messages) {
        const pendingError = decisionErrors.current.get(row.message_id);
        if (pendingError && row.decision_receipts?.some(receipt => receipt.outcome !== "unknown")) {
          decisionErrors.current.delete(row.message_id);
          unknownConfirmationIds.current.delete(row.message_id);
        }
      }
      setAssistantState(state);
      setAssistantOwnerId(requestUserId);
      setAssistantLoadStatus("ready");
      setAssistantNotice(state.unavailable ? "This message is not available in this conversation." : "");
      const chronologicalMessages = [...state.messages].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id));
      setMessages(chronologicalMessages.map(row => {
        const hasDecisionReceipt = Boolean(row.decision_receipts?.length);
        const message = assistantMessageForView(row, hasDecisionReceipt || completedActionMessageIds.current.has(row.message_id) || decisionReceiptsUnavailable ? undefined : freshActionsByMessage.current.get(row.message_id));
        message.decisionError = decisionErrors.current.get(row.message_id);
        if (completedActionMessageIds.current.has(row.message_id)) message.operationStatus = "completed";
        if (unknownConfirmationIds.current.has(row.message_id)) message.operationStatus = "outcome_unknown";
        return message;
      }));
      if (messageId && !state.messages.some(row => row.message_id === messageId)) {
        setAssistantNotice("This message isn’t available for this account or may have expired.");
      }
      return { ...state, messages: chronologicalMessages };
    } catch (error) {
      if (controller.signal.aborted || currentUserId.current !== requestUserId || generation !== assistantLoadGeneration.current) return null;
      setAssistantLoadStatus("offline");
      setAssistantNotice(error instanceof Error ? error.message : "Folio Assistant is unavailable right now.");
      return null;
    } finally {
      if (assistantLoadAbort.current === controller) assistantLoadAbort.current = null;
    }
  }, [accessToken, userId]);

  async function loadOlderAssistantMessages() {
    const cursor = assistantState?.next_cursor;
    if (!cursor || loadingOlder || historyMode !== "cloud") return;
    const requestUserId = userId;
    const generation = assistantLoadGeneration.current;
    const root = messagesRef.current;
    const oldHeight = root?.scrollHeight || 0;
    const oldTop = root?.scrollTop || 0;
    setLoadingOlder(true);
    setAssistantNotice("");
    try {
      const raw = await folioAssistantRequest(accessToken, "get_assistant_state", { cursor, limit: 40 });
      const page = parseAssistantState(raw);
      if (currentUserId.current !== requestUserId || generation !== assistantLoadGeneration.current || !page) return;
      const current = assistantState;
      const decisionReceiptsUnavailable = page.management_unavailable?.includes("decision_receipts") === true || current?.management_unavailable?.includes("decision_receipts") === true;
      const byId = new Map([...(current?.messages || []), ...page.messages].map(message => [message.message_id, message]));
      const combinedMessages = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id));
      setAssistantState(current ? { ...current, ...page, messages: combinedMessages } : page);
      setMessages(combinedMessages.map(row => {
        const message = assistantMessageForView(row, completedActionMessageIds.current.has(row.message_id) || decisionReceiptsUnavailable ? undefined : freshActionsByMessage.current.get(row.message_id));
        if (completedActionMessageIds.current.has(row.message_id)) message.operationStatus = "completed";
        if (unknownConfirmationIds.current.has(row.message_id)) message.operationStatus = "outcome_unknown";
        return message;
      }));
      window.requestAnimationFrame(() => { if (root) root.scrollTop = oldTop + Math.max(0, root.scrollHeight - oldHeight); });
    } catch (error) {
      if (currentUserId.current === requestUserId && generation === assistantLoadGeneration.current) setAssistantNotice(error instanceof Error ? error.message : "Couldn’t load older messages. Refresh and try again.");
    } finally { setLoadingOlder(false); }
  }

  async function reconcileInterruptedReply(messageId: string) {
    if (!isFolioAssistantMessageId(messageId)) return;
    setAssistantNotice("Checking the saved reply status before retrying…");
    const state = await refreshAssistantState(messageId);
    if (!state) return;
    const reply = state.messages.find(message => message.message_id === messageId);
    if (!reply || !["interrupted", "failed"].includes(reply.generation_status)) {
      setAssistantNotice(reply?.generation_status === "pending" ? "Folio is still finishing this saved reply. No retry was started." : "This reply is no longer interrupted, so no retry was started.");
      return;
    }
    const question = reply.reply_to_message_id
      ? state.messages.find(message => message.message_id === reply.reply_to_message_id)?.content || messages.find(message => message.id === reply.reply_to_message_id)?.content
      : state.messages.find(message => message.role === "user" && message.request_id === reply.request_id)?.content;
    if (!question) {
      setAssistantNotice("The original question isn’t available here. You can ask a fresh question instead.");
      return;
    }
    setAssistantNotice("The saved reply is interrupted. Starting a fresh request now; no old proposal or action will be reused.");
    await ask(question);
  }

  useEffect(() => {
    if (initialMessageId && isFolioAssistantMessageId(initialMessageId)) {
      queueMicrotask(() => {
        if (!isFolioAssistantMessageId(initialMessageId)) return;
        handledTarget.current = null;
        setReplyTargetMessageId(null);
        setCommitmentsOpen(false);
        setTargetMessageId(initialMessageId);
        setHistoryMode("cloud");
        setOpen(true);
      });
    }
  }, [initialMessageId, userId]);

  useEffect(() => {
    if (historyMode !== "cloud") return;
    const timer = window.setTimeout(() => {
      void refreshAssistantState(targetMessageId || undefined).then(state => {
        if (!state || !targetMessageId || handledTarget.current === targetMessageId) return;
        handledTarget.current = targetMessageId;
        onAssistantMessageHandled?.(state.messages.some(row => row.message_id === targetMessageId) && state.unavailable !== true);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [historyMode, targetMessageId, refreshAssistantState, onAssistantMessageHandled]);

  useEffect(() => {
    if (historyMode !== "cloud") return;
    const refresh = () => { void refreshAssistantState(targetMessageId || undefined); };
    window.addEventListener("folio-agent-updated", refresh);
    return () => window.removeEventListener("folio-agent-updated", refresh);
  }, [historyMode, targetMessageId, refreshAssistantState]);

  useEffect(() => {
    if (!open || historyMode !== "cloud" || loading || typeof document === "undefined") return;
    let timer: number | null = null;
    let inFlight = false;
    let stopped = false;
    const clearTimer = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };
    const schedule = () => {
      clearTimer();
      if (!stopped && document.visibilityState === "visible") timer = window.setTimeout(() => { void poll(); }, 60_000);
    };
    const poll = async () => {
      clearTimer();
      if (stopped || inFlight || document.visibilityState !== "visible" || currentUserId.current !== userId) return;
      inFlight = true;
      try { await refreshAssistantState(targetMessageId || undefined); }
      finally { inFlight = false; schedule(); }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") { clearTimer(); assistantLoadAbort.current?.abort(); }
      else void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => { stopped = true; clearTimer(); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [open, historyMode, loading, userId, targetMessageId, refreshAssistantState]);

  useEffect(() => {
    if (!open || historyMode !== "cloud" || !targetMessageId) return;
    const element = messagesRef.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      const target = element.querySelector<HTMLElement>(`[data-assistant-message-id="${targetMessageId}"]`);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "auto" });
        target.classList.add("ask-folio-target-message");
        window.setTimeout(() => setMessageVisibilityPulse(value => value + 1), 80);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, historyMode, targetMessageId, messages]);

  useEffect(() => {
    if (!open || historyMode !== "cloud") return;
    const root = messagesRef.current;
    if (!root) return;
    for (const row of assistantState?.messages || []) {
      if (row.role !== "assistant" || row.read_at || readMessageIds.current.has(row.message_id)) continue;
      const node = root.querySelector<HTMLElement>(`[data-assistant-message-id="${row.message_id}"]`);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      readMessageIds.current.add(row.message_id);
      void folioAssistantRequest<{ message?: { read_at?: string } }>(accessToken, "mark_assistant_message_read", { message_id: row.message_id })
        .then(result => setAssistantState(current => current ? { ...current, messages: current.messages.map(message => message.message_id === row.message_id ? { ...message, read_at: result.message?.read_at || new Date().toISOString() } : message) } : current))
        .catch(() => readMessageIds.current.delete(row.message_id));
    }
  }, [open, historyMode, assistantState, messages, accessToken, messageVisibilityPulse]);

  useEffect(() => {
    if (!open || useCompactSheet) return;
    if (window.matchMedia("(min-width: 601px) and (pointer: fine)").matches) inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (commitmentsOpen) { event.preventDefault(); setCommitmentsOpen(false); return; }
        if (folio2 && loading && !asking) { event.preventDefault(); return; }
        closePanel();
      }
    };
    const backdrop = backdropRef.current;
    const syncViewport = () => {
      if (!backdrop) return;
      const viewport = window.visualViewport;
      const rect = askFolioViewportRect(viewport, window.innerHeight, document.documentElement.clientHeight);
      backdrop.style.setProperty("--ask-folio-panel-height", `${rect.height}px`);
      backdrop.style.setProperty("--ask-folio-panel-top", `${rect.top}px`);
      backdrop.dataset.keyboardOpen = String(rect.keyboardOpen);
    };
    const scrollY = window.scrollY;
    const previous = {
      htmlOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
      bodyTop: document.body.style.top,
      bodyWidth: document.body.style.width,
    };
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    syncViewport();
    window.addEventListener("keydown", closeOnEscape);
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.visualViewport?.removeEventListener("scroll", syncViewport);
      document.documentElement.style.overflow = previous.htmlOverflow;
      document.body.style.overflow = previous.bodyOverflow;
      document.body.style.position = previous.bodyPosition;
      document.body.style.top = previous.bodyTop;
      document.body.style.width = previous.bodyWidth;
      window.scrollTo(0, scrollY);
    };
  }, [open, folio2, useCompactSheet, loading, asking, pendingConfirmation, commitmentsOpen, closePanel]);

  useLayoutEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    const element = messagesRef.current;
    if (!element) return;
    if (!wasOpen.current) {
      if (messages.length > 0 && !targetMessageId) scrollAskFolioToLatest(element);
      messagesScrollTop.current = element.scrollTop;
      messagesNearBottom.current = true;
    } else element.scrollTop = messagesScrollTop.current;
    wasOpen.current = true;
    return () => { if (element) messagesScrollTop.current = element.scrollTop; };
  }, [open, useCompactSheet, messages.length, targetMessageId]);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) return;
    if (targetMessageId && historyMode === "cloud") return;
    if ((!folio2 || messagesNearBottom.current) && messages.length > 0) {
      messagesElement.scrollTo({ top: messagesElement.scrollHeight, behavior: loading ? "auto" : "smooth" });
      setShowLatest(false);
    }
  }, [messages, loading, open, folio2, targetMessageId, historyMode]);

  function scrollToLatest() {
    const element = messagesRef.current;
    if (!element) return;
    scrollAskFolioToLatest(element);
    messagesScrollTop.current = element.scrollTop;
    messagesNearBottom.current = true;
    setShowLatest(false);
  }

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  }, [draft, open]);

  async function ask(content: string, taskContextOverride?: SelectedTaskContext | null, watchContextOverride?: SelectedWatchContext | null, timeZoneOverride?: string) {
    const question = content.trim();
    if (!question || loading || assistantLoadStatus !== "ready" || historyMode !== "cloud" || hasUnresolvedAsk) return;
    const requestUserId = userId;
    const requestGeneration = conversationGeneration.current;
    const requestId = crypto.randomUUID();
    const savedMessages = assistantOwnerId === userId ? assistantState?.messages || [] : [];
    const requestTaskContext = taskContextOverride === undefined ? selectedTaskContext : taskContextOverride;
    const replyCandidate = replyTargetMessageId || targetMessageId;
    const replyToMessageId = replyCandidate && savedMessages.some(row => row.message_id === replyCandidate) ? replyCandidate : null;
    const controller = new AbortController();
    const busyToken = Symbol("ask-folio");
    activeBusyToken.current = busyToken;
    askAbort.current = controller;
    const optimisticUser: Message = { id: `request:${requestId}`, requestId, role: "user", content: question, savedState: "pending" };
    const requestTimeout = window.setTimeout(() => {
      if (currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
        conversationGeneration.current += 1;
        if (askAbort.current === controller) askAbort.current = null;
        if (askTimeout.current === requestTimeout) askTimeout.current = null;
        if (activeBusyToken.current === busyToken) activeBusyToken.current = null;
        setLoading(false);
        setAsking(false);
        setAssistantNotice("This reply took too long. Checking the saved conversation before suggesting a retry.");
        void refreshAssistantState().then(state => {
          if (!state?.messages.some(row => row.request_id === requestId)) {
            setMessages(current => [...current.filter(message => message.id !== optimisticUser.id), { ...optimisticUser, savedState: "unknown" }]);
            setAssistantNotice("Folio couldn’t confirm whether this message was saved. Refresh the conversation to reconcile before retrying.");
          }
        });
      }
      controller.abort(new Error("Ask Folio took too long to respond."));
    }, ASK_FOLIO_STREAM_TOTAL_TIMEOUT_MS);
    askTimeout.current = requestTimeout;
    setMessages(current => [...current, optimisticUser]);
    setDraft("");
    setLoading(true);
    setAsking(true);
    setAssistantNotice("");
    try {
      const response = await fetch("/api/ask-folio", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "x-folio-api-generation": process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || "1",
        },
        signal: controller.signal,
        body: JSON.stringify({ request_id: requestId, ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}), ...(requestTaskContext ? { assistant_task_context: { task_id: requestTaskContext.task_id, expected_version: requestTaskContext.expected_version, intent: requestTaskContext.intent } } : {}), ...(watchContextOverride ? { assistant_watch_context: watchContextOverride } : {}), question, timezone: timeZoneOverride || deviceTimezone(), memories: memories.map(({ key, summary, kind, createdAt, effectiveFrom, effectiveUntil }) => ({ key, summary, kind, createdAt, effectiveFrom, effectiveUntil })) }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(typeof data.error === "string" ? data.error : "Ask Folio could not answer right now.");
      }
      if (!response.body) throw new Error("Ask Folio returned an empty response.");
      if (response.headers.get("content-type")?.includes("application/json")) {
        const data = await response.json() as Record<string, unknown>;
        if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
        const pendingActions = Array.isArray(data.pendingActions) ? data.pendingActions.filter(isPendingAction) : data.pendingAction ? [data.pendingAction].filter(isPendingAction) : [];
        const assistantId = typeof data.assistant_message_id === "string" && isFolioAssistantMessageId(data.assistant_message_id) ? data.assistant_message_id : undefined;
        const userIdFromReply = typeof data.user_message_id === "string" && isFolioAssistantMessageId(data.user_message_id) ? data.user_message_id : undefined;
        if (assistantId && pendingActions.length) freshActionsByMessage.current.set(assistantId, pendingActions);
        const state = await refreshAssistantState(assistantId);
        if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
        if (!state?.messages.some(row => row.request_id === requestId)) {
          const answer = typeof data.answer === "string" ? data.answer : "Folio replied, but the saved conversation could not be confirmed.";
          setMessages(current => [...current.filter(message => message.id !== optimisticUser.id),
            { ...optimisticUser, id: userIdFromReply || optimisticUser.id, savedState: "unknown" },
            { id: assistantId || `reply:${requestId}`, role: "assistant", content: answer, savedState: "unknown", pendingActions }]);
          setAssistantNotice("Folio replied, but I couldn’t verify the saved conversation. Refresh before retrying or confirming any proposal.");
        } else {
          setReplyTargetMessageId(null);
          setSelectedTaskContext(null);
          setTargetMessageId(null);
        }
        return;
      }
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
      const streamId = `stream:${requestId}`;
      setMessages(current => [...current, { id: streamId, role: "assistant", content: "" }]);
      let answer = "";
      const finalData = await consumeAskFolioStream(response.body, (delta) => {
        answer += delta;
        if (currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) setMessages(current => current.map(message => message.id === streamId ? { ...message, content: answer } : message));
      }, () => {
        answer = "";
        if (currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) setMessages(current => current.map(message => message.id === streamId ? { ...message, content: "" } : message));
      });
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
      const pendingActions = Array.isArray(finalData.pendingActions)
        ? finalData.pendingActions.filter(isPendingAction)
        : isPendingAction(finalData.pendingAction) ? [finalData.pendingAction] : [];
      const assistantId = typeof finalData.assistant_message_id === "string" && isFolioAssistantMessageId(finalData.assistant_message_id) ? finalData.assistant_message_id : undefined;
      if (assistantId && pendingActions.length) freshActionsByMessage.current.set(assistantId, pendingActions);
      const state = await refreshAssistantState(assistantId);
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
      if (!state?.messages.some(row => row.request_id === requestId)) {
        setMessages(current => {
          const withoutTemporary = current.filter(message => message.id !== optimisticUser.id && message.id !== streamId);
          return [...withoutTemporary,
            { ...optimisticUser, id: typeof finalData.user_message_id === "string" && isFolioAssistantMessageId(finalData.user_message_id) ? finalData.user_message_id : optimisticUser.id, savedState: "unknown" },
            { id: assistantId || streamId, role: "assistant", content: typeof finalData.answer === "string" ? finalData.answer : answer, savedState: "unknown", pendingActions }];
        });
        setAssistantNotice("Folio replied, but I couldn’t verify the saved conversation. Refresh before retrying or confirming any proposal.");
      } else {
        setReplyTargetMessageId(null);
        setSelectedTaskContext(null);
        setTargetMessageId(null);
      }
    } catch (error) {
      if (currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration && !controller.signal.aborted) {
        const state = await refreshAssistantState();
        if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
        if (!state?.messages.some(row => row.request_id === requestId)) {
          setMessages(current => [...current.filter(message => message.id !== optimisticUser.id), { ...optimisticUser, savedState: "unknown" }]);
          setAssistantNotice(error instanceof Error ? `${error.message} I couldn’t confirm whether the message was saved; refresh before retrying.` : "Folio couldn’t confirm whether the message was saved. Refresh before retrying.");
        }
      }
    } finally {
      window.clearTimeout(requestTimeout);
      if (askTimeout.current === requestTimeout) askTimeout.current = null;
      if (askAbort.current === controller) {
        askAbort.current = null;
        if (activeBusyToken.current === busyToken && currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
          activeBusyToken.current = null;
          setLoading(false);
          setAsking(false);
        }
      }
    }
  }

  async function confirmActions(messageId: string, actions: PendingAction[]) {
    const confirmationMessage = messages.find(message => message.id === messageId);
    if (loading || hasUnknownConfirmation || unknownConfirmationIds.current.size > 0 || confirmationInFlight.current.has(messageId) || confirmationMessage?.operationStatus) return;
    const requestUserId = userId;
    const requestGeneration = conversationGeneration.current;
    const busyToken = Symbol("folio-confirmation");
    activeBusyToken.current = busyToken;
    confirmationInFlight.current.add(messageId);
    setWaitingOnAction(true);
    let actionCompleted = false;
    let routeActionCompleted = false;
    let routeDecisionReceipt: Record<string, unknown> | null = null;
    let memoryStateAdopted = false;
    let memoryServerSaved = false;
    let replayedApplied = false;
    let memoryReplayRefreshFailed = false;
    const confirmationTimeout = window.setTimeout(() => {
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
      confirmationInFlight.current.delete(messageId);
      setWaitingOnAction(false);
      unknownConfirmationIds.current.add(messageId);
      setMessages(current => current.map(message => message.id === messageId ? { ...message, operationStatus: "outcome_unknown" } : message));
      if (activeBusyToken.current === busyToken) {
        activeBusyToken.current = null;
        setLoading(false);
      }
    }, ASK_FOLIO_CONFIRMATION_TIMEOUT_MS);
    setLoading(true);
    try {
      const response = await fetch("/api/ask-folio", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "x-folio-api-generation": process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || "1" },
        body: JSON.stringify({ ...(actions.length === 1 ? { confirmedAction: actions[0] } : { confirmedActions: actions }), timezone: deviceTimezone() }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      routeDecisionReceipt = isRecord(data.decision_receipt) ? data.decision_receipt : null;
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
      routeActionCompleted = data.actionCompleted === true;
      const frame=document.querySelector<HTMLIFrameElement>('iframe[title="Folio finance dashboard"]');
      const memoryOnly=actions.every(action=>['save_agent_memory','save_user_memory'].includes(action.tool));
      const feedbackOnly=actions.every(action=>action.tool==='execute_agent_action'&&typeof data.action_type==='string'&&['acknowledge_recurring_change','acknowledge_change','dismiss_event','snooze_event'].includes(data.action_type));
      const replayOutcome = persistedDecisionReceipt(routeDecisionReceipt)?.outcome || (isRecord(routeDecisionReceipt) && ["applied", "declined", "failed", "unknown"].includes(String(routeDecisionReceipt.outcome)) ? String(routeDecisionReceipt.outcome) : null);
      replayedApplied = data.replayed === true && data.actionCompleted === true && replayOutcome === "applied";
      if (replayedApplied && memoryOnly) {
        if (data.memory_state_refreshed === true && Array.isArray(data.memories) && onAdoptCanonicalMemories) {
          try { memoryStateAdopted = await onAdoptCanonicalMemories(data.memories) === true; } catch { memoryStateAdopted = false; }
        }
        memoryReplayRefreshFailed = !memoryStateAdopted;
      } else if (data.memory && typeof data.memory === "object" && !Array.isArray(data.memory)) {
        const memory = data.memory as Record<string, unknown>;
        if (typeof memory.key === "string" && typeof memory.summary === "string" && (memory.kind === "goal" || memory.kind === "decision" || memory.kind === "completed_change")) {
          if (data.memory_saved !== true || !Array.isArray(data.memories)) throw new Error("Folio did not return the verified saved memory list. Your existing memories are unchanged.");
          memoryServerSaved = true;
          const saved = await onSaveMemory(memory as unknown as UserMemory, data.memories as Array<UserMemory & { id: string; createdAt: string }>);
          if (saved !== true) throw new Error("Folio could not verify that this memory was saved. Your existing memories are unchanged.");
          memoryStateAdopted = true;
        }
      }
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== requestGeneration) return;
      if (!response.ok && !replayedApplied) throw new Error(typeof data.error === "string" ? data.error : "Folio could not complete that action.");
      if (data.actionCompleted !== true) throw new Error("Folio did not confirm whether the change completed.");
      actionCompleted = true;
      unknownConfirmationIds.current.delete(messageId);
      if(memoryOnly && memoryStateAdopted)frame?.contentWindow?.postMessage({type:'folio-agent-memory-changed'},window.location.origin);
      window.dispatchEvent(new CustomEvent('folio-agent-chat-completed',{detail:{financial:!memoryOnly&&!feedbackOnly}}));
      freshActionsByMessage.current.delete(messageId);
      completedActionMessageIds.current.add(messageId);
      const confirmedReceipt = persistedDecisionReceipt(routeDecisionReceipt);
      setMessages(current => current.map(message => message.id === messageId ? { ...message, pendingAction: undefined, pendingActions: undefined, operationStatus: "completed", assistant: confirmedReceipt && message.assistant ? { ...message.assistant, decision_receipts: [...(message.assistant.decision_receipts || []), confirmedReceipt] } : message.assistant } : message));
      const saved = await refreshAssistantState();
      if (replayedApplied && routeDecisionReceipt?.saved === false && currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
        setAssistantNotice("Folio confirmed this proposal was already applied and did not repeat it, but couldn’t save a durable decision receipt. The proposal stays locked; refresh the saved conversation before continuing.");
      } else if (memoryReplayRefreshFailed && currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
        setAssistantNotice("This memory proposal had already been applied, and Folio did not repeat it. I couldn’t refresh the current saved memory list, so your existing list is unchanged; refresh saved context before relying on it.");
      } else if (!saved && currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
        setMessages(current => current.map(message => message.id === messageId ? { ...message, pendingAction: undefined, pendingActions: undefined, operationStatus: "completed" } : message));
        setAssistantNotice(confirmedReceipt ? "The change and its decision receipt were confirmed. I couldn’t refresh the saved conversation, so the proposal stays locked here." : routeDecisionReceipt?.saved === false ? "The change was confirmed, but its decision receipt could not be saved. The proposal stays locked while you refresh and reconcile the saved conversation." : "The change was confirmed. I couldn’t refresh the saved conversation, so the original proposal stays locked here.");
      }
    } catch (error) {
      if (currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
        if (!actionCompleted) {
          const memoryOnly = actions.every(action => ['save_agent_memory','save_user_memory'].includes(action.tool));
          if (routeActionCompleted && memoryOnly && memoryStateAdopted && routeDecisionReceipt?.saved === false) {
            const detail = error instanceof Error && error.message ? error.message : "Folio could not persist the decision receipt.";
            freshActionsByMessage.current.delete(messageId);
            completedActionMessageIds.current.add(messageId);
            setMessages(current => current.map(message => message.id === messageId ? { ...message, pendingAction: undefined, pendingActions: undefined, operationStatus: "completed", decisionError: `Folio saved this memory and returned its canonical list, but could not persist the decision receipt. The proposal is locked. ${detail}` } : message));
            setAssistantNotice("Folio saved the memory, but couldn’t persist its decision receipt. The proposal is locked; refresh the saved conversation before continuing.");
          } else if (routeActionCompleted && memoryOnly) {
            const detail = error instanceof Error && error.message ? error.message : "Folio could not verify that the memory was saved.";
            setMessages(current => current.map(message => message.id === messageId ? { ...message, actionError: detail, actionErrorType: "memory" } : message));
            setAssistantNotice(memoryServerSaved ? "Folio confirmed this memory in saved context, but this view could not adopt the canonical list. Your existing memory view is unchanged; retry the sync before continuing." : "The memory wasn’t confirmed as saved. Your existing memories are unchanged; you can retry this save.");
          } else if (persistedDecisionReceipt(routeDecisionReceipt) && ["declined", "failed", "unknown"].includes(persistedDecisionReceipt(routeDecisionReceipt)!.outcome)) {
            const receipt = persistedDecisionReceipt(routeDecisionReceipt)!;
            freshActionsByMessage.current.delete(messageId);
            completedActionMessageIds.current.add(messageId);
            if (receipt.outcome === "unknown") unknownConfirmationIds.current.add(messageId);
            setMessages(current => current.map(message => message.id === messageId ? { ...message, pendingAction: undefined, pendingActions: undefined, operationStatus: receipt.outcome === "unknown" ? "outcome_unknown" : "completed", assistant: message.assistant ? { ...message.assistant, decision_receipts: [...(message.assistant.decision_receipts || []), receipt] } : message.assistant } : message));
            setAssistantNotice(receipt.outcome === "unknown" ? "The result is still being verified. This proposal is locked and cannot be repeated." : receipt.outcome === "declined" ? "Folio confirms this proposal was already declined. No change was made again." : "Folio recorded that the proposed change did not complete. This proposal is locked; review current details before trying again.");
          } else {
            unknownConfirmationIds.current.add(messageId);
            const detail = error instanceof Error && error.message ? ` Folio returned: ${error.message}` : "";
            setMessages(current => current.map(message => message.id === messageId ? { ...message, operationStatus: "outcome_unknown" } : message));
            setAssistantNotice(`I couldn’t verify whether the confirmed change completed.${detail} It may already have been applied, so it’s locked to prevent a duplicate. Check Folio before trying again.`);
          }
        } else {
          freshActionsByMessage.current.delete(messageId);
          completedActionMessageIds.current.add(messageId);
          setMessages(current => current.map(message => message.id === messageId ? { ...message, pendingAction: undefined, pendingActions: undefined, operationStatus: "completed" } : message));
          setAssistantNotice("Folio confirmed the change completed, but the saved conversation could not be refreshed. This proposal is locked here.");
        }
      }
    } finally {
      window.clearTimeout(confirmationTimeout);
      confirmationInFlight.current.delete(messageId);
      setWaitingOnAction(false);
      if (activeBusyToken.current === busyToken && currentUserId.current === requestUserId && conversationGeneration.current === requestGeneration) {
        activeBusyToken.current = null;
        setLoading(false);
      }
    }
  }

  function markUnknownConfirmationReconciled(messageId: string) {
    if (confirmationInFlight.current.has(messageId)) return;
    unknownConfirmationIds.current.delete(messageId);
    setMessages(current => current.map(message => message.id === messageId ? { ...message, operationStatus: "reconciled" } : message));
  }

  async function cancelAction(messageId: string) {
    const original = messages.find(message => message.id === messageId);
    const proposalIds = original?.assistant?.pending_action_proposal_ids;
    if (!original?.assistant || !proposalIds?.length || loading || confirmationInFlight.current.has(messageId)) {
      unknownConfirmationIds.current.add(messageId);
      setMessages(current => current.map(message => message.id === messageId ? { ...message, operationStatus: "outcome_unknown", decisionError: "Folio could not verify this proposal’s decision record. It is locked and cannot be applied." } : message));
      setAssistantNotice("Folio couldn’t verify that this proposal was declined. Refresh before trying any action.");
      return;
    }
    const actions = original.pendingActions || (original.pendingAction ? [original.pendingAction] : []);
    const proposalMetadata = proposalIds.slice(0, actions.length).map((proposalId, index) => {
      const metadata = isRecord(actions[index]?.args?._folio_receipt) ? actions[index].args._folio_receipt : null;
      return metadata && metadata.message_id === original.assistant!.message_id && metadata.proposal_id === proposalId && typeof metadata.tool === "string" && /^[0-9a-f]{64}$/i.test(String(metadata.proposal_sha256 || ""))
        ? { proposal_id: proposalId, tool: metadata.tool, proposal_sha256: metadata.proposal_sha256 as string }
        : null;
    });
    if (proposalMetadata.length !== proposalIds.length || proposalMetadata.some(item => !item)) {
      unknownConfirmationIds.current.add(messageId);
      setMessages(current => current.map(message => message.id === messageId ? { ...message, operationStatus: "outcome_unknown", decisionError: "Folio could not verify this proposal’s receipt metadata. It is locked and cannot be applied." } : message));
      setAssistantNotice("This proposal is locked because Folio could not verify its saved receipt metadata. Refresh the conversation before continuing.");
      return;
    }
    const generation = conversationGeneration.current;
    const requestUserId = userId;
    confirmationInFlight.current.add(messageId);
    setLoading(true);
    setAssistantNotice("Recording your decision…");
    try {
      const receipts: AssistantDecisionReceipt[] = [];
      for (const item of proposalMetadata) {
        const proposalId = item!.proposal_id;
        const response = await fetch("/api/ask-folio", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "x-folio-api-generation": process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || "1" },
          body: JSON.stringify({ confirmedAction: { tool: "record_assistant_decision_receipt", args: { message_id: original.assistant.message_id, proposal_id: proposalId, outcome: "declined", tool: item!.tool, proposal_sha256: item!.proposal_sha256 } }, timezone: deviceTimezone() }),
        });
        const result = await response.json().catch(() => ({})) as Record<string, unknown>;
        const decision = isRecord(result.decision_receipt) ? result.decision_receipt : null;
        const receipt = persistedDecisionReceipt(decision);
        if (!response.ok || result.actionCompleted !== true || !isDecisionReceipt(receipt) || receipt.outcome !== "declined" || receipt.message_id !== original.assistant.message_id || receipt.proposal_id !== proposalId) throw new Error(typeof result.error === "string" ? result.error : "Folio did not confirm the saved decline.");
        receipts.push(receipt);
      }
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== generation) return;
      freshActionsByMessage.current.delete(messageId);
      decisionErrors.current.delete(original.assistant.message_id);
      setMessages(current => current.map(message => message.id === messageId ? {
        ...message,
        pendingAction: undefined,
        pendingActions: undefined,
        actionError: undefined,
        actionErrorType: undefined,
        assistant: message.assistant ? { ...message.assistant, decision_receipts: [...(message.assistant.decision_receipts || []), ...receipts] } : message.assistant,
      } : message));
      setAssistantNotice("Your choice was saved. This proposal is no longer available to apply.");
      await refreshAssistantState();
    } catch (error) {
      if (currentUserId.current !== requestUserId || conversationGeneration.current !== generation) return;
      unknownConfirmationIds.current.add(messageId);
      const decisionError = error instanceof Error ? error.message : "The saved decline could not be verified.";
      decisionErrors.current.set(messageId, decisionError);
      setMessages(current => current.map(message => message.id === messageId ? { ...message, operationStatus: "outcome_unknown", decisionError } : message));
      setAssistantNotice("I couldn’t confirm the decision receipt. The proposal is locked while I check the saved conversation; it won’t be applied.");
      await refreshAssistantState();
    } finally {
      confirmationInFlight.current.delete(messageId);
      if (currentUserId.current === requestUserId && conversationGeneration.current === generation) setLoading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  async function clearHistory() {
    if (loading || hasUnknownConfirmation || pendingConfirmation) return;
    if (historyMode === "device") {
      if (!window.confirm("Clear this device-only Ask Folio history? This only removes its saved copy on this browser. The cloud conversation is separate and won’t change.")) return;
      conversationGeneration.current += 1;
      askAbort.current?.abort();
      askAbort.current = null;
      try { clearAskFolioHistory(userId, localStorage); } catch { /* In-memory clear still works when storage is unavailable. */ }
      setDeviceMessages([]);
      setMessages([]);
      setDraft("");
      messagesScrollTop.current = 0;
      messagesNearBottom.current = true;
      setShowLatest(false);
      return;
    }
    if (!assistantState?.thread) return;
    if (!window.confirm("Archive older messages from this conversation? They’ll be hidden here and left out of future chat context until restored. Nothing is deleted, and watches, preferences, long-term memories, and goals are unchanged.")) return;
    setAssistantNotice("");
    try {
      await folioAssistantRequest(accessToken, "archive_assistant_history", { expected_updated_at: assistantState.thread.updated_at });
      freshActionsByMessage.current.clear();
      setTargetMessageId(null);
      setShowLatest(false);
      setAssistantNotice("Conversation archived. Older messages are hidden and left out of future chat context until restored. Nothing was deleted; watches, preferences, memories, and goals are unchanged.");
      await refreshAssistantState();
      messagesScrollTop.current = 0;
      messagesNearBottom.current = true;
    } catch (error) {
      setAssistantNotice(error instanceof Error ? error.message : "Couldn’t clear the saved conversation. Refresh and try again.");
    }
  }

  async function restoreArchivedHistory() {
    if (loading || hasUnknownConfirmation || pendingConfirmation || assistantLoadStatus === "loading" || historyMode !== "cloud") return;
    const thread = assistantState?.thread;
    if (!thread?.archived_before) return;
    if (!window.confirm("Restore the archived messages? They’ll be visible again and included in future chat context. Nothing is deleted; watches, preferences, long-term memories, and goals are unchanged.")) return;
    const requestUserId = userId;
    const generation = assistantLoadGeneration.current;
    setAssistantNotice("");
    try {
      await folioAssistantRequest(accessToken, "restore_assistant_history", { expected_updated_at: thread.updated_at });
      if (currentUserId.current !== requestUserId || generation !== assistantLoadGeneration.current) return;
      freshActionsByMessage.current.clear();
      setTargetMessageId(null);
      setShowLatest(false);
      setAssistantNotice("Archived messages restored to your saved conversation.");
      await refreshAssistantState();
      messagesScrollTop.current = 0;
      messagesNearBottom.current = true;
    } catch (error) {
      if (currentUserId.current === requestUserId && generation === assistantLoadGeneration.current) {
        setAssistantNotice(error instanceof Error ? error.message : "Couldn’t restore the archived conversation. Refresh and try again.");
      }
    }
  }

  function switchHistoryMode(mode: "cloud" | "device") {
    if (mode === historyMode) return;
    assistantLoadGeneration.current += 1;
    assistantLoadAbort.current?.abort();
    assistantLoadAbort.current = null;
    setHistoryMode(mode);
    setShowLatest(false);
    messagesNearBottom.current = true;
    setAssistantNotice("");
    setReplyTargetMessageId(null);
    setSelectedTaskContext(null);
    setCommitmentsOpen(false);
    if (mode === "device") {
      freshActionsByMessage.current.clear();
      setMessages(deviceMessages);
      setTargetMessageId(null);
    } else {
      setMessages((assistantState?.messages || []).map(row => assistantMessageForView(row, freshActionsByMessage.current.get(row.message_id))));
      if (!assistantState) void refreshAssistantState();
    }
  }

  const closeHistoryMenu = (restoreFocus = false) => {
    setHeaderMenuOpen(false);
    if (restoreFocus) headerMenuTriggerRef.current?.focus();
  };
  const clearHistoryButton = visibleMessages.length > 0 ? <button className="ask-folio-menu-item" type="button" onClick={() => { closeHistoryMenu(true); void clearHistory(); }} aria-label={historyMode === "cloud" ? "Archive saved conversation" : "Clear device-only conversation"} disabled={loading || hasUnknownConfirmation || pendingConfirmation}><Trash2 size={16} /><span>{historyMode === "cloud" ? "Archive saved conversation" : "Clear device-only history"}</span></button> : null;
  const historyMenu = <div className="ask-folio-header-menu" ref={headerMenuRef} onKeyDownCapture={event => { if (event.key === "Escape" && headerMenuOpen) { event.preventDefault(); event.stopPropagation(); closeHistoryMenu(true); } }}>
    <button ref={headerMenuTriggerRef} type="button" className="ask-folio-header-menu-trigger" aria-label="More chat options" aria-expanded={headerMenuOpen} aria-controls="ask-folio-header-options" onClick={() => setHeaderMenuOpen(value => !value)}><MoreHorizontal size={20} /></button>
    <div className="ask-folio-header-menu-popover" id="ask-folio-header-options" aria-label="Chat options" hidden={!headerMenuOpen}>
      <button className="ask-folio-menu-item" type="button" onClick={() => { closeHistoryMenu(true); setCommitmentsOpen(true); void refreshAssistantState(); }}><Eye size={16} /><span>What Folio is watching</span></button>
      {deviceOwnerId === userId && deviceMessages.length > 0 && <button className="ask-folio-menu-item" type="button" onClick={() => { closeHistoryMenu(true); switchHistoryMode(historyMode === "cloud" ? "device" : "cloud"); }}><History size={16} /><span>{historyMode === "cloud" ? "Device-only history" : "Return to saved conversation"}</span></button>}
      {historyMode === "cloud" && assistantOwnerId === userId && assistantState?.thread?.archived_before && <button className="ask-folio-menu-item" type="button" disabled={loading || hasUnknownConfirmation || pendingConfirmation || assistantLoadStatus === "loading"} onClick={() => { closeHistoryMenu(true); void restoreArchivedHistory(); }}><History size={16} /><span>Restore archived messages</span></button>}
      {clearHistoryButton}
    </div>
  </div>;

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1600);
    } catch {
      setCopiedMessageId(null);
    }
  }

  async function changeAssistantItemState(item: AssistantCommitment, status: "active" | "snoozed" | "resolved") {
    if (managementBusyId) return;
    const operation = "set_assistant_commitment_state";
    const args: Record<string, unknown> = { watch_id: item.watch_id, expected_version: item.version, status };
    if (status === "snoozed") {
      const now = Date.now();
      let until = now + 7 * 24 * 60 * 60 * 1000;
      if (item.expires_at) {
        const expiry = Date.parse(item.expires_at);
        if (Number.isFinite(expiry)) until = Math.min(until, expiry);
      }
      if (until <= now) { setManagementNotice("This check has reached its reviewed end time and can’t be paused."); return; }
      args.snoozed_until = new Date(until).toISOString();
    }
    setManagementBusyId(item.watch_id);
    setManagementNotice("");
    let operationReturned = false;
    try {
      const response = await fetch("/api/ask-folio", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "x-folio-api-generation": process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || "1" },
        body: JSON.stringify({ confirmedAction: { tool: operation, args }, timezone: deviceTimezone() }),
      });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || result.actionCompleted !== true) throw new Error(typeof result.error === "string" ? result.error : "Folio could not confirm this status change.");
      operationReturned = true;
      const refreshed = await refreshAssistantState();
      const savedCommitment = refreshed?.commitments?.find(candidate => candidate.watch_id === item.watch_id && candidate.version > item.version && candidate.status === status);
      setManagementNotice(savedCommitment ? status === "resolved" ? "Follow-up stopped." : status === "snoozed" ? "Follow-up paused." : "Follow-up resumed." : "Folio accepted the status change, but the latest saved state could not be verified. Refresh before acting again.");
    } catch (error) {
      const refreshed = await refreshAssistantState();
      setManagementNotice(refreshed
        ? operationReturned ? "The status changed, but Folio could not verify the latest list. Review the saved status before acting again." : "Couldn’t confirm that status change. The list was refreshed; don’t repeat it until you check the current status."
        : error instanceof Error ? `Couldn’t confirm the status change. ${error.message} Refresh before trying again.` : "Couldn’t confirm the status change. Refresh before trying again.");
    } finally { setManagementBusyId(""); }
  }

  function openWatchStateReview(watch: Pick<AssistantWatch, "watch_id" | "version" | "label" | "template">, intent: SelectedWatchContext["intent"], timezone: string, snoozedUntil?: string) {
    const assistant_watch_context: SelectedWatchContext = { watch_id: watch.watch_id, expected_version: watch.version, intent, ...(snoozedUntil ? { snoozed_until: snoozedUntil } : {}) };
    setCommitmentsOpen(false);
    setWatchPauseForm(null);
    setReplyTargetMessageId(null);
    setTargetMessageId(null);
    setSelectedTaskContext(null);
    const request = intent === "pause"
      ? `Review pausing my saved ${watch.template.replaceAll("_", " ")} “${watch.label}” until ${snoozedUntil} in ${timezone}. Do not change anything unless I confirm the exact review.`
      : intent === "resume"
        ? `Review resuming my saved ${watch.template.replaceAll("_", " ")} “${watch.label}”. Do not change anything unless I confirm the exact review.`
        : `Review stopping my saved ${watch.template.replaceAll("_", " ")} “${watch.label}”. Do not change anything unless I confirm the exact review.`;
    void ask(request, null, assistant_watch_context, timezone);
  }

  function beginWatchPause(watch: AssistantWatch) {
    setManagementNotice("");
    setWatchPauseForm({ watch_id: watch.watch_id, version: watch.version, label: watch.label, template: watch.template,
      date: "", time: "", timezone: watch.schedule?.timezone || String(assistantState?.preferences.timezone || deviceTimezone()), choices: [], selectedInstant: null, error: "" });
  }

  function reviewWatchPause(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = watchPauseForm;
    if (!form) return;
    let timezoneValid = true;
    try { new Intl.DateTimeFormat("en-US", { timeZone: form.timezone }); } catch { timezoneValid = false; }
    if (!timezoneValid) { setWatchPauseForm({ ...form, choices: [], selectedInstant: null, error: "Enter a valid IANA time zone, such as America/Los_Angeles." }); return; }
    const choices = watchPauseChoices(form.date, form.time, form.timezone);
    if (!choices.length) { setWatchPauseForm({ ...form, choices: [], selectedInstant: null, error: "Choose a future local date and time that exists in this time zone. Daylight-saving gaps can’t be scheduled." }); return; }
    if (choices.length > 1 && form.selectedInstant === null) {
      setWatchPauseForm({ ...form, choices, error: "This local time occurs twice. Choose the exact time-zone offset before reviewing." });
      return;
    }
    const selected = choices.find(choice => choice.instant === form.selectedInstant) || (choices.length === 1 ? choices[0] : null);
    if (!selected) { setWatchPauseForm({ ...form, choices, error: "Choose one of the exact time-zone offsets shown." }); return; }
    openWatchStateReview({ watch_id: form.watch_id, version: form.version, label: form.label, template: form.template }, "pause", form.timezone, selected.snoozed_until);
  }

  async function changeMessageLifecycle(message: AssistantMessage, lifecycle: "active" | "snoozed" | "resolved") {
    if (!Number.isSafeInteger(message.lifecycle_version) || lifecycleBusyMessageId) return;
    setLifecycleBusyMessageId(message.message_id);
    setAssistantNotice("");
    const args: Record<string, unknown> = { message_id: message.message_id, expected_version: message.lifecycle_version, lifecycle };
    if (lifecycle === "snoozed") args.snoozed_until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const reconcile = async () => {
      const fresh = await refreshAssistantState(message.message_id);
      setAssistantNotice(fresh?.messages.some(row => row.message_id === message.message_id)
        ? "The issue status was refreshed. No status change was repeated."
        : "The issue status could not be verified. Refresh the conversation before acting again.");
    };
    try {
      const response = await fetch("/api/ask-folio", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "x-folio-api-generation": process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || "1" },
        body: JSON.stringify({ confirmedAction: { tool: "set_assistant_message_lifecycle", args } }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || data.actionCompleted !== true) throw new Error(typeof data.error === "string" ? data.error : "Folio could not verify this issue status change.");
      const fresh = await refreshAssistantState(message.message_id);
      setAssistantNotice(fresh?.messages.some(row => row.message_id === message.message_id && row.lifecycle === lifecycle)
        ? lifecycle === "resolved" ? "Marked as expected. This exact issue is quiet now." : lifecycle === "snoozed" ? "This issue is paused for 7 days." : "This issue is active again."
        : "Folio accepted the status change, but the latest issue state could not be verified. Refresh before acting again.");
    } catch {
      await reconcile();
    } finally { setLifecycleBusyMessageId(""); }
  }

  function taskPrompt(task: AssistantState["scheduled_tasks"][number], intent: "pause" | "resume" | "edit") {
    const summary = `“${task.instruction}” · ${taskScheduleLabel(task)}`;
    const context: SelectedTaskContext = { task_id: task.task_id, expected_version: task.version, intent, instruction: task.instruction, schedule: taskScheduleLabel(task) };
    setSelectedTaskContext(context);
    setReplyTargetMessageId(null);
    setTargetMessageId(null);
    if (intent === "edit") {
      setDraft(`Edit this saved scheduled task: ${summary}. I want to change: `);
      setCommitmentsOpen(false);
      setManagementNotice("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    const request = intent === "pause"
      ? `Pause my saved scheduled task ${summary}. Keep its instruction, schedule, and delivery unchanged, and show me the exact review before saving.`
      : `Resume my saved scheduled task ${summary}. Keep its instruction, schedule, and delivery unchanged, and show me the exact review before saving.`;
    setCommitmentsOpen(false);
    setManagementNotice("");
    void ask(request, context);
  }

  function viewCommitmentOrigin(commitment: AssistantCommitment) {
    if (commitment.origin.kind === "message" && isFolioAssistantMessageId(commitment.origin.message_id)) {
      setReplyTargetMessageId(null);
      setTargetMessageId(commitment.origin.message_id);
      setCommitmentsOpen(false);
    } else if (commitment.origin.kind === "event" && onOpenEvent) {
      setCommitmentsOpen(false);
      onOpenEvent(commitment.origin.event_id);
      setOpen(false);
    }
  }

  function viewTaskResult(messageId: string) {
    if (!isFolioAssistantMessageId(messageId)) return;
    setCommitmentsOpen(false);
    setReplyTargetMessageId(null);
    setSelectedTaskContext(null);
    setTargetMessageId(messageId);
    setHistoryMode("cloud");
    setOpen(true);
    void refreshAssistantState(messageId);
  }

  const proactiveTitle = (source: AssistantMessage["source"]) => source === "event" ? "Folio alert" : source === "watch" ? "Folio watch update" : source === "weekly_review" ? "Weekly review" : source === "scheduled_task" ? "Scheduled check" : "Folio update";
  const activeReplyId = replyTargetMessageId || targetMessageId;
  const activeReplyTarget = activeReplyId ? visibleMessages.find(message => message.assistant?.message_id === activeReplyId && message.assistant.role === "assistant" && message.assistant.source !== "reply") : undefined;

  const panelBody = <>
      <header className={`ask-folio-header ${folio2 && useCompactSheet ? "ask-folio-header-sheet" : ""}`}>
          <div>
            <p className="eyebrow">{commitmentsOpen ? "Private assistant" : historyMode === "cloud" ? "Private conversation" : "Device-only history"}</p>
            <h2 id="ask-folio-title">{commitmentsOpen ? "What Folio is watching" : "Ask Folio"}</h2>
          </div>
          <div className="ask-folio-header-actions">
            {!useCompactSheet && historyMenu}
            {!folio2 && <button type="button" onClick={closePanel} aria-label="Close Ask Folio"><X size={21} /></button>}{folio2 && <button type="button" onClick={closePanel} aria-label="Close Ask Folio" disabled={loading && !asking}><X size={21} /></button>}
          </div>
        </header>

        <div className="ask-folio-conversation">
        {commitmentsOpen ? <section className="ask-folio-commitments" aria-label="What Folio is watching">
          <div className="ask-folio-commitments-heading"><div><h3>What Folio is watching</h3><p>Review your saved checks, follow-ups, and their latest status.</p></div><button ref={managementBackRef} type="button" onClick={() => setCommitmentsOpen(false)}>Back to chat</button></div>
          {assistantLoadStatus === "loading" && !assistantState && <p className="ask-folio-commitments-loading" role="status">Loading your current checks…</p>}
          {assistantLoadStatus === "offline" && <div className="ask-folio-commitments-error" role="alert"><p>Your saved checks aren’t available right now. No status changes were made.</p><button type="button" onClick={() => void refreshAssistantState()}>Refresh checks</button></div>}
          {assistantOwnerId === userId && assistantState?.management_unavailable?.includes("decision_receipts") && <div className="ask-folio-commitments-error" role="status"><p>Some saved action outcomes couldn’t be loaded. A missing receipt does not verify that an older proposal was unapplied. Refresh the saved history before acting on it.</p><button type="button" aria-label="Refresh verified decision history" disabled={assistantLoadStatus === "loading"} onClick={() => void refreshAssistantState()}>Refresh history</button></div>}
          {assistantOwnerId === userId && assistantState && (() => {
            const commitments = assistantState.commitments || [];
            const watches = assistantState.watches.filter(watch => watch.template !== "issue_follow_through");
            const tasks = assistantState.scheduled_tasks || [];
            const commitmentsUnavailable = assistantState.management_unavailable?.includes("commitments") === true;
            const tasksUnavailable = assistantState.management_unavailable?.includes("scheduled_tasks") === true;
            const sectionUnavailable = (label: string) => <div className="ask-folio-commitments-unavailable" role="status"><span>{label} couldn’t be loaded. This isn’t an empty list.</span><button type="button" disabled={assistantLoadStatus === "loading"} onClick={() => void refreshAssistantState()}>Refresh checks</button></div>;
            const deliveryPermission = deviceNotificationPermission();
            const deliveryText = (delivery: "chat" | "chat_and_push" | undefined) => delivery === "chat_and_push"
              ? `Chat + push requested · Folio push ${assistantState.preferences.push_enabled === true ? "on" : "off"} · this browser permission ${deliveryPermission}. Viewing this list does not request or change permission.`
              : "Chat only · no push delivery requested.";
            const sourceMessage = (commitment: AssistantCommitment) => commitment.origin.kind === "message"
              ? assistantState.messages.find(message => message.message_id === commitment.origin.message_id)?.content
              : commitment.origin.kind === "event" ? assistantState.messages.find(message => message.event_id === commitment.origin.event_id)?.content : undefined;
            return <>
              {managementNotice && <p className="ask-folio-commitments-notice" role="status">{managementNotice}</p>}
              <p className="ask-folio-delivery-facts">Push status · Folio push is {assistantState.preferences.push_enabled === true ? "on" : "off"}; this browser’s notification permission is {deliveryPermission}. Viewing this list does not request or change permission.</p>
              <section className="ask-folio-managed-section" aria-label="Issue follow-ups"><h4>Issue follow-ups</h4>
                {commitmentsUnavailable && sectionUnavailable("Issue follow-ups")}
                {commitments.length ? commitments.map(commitment => {
                  const zone = "timezone" in commitment.schedule ? commitment.schedule.timezone : String(assistantState.preferences.timezone || "UTC");
                  const due = "timezone" in commitment.schedule ? `${formatAssistantDate(commitment.schedule.local_date)} at ${formatAssistantClock(commitment.schedule.local_time)} ${zone} (${formatAssistantOffset(commitment.schedule.utc_offset_minutes)})` : "When verified data changes";
                  const baseline = formatAssistantMinorAmount(commitment.baseline.value_minor, commitment.baseline.currency);
                  const referenceLabel = commitment.baseline.metric === "cash_buffer" ? "forecast floor" : "budget target";
                  const referenceValue = formatAssistantMinorAmount(commitment.baseline.reference_minor, commitment.baseline.currency);
                  const rule = commitmentRuleDescription(commitment.condition, commitment.baseline);
                  const failure = commitment.last_failure;
                  return <article className="ask-folio-managed-card" key={commitment.watch_id}>
                    <div className="ask-folio-managed-card-heading"><div><strong>{commitment.label}</strong><small>{assistantStateLabel(commitment.status)} · Issue follow-up</small></div><span>{commitment.last_outcome ? commitmentOutcomeLabel(commitment.last_outcome) : "Not checked yet"}</span></div>
                    {sourceMessage(commitment) && <blockquote className="ask-folio-managed-origin">“{sourceMessage(commitment)!.slice(0, 180)}{sourceMessage(commitment)!.length > 180 ? "…" : ""}”</blockquote>}
                    <dl><div><dt>Accepted baseline</dt><dd>{baseline} · captured {formatAssistantInstant(commitment.baseline.captured_at, zone) || "time unavailable"}</dd></div><div><dt>Comparison scope</dt><dd>{commitmentPeriodDescription(commitment.baseline.period)} · {referenceLabel} {referenceValue}</dd></div><div><dt>Worsening rule</dt><dd>{rule}</dd></div><div><dt>Check</dt><dd>{due}</dd></div><div><dt>Stop condition</dt><dd>{assistantEndConditionLabel(commitment.end_condition)}</dd></div><div><dt>Next check</dt><dd>{commitment.next_check_at ? formatAssistantInstant(commitment.next_check_at, zone) || "Time unavailable" : "No next check scheduled"}</dd></div><div><dt>Last checked</dt><dd>{commitment.last_checked_at ? formatAssistantInstant(commitment.last_checked_at, zone) || "Time unavailable" : "Not checked yet"}</dd></div><div><dt>Delivery</dt><dd>{deliveryText(commitment.delivery)}</dd></div>{commitment.expires_at && <div><dt>Expires</dt><dd>{formatAssistantInstant(commitment.expires_at, zone) || "Time unavailable"}</dd></div>}</dl>
                    {failure && <p className="ask-folio-managed-failure" role="alert">Needs attention: {failure}</p>}
                    {commitment.origin.kind !== "issue" && <button className="ask-folio-managed-link" type="button" onClick={() => viewCommitmentOrigin(commitment)}>{commitment.origin.kind === "event" ? "Open linked alert" : "View original message"}</button>}
                    <div className="ask-folio-managed-actions">{commitment.status === "active" ? <button type="button" disabled={Boolean(managementBusyId)} onClick={() => void changeAssistantItemState(commitment, "snoozed")}>Pause 7 days</button> : commitment.status === "snoozed" ? <button type="button" disabled={Boolean(managementBusyId)} onClick={() => void changeAssistantItemState(commitment, "active")}>Resume</button> : null}{commitment.status === "active" || commitment.status === "snoozed" ? <button type="button" disabled={Boolean(managementBusyId)} onClick={() => void changeAssistantItemState(commitment, "resolved")}>Stop follow-up</button> : null}</div>
                  </article>;
                }) : !commitmentsUnavailable && <p className="ask-folio-commitments-empty">No issue follow-ups saved.</p>}
              </section>
              <section className="ask-folio-managed-section" aria-label="Bounded watches"><h4>Bounded watches</h4>
                {watches.length ? watches.map(watch => <article className="ask-folio-managed-card" key={watch.watch_id}>
                  <div className="ask-folio-managed-card-heading"><div><strong>{watch.label}</strong><small>{assistantStateLabel(watch.status)} · {watch.template.replaceAll("_", " ")}</small></div><span>{watch.last_outcome ? assistantWatchOutcomeLabel(watch.last_outcome) : "Not checked yet"}</span></div>
                  <dl>{watch.schedule && <div><dt>Scheduled</dt><dd>{formatAssistantDate(watch.schedule.local_date)} at {formatAssistantClock(watch.schedule.local_time)} {watch.schedule.timezone} ({formatAssistantOffset(watch.schedule.utc_offset_minutes)})</dd></div>}<div><dt>Next check</dt><dd>{watch.next_check_at ? formatAssistantInstant(watch.next_check_at, watch.schedule?.timezone || "UTC") || "Time unavailable" : "No next check scheduled"}</dd></div><div><dt>Last checked</dt><dd>{watch.last_checked_at ? formatAssistantInstant(watch.last_checked_at, watch.schedule?.timezone || "UTC") || "Time unavailable" : "Not checked yet"}</dd></div>{watch.expires_at && <div><dt>Expires</dt><dd>{formatAssistantInstant(watch.expires_at, watch.schedule?.timezone || "UTC") || "Time unavailable"}</dd></div>}<div><dt>Delivery</dt><dd>{deliveryText(watch.delivery)}</dd></div></dl>
                  {watch.last_failure && <p className="ask-folio-managed-failure" role="alert">Needs attention: {watch.last_failure}</p>}
                  <div className="ask-folio-managed-actions">{watch.status === "active" && <button type="button" disabled={Boolean(managementBusyId)} onClick={() => beginWatchPause(watch)}>Pause until…</button>}{watch.status === "snoozed" && <button type="button" disabled={Boolean(managementBusyId)} onClick={() => openWatchStateReview(watch, "resume", watch.schedule?.timezone || String(assistantState.preferences.timezone || deviceTimezone()))}>Resume</button>}{(watch.status === "active" || watch.status === "snoozed") && <button type="button" disabled={Boolean(managementBusyId)} onClick={() => openWatchStateReview(watch, "stop", watch.schedule?.timezone || String(assistantState.preferences.timezone || deviceTimezone()))}>Stop watch</button>}</div>
                  {watchPauseForm?.watch_id === watch.watch_id && <form className="ask-folio-watch-pause-form" onSubmit={reviewWatchPause} aria-label={`Choose pause time for ${watch.label}`}>
                    <strong>Choose when to resume this watch</strong>
                    <label><span>Date</span><input type="date" required value={watchPauseForm.date} onChange={event => setWatchPauseForm({ ...watchPauseForm, date: event.target.value, choices: [], selectedInstant: null, error: "" })} /></label>
                    <label><span>Time</span><input type="time" required value={watchPauseForm.time} onChange={event => setWatchPauseForm({ ...watchPauseForm, time: event.target.value, choices: [], selectedInstant: null, error: "" })} /></label>
                    <label><span>Time zone (IANA)</span><input type="text" required value={watchPauseForm.timezone} onChange={event => setWatchPauseForm({ ...watchPauseForm, timezone: event.target.value, choices: [], selectedInstant: null, error: "" })} placeholder="America/Los_Angeles" autoCapitalize="none" /></label>
                    {watchPauseForm.choices.length > 1 && <fieldset><legend>This local time occurs twice. Choose the exact offset.</legend>{watchPauseForm.choices.map(choice => <label key={choice.instant}><input type="radio" name={`watch-pause-${watch.watch_id}`} checked={watchPauseForm.selectedInstant === choice.instant} onChange={() => setWatchPauseForm({ ...watchPauseForm, selectedInstant: choice.instant, error: "" })} /><span>{formatAssistantInstant(new Date(choice.instant).toISOString(), watchPauseForm.timezone)} ({formatAssistantOffset(choice.offset)})</span></label>)}</fieldset>}
                    {watchPauseForm.error && <p role="alert">{watchPauseForm.error}</p>}
                    <small>Folio will show the exact date, time, and zone before pausing. No status changes until you confirm that server review.</small>
                    <div className="ask-folio-managed-actions"><button type="submit">Review pause</button><button type="button" onClick={() => setWatchPauseForm(null)}>Cancel</button></div>
                  </form>}
                </article>) : <p className="ask-folio-commitments-empty">No bounded watches saved.</p>}
              </section>
              <section className="ask-folio-managed-section" aria-label="Scheduled reports and checks"><h4>Scheduled reports &amp; checks</h4>
                {tasksUnavailable && sectionUnavailable("Scheduled reports and checks")}
                {tasks.length ? tasks.map(task => <article className="ask-folio-managed-card" key={task.task_id}>
                  {(() => {
                    const deliveryStatus = task.last_delivery_status;
                    const resultMessageId = task.last_message_id;
                    const deliveryLabel = deliveryStatus === "sent" ? "Provider accepted; device receipt is not available" : deliveryStatus === "deferred" ? "Deferred by the delivery provider" : deliveryStatus === "failed" ? "Delivery failed" : deliveryStatus === "uncertain" ? "Delivery outcome uncertain; check the saved result" : deliveryStatus === "pending" ? "Awaiting provider status" : null;
                    return <>
                  <div className="ask-folio-managed-card-heading"><div><strong>{task.instruction}</strong><small>{task.enabled ? "Active" : "Paused"} · {task.cadence} task</small></div><span>{task.last_outcome ? task.last_outcome.replaceAll("_", " ") : "Not run yet"}</span></div>
                  <dl><div><dt>Schedule</dt><dd>{taskScheduleLabel(task)}</dd></div><div><dt>Next run</dt><dd>{task.enabled && task.next_run_at ? formatAssistantInstant(task.next_run_at, task.timezone) || "Time unavailable" : task.enabled ? "Not scheduled" : "Paused"}</dd></div><div><dt>Last run</dt><dd>{task.last_run_at ? formatAssistantInstant(task.last_run_at, task.timezone) || "Time unavailable" : "Not run yet"}</dd></div><div><dt>Delivery</dt><dd>{deliveryText(task.delivery)}</dd></div>{deliveryLabel && <div><dt>Last delivery</dt><dd>{deliveryLabel}</dd></div>}</dl>
                  {task.last_outcome === "missed" ? <div className="ask-folio-managed-missed" role="status"><strong>Scheduled slot missed</strong><span>No report ran for that slot. Missed slots are not retried; the next normal run is shown above.</span></div> : task.last_failure && <div className="ask-folio-managed-failure" role="alert"><strong>Last run needs attention</strong><span>{task.last_failure}</span>{task.retryable ? <small>There may be another bounded run attempt. Review this task before changing its schedule.</small> : <small>The bounded retry limit is exhausted. Edit or resume only through a fresh reviewed task change; no run was repeated.</small>}</div>}
                  {typeof resultMessageId === "string" && isFolioAssistantMessageId(resultMessageId) && <button className="ask-folio-managed-link" type="button" onClick={() => viewTaskResult(resultMessageId)}>View last result in chat</button>}
                  <div className="ask-folio-managed-actions">{task.enabled ? <button type="button" disabled={loading || assistantLoadStatus !== "ready"} onClick={() => taskPrompt(task, "pause")}>Pause in chat</button> : <button type="button" disabled={loading || assistantLoadStatus !== "ready"} onClick={() => taskPrompt(task, "resume")}>Resume in chat</button>}<button type="button" disabled={loading || assistantLoadStatus !== "ready"} onClick={() => taskPrompt(task, "edit")}>Edit in chat</button></div>
                    </>;
                  })()}
                </article>) : !tasksUnavailable && <p className="ask-folio-commitments-empty">No recurring reports or checks saved.</p>}
              </section>
              {!commitments.length && !watches.length && !tasks.length && !commitmentsUnavailable && !tasksUnavailable && <p className="ask-folio-commitments-empty">You don’t have ongoing checks saved yet. Ask me to set up a report or follow through on an issue, and I’ll show you the exact review before anything is saved.</p>}
            </>;
          })()}
        </section> : <>
        {decisionReceiptsUnavailable && <div className="ask-folio-history-verification-note" role="status"><p>Saved action outcomes couldn’t be verified. A missing receipt does not mean an older proposal was unapplied, so restored proposal controls are paused.</p><button type="button" aria-label="Refresh verified decision history" disabled={assistantLoadStatus === "loading"} onClick={() => void refreshAssistantState(targetMessageId || undefined)}><RefreshCw size={15} /> Refresh history</button></div>}
        <div ref={attachMessages} className="ask-folio-messages" aria-live="polite" onScroll={(event)=>{const target=event.currentTarget;messagesScrollTop.current=target.scrollTop;messagesNearBottom.current=target.scrollHeight-target.scrollTop-target.clientHeight<90;setShowLatest(!messagesNearBottom.current);setMessageVisibilityPulse(value=>value+1);}}>
          {historyMode === "cloud" && assistantState?.next_cursor && <button type="button" className="ask-folio-load-older" disabled={loadingOlder} onClick={() => void loadOlderAssistantMessages()}>{loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}</button>}
          {assistantLoadStatus === "loading" && historyMode === "cloud" && messages.length === 0 ? <p className="ask-folio-state-note" role="status">Loading your saved conversation…</p> : null}
          {assistantLoadStatus === "offline" && historyMode === "cloud" && visibleMessages.length === 0 ? <div className="ask-folio-state-note" role="status"><p>Your saved conversation isn’t available right now. No message will be treated as saved while offline.</p><button type="button" onClick={() => void refreshAssistantState(targetMessageId || undefined)}><RefreshCw size={15} /> Try again</button></div> : null}
          {historyMode === "cloud" && assistantOwnerId === userId && assistantState?.thread?.archived_before && <p className="ask-folio-archive-status" role="status">Archived. Older messages are saved, not deleted, and left out of future chat context.</p>}
          {visibleMessages.length === 0 && assistantLoadStatus === "ready" ? <section className="ask-folio-welcome">
            <div className="ask-folio-orb"><SparkChatIcon size={30} /></div>
            <h3>{historyMode === "device" ? "No device-only history" : targetMessageId && assistantNotice ? "Message unavailable" : "What do you want to understand?"}</h3>
            <p>{historyMode === "device" ? "This browser has no older device-only chat saved." : targetMessageId && assistantNotice ? "This exact message isn’t available for this account. Your conversation stays private." : "I can help you understand your finances and review changes before anything is applied."}</p>
            {historyMode === "cloud" && !targetMessageId && <div className="ask-folio-suggestions">{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => void ask(suggestion)}>{suggestion}</button>)}</div>}
          </section> : visibleMessages.map((message) => {
            if (message.id.startsWith("stream:") && !message.content && !message.pendingActions?.length) return null;
            const hasDecisionReceipts = Boolean(message.assistant?.decision_receipts?.length);
            const hasSavedProposal = Boolean(message.assistant?.pending_action_proposal_ids?.length || message.assistant?.pending_action_summaries?.length || message.historicalActionSummaries?.length || message.pendingActions?.length || message.pendingAction);
            const receiptUnavailableForProposal = decisionReceiptsUnavailable && hasSavedProposal && !hasDecisionReceipts;
            const actions = hasDecisionReceipts || receiptUnavailableForProposal ? [] : message.pendingActions ?? (message.pendingAction ? [message.pendingAction] : []);
            const watchConfirmationAction = actions.length === 1 && actions[0].tool === "confirm_assistant_watch";
            const hasWatchConfirmationAction = actions.some(action => action.tool === "confirm_assistant_watch");
            const watchPreview = watchConfirmationAction ? parseAssistantWatchPreview(actions[0].watchPreview) : null;
            const watchPreviewUnavailable = hasWatchConfirmationAction && (!watchConfirmationAction || !watchPreview);
            const watchStateConfirmationAction = actions.length === 1 && actions[0].tool === "confirm_assistant_watch_state";
            const hasWatchStateConfirmationAction = actions.some(action => action.tool === "confirm_assistant_watch_state");
            const watchStatePreview = watchStateConfirmationAction ? parseWatchStatePreview(actions[0].watchStatePreview) : null;
            const watchStatePreviewUnavailable = hasWatchStateConfirmationAction && (!watchStateConfirmationAction || !watchStatePreview);
            const commitmentConfirmationAction = actions.length === 1 && actions[0].tool === "confirm_assistant_commitment";
            const hasCommitmentConfirmationAction = actions.some(action => action.tool === "confirm_assistant_commitment");
            const commitmentPreview = commitmentConfirmationAction ? parseCommitmentPreview(actions[0].commitmentPreview) : null;
            const taskConfirmationAction = actions.length === 1 && actions[0].tool === "confirm_assistant_task";
            const hasTaskConfirmationAction = actions.some(action => action.tool === "confirm_assistant_task");
            const taskPreview = taskConfirmationAction ? parseTaskPreview(actions[0].taskPreview) : null;
            const memoryConfirmationAction = actions.length === 1 && actions[0].tool === "save_user_memory";
            const hasMemoryConfirmationAction = actions.some(action => action.tool === "save_user_memory");
            const memoryReview = memoryConfirmationAction ? parseMemoryReview(actions[0].args) : null;
            const commitmentOriginMessage = commitmentPreview?.origin.kind === "message"
              ? assistantState?.messages.find(row => row.message_id === commitmentPreview.origin.message_id)?.content
              : commitmentPreview?.origin.kind === "event" ? assistantState?.messages.find(row => row.event_id === commitmentPreview.origin.event_id)?.content : undefined;
            const reviewPreviewUnavailable = watchPreviewUnavailable || watchStatePreviewUnavailable || hasCommitmentConfirmationAction && (!commitmentConfirmationAction || !commitmentPreview || Boolean(commitmentPreview.acknowledge_origin?.will_resolve && !commitmentOriginMessage)) || hasTaskConfirmationAction && (!taskConfirmationAction || !taskPreview) || hasMemoryConfirmationAction && (!memoryConfirmationAction || !memoryReview);
            const linkedWatches = message.assistant?.source === "watch"
              ? (assistantOwnerId === userId ? assistantState?.watches.filter(watch => message.assistant!.watch_ids.includes(watch.watch_id)) : []) || []
              : [];
            const destructive = actions.some((action) => action.destructive);
            const singleRule = actions.length === 1 && actions[0].tool === "save_categorization_rule";
            const rentalOnly = actions.length > 0 && actions.every((action) => action.tool === "save_rental_classification");
            const rentalPreview = rentalOnly && actions.length === 1 ? rentalPreviewFor(actions[0]) : null;
            const duplicateRentalAnswer = Boolean(rentalPreview && /^Review these rental reporting changes\./i.test(message.content));
            return <article key={message.id} data-assistant-message-id={message.assistant?.message_id} className={`ask-folio-message ${message.role} ${message.assistant?.lifecycle || ""} ${message.savedState ? `saved-${message.savedState}` : ""}`}>
              <div className="ask-folio-message-meta"><span className="sr-only">{message.role === "assistant" ? "Folio replied" : "You said"}</span>{message.assistant && message.assistant.lifecycle !== "active" && <span className={`ask-folio-lifecycle ${message.assistant.lifecycle}`} aria-label={`Message status: ${message.assistant.lifecycle}`}>{message.assistant.lifecycle === "snoozed" && message.assistant.snoozed_until ? `Snoozed until ${new Date(message.assistant.snoozed_until).toLocaleDateString()}` : message.assistant.lifecycle}</span>}{message.assistant && message.assistant.generation_status !== "complete" && <span className={`ask-folio-generation-status ${message.assistant.generation_status}`}>{message.assistant.generation_status === "pending" ? "Reply pending" : message.assistant.generation_status === "interrupted" ? "Reply interrupted" : "Reply failed"}</span>}<button type="button" className="ask-folio-copy" onClick={() => void copyMessage(message)} aria-label={`Copy ${message.role === "assistant" ? "Folio" : "your"} message`} title="Copy message">{copiedMessageId === message.id ? <Check size={15} /> : <Copy size={15} />}<span className="ask-folio-copy-label">{copiedMessageId === message.id ? "Copied" : "Copy"}</span></button></div>
              {message.role === "assistant" ? <AssistantMarkdown content={duplicateRentalAnswer ? "Review the rental classifications below." : message.content} onOpenGoal={onOpenGoal ? (goalId, activityId) => { setOpen(false); onOpenGoal(goalId, activityId); } : undefined} /> : <p className="ask-folio-user-content">{message.content}</p>}
              {message.assistant && message.assistant.generation_status === "pending" && <div className="ask-folio-historical-actions"><strong>Reply in progress</strong><p>Folio has a saved reply in progress. Check the conversation before asking again.</p><button type="button" disabled={assistantLoadStatus === "loading"} onClick={() => void refreshAssistantState(message.assistant!.message_id)}>Check saved status</button></div>}
              {message.assistant && (message.assistant.generation_status === "interrupted" || message.assistant.generation_status === "failed") && <div className="ask-folio-historical-actions"><strong>Reply interrupted</strong><p>Check the saved request status first. If it’s still interrupted, Folio will start a fresh request without reusing any old proposal or action.</p><button type="button" disabled={loading || assistantLoadStatus === "loading"} onClick={() => void reconcileInterruptedReply(message.assistant!.message_id)}>Check status and try again</button></div>}
              {message.assistant?.source === "event" && message.assistant.event_id && <div className="ask-folio-event-review"><span>Folio alert</span><button type="button" onClick={() => onOpenEvent?.(message.assistant!.event_id!)}>Review alert</button></div>}
              {message.assistant?.source === "watch" && linkedWatches.map(watch => <AssistantWatchOutcomeCard key={watch.watch_id} watch={watch} onReviewRefund={onOpenTransaction ? (transactionId) => { setOpen(false); onOpenTransaction(transactionId); } : undefined} />)}
              {message.assistant?.decision_receipts?.map(receipt => <div className={`ask-folio-decision-receipt ${receipt.outcome}`} key={receipt.receipt_id} role="status"><strong>{decisionOutcomeLabel(receipt.outcome)}</strong><span>{receipt.outcome === "unknown" ? "The confirmed result is still being verified. This proposal cannot be repeated." : receipt.outcome === "declined" ? "You chose not to apply this proposal." : receipt.outcome === "failed" ? "The proposed action did not complete." : "Folio verified the resulting change."}</span><small>{receipt.verified_at ? `Verified ${formatAssistantInstant(receipt.verified_at, String(assistantState?.preferences.timezone || "UTC")) || "recently"}` : `Recorded ${formatAssistantInstant(receipt.created_at, String(assistantState?.preferences.timezone || "UTC")) || "recently"}`}</small></div>)}
              {message.role === "assistant" && message.assistant && message.assistant.source !== "reply" && <div className="ask-folio-message-followup">
                {Number.isSafeInteger(message.assistant.lifecycle_version) && message.assistant.lifecycle !== "superseded" && <><span className="ask-folio-followup-label">This is a saved {proactiveTitle(message.assistant.source).toLowerCase()}.</span>{message.assistant.lifecycle === "active" && <><button type="button" disabled={Boolean(lifecycleBusyMessageId)} onClick={() => void changeMessageLifecycle(message.assistant!, "resolved")}>Expected</button><button type="button" disabled={Boolean(lifecycleBusyMessageId)} onClick={() => void changeMessageLifecycle(message.assistant!, "snoozed")}>Pause 7 days</button></>}{message.assistant.lifecycle === "snoozed" && <><button type="button" disabled={Boolean(lifecycleBusyMessageId)} onClick={() => void changeMessageLifecycle(message.assistant!, "active")}>Resume</button><button type="button" disabled={Boolean(lifecycleBusyMessageId)} onClick={() => void changeMessageLifecycle(message.assistant!, "resolved")}>Expected</button></>}{message.assistant.lifecycle === "resolved" && <button type="button" disabled={Boolean(lifecycleBusyMessageId)} onClick={() => void changeMessageLifecycle(message.assistant!, "active")}>Reopen</button>}</>}
                <button type="button" disabled={historyMode !== "cloud" || !isFolioAssistantMessageId(message.assistant.message_id)} onClick={() => { setSelectedTaskContext(null); setReplyTargetMessageId(message.assistant!.message_id); setTargetMessageId(null); inputRef.current?.focus(); }}><Reply size={14} /> Reply</button><span>Replying keeps this {proactiveTitle(message.assistant.source).toLowerCase()} in context.</span></div>}
              {receiptUnavailableForProposal && <div className="ask-folio-historical-actions" role="status"><strong>Decision history unavailable</strong><p>Folio couldn’t load the verified outcome for this saved proposal. Don’t treat it as unapplied or decline it; refresh the saved history before deciding what to do.</p><button type="button" disabled={assistantLoadStatus === "loading"} onClick={() => void refreshAssistantState(message.assistant?.message_id)}>Refresh verified history</button></div>}
              {message.historicalActionSummaries?.length && !hasDecisionReceipts && !receiptUnavailableForProposal && message.operationStatus !== "completed" ? <div className="ask-folio-historical-actions"><strong>Saved proposal summary</strong><p>This older proposal can’t be applied from chat history. Ask Folio to review current details before deciding.</p>{message.historicalActionSummaries.map((summary,index)=><div key={`${index}-${summary}`}><span>{summary}</span><button type="button" disabled={loading || historyMode !== "cloud"} onClick={() => void ask(`Review the current details for this older proposal: ${summary}`)}>Review current details</button></div>)}</div> : null}
              {message.operationStatus === "completed" && actions.length === 0 && !receiptUnavailableForProposal && <div className="ask-folio-operation-status" role="status"><p>{message.decisionError || "Confirmed. This proposal is locked and can’t be applied again. Re-review current details before making any new change."}</p></div>}
              {historyMode === "device" && actions.length > 0 && <div className="ask-folio-historical-actions"><strong>Unconfirmed device-history proposal</strong><p>This proposal is only saved on this browser and cannot be applied from history. Return to the saved conversation and ask Folio to review current details.</p></div>}
              {historyMode === "cloud" && actions.length > 0 && <div className={`ask-folio-confirm ${destructive ? "destructive" : ""} ${rentalOnly ? "rental-confirm" : ""}`}>
                <strong>{hasCommitmentConfirmationAction ? "Review issue follow-up" : hasTaskConfirmationAction ? "Review scheduled task" : hasMemoryConfirmationAction ? "Review personal context" : hasWatchStateConfirmationAction ? "Review watch status" : hasWatchConfirmationAction ? watchPreview?.template === "expected_refund" ? "Review expected refund" : watchPreview?.template === "one_time_follow_up" ? "Review one-time follow-up" : "Review bounded watch" : rentalOnly ? "Review rental classifications" : destructive ? "Confirm irreversible action" : singleRule ? "Review categorization rule" : actions.length > 1 ? `Ready to apply ${actions.length} changes` : "Ready to apply"}</strong>
                {rentalOnly && <p className="ask-folio-confirm-notice">Rental reporting only. Your household transaction categories will not change.</p>}
                {watchConfirmationAction && watchPreview && <AssistantWatchReviewCard preview={watchPreview} />}
                {watchStateConfirmationAction && watchStatePreview && <AssistantWatchStateReviewCard preview={watchStatePreview} defaultTimezone={String(assistantState?.preferences.timezone || "UTC")} />}
                {commitmentConfirmationAction && commitmentPreview && <AssistantCommitmentReviewCard preview={commitmentPreview} sourceMessage={commitmentOriginMessage} summary={actions[0].summary} pushPreference={assistantState?.preferences.push_enabled === true} permission={deviceNotificationPermission()} />}
                {taskConfirmationAction && taskPreview && <AssistantTaskReviewCard preview={taskPreview} pushPreference={assistantState?.preferences.push_enabled === true} permission={deviceNotificationPermission()} />}
                {memoryConfirmationAction && memoryReview && <AssistantMemoryReviewCard memory={memoryReview} />}
                {message.actionError && <p className="ask-folio-action-error" role="alert">{message.actionError}</p>}
                {reviewPreviewUnavailable && <div className="ask-folio-historical-actions" role="alert"><strong>Review details unavailable</strong><p>Folio couldn’t verify the server-generated details, so this proposal can’t be confirmed. Decline it and ask Folio to prepare a fresh review.</p></div>}
                {rentalOnly && rentalPreview ? <><div className="ask-folio-rental-preview-count"><strong>{rentalPreview.total_count} transaction{rentalPreview.total_count===1?"":"s"}</strong>{rentalPreview.rows.length>2&&<span>Scroll to review all proposed changes.</span>}</div><div className="ask-folio-rental-preview" aria-label="Rental classification preview">{rentalPreview.rows.map((row) => <section className="ask-folio-rental-preview-row" data-transaction-id={row.transaction_id} key={row.transaction_id}>
                  <div className="ask-folio-rental-preview-heading"><strong className="ask-folio-rental-merchant" title={row.merchant}>{row.merchant}</strong><strong className="ask-folio-rental-amount">{rentalAmount(row.amount, row.currency)}</strong></div>
                  <div className="ask-folio-rental-meta">{rentalDate(row.date)} <span aria-hidden="true">·</span> {row.account}</div>
                  <div className="ask-folio-rental-classification"><span>{row.treatment}</span><strong>{row.category}</strong></div>
                  {row.reference && <details className="ask-folio-rental-reference"><summary>Bank reference</summary><p>{row.reference}</p></details>}
                </section>)}</div></> : actions.length === 1 && !watchConfirmationAction && !watchStateConfirmationAction && !commitmentConfirmationAction && !taskConfirmationAction && !memoryConfirmationAction && <div className="ask-folio-confirm-summary">{actions[0].summary}</div>}
                {actions.length > 1 && <details open>
                  <summary>Review all changes</summary>
                  <ul>{actions.map((action, index) => <li key={`${action.tool}-${index}`}>{action.summary}</li>)}</ul>
                </details>}
                {taskConfirmationAction && taskPreview && <div className="ask-folio-confirm-summary">This exact task change requires your confirmation. Existing schedules and device permissions stay unchanged until you confirm.</div>}
                {message.operationStatus === "completed" ? <div className="ask-folio-operation-status" role="status"><p>Confirmed. This saved proposal is locked and can’t be applied again. Re-review current details if needed.</p></div> : message.operationStatus === "outcome_unknown" ? <div className="ask-folio-operation-status" role="status">
                  <p>{message.decisionError ? "Folio could not verify that your decline was saved. This proposal is locked so it can’t be applied; check the saved conversation before continuing." : "The confirmed request may already have been applied, but Folio has not verified the result. This proposal is locked to prevent a duplicate. Check the related Folio data before continuing."}</p>
                  {message.decisionError ? <button type="button" disabled={assistantLoadStatus === "loading"} onClick={() => { decisionErrors.current.set(message.id, message.decisionError!); void refreshAssistantState(); }}>{assistantLoadStatus === "loading" ? "Checking saved decision…" : "Check saved decision"}</button> : <button type="button" disabled={waitingOnAction} onClick={() => markUnknownConfirmationReconciled(message.id)}>{waitingOnAction ? "Waiting for the request to finish…" : "I checked the current Folio data"}</button>}
                </div> : message.operationStatus === "reconciled" ? <div className="ask-folio-operation-status" role="status">
                  <p>You checked the result in Folio. This original proposal is retained for reference and cannot be applied again.</p>
                </div> : <div>
                  <button type="button" className="cancel" disabled={loading} onClick={() => void cancelAction(message.id)}>Decline</button>
                  <button type="button" className="confirm" disabled={loading || hasUnknownConfirmation || Boolean(message.savedState) || Boolean(reviewPreviewUnavailable)} onClick={() => void confirmActions(message.id, actions)}>
                    {message.actionErrorType === "memory" ? "Retry memory save" : watchStateConfirmationAction && watchStatePreview ? watchStatePreview.proposed_status === "snoozed" ? "Confirm pause" : watchStatePreview.proposed_status === "resolved" ? "Confirm stop" : "Confirm resume" : rentalOnly ? "Apply rental changes" : destructive ? "Confirm" : actions.length > 1 ? `Apply ${actions.length} changes` : "Apply change"}
                  </button>
                  {hasUnknownConfirmation && <p role="status">Confirmed changes are paused until the unknown result is checked in Folio.</p>}
                </div>}
              </div>}
            </article>;
          })}
          {loading && <div className="ask-folio-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={17} /><span>{asking ? "Folio is replying…" : waitingOnAction ? "Applying the reviewed change…" : "Working…"}</span></div>}
          {assistantNotice && <div className="ask-folio-state-note" role="status" aria-live="polite"><span>{assistantNotice}</span>{(assistantLoadStatus === "offline" || needsAskReconciliation || visibleMessages.some(message => message.savedState === "unknown")) && historyMode === "cloud" && <button type="button" aria-label="Refresh conversation" disabled={assistantLoadStatus === "loading"} onClick={() => { setNeedsAskReconciliation(false); void refreshAssistantState(targetMessageId || undefined); }}><RefreshCw size={15} /> Refresh conversation</button>}</div>}
          <div />
        </div>
        {showLatest && visibleMessages.length > 0 && <button type="button" className="ask-folio-latest" onClick={scrollToLatest} aria-label="Scroll to latest message"><ChevronDown size={16} /> Latest</button>}
        </>}
        </div>

        <form className="ask-folio-composer" onSubmit={submit}>
          {commitmentsOpen ? <button type="button" className="ask-folio-return-cloud" onClick={() => setCommitmentsOpen(false)}>Back to conversation</button> : historyMode === "device" ? <button type="button" className="ask-folio-return-cloud" onClick={() => switchHistoryMode("cloud")}>Return to saved chat</button> : <>
          {selectedTaskContext && <div className="ask-folio-task-context" role="group" aria-label="Selected scheduled task"><span>{selectedTaskContext.intent === "edit" ? "Editing" : selectedTaskContext.intent === "pause" ? "Pausing" : selectedTaskContext.intent === "resume" ? "Resuming" : "Reviewing recovery for"} <strong>{selectedTaskContext.instruction}</strong><small>{selectedTaskContext.schedule} · exact task selection</small></span><button type="button" aria-label="Cancel selected task" onClick={() => setSelectedTaskContext(null)}><X size={15} /></button></div>}
          {activeReplyTarget && <div className="ask-folio-reply-context" role="group" aria-label={`Replying to ${proactiveTitle(activeReplyTarget.assistant!.source)}`}><span>Replying to {proactiveTitle(activeReplyTarget.assistant!.source)}</span><p>{activeReplyTarget.content.slice(0, 180)}{activeReplyTarget.content.length > 180 ? "…" : ""}</p><button type="button" aria-label="Cancel reply target" onClick={() => { setReplyTargetMessageId(null); setTargetMessageId(null); }}><X size={15} /></button></div>}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                const keyboardEvent = event.nativeEvent as KeyboardEvent;
                if (keyboardEvent.isComposing) return;
                const touchKeyboard = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;
                if (touchKeyboard) return;
                event.preventDefault();
                if (draft.trim()) void ask(draft);
              }
            }}
            rows={1}
            maxLength={8000}
            placeholder="Ask Folio…"
            aria-label="Ask Folio a question"
          />
          {asking ? <button type="button" className="ask-folio-stop" onClick={() => cancelAsk()} aria-label="Stop waiting for Folio"><Square size={16} /><span>Stop</span></button> : <button type="submit" disabled={loading || assistantLoadStatus !== "ready" || hasUnresolvedAsk || !draft.trim()} aria-label="Send question"><Send size={19} /></button>}
          </>}
        </form>

  </>;
  return <>
    <button className="ask-folio-launcher" type="button" onClick={() => setOpen(true)} aria-label="Open Ask Folio" data-folio-update-blocked={loading || Boolean(draft.trim()) ? "true" : undefined}>
      <Sparkles size={20} strokeWidth={2} aria-hidden="true" /> <span>Ask Folio</span>{!open && historyMode === "cloud" && Boolean(assistantOwnerId === userId && assistantState?.messages.some(message => message.role === "assistant" && !message.read_at && message.lifecycle !== "resolved" && message.lifecycle !== "superseded")) && <i className="ask-folio-unread-dot" aria-label="New Ask Folio messages" />}
    </button>
    {open && (useCompactSheet ? <FolioCompactSheet open={open} onOpenChange={(next) => next ? setOpen(true) : closePanel()} title={commitmentsOpen ? "What Folio is watching" : "Ask Folio"} description={historyMode === "cloud" ? "Private conversation" : "Device-only history"} className="ask-folio-sheet-content" dismissBlocked={loading && !asking} onDismissBlocked={()=>{}} onEscapeKeyDown={(event) => { if (commitmentsOpen) { event.preventDefault(); setCommitmentsOpen(false); } else if (headerMenuOpen) { event.preventDefault(); closeHistoryMenu(true); } }} headerActions={historyMenu} initialExpanded keyboardAware><div className="ask-folio-panel ask-folio-panel-sheet">{panelBody}</div></FolioCompactSheet> : <div ref={backdropRef} className={`ask-folio-backdrop ${folio2 && pendingConfirmation ? "folio2-review-fullscreen" : ""}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget && (!folio2 || asking || !loading)) closePanel();
    }}><aside className={`ask-folio-panel ${folio2 ? "ask-folio-panel-review" : ""}`} role="dialog" aria-modal="true" aria-labelledby="ask-folio-title">{panelBody}</aside></div>)}
  </>;
}
