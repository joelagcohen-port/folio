// Shapes are validated against the authenticated autonomy catalog before these view helpers run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PolicyDraft = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionMetadata = Record<string, any>;

export function canReviewAutonomyPolicy(draft: PolicyDraft, action: ActionMetadata): boolean {
  if (draft.min_confidence_percent === '' || draft.min_confidence_percent === null || draft.min_confidence_percent === undefined) return false;
  const confidence = Number(draft.min_confidence_percent);
  const floor = Number(action.default_min_confidence ?? 0) * 100;
  if (!Number.isFinite(confidence) || confidence < floor || confidence > 100) return false;
  if ((draft.scope?.category_ids?.length ?? 0) < Number(action.min_categories ?? 0)) return false;
  if (!action.requires_limits) return true;
  const perAction = Number(draft.max_amount), monthly = Number(draft.max_monthly_amount);
  const limit = Number(action.max_amount_cents ?? 0) / 100;
  const centsSafe = (value: number, allowZero = false) => {
    const scaled = value * 100, rounded = Math.round(scaled);
    return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-7;
  };
  if (draft.cash_floor === '' || draft.cash_floor === null || draft.cash_floor === undefined) return false;
  return centsSafe(perAction) && centsSafe(monthly) && perAction <= limit && centsSafe(Number(draft.cash_floor), true);
}

export function autonomyPolicyPayload(draft: PolicyDraft, action: ActionMetadata) {
  const { min_confidence_percent, action_limit, required_scope_category_count, ...policy } = draft;
  void action_limit;
  void required_scope_category_count;
  const sourceScope = draft.scope && typeof draft.scope === 'object' ? draft.scope : {};
  const scopeIds = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  const scope: PolicyDraft = {
    category_ids: scopeIds(sourceScope.category_ids),
    plan_ids: scopeIds(sourceScope.plan_ids),
    account_ids: scopeIds(sourceScope.account_ids),
    merchant_ids: scopeIds(sourceScope.merchant_ids),
  };
  if (typeof sourceScope.monthly_budget === 'boolean') scope.monthly_budget = sourceScope.monthly_budget;
  const result: PolicyDraft = { ...policy, scope, min_confidence: Number(min_confidence_percent) / 100, expected_version: draft.expected_version ?? 0 };
  if (!action.requires_limits) {
    delete result.max_amount;
    delete result.max_monthly_amount;
    delete result.cash_floor;
  } else {
    result.max_amount = Number(result.max_amount);
    result.max_monthly_amount = Number(result.max_monthly_amount);
    result.cash_floor = Number(result.cash_floor);
  }
  return result;
}

export function autonomyPreviewStatus(status: unknown) {
  if (status === 'dry_run_would_execute') return 'Would qualify — no change made';
  if (status === 'dry_run_blocked') return 'Blocked';
  if (status === 'policy_saved') return 'Policy saved — preview only';
  return 'Preview result';
}
