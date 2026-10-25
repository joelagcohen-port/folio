export const FOLIO_API_GENERATION = 1;
export const FOLIO_MIN_SUPPORTED_GENERATION = 1;

export function folioClientNeedsUpdate(request: Request) {
  const clientGeneration = Number(request.headers.get("x-folio-api-generation"));
  return !Number.isInteger(clientGeneration) || clientGeneration < FOLIO_MIN_SUPPORTED_GENERATION || clientGeneration !== FOLIO_API_GENERATION;
}

export function folioReadNeedsUpdate(request: Request) {
  const raw = request.headers.get("x-folio-api-generation");
  const generation = raw === null ? 0 : Number(raw);
  return !Number.isInteger(generation) || generation < FOLIO_MIN_SUPPORTED_GENERATION - 1 || generation > FOLIO_API_GENERATION;
}

export function folioUpdateRequiredResponse() {
  return Response.json({ error: "This Folio version needs to update before it can make changes.", code: "CLIENT_UPDATE_REQUIRED", apiGeneration: FOLIO_API_GENERATION, minSupportedGeneration: FOLIO_MIN_SUPPORTED_GENERATION }, { status: 409, headers: { "cache-control": "no-store" } });
}

const readOnlyTools = new Set([
  ...Object.keys({
    get_autonomy_state: true, get_transaction_category_catalog: true, get_notification_settings: true, get_agent_event_detail: true,
    list_accounts: true, get_account_detail: true, get_account_history_batch: true, get_rental_accounts: true, get_rental_preferences: true,
    get_rental_report: true, search_rental_transactions: true, preview_rental_classifications: true,
    refund_candidates: true, reviewed_refund_state: true, get_refund_preferences: true, transaction_split_state: true,
    list_budget_targets: true, get_budget_progress: true, get_budget_category_context: true, get_budget_rollover_state: true, review_budget_rollover_edit: true, review_rollover_correction: true, review_target_save: true, review_budget_move: true, review_budget_move_undo: true, list_recurring: true, review_recurring_lifecycle: true, list_investments: true,
    list_investment_history: true, list_investment_activity: true, get_planning: true,
    get_planning_refresh_status: true, get_planning_history: true, list_financial_plans: true,
    get_agent_state: true, get_assistant_state: true, list_agent_events: true, list_agent_event_history: true, list_categorization_rules: true,
    spending_summary: true, monthly_transaction_summaries: true, search_transactions: true,
    get_completed_year_spending: true, sync_prepared_transactions: true, refresh_status: true,
  }),
  "guided_budget_preview", "guided_budget_reallocation_preview",
]);

export function isFolioWriteTool(tool: string, args: Record<string, unknown> = {}) {
  if (tool === "get_agent_state" && args.mark_seen === true) return true;
  return !readOnlyTools.has(tool);
}
