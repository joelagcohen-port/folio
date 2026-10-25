/** Browser-safe wire contract for the private, household-member Folio Assistant. */
export type AssistantRole = "user" | "assistant";
export type AssistantSource = "user" | "reply" | "event" | "weekly_review" | "watch" | "scheduled_task" | "system";
export type AssistantGenerationStatus = "complete" | "pending" | "failed" | "interrupted";
export type AssistantMessageLifecycle = "active" | "snoozed" | "resolved" | "superseded";
export type AssistantWatchTemplate = "cash_flow" | "budget" | "recurring" | "account_health" | "one_time_follow_up" | "expected_refund" | "issue_follow_through";
export type AssistantWatchStatus = "draft" | "active" | "snoozed" | "resolved" | "superseded";
export type AssistantWatchOutcome = "pending" | "completed" | "received" | "partial" | "not_received" | "needs_review" | "unavailable" | "missed";
export type AssistantCommitmentOutcome = AssistantWatchOutcome | "worsened" | "unchanged" | "improved" | "data_unavailable";
export type AssistantDecisionOutcome = "applied" | "declined" | "failed" | "unknown";
export type AssistantDecisionEvidenceKind = "agent_action" | "assistant_watch" | "assistant_task" | "assistant_memory" | "signed_server_result";

/** A bounded, read-only continuation tied to a server-owned issue, not arbitrary model code. */
export type AssistantCommitmentOrigin =
  | { kind: "message"; message_id: string }
  | { kind: "event"; event_id: string; event_version: number }
  | { kind: "issue"; issue_id: string };
export type AssistantCommitmentMetric = "cash_buffer" | "category_budget";
export type AssistantCommitmentCondition =
  | {
      kind: "only_if_worse"; metric: "cash_buffer";
      comparator: { field: "forecast_low_vs_floor"; direction: "lower"; crosses_below_floor: true; floor_minor: number; horizon_days: number; account_scope: string; account_scope_key: string; min_decline_minor: number; relative_percent: 5; earlier_low_date_days: 7; currency: "USD" };
    }
  | {
      kind: "only_if_worse"; metric: "category_budget"; category_name: string;
      comparator: { field: "projected_overage"; direction: "higher"; budget_month: string; category_id: string; target_minor: number; min_increase_minor: number; relative_percent: 5; currency: "USD" };
    };
export type AssistantCommitmentPeriod =
  | { kind: "forecast"; horizon_days: number; low_date: string; account_scope: string; account_scope_key: string }
  | { kind: "budget"; month: string; category_id: string; category_name: string; target_minor: number; timezone: string };
export type AssistantCommitmentBaseline = {
  metric: AssistantCommitmentMetric;
  value_minor: number;
  reference_minor: number;
  currency: "USD";
  captured_at: string;
  source_revision: string;
  source: "canonical";
  period: AssistantCommitmentPeriod;
};
export type AssistantCommitmentSchedule = AssistantWatchSchedule | { kind: "event_driven" };
export type AssistantCommitmentEndCondition =
  | { kind: "one_check" }
  | { kind: "verified_payday"; stream_key: string; expected_date: string; timezone: string }
  | { kind: "budget_period_end" }
  | { kind: "issue_resolved" };

export interface AssistantWatchSchedule {
  due_at: string;
  local_date: string;
  local_time: string;
  timezone: string;
  utc_offset_minutes: number;
}

export interface AssistantWatchFollowUp {
  check: "reminder" | "cash_flow" | "budget" | "recurring" | "account_health";
  reminder_text?: string;
  category_name?: string;
}

export interface AssistantWatchRefund {
  original_transaction_id: string;
  expected_amount_minor: number;
  currency: string;
  expected_by_date: string;
  original_merchant: string;
  original_date: string;
  original_amount_minor: number;
  baseline_received_minor: number;
}

export interface AssistantThread {
  thread_id: string;
  updated_at: string;
  archived_before: string | null;
}

export interface AssistantMessage {
  message_id: string;
  thread_id: string;
  role: AssistantRole;
  source: AssistantSource;
  content: string;
  created_at: string;
  updated_at: string;
  request_id: string | null;
  reply_to_message_id: string | null;
  generation_status: AssistantGenerationStatus;
  lifecycle: AssistantMessageLifecycle;
  event_id: string | null;
  event_version: number | null;
  snoozed_until: string | null;
  read_at: string | null;
  superseded_by: string | null;
  watch_ids: string[];
  pending_action_summaries?: string[];
  pending_action_tools?: string[];
  pending_action_fingerprints?: string[];
  lifecycle_version?: number;
  pending_action_proposal_ids?: string[];
  decision_receipts?: AssistantDecisionReceipt[];
}

export interface AssistantWatch {
  watch_id: string;
  template: AssistantWatchTemplate;
  category_name?: string;
  schedule?: AssistantWatchSchedule;
  follow_up?: AssistantWatchFollowUp;
  refund?: AssistantWatchRefund;
  delivery?: "chat" | "chat_and_push";
  label: string;
  status: AssistantWatchStatus;
  version: number;
  snoozed_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  next_check_at?: string | null;
  last_checked_at?: string | null;
  last_outcome?: AssistantWatchOutcome | null;
  completed_at?: string | null;
  last_failure?: string | null;
  lifecycle_version?: number;
  commitment?: Omit<AssistantCommitment, "watch_id">;
}

/** First-class view over an issue_follow_through watch. Baselines are server-read. */
export interface AssistantCommitment {
  watch_id: string;
  origin: AssistantCommitmentOrigin;
  condition: AssistantCommitmentCondition;
  baseline: AssistantCommitmentBaseline;
  schedule: AssistantCommitmentSchedule;
  end_condition: AssistantCommitmentEndCondition;
  notify: "only_if_worse";
  delivery: "chat" | "chat_and_push";
  label: string;
  status: AssistantWatchStatus;
  version: number;
  snoozed_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  next_check_at: string | null;
  last_checked_at: string | null;
  last_outcome: AssistantCommitmentOutcome | null;
  last_failure: string | null;
  completed_at: string | null;
}

export interface AssistantDecisionReceipt {
  receipt_id: string;
  proposal_id: string;
  message_id: string;
  outcome: AssistantDecisionOutcome;
  evidence_kind: AssistantDecisionEvidenceKind | null;
  evidence_id: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantScheduledTask {
  task_id: string;
  instruction: string;
  cadence: "daily" | "weekly";
  weekday: number | null;
  local_time: string;
  timezone: string;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  starts_at: string;
  delivery?: "chat" | "chat_and_push";
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_outcome?: "pending" | "running" | "completed" | "failed" | "cancelled" | "missed" | null;
  last_failure?: string | null;
  retryable?: boolean;
  last_message_id?: string | null;
  last_delivery_status?: "pending" | "deferred" | "sent" | "failed" | "uncertain" | "cancelled" | null;
}

export type AssistantWatchPreview = AssistantWatch & {
  timing_note: string;
  push_available: boolean;
};

/** Existing notification JSON plus opt-in-only Assistant schedules and messaging. */
export interface AssistantPreferences {
  assistant_proactive_enabled: boolean;
  assistant_daily_check_enabled: boolean;
  assistant_daily_check_time: string;
  assistant_weekly_review_enabled: boolean;
  assistant_weekly_review_day: number;
  assistant_weekly_review_time: string;
  timezone?: string;
  in_app_enabled?: boolean;
  push_enabled?: boolean;
  quiet_hours?: unknown;
  [key: string]: unknown;
}

export interface AssistantState {
  thread: AssistantThread | null;
  messages: AssistantMessage[];
  next_cursor: string | null;
  watches: AssistantWatch[];
  commitments?: AssistantCommitment[];
  scheduled_tasks: AssistantScheduledTask[];
  preferences: AssistantPreferences;
  management_unavailable?: Array<"scheduled_tasks" | "commitments" | "decision_receipts">;
  unavailable?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

const roles = ["user", "assistant"] as const;
const sources = ["user", "reply", "event", "weekly_review", "watch", "scheduled_task", "system"] as const;
const generations = ["complete", "pending", "failed", "interrupted"] as const;
const lifecycles = ["active", "snoozed", "resolved", "superseded"] as const;
const watchTemplates = ["cash_flow", "budget", "recurring", "account_health", "one_time_follow_up", "expected_refund", "issue_follow_through"] as const;
const watchStatuses = ["draft", "active", "snoozed", "resolved", "superseded"] as const;
const watchOutcomes = ["pending", "completed", "received", "partial", "not_received", "needs_review", "unavailable", "missed"] as const;
const decisionOutcomes = ["applied", "declined", "failed", "unknown"] as const;
const evidenceKinds = ["agent_action", "assistant_watch", "assistant_task", "assistant_memory", "signed_server_result"] as const;

function isAssistantDecisionReceipt(value: unknown): value is AssistantDecisionReceipt {
  return isRecord(value) && typeof value.receipt_id === "string" && typeof value.proposal_id === "string" &&
    typeof value.message_id === "string" && oneOf(value.outcome, decisionOutcomes) &&
    (value.evidence_kind === null || oneOf(value.evidence_kind, evidenceKinds)) &&
    (value.evidence_id === null || typeof value.evidence_id === "string") &&
    (value.verified_at === null || typeof value.verified_at === "string") &&
    typeof value.created_at === "string" && typeof value.updated_at === "string";
}

export function isAssistantCommitment(value: unknown): value is AssistantCommitment {
  if (!isRecord(value) || typeof value.watch_id !== "string" || !isRecord(value.origin) ||
      !isRecord(value.condition) || !isRecord(value.baseline) || !isRecord(value.schedule) ||
      !isRecord(value.end_condition) || value.notify !== "only_if_worse" ||
      !oneOf(value.delivery, ["chat", "chat_and_push"] as const) || typeof value.label !== "string" ||
      !oneOf(value.status, watchStatuses) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      (value.snoozed_until !== null && typeof value.snoozed_until !== "string") ||
      (value.expires_at !== null && typeof value.expires_at !== "string") ||
      typeof value.created_at !== "string" || typeof value.updated_at !== "string" ||
      (value.next_check_at !== null && typeof value.next_check_at !== "string") ||
      (value.last_checked_at !== null && typeof value.last_checked_at !== "string") ||
      (value.last_outcome !== null && !oneOf(value.last_outcome, [...watchOutcomes, "worsened", "unchanged", "improved", "data_unavailable"] as const)) ||
      (value.last_failure !== null && typeof value.last_failure !== "string") ||
      (value.completed_at !== null && typeof value.completed_at !== "string")) return false;
  const origin = value.origin;
  if (origin.kind === "message") {
    if (typeof origin.message_id !== "string" || Object.keys(origin).some(key => !["kind", "message_id"].includes(key))) return false;
  } else if (origin.kind === "event") {
    if (typeof origin.event_id !== "string" || !Number.isSafeInteger(origin.event_version) || Number(origin.event_version) < 1 ||
        Object.keys(origin).some(key => !["kind", "event_id", "event_version"].includes(key))) return false;
  } else if (origin.kind === "issue") {
    if (typeof origin.issue_id !== "string" || Object.keys(origin).some(key => !["kind", "issue_id"].includes(key))) return false;
  } else return false;
  const condition = value.condition;
  if (condition.kind !== "only_if_worse" || !["cash_buffer", "category_budget"].includes(String(condition.metric)) ||
      (condition.metric === "category_budget" ? typeof condition.category_name !== "string" : condition.category_name !== undefined) ||
      !isRecord(condition.comparator) || Object.keys(condition).some(key => !["kind", "metric", "category_name", "comparator"].includes(key))) return false;
  const comparator = condition.comparator;
  if (condition.metric === "cash_buffer") {
    if (comparator.field !== "forecast_low_vs_floor" || comparator.direction !== "lower" || comparator.crosses_below_floor !== true || !Number.isSafeInteger(comparator.floor_minor) ||
        !Number.isSafeInteger(comparator.horizon_days) || Number(comparator.horizon_days) < 1 || typeof comparator.account_scope !== "string" ||
        typeof comparator.account_scope_key !== "string" || !/^[0-9a-f]{64}$/.test(comparator.account_scope_key) ||
        !Number.isSafeInteger(comparator.min_decline_minor) || Number(comparator.min_decline_minor) < 1 || comparator.relative_percent !== 5 ||
        comparator.earlier_low_date_days !== 7 || comparator.currency !== "USD" ||
        Object.keys(comparator).some(key => !["field", "direction", "crosses_below_floor", "floor_minor", "horizon_days", "account_scope", "account_scope_key", "min_decline_minor", "relative_percent", "earlier_low_date_days", "currency"].includes(key))) return false;
  } else if (comparator.field !== "projected_overage" || comparator.direction !== "higher" ||
      !/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(comparator.budget_month || "")) || typeof comparator.category_id !== "string" ||
      !Number.isSafeInteger(comparator.target_minor) || Number(comparator.target_minor) < 0 || !Number.isSafeInteger(comparator.min_increase_minor) ||
      Number(comparator.min_increase_minor) < 1 || comparator.relative_percent !== 5 || comparator.currency !== "USD" ||
      Object.keys(comparator).some(key => !["field", "direction", "budget_month", "category_id", "target_minor", "min_increase_minor", "relative_percent", "currency"].includes(key))) return false;
  const baseline = value.baseline;
  if (!oneOf(baseline.metric, ["cash_buffer", "category_budget"] as const) || !Number.isSafeInteger(baseline.value_minor) ||
      !Number.isSafeInteger(baseline.reference_minor) || baseline.currency !== "USD" || typeof baseline.captured_at !== "string" ||
      typeof baseline.source_revision !== "string" || baseline.source !== "canonical" || !isRecord(baseline.period)) return false;
  if (baseline.metric === "cash_buffer") {
    if (baseline.period.kind !== "forecast" || !Number.isSafeInteger(baseline.period.horizon_days) || Number(baseline.period.horizon_days) < 1 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(baseline.period.low_date || "")) || typeof baseline.period.account_scope !== "string" ||
        typeof baseline.period.account_scope_key !== "string") return false;
  } else if (baseline.period.kind !== "budget" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(baseline.period.month || "")) ||
      typeof baseline.period.category_id !== "string" || typeof baseline.period.category_name !== "string" || !Number.isSafeInteger(baseline.period.target_minor) || typeof baseline.period.timezone !== "string") return false;
  const schedule = value.schedule;
  if (schedule.kind === "event_driven") {
    if (Object.keys(schedule).length !== 1) return false;
  } else if (typeof schedule.due_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(String(schedule.local_date || "")) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.local_time || "")) || typeof schedule.timezone !== "string" ||
      !Number.isInteger(schedule.utc_offset_minutes) || Object.keys(schedule).some(key => !["due_at", "local_date", "local_time", "timezone", "utc_offset_minutes"].includes(key))) return false;
  const end = value.end_condition;
  if (end.kind === "one_check" || end.kind === "issue_resolved") { if (Object.keys(end).length !== 1) return false; }
  else if (end.kind === "verified_payday") { if (condition.metric !== "cash_buffer" || Object.keys(end).length !== 4 || typeof end.stream_key !== "string" || !end.stream_key || end.stream_key.length > 240 || !/^20\d{2}-\d{2}-\d{2}$/.test(end.expected_date) || typeof end.timezone !== "string") return false; }
  else if (end.kind === "budget_period_end") { if (condition.metric !== "category_budget" || Object.keys(end).length !== 1) return false; }
  else return false;
  return true;
}

export function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!isRecord(value)) return false;
  return typeof value.message_id === "string" && typeof value.thread_id === "string" &&
    oneOf(value.role, roles) && oneOf(value.source, sources) && typeof value.content === "string" &&
    typeof value.created_at === "string" && typeof value.updated_at === "string" &&
    (value.request_id === null || typeof value.request_id === "string") &&
    (value.reply_to_message_id === null || typeof value.reply_to_message_id === "string") &&
    oneOf(value.generation_status, generations) && oneOf(value.lifecycle, lifecycles) &&
    (value.event_id === null || typeof value.event_id === "string") &&
    (value.event_version === null || (Number.isSafeInteger(value.event_version) && Number(value.event_version) > 0)) &&
    (value.snoozed_until === null || typeof value.snoozed_until === "string") &&
    (value.read_at === null || typeof value.read_at === "string") &&
    (value.superseded_by === null || typeof value.superseded_by === "string") &&
    Array.isArray(value.watch_ids) && value.watch_ids.every((id) => typeof id === "string") &&
    (value.lifecycle_version === undefined || (Number.isSafeInteger(value.lifecycle_version) && Number(value.lifecycle_version) > 0)) &&
    (value.pending_action_proposal_ids === undefined || (Array.isArray(value.pending_action_proposal_ids) && value.pending_action_proposal_ids.every((id) => typeof id === "string"))) &&
    (value.pending_action_tools === undefined || (Array.isArray(value.pending_action_tools) && value.pending_action_tools.every((tool) => typeof tool === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(tool)))) &&
    (value.pending_action_fingerprints === undefined || (Array.isArray(value.pending_action_fingerprints) && value.pending_action_fingerprints.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)))) &&
    (value.pending_action_proposal_ids === undefined || value.pending_action_tools === undefined || value.pending_action_proposal_ids.length === value.pending_action_tools.length) &&
    (value.pending_action_proposal_ids === undefined || value.pending_action_fingerprints === undefined || value.pending_action_proposal_ids.length === value.pending_action_fingerprints.length) &&
    (value.decision_receipts === undefined || (Array.isArray(value.decision_receipts) && value.decision_receipts.every(isAssistantDecisionReceipt))) &&
    (value.pending_action_summaries === undefined || (Array.isArray(value.pending_action_summaries) && value.pending_action_summaries.every((item) => typeof item === "string")));
}

export function isAssistantWatch(value: unknown): value is AssistantWatch {
  if (!isRecord(value)) return false;
  const base = typeof value.watch_id === "string" && oneOf(value.template, watchTemplates) &&
    (value.category_name === undefined || typeof value.category_name === "string") &&
    typeof value.label === "string" && oneOf(value.status, watchStatuses) &&
    Number.isSafeInteger(value.version) && Number(value.version) > 0 &&
    (value.snoozed_until === null || typeof value.snoozed_until === "string") &&
    (value.expires_at === null || typeof value.expires_at === "string") &&
    typeof value.created_at === "string" && typeof value.updated_at === "string" &&
    (value.delivery === undefined || oneOf(value.delivery, ["chat", "chat_and_push"] as const)) &&
    (value.next_check_at === undefined || value.next_check_at === null || typeof value.next_check_at === "string") &&
    (value.last_checked_at === undefined || value.last_checked_at === null || typeof value.last_checked_at === "string") &&
    (value.last_outcome === undefined || value.last_outcome === null || oneOf(value.last_outcome, value.template === "issue_follow_through" ? [...watchOutcomes, "worsened", "unchanged", "improved", "data_unavailable"] as const : watchOutcomes)) &&
    (value.completed_at === undefined || value.completed_at === null || typeof value.completed_at === "string") &&
    (value.last_failure === undefined || value.last_failure === null || typeof value.last_failure === "string");
  if (!base) return false;
  if (value.template === "issue_follow_through") return isRecord(value.commitment) && isAssistantCommitment({ ...value.commitment, watch_id: value.watch_id });
  const scheduled = value.template === "one_time_follow_up" || value.template === "expected_refund";
  if (scheduled && (!isRecord(value.schedule) || typeof value.schedule.due_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value.schedule.local_date || "")) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.schedule.local_time || "")) ||
      typeof value.schedule.timezone !== "string" || !Number.isInteger(value.schedule.utc_offset_minutes))) return false;
  if (!scheduled && value.schedule != null) return false;
  if (value.template === "one_time_follow_up") {
    if (!isRecord(value.follow_up) || !oneOf(value.follow_up.check, ["reminder", "cash_flow", "budget", "recurring", "account_health"] as const) ||
        (value.follow_up.reminder_text !== undefined && typeof value.follow_up.reminder_text !== "string") ||
        (value.follow_up.category_name !== undefined && typeof value.follow_up.category_name !== "string") ||
        (value.follow_up.check === "reminder" && (typeof value.follow_up.reminder_text !== "string" || !value.follow_up.reminder_text.trim() || value.follow_up.reminder_text.length > 280)) ||
        (value.follow_up.check !== "reminder" && value.follow_up.reminder_text !== undefined) ||
        (value.follow_up.check === "budget" ? typeof value.follow_up.category_name !== "string" : value.follow_up.category_name !== undefined)) return false;
  }
  if (value.template !== "one_time_follow_up" && value.follow_up != null) return false;
  if (value.template === "expected_refund") {
    if (!isRecord(value.refund) || typeof value.refund.original_transaction_id !== "string" ||
        !Number.isSafeInteger(value.refund.expected_amount_minor) || Number(value.refund.expected_amount_minor) <= 0 ||
        value.refund.currency !== "USD" || typeof value.refund.expected_by_date !== "string" ||
        typeof value.refund.original_merchant !== "string" || typeof value.refund.original_date !== "string" ||
        !Number.isSafeInteger(value.refund.original_amount_minor) || Number(value.refund.original_amount_minor) <= 0 ||
        Number(value.refund.expected_amount_minor) > Number(value.refund.original_amount_minor) ||
        !Number.isSafeInteger(value.refund.baseline_received_minor) || Number(value.refund.baseline_received_minor) < 0 ||
        value.refund.expected_by_date !== (value.schedule as AssistantWatchSchedule).local_date) return false;
  }
  if (value.template !== "expected_refund" && value.refund != null) return false;
  if (scheduled && !oneOf(value.delivery, ["chat", "chat_and_push"] as const)) return false;
  if (value.template === "budget" && typeof value.category_name !== "string") return false;
  if (value.template !== "budget" && value.category_name !== undefined) return false;
  return true;
}

function isAssistantScheduledTask(value: unknown): value is AssistantScheduledTask {
  return isRecord(value) && typeof value.task_id === "string" && typeof value.instruction === "string" &&
    oneOf(value.cadence, ["daily", "weekly"] as const) && (value.weekday === null || Number.isSafeInteger(value.weekday)) &&
    typeof value.local_time === "string" && typeof value.timezone === "string" && typeof value.enabled === "boolean" &&
    Number.isSafeInteger(value.version) && typeof value.created_at === "string" && typeof value.updated_at === "string" && typeof value.starts_at === "string" &&
    (value.delivery === undefined || oneOf(value.delivery, ["chat", "chat_and_push"] as const)) &&
    (value.next_run_at === undefined || value.next_run_at === null || typeof value.next_run_at === "string") &&
    (value.last_run_at === undefined || value.last_run_at === null || typeof value.last_run_at === "string") &&
    (value.last_outcome === undefined || value.last_outcome === null || oneOf(value.last_outcome, ["pending", "running", "completed", "failed", "cancelled", "missed"] as const)) &&
    (value.last_failure === undefined || value.last_failure === null || typeof value.last_failure === "string") &&
    (value.retryable === undefined || typeof value.retryable === "boolean") &&
    (value.last_message_id === undefined || value.last_message_id === null || typeof value.last_message_id === "string") &&
    (value.last_delivery_status === undefined || value.last_delivery_status === null || oneOf(value.last_delivery_status, ["pending", "deferred", "sent", "failed", "uncertain", "cancelled"] as const));
}

export function parseAssistantState(value: unknown): AssistantState | null {
  if (!isRecord(value) || (value.thread !== null && !isRecord(value.thread)) || !isRecord(value.preferences) ||
      !Array.isArray(value.messages) || !value.messages.every(isAssistantMessage) ||
      !Array.isArray(value.watches) || !value.watches.every(isAssistantWatch) ||
      (value.commitments !== undefined && (!Array.isArray(value.commitments) || !value.commitments.every(isAssistantCommitment))) ||
      (value.scheduled_tasks !== undefined && (!Array.isArray(value.scheduled_tasks) || !value.scheduled_tasks.every(isAssistantScheduledTask))) ||
      (value.management_unavailable !== undefined && (!Array.isArray(value.management_unavailable) || !value.management_unavailable.every((x) => oneOf(x, ["scheduled_tasks", "commitments", "decision_receipts"] as const)))) ||
      (value.next_cursor !== null && typeof value.next_cursor !== "string") ||
      (value.unavailable !== undefined && typeof value.unavailable !== "boolean")) return null;
  const thread = value.thread as Record<string, unknown> | null;
  if (thread !== null && (typeof thread.thread_id !== "string" || typeof thread.updated_at !== "string" ||
      (thread.archived_before !== null && typeof thread.archived_before !== "string"))) return null;
  return value as unknown as AssistantState;
}
