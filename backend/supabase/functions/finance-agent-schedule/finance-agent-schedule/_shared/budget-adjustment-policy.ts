export type BudgetAdjustmentStyle = 'cautious' | 'balanced' | 'flexible' | 'custom';
export type CategoryPermission = 'automatic' | 'ask_me' | 'never_adjust';

export const BUDGET_STYLE_LIMITS = {
  cautious: { perAdjustment: 25, perMonth: 75 },
  balanced: { perAdjustment: 50, perMonth: 150 },
  flexible: { perAdjustment: 100, perMonth: 300 },
} as const;

export const BUDGET_ADJUSTMENT_STYLE_CATALOG = [
  { id: 'cautious', label: 'Cautious', description: 'Smaller changes with a lower monthly cap.', per_adjustment: BUDGET_STYLE_LIMITS.cautious.perAdjustment, per_month: BUDGET_STYLE_LIMITS.cautious.perMonth },
  { id: 'balanced', label: 'Balanced', description: 'Moderate changes with a moderate monthly cap.', per_adjustment: BUDGET_STYLE_LIMITS.balanced.perAdjustment, per_month: BUDGET_STYLE_LIMITS.balanced.perMonth },
  { id: 'flexible', label: 'Flexible', description: 'Larger changes with a higher monthly cap.', per_adjustment: BUDGET_STYLE_LIMITS.flexible.perAdjustment, per_month: BUDGET_STYLE_LIMITS.flexible.perMonth },
] as const;

export function defaultBudgetCategoryPermission(category: { label?: unknown; type?: unknown; category_type?: unknown; excluded_from_budget?: unknown; planning_group?: unknown; group_name?: unknown; protected?: unknown }): CategoryPermission {
  const label = String(category.label ?? '').trim();
  const type = String(category.type ?? category.category_type ?? 'expense');
  const group = String(category.planning_group ?? category.group_name ?? '');
  if (!label || type !== 'expense' || category.excluded_from_budget === true || category.protected === true || group === 'Fixed' || group === 'Non-monthly') return 'never_adjust';
  if (group === 'Flexible') return 'automatic';
  return 'ask_me';
}

export function limitsForBudgetStyle(style: BudgetAdjustmentStyle, prior?: Record<string, any>) {
  return style === 'custom' ? { perAdjustment: Number(prior?.max_amount), perMonth: Number(prior?.max_monthly_amount) } : BUDGET_STYLE_LIMITS[style];
}

export function getEffectiveCategoryFloor(input: { consumed: number; committed: number; projected: number; legacyMinimum?: number | null; customerReserve?: number | null }) {
  const legacyFloor = input.legacyMinimum ?? 0;
  const additionalReserve = input.customerReserve ?? 0;
  if (!Number.isFinite(input.consumed) || input.consumed === null || input.consumed === undefined) return null;
  if (![input.committed, input.projected, legacyFloor, additionalReserve].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
  return Math.max(0, input.projected, legacyFloor, input.consumed + input.committed + additionalReserve);
}
