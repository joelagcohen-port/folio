export type BudgetAdjustmentStyle = 'cautious' | 'balanced' | 'flexible' | 'custom';
export type CategoryPermission = 'automatic' | 'ask_me' | 'never_adjust';

export type BudgetAdjustmentStyleDefinition = { id: Exclude<BudgetAdjustmentStyle, 'custom'>; label: string; description: string; per_adjustment: number; per_month: number };

export function defaultBudgetCategoryPermission(category: { label?: unknown; type?: unknown; category_type?: unknown; excluded_from_budget?: unknown; planning_group?: unknown; group_name?: unknown }): CategoryPermission {
  const label = String(category.label ?? '').trim();
  const type = String(category.type ?? category.category_type ?? 'expense');
  const group = String(category.planning_group ?? category.group_name ?? '');
  if (!label || type !== 'expense' || category.excluded_from_budget === true || (category as any).protected === true || group === 'Fixed' || group === 'Non-monthly') return 'never_adjust';
  if ((category as any).default_budget_permission === 'never_adjust') return 'never_adjust';
  if ((category as any).default_budget_permission === 'ask_me') return 'ask_me';
  if ((category as any).default_budget_permission === 'automatic' || group === 'Flexible') return 'automatic';
  return 'never_adjust';
}

export function inferBudgetAdjustmentStyle(policy: Record<string, any> | null | undefined, definitions: BudgetAdjustmentStyleDefinition[] = []): BudgetAdjustmentStyle {
  if (!policy || (!policy.policy_id && policy.max_amount == null && policy.max_monthly_amount == null)) return 'balanced';
  if (['cautious','balanced','flexible','custom'].includes(String(policy.adjustment_style))) return policy.adjustment_style;
  const { max_amount: per, max_monthly_amount: month } = policy;
  const match = definitions.find((item) => Number(per) === item.per_adjustment && Number(month) === item.per_month);
  return match?.id || 'custom';
}

export function limitsForBudgetStyle(style: BudgetAdjustmentStyle, definitions: BudgetAdjustmentStyleDefinition[] = [], prior?: Record<string, any>) {
  if (style === 'custom') return { perAdjustment: Number(prior?.max_amount), perMonth: Number(prior?.max_monthly_amount) };
  const definition = definitions.find((item) => item.id === style);
  return definition ? { perAdjustment: definition.per_adjustment, perMonth: definition.per_month } : null;
}

