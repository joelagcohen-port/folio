type Row = Record<string, unknown>;

type Operation = {
  functionName: string;
  action?: string;
  destructive?: boolean;
  householdScoped?: boolean;
};

export const folioOperations: Record<string, Operation> = {
  get_autonomy_state: { functionName: "finance-live-data", action: "get_autonomy_state", householdScoped: true },
  set_autonomy_mode: { functionName: "finance-live-data", action: "set_autonomy_mode", householdScoped: true },
  save_autonomy_policy: { functionName: "finance-live-data", action: "save_autonomy_policy", householdScoped: true },
  authorize_autonomy_policy: { functionName: "finance-live-data", action: "authorize_autonomy_policy", householdScoped: true },
  undo_autonomy_action: { functionName: "finance-live-data", action: "undo_autonomy_action", householdScoped: true },
  run_autonomy_dry_run: { functionName: "finance-live-data", action: "run_autonomy_dry_run", householdScoped: true },
  snooze_autonomy_suggestion: { functionName: "finance-live-data", action: "snooze_autonomy_suggestion", householdScoped: true },
  prepare_agent_action: { functionName: "finance-live-data", action: "prepare_agent_action", householdScoped: true },
  claim_agent_action: { functionName: "finance-live-data", action: "claim_agent_action", householdScoped: true },
  finish_agent_action: { functionName: "finance-live-data", action: "finish_agent_action", householdScoped: true },
  refresh_agent_state: { functionName: "finance-live-data", action: "refresh_agent_state", householdScoped: true },

  get_notification_settings: { functionName: "finance-live-data", action: "get_notification_settings", householdScoped: true },
  get_assistant_state: { functionName: "finance-live-data", action: "get_assistant_state", householdScoped: true },
  begin_assistant_turn: { functionName: "finance-live-data", action: "begin_assistant_turn", householdScoped: true },
  mark_assistant_message_read: { functionName: "finance-live-data", action: "mark_assistant_message_read", householdScoped: true },
  archive_assistant_history: { functionName: "finance-live-data", action: "archive_assistant_history", householdScoped: true },
  restore_assistant_history: { functionName: "finance-live-data", action: "restore_assistant_history", householdScoped: true },
  review_assistant_watch: { functionName: "finance-live-data", action: "review_assistant_watch", householdScoped: true },
  confirm_assistant_watch: { functionName: "finance-live-data", action: "confirm_assistant_watch", householdScoped: true },
  review_assistant_watch_state: { functionName: "finance-live-data", action: "review_assistant_watch_state", householdScoped: true },
  confirm_assistant_watch_state: { functionName: "finance-live-data", action: "confirm_assistant_watch_state", householdScoped: true },
  review_assistant_commitment: { functionName: "finance-live-data", action: "review_assistant_commitment", householdScoped: true },
  confirm_assistant_commitment: { functionName: "finance-live-data", action: "confirm_assistant_commitment", householdScoped: true },
  set_assistant_commitment_state: { functionName: "finance-live-data", action: "set_assistant_commitment_state", householdScoped: true },
  set_assistant_message_lifecycle: { functionName: "finance-live-data", action: "set_assistant_message_lifecycle", householdScoped: true },
  record_assistant_decision_receipt: { functionName: "finance-live-data", action: "record_assistant_decision_receipt", householdScoped: true },
  claim_assistant_decision_receipt: { functionName: "finance-live-data", action: "claim_assistant_decision_receipt", householdScoped: true },
  save_assistant_memory: { functionName: "finance-live-data", action: "save_assistant_memory", householdScoped: true },
  list_assistant_memories: { functionName: "finance-live-data", action: "list_assistant_memories", householdScoped: true },
  review_assistant_task: { functionName: "finance-live-data", action: "review_assistant_task", householdScoped: true },
  confirm_assistant_task: { functionName: "finance-live-data", action: "confirm_assistant_task", householdScoped: true },
  set_assistant_watch_state: { functionName: "finance-live-data", action: "set_assistant_watch_state", householdScoped: true },
  save_notification_settings: { functionName: "finance-live-data", action: "save_notification_settings", householdScoped: true },
  save_push_subscription: { functionName: "finance-live-data", action: "save_push_subscription", householdScoped: true },
  remove_push_subscription: { functionName: "finance-live-data", action: "remove_push_subscription", householdScoped: true },
  get_agent_event_detail: { functionName: "finance-live-data", action: "get_agent_event_detail", householdScoped: true },
  claim_agent_notifications: { functionName: "finance-live-data", action: "claim_agent_notifications", householdScoped: true },
  complete_agent_notifications: { functionName: "finance-live-data", action: "complete_agent_notifications", householdScoped: true },

  list_accounts: { functionName: "finance-account-management", action: "list", householdScoped: true },
  get_account_detail: { functionName: "finance-account-management", action: "detail", householdScoped: true },
  get_account_history_batch: { functionName: "finance-account-management", action: "history_batch", householdScoped: true },
  save_manual_account: { functionName: "finance-account-management", action: "save_manual", householdScoped: true },
  save_manual_account_atomic: { functionName: "finance-account-management", action: "save_manual_atomic", householdScoped: true },
  review_account_status: { functionName: "finance-account-management", action: "review_status", householdScoped: true },
  confirm_account_status: { functionName: "finance-account-management", action: "confirm_status", householdScoped: true },
  get_standalone_goal_plan_state: { functionName: "finance-live-data", action: "get_standalone_goal_plan_state", householdScoped: true },
  review_standalone_goal_plan: { functionName: "finance-live-data", action: "review_standalone_goal_plan", householdScoped: true },
  confirm_standalone_goal_plan: { functionName: "finance-live-data", action: "confirm_standalone_goal_plan", householdScoped: true },
  set_account_status: { functionName: "finance-account-management", action: "set_status", householdScoped: true },
  delete_account: { functionName: "finance-account-management", action: "delete", destructive: true, householdScoped: true },
  create_account_link: { functionName: "finance-account-management", action: "create_link_token", householdScoped: true },
  complete_account_link: { functionName: "finance-account-management", householdScoped: true },
  resolve_account_duplicate: { functionName: "finance-account-management", action: "resolve_duplicate", householdScoped: true },
  sync_account: { functionName: "plaid-sync-transactions", householdScoped: true },
  sync_transactions: { functionName: "plaid-sync-transactions", householdScoped: true },
  refresh_status: { functionName: "plaid-sync-transactions", householdScoped: true },
  search_transactions: { functionName: "plaid-transaction-query", action: "search_transactions", householdScoped: true },
  monthly_transaction_summaries: { functionName: "plaid-transaction-query", action: "monthly_transaction_summaries", householdScoped: true },
  sync_prepared_transactions: { functionName: "plaid-transaction-query", action: "sync_prepared_transactions", householdScoped: true },
  get_completed_year_spending: { functionName: "plaid-transaction-query", action: "completed_year_spending", householdScoped: true },
  spending_summary: { functionName: "plaid-transaction-query", action: "spending_summary", householdScoped: true },
  get_rental_accounts: { functionName: "finance-rental-reporting", action: "get_accounts", householdScoped: true },
  get_rental_preferences: { functionName: "finance-rental-reporting", action: "get_preferences", householdScoped: true },
  save_rental_preferences: { functionName: "finance-rental-reporting", action: "save_preferences", householdScoped: true },
  read_rental_children: { functionName: "finance-rental-reporting", action: "read_rental_children", householdScoped: true },
  review_rental_child: { functionName: "finance-rental-reporting", action: "review_rental_child", householdScoped: true },
  confirm_rental_child: { functionName: "finance-rental-reporting", action: "confirm_rental_child", householdScoped: true },
  get_rental_report: { functionName: "finance-rental-reporting", action: "get_report", householdScoped: true },
  search_rental_transactions: { functionName: "finance-rental-reporting", action: "search_transactions", householdScoped: true },
  preview_rental_classifications: { functionName: "finance-rental-reporting", action: "preview_classifications", householdScoped: true },
  save_rental_classification: { functionName: "finance-rental-reporting", action: "save_classification", householdScoped: true },
  save_rental_classification_reviewed_atomic: { functionName: "finance-rental-reporting", action: "save_classification_reviewed_atomic", householdScoped: true },
  update_transaction: { functionName: "finance-transaction-management", action: "update", householdScoped: true },
  set_transaction_exclusions: { functionName: "finance-transaction-management", action: "set_exclusions", householdScoped: true },
  reviewed_transaction_state: { functionName: "finance-transaction-management", action: "reviewed_state", householdScoped: true },
  reviewed_transaction_update: { functionName: "finance-transaction-management", action: "reviewed_update", householdScoped: true },
  get_transaction_category_catalog: { functionName: "finance-live-data", action: "transaction_category_catalog", householdScoped: true },
  transaction_split_state: { functionName: "finance-transaction-management", action: "transaction_split_state", householdScoped: true },
  review_transaction_split: { functionName: "finance-transaction-management", action: "review_transaction_split", householdScoped: true },
  confirm_transaction_split: { functionName: "finance-transaction-management", action: "confirm_transaction_split", householdScoped: true },
  review_transaction_split_undo: { functionName: "finance-transaction-management", action: "review_transaction_split_undo", householdScoped: true },
  confirm_transaction_split_undo: { functionName: "finance-transaction-management", action: "confirm_transaction_split_undo", householdScoped: true },
  refund_relationship: { functionName: "finance-transaction-management", action: "refund_relationship", householdScoped: true },
  refund_candidates: { functionName: "finance-transaction-management", action: "refund_candidates", householdScoped: true },
  review_split_refund: { functionName: "finance-transaction-management", action: "review_split_refund", householdScoped: true },
  confirm_split_refund: { functionName: "finance-transaction-management", action: "confirm_split_refund", householdScoped: true },
  reviewed_refund_state: { functionName: "finance-transaction-management", action: "reviewed_refund_state", householdScoped: true },
  reviewed_refund_preview: { functionName: "finance-transaction-management", action: "reviewed_refund_preview", householdScoped: true },
  reviewed_refund_update: { functionName: "finance-transaction-management", action: "reviewed_refund_update", householdScoped: true },
  reviewed_refund_undo: { functionName: "finance-transaction-management", action: "reviewed_refund_undo", householdScoped: true },
  get_refund_preferences: { functionName: "finance-transaction-management", action: "get_refund_preferences", householdScoped: true },
  save_refund_preferences: { functionName: "finance-transaction-management", action: "save_refund_preferences", householdScoped: true },
  delete_transaction: { functionName: "finance-transaction-management", action: "delete", destructive: true, householdScoped: true },
  list_budget_targets: { functionName: "finance-budget-management", action: "list" },
  get_budget_progress: { functionName: "finance-budget-progress" },
  get_budget_category_context: { functionName: "finance-live-data", action: "get_budget_category_context", householdScoped: true },
  list_recurring: { functionName: "finance-live-data", action: "list_recurring", householdScoped: true },
  review_recurring_lifecycle: { functionName: "finance-live-data", action: "review_recurring_lifecycle", householdScoped: true },
  apply_recurring_lifecycle: { functionName: "finance-live-data", action: "apply_recurring_lifecycle", householdScoped: true },
  update_recurring: { functionName: "finance-live-data", action: "update_recurring", householdScoped: true },
  save_manual_recurring: { functionName: "finance-live-data", action: "save_manual_recurring", householdScoped: true },
  deactivate_manual_recurring: { functionName: "finance-live-data", action: "deactivate_manual_recurring", householdScoped: true },
  list_investments: { functionName: "finance-live-data", action: "list_investments", householdScoped: true },
  list_investment_history: { functionName: "finance-live-data", action: "list_investment_history", householdScoped: true },
  list_investment_activity: { functionName: "finance-live-data", action: "list_investment_activity", householdScoped: true },
  list_investment_evidence: { functionName: "finance-live-data", action: "list_investment_evidence", householdScoped: true },
  get_folio2_release_state: { functionName: "finance-live-data", action: "get_folio2_release_state", householdScoped: true },
  get_folio2_write_status: { functionName: "finance-live-data", action: "get_folio2_write_status", householdScoped: true },
  get_cash_forecast_funding: { functionName: "finance-live-data", action: "get_cash_forecast_funding", householdScoped: true },
  review_cash_forecast_funding: { functionName: "finance-live-data", action: "review_cash_forecast_funding", householdScoped: true },
  confirm_cash_forecast_funding: { functionName: "finance-live-data", action: "confirm_cash_forecast_funding", householdScoped: true },
  get_planning: { functionName: "finance-live-data", action: "get_planning", householdScoped: true },
  get_planning_refresh_status: { functionName: "finance-live-data", action: "get_planning_refresh_status", householdScoped: true },
  get_planning_history: { functionName: "finance-live-data", action: "get_planning_history", householdScoped: true },
  list_financial_plans: { functionName: "finance-live-data", action: "list_financial_plans", householdScoped: true },
  save_financial_plan: { functionName: "finance-live-data", action: "save_financial_plan", householdScoped: true },
  get_cash_floor_scope_evidence: { functionName: "finance-live-data", action: "get_cash_floor_scope_evidence", householdScoped: true },
  review_cash_floor_scope: { functionName: "finance-live-data", action: "review_cash_floor_scope", householdScoped: true },
  confirm_cash_floor_scope: { functionName: "finance-live-data", action: "confirm_cash_floor_scope", householdScoped: true },
  create_plan_scenario: { functionName: "finance-live-data", action: "create_plan_scenario", householdScoped: true },
  list_plan_scenarios: { functionName: "finance-live-data", action: "list_plan_scenarios", householdScoped: true },
  evaluate_agent_events: { functionName: "finance-live-data", action: "evaluate_agent_events", householdScoped: true },
  get_agent_state: { functionName: "finance-live-data", action: "get_agent_state", householdScoped: true },
  save_agent_memory: { functionName: "finance-live-data", action: "save_agent_memory", householdScoped: true },
  list_agent_events: { functionName: "finance-live-data", action: "list_agent_events", householdScoped: true },
  list_agent_event_history: { functionName: "finance-live-data", action: "list_agent_event_history", householdScoped: true },
  apply_agent_event_disposition: { functionName: "finance-live-data", action: "apply_agent_event_disposition", householdScoped: true },
  restore_agent_event_v2: { functionName: "finance-live-data", action: "restore_agent_event_v2", householdScoped: true },
  restore_agent_event: { functionName: "finance-live-data", action: "restore_agent_event", householdScoped: true },
  feedback_agent_event: { functionName: "finance-live-data", action: "feedback_agent_event", householdScoped: true },
  get_savings_goal_plan_state: { functionName: "finance-live-data", action: "get_savings_goal_plan_state", householdScoped: true },
  get_goal_settings_state: { functionName: "finance-live-data", action: "get_goal_settings_state", householdScoped: true },
  review_goal_savings_settings: { functionName: "finance-live-data", action: "review_goal_savings_settings", householdScoped: true },
  confirm_goal_savings_settings: { functionName: "finance-live-data", action: "confirm_goal_savings_settings", householdScoped: true },
  review_savings_goal_plan_creation: { functionName: "finance-live-data", action: "review_savings_goal_plan_creation", householdScoped: true },
  confirm_savings_goal_plan_creation: { functionName: "finance-live-data", action: "confirm_savings_goal_plan_creation", householdScoped: true },
  review_savings_goal_plan_edit: { functionName: "finance-live-data", action: "review_savings_goal_plan_edit", householdScoped: true },
  get_debt_goal_state: { functionName: "finance-live-data", action: "get_debt_goal_state", householdScoped: true },
  review_debt_goal: { functionName: "finance-live-data", action: "review_debt_goal", householdScoped: true },
  confirm_debt_goal: { functionName: "finance-live-data", action: "confirm_debt_goal", householdScoped: true },
  confirm_savings_goal_plan_edit: { functionName: "finance-live-data", action: "confirm_savings_goal_plan_edit", householdScoped: true },
  save_goal: { functionName: "finance-live-data", action: "save_goal", householdScoped: true },
  deactivate_goal: { functionName: "finance-live-data", action: "deactivate_goal", householdScoped: true },
  get_savings_activity: { functionName: "finance-live-data", action: "get_savings_activity", householdScoped: true },
  get_savings_overview: { functionName: "finance-live-data", action: "get_savings_overview", householdScoped: true },
  save_goal_savings_settings: { functionName: "finance-live-data", action: "save_goal_savings_settings", householdScoped: true },
  review_savings_activity: { functionName: "finance-live-data", action: "review_savings_activity", householdScoped: true },
  undo_savings_activity_decision: { functionName: "finance-live-data", action: "undo_savings_activity_decision", householdScoped: true },
  save_budget_target: { functionName: "finance-budget-management", action: "save" },
  get_budget_rollover_state: { functionName: "finance-budget-management", action: "get_budget_rollover_state", householdScoped: true },
  review_budget_rollover_edit: { functionName: "finance-budget-management", action: "review_budget_rollover_edit", householdScoped: true },
  confirm_budget_rollover_edit: { functionName: "finance-budget-management", action: "confirm_budget_rollover_edit", householdScoped: true },
  review_rollover_correction: { functionName: "finance-budget-management", action: "review_rollover_correction", householdScoped: true },
  confirm_rollover_correction: { functionName: "finance-budget-management", action: "confirm_rollover_correction", householdScoped: true },
  review_target_save: { functionName: "finance-budget-management", action: "review_target_save", householdScoped: true },
  confirm_target_save: { functionName: "finance-budget-management", action: "confirm_target_save", householdScoped: true },
  review_budget_move: { functionName: "finance-budget-management", action: "review_budget_move", householdScoped: true },
  confirm_budget_move: { functionName: "finance-budget-management", action: "confirm_budget_move", householdScoped: true },
  review_budget_move_undo: { functionName: "finance-budget-management", action: "review_budget_move_undo", householdScoped: true },
  confirm_budget_move_undo: { functionName: "finance-budget-management", action: "confirm_budget_move_undo", householdScoped: true },
  reallocate_budget_targets: { functionName: "finance-budget-management", action: "reallocate" },
  deactivate_budget_target: { functionName: "finance-budget-management", action: "deactivate" },
  apply_plan_budget_suggestion: { functionName: "finance-budget-management", action: "apply_plan_suggestion", householdScoped: true },
  reject_plan_budget_suggestion: { functionName: "finance-budget-management", action: "reject_plan_suggestion", householdScoped: true },
  list_categorization_rules: { functionName: "plaid-categorization-rules", action: "list", householdScoped: true },
  review_uncategorized_zelle: { functionName: "plaid-categorization-rules", action: "review_zelle", householdScoped: true },
  save_categorization_rule: { functionName: "plaid-categorization-rules", action: "save", householdScoped: true },
  delete_categorization_rule: { functionName: "plaid-categorization-rules", action: "deactivate", householdScoped: true },
};

export function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortedRequestError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortedRequestError());
      return;
    }
    onAbort = () => reject(abortedRequestError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => response.text()), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function waitForRetryDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const finish = (continueRetry: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(continueRetry);
    };
    const onAbort = () => finish(false);
    if (signal?.aborted) { finish(false); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type FolioOperationTiming = { requestId?: string; status: number; attempts: number; upstreamMs: number; outcome: "success" | "error" | "cancelled" | "timeout"; fresh?: boolean; stale?: boolean; generation?: number; revision?: number; refreshLagMs?: number };

function preparedTiming(data: unknown, requestId: string | undefined, status: number, attempts: number, upstreamMs: number, outcome: FolioOperationTiming["outcome"]): FolioOperationTiming {
  const value = isRecord(data) ? data : {};
  const parsedAt = typeof value.refreshed_at === "string" ? Date.parse(value.refreshed_at) : NaN;
  return {
    ...(requestId ? { requestId } : {}), status, attempts, upstreamMs, outcome,
    ...(typeof value.fresh === "boolean" ? { fresh: value.fresh } : {}),
    ...(typeof value.stale === "boolean" ? { stale: value.stale } : {}),
    ...(Number.isSafeInteger(value.generation) && Number(value.generation) >= 0 ? { generation: Number(value.generation) } : {}),
    ...(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? { revision: Number(value.revision) } : {}),
    ...(Number.isFinite(parsedAt) ? { refreshLagMs: Math.max(0, Math.min(86400000, Date.now() - parsedAt)) } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Folio tool responses are dynamic JSON, narrowed by each caller.
export async function callFolioOperation(tool: string, args: Row, authorization: string, options: { timeoutMs?: number; retry?: boolean; signal?: AbortSignal; requestId?: string } = {}): Promise<{ ok: boolean; status: number; data: any; metrics?: FolioOperationTiming }> {
  // Economic reads include pending activity unless the caller explicitly requests posted-only results.
  if (["search_transactions", "spending_summary", "monthly_transaction_summaries", "get_budget_progress"].includes(tool) && args.include_pending === undefined) {
    args = { ...args, include_pending: true };
  }
  const operation = folioOperations[tool];
  if (!operation) {
    return { ok: false, status: 400, data: { error: "Unsupported Folio operation." } };
  }
  if (operation.destructive && args.confirm_permanent !== true) {
    return { ok: false, status: 400, data: { error: "Permanent deletion requires explicit confirmation." } };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return { ok: false, status: 503, data: { error: "Folio has not been connected to Supabase." } };
  }

  const action = tool === "complete_account_link"
    ? (typeof args.link_token === "string" ? "complete_hosted_link" : "exchange_public_token")
    : operation.action;
  const householdId = operation.householdScoped ? process.env.FOLIO_HOUSEHOLD_ID : undefined;
  if (operation.householdScoped && !householdId) {
    return { ok: false, status: 503, data: { error: "Folio household routing is not configured." } };
  }
  const payload: Row = {
    ...args,
    ...(householdId ? { household_id: householdId } : {}),
    ...(action ? { action } : {}),
  };
  // Reads can be retried safely. In particular, budget-move previews must never
  // leave the client waiting on an upstream connection until the mobile browser
  // cancels it. Writes are deliberately not retried: an unknown write outcome
  // must be reconciled from fresh data rather than repeated automatically.
  const retryableRead = new Set([
    "get_assistant_state",
    "get_folio2_release_state", "get_folio2_write_status", "get_cash_forecast_funding",
    "list_accounts", "get_account_detail", "get_account_history_batch", "search_transactions", "spending_summary", "monthly_transaction_summaries", "get_rental_accounts", "get_rental_preferences", "get_rental_report", "search_rental_transactions", "preview_rental_classifications",
    "get_budget_progress", "get_budget_category_context", "list_budget_targets", "get_budget_rollover_state", "review_budget_rollover_edit", "review_rollover_correction", "review_target_save", "review_budget_move", "review_budget_move_undo", "transaction_split_state", "list_recurring", "review_recurring_lifecycle", "list_investments", "list_agent_events", "list_agent_event_history",
    "list_investment_history", "list_investment_activity", "list_investment_evidence", "get_planning", "get_planning_refresh_status", "get_planning_history", "get_savings_activity", "get_savings_overview", "list_categorization_rules",
  ]).has(tool);
  const investmentEvidenceRead = tool === "list_investment_evidence";
  const preparedTransactionRead = new Set(["search_transactions", "spending_summary", "monthly_transaction_summaries", "get_budget_progress"]).has(tool);
  const planningRefreshStatusRead = tool === "get_planning_refresh_status";
  const accountHistoryBatchRead = tool === "get_account_history_batch";
  const planningSnapshotRead = tool === "get_planning";
  const reviewedTransactionStateRead = tool === "reviewed_transaction_state";
  const splitStateRead = tool === "transaction_split_state";
  // The cached forecast lookup can itself take 10–11 seconds on the existing
  // snapshot index. A second request after an 8-second abort overlaps the same
  // read and adds pressure without helping the refresh worker.
  // Ask's lightweight household access gate may encounter transient Edge cold
  // starts. It opts into one bounded retry; ordinary status polling remains
  // single-attempt unless its caller explicitly requests retry.
  const attempts = options.retry === false || preparedTransactionRead || planningSnapshotRead || (planningRefreshStatusRead && options.retry !== true) || accountHistoryBatchRead || investmentEvidenceRead || reviewedTransactionStateRead || splitStateRead ? 1 : retryableRead ? 2 : 1;
  const bankSync = tool === "sync_transactions" || tool === "sync_account";
  const preparedReplicaSync = tool === "sync_prepared_transactions";
  const timeoutMs = options.timeoutMs ?? (bankSync ? 60000 : investmentEvidenceRead ? 70000 : planningRefreshStatusRead ? 1500 : planningSnapshotRead ? 12000 : accountHistoryBatchRead || preparedReplicaSync || preparedTransactionRead || splitStateRead ? 20000 : retryableRead ? 8000 : 15000);
  const timeoutMessage = bankSync
    ? "Bank refresh could not be confirmed. Saved data is still available; the bank sync may finish in the background."
    : "Folio could not confirm the request in time. Refresh the data before trying again.";
  const startedAt = Date.now();
  const retryDelays = Array.from({ length: Math.max(0, attempts - 1) }, (_, index) => Math.min(400, 150 * (index + 1)));
  const deadlineAt = startedAt + timeoutMs * attempts + retryDelays.reduce((total, delay) => total + delay, 0);
  let response: Response | null = null;
  let responseText: string | null = null;
  let attemptsUsed = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    attemptsUsed = attempt + 1;
    const remainingBudgetMs = deadlineAt - Date.now();
    if (remainingBudgetMs <= 0) {
      const upstreamMs = Date.now() - startedAt;
      const metrics = preparedTiming(null, options.requestId, 504, attemptsUsed - 1, upstreamMs, "timeout");
      console.warn("Folio operation timing", { operation: tool, function: operation.functionName, ...metrics });
      return { ok: false, status: 504, data: { error: timeoutMessage }, metrics };
    }
    let retrying = false;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remainingBudgetMs));
    try {
      response = await fetch(`${supabaseUrl}/functions/v1/${operation.functionName}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: anonKey, authorization },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok && attempt < attempts - 1 && response.status >= 500) {
        retrying = true;
        console.warn("Folio read retry", { requestId: options.requestId, operation: tool, status: response.status, attempt: attempt + 1, outcome: "upstream_error" });
      } else {
        // Keep the deadline and caller cancellation relay alive until the body
        // is fully consumed, not only until fetch receives response headers.
        responseText = await readResponseText(response, controller.signal);
        break;
      }
    } catch {
      if (options.signal?.aborted) {
        const upstreamMs = Date.now() - startedAt;
        const metrics = preparedTiming(null, options.requestId, 499, attemptsUsed, upstreamMs, "cancelled");
        console.info("Folio operation timing", { operation: tool, function: operation.functionName, ...metrics });
        return { ok: false, status: 499, data: { error: "This request is no longer needed." }, metrics };
      }
      if (attempt === attempts - 1) {
        const upstreamMs = Date.now() - startedAt;
        const metrics = preparedTiming(null, options.requestId, 504, attemptsUsed, upstreamMs, "timeout");
        console.warn("Folio operation timing", { operation: tool, function: operation.functionName, ...metrics });
        return { ok: false, status: 504, data: { error: timeoutMessage }, metrics };
      }
      retrying = true;
      console.warn("Folio read retry", { requestId: options.requestId, operation: tool, attempt: attempt + 1, outcome: "timeout" });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", relayAbort);
    }
    if (attempt < attempts - 1 && retrying) {
      const waited = await waitForRetryDelay(retryDelays[attempt], options.signal);
      if (!waited) {
        const upstreamMs = Date.now() - startedAt;
        const metrics = preparedTiming(null, options.requestId, 499, attemptsUsed, upstreamMs, "cancelled");
        console.info("Folio operation timing", { operation: tool, function: operation.functionName, ...metrics });
        return { ok: false, status: 499, data: { error: "This request is no longer needed." }, metrics };
      }
    }
  }
  if (!response || responseText === null) {
    const upstreamMs = Date.now() - startedAt;
    const metrics = preparedTiming(null, options.requestId, 504, attemptsUsed, upstreamMs, "timeout");
    console.warn("Folio operation timing", { operation: tool, function: operation.functionName, ...metrics });
    return { ok: false, status: 504, data: { error: timeoutMessage }, metrics };
  }
  let data: unknown;
  let validJson = true;
  try {
    data = JSON.parse(responseText);
  } catch {
    validJson = false;
    data = { error: "Folio returned an unreadable response." };
  }
  const validEnvelope = validJson && isRecord(data);
  if (!validEnvelope) data = { error: validJson ? "Folio returned an invalid response." : "Folio returned an unreadable response." };
  const status = response.ok && !validEnvelope ? 502 : response.status;
  const upstreamMs = Date.now() - startedAt;
  const metrics = preparedTiming(data, options.requestId, status, attemptsUsed, upstreamMs, response.ok && validEnvelope ? "success" : "error");
  console.info("Folio operation timing", { operation: tool, function: operation.functionName, ...metrics });
  return { ok: response.ok && validEnvelope, status, data, metrics };
}

type AssistantFinalizationInput = {
  request_id: string;
  attempt_token: string;
  content: string;
  generation_status: "complete" | "failed" | "interrupted";
  pending_action_summaries?: string[];
  pending_action_tools?: string[];
  pending_action_fingerprints?: string[];
};

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function assistantUuid() {
  return globalThis.crypto.randomUUID();
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticatedFolioUserId(authorization: string) {
  const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Folio has not been connected to Supabase.");
  const response = await fetch(`${url}/auth/v1/user`, { headers: { authorization, apikey: anonKey }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Folio could not verify the signed-in account for Assistant reply saving.");
  const user = await response.json().catch(() => null);
  if (!isRecord(user) || typeof user.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id)) {
    throw new Error("Folio could not verify the signed-in account for Assistant reply saving.");
  }
  return user.id;
}

/** Create a short-lived ES256 proof for one authenticated server-side turn completion. */
export async function signAssistantFinalization(authorization: string, input: AssistantFinalizationInput) {
  const privateJwkText = process.env.FOLIO_ASSISTANT_SIGNING_PRIVATE_JWK;
  const keyId = process.env.FOLIO_ASSISTANT_SIGNING_KEY_ID;
  const householdId = process.env.FOLIO_HOUSEHOLD_ID;
  if (!privateJwkText || !keyId || !householdId) throw new Error("Assistant reply saving is not configured.");
  let jwk: JsonWebKey & { kid?: string };
  try { jwk = JSON.parse(privateJwkText); } catch { throw new Error("Assistant reply saving is not configured."); }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || (jwk.kid && jwk.kid !== keyId)) {
    throw new Error("Assistant reply saving is not configured.");
  }
  const userId = await authenticatedFolioUserId(authorization);
  const issued = Math.floor(Date.now() / 1000);
  const claims = {
    aud: "folio-assistant-finish",
    household_id: householdId,
    user_id: userId,
    request_id: input.request_id,
    attempt_token: input.attempt_token,
    content_sha256: await sha256Hex(input.content),
    generation_status: input.generation_status,
    pending_action_summaries: input.pending_action_summaries ?? [],
    pending_action_tools: input.pending_action_tools ?? [],
    pending_action_fingerprints: input.pending_action_fingerprints ?? [],
    iat: issued,
    exp: issued + 15 * 60,
    jti: assistantUuid(),
  };
  const header = { alg: "ES256", typ: "JWT", kid: keyId };
  const bytes = new TextEncoder();
  const encodedHeader = base64url(bytes.encode(JSON.stringify(header)));
  const encodedPayload = base64url(bytes.encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await globalThis.crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes.encode(signingInput)));
  return `${signingInput}.${base64url(signature)}`;
}

export type AssistantDecisionReceiptInput = {
  message_id: string;
  proposal_id: string;
  tool: string;
  proposal_sha256: string;
  outcome: "applied" | "failed" | "unknown";
  evidence_kind?: string;
  evidence_id?: string;
  operation_result?: unknown;
};

/** Sign a post-operation receipt using the existing Assistant signing key. */
export async function signAssistantDecisionReceipt(authorization: string, input: AssistantDecisionReceiptInput) {
  const privateJwkText = process.env.FOLIO_ASSISTANT_SIGNING_PRIVATE_JWK;
  const keyId = process.env.FOLIO_ASSISTANT_SIGNING_KEY_ID;
  const householdId = process.env.FOLIO_HOUSEHOLD_ID;
  if (!privateJwkText || !keyId || !householdId) throw new Error("Assistant decision receipts are not configured.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.message_id) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.proposal_id) ||
      !/^[0-9a-f]{64}$/i.test(input.proposal_sha256) ||
      !input.tool.trim() || !["applied", "failed", "unknown"].includes(input.outcome)) throw new Error("Assistant decision receipt input is invalid.");
  const resultText = JSON.stringify(input.operation_result ?? { evidence_id: input.evidence_id ?? null }) ?? "null";
  if (resultText.length > 128_000) throw new Error("Assistant decision receipt result is too large.");
  let jwk: JsonWebKey & { kid?: string };
  try { jwk = JSON.parse(privateJwkText); } catch { throw new Error("Assistant decision receipts are not configured."); }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || (jwk.kid && jwk.kid !== keyId)) throw new Error("Assistant decision receipts are not configured.");
  const userId = await authenticatedFolioUserId(authorization);
  const issued = Math.floor(Date.now() / 1000);
  const claims = {
    aud: "folio-assistant-receipt", household_id: householdId, user_id: userId,
    message_id: input.message_id, proposal_id: input.proposal_id, tool: input.tool,
    proposal_sha256: input.proposal_sha256,
    outcome: input.outcome, evidence_kind: input.evidence_kind ?? null, evidence_id: input.evidence_id ?? null,
    operation_sha256: await sha256Hex(resultText), iat: issued, exp: issued + 15 * 60, jti: assistantUuid(),
  };
  const header = { alg: "ES256", typ: "JWT", kid: keyId };
  const bytes = new TextEncoder();
  const encodedHeader = base64url(bytes.encode(JSON.stringify(header)));
  const encodedPayload = base64url(bytes.encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await globalThis.crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes.encode(signingInput)));
  return `${signingInput}.${base64url(signature)}`;
}

/** Check server-only signing configuration before reserving a persistent turn. */
export async function assistantFinalizationSigningReady() {
  const privateJwkText = process.env.FOLIO_ASSISTANT_SIGNING_PRIVATE_JWK;
  const keyId = process.env.FOLIO_ASSISTANT_SIGNING_KEY_ID;
  const householdId = process.env.FOLIO_HOUSEHOLD_ID;
  if (!privateJwkText || !keyId || !householdId) return false;
  try {
    const jwk = JSON.parse(privateJwkText) as JsonWebKey & { kid?: string };
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || (jwk.kid && jwk.kid !== keyId)) return false;
    await globalThis.crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return true;
  } catch {
    return false;
  }
}

/** Server-only, non-retrying Edge write. It is intentionally absent from folioOperations and /api/folio. */
export async function callAssistantFinalization(authorization: string, input: AssistantFinalizationInput, proof: string) {
  const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY, householdId = process.env.FOLIO_HOUSEHOLD_ID;
  if (!url || !anonKey || !householdId) return { ok: false, status: 503, data: { error: "Assistant reply saving is not configured." } };
  try {
    const response = await fetch(`${url}/functions/v1/finance-live-data`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey, authorization },
      body: JSON.stringify({
        action: "finish_assistant_turn", household_id: householdId, ...input, proof,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({ error: "Assistant reply save returned an unreadable response." }));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 503, data: { error: "Folio could not confirm that the Assistant reply was saved. Refresh the conversation before retrying." } };
  }
}
