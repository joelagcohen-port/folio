import "./savings-math.js";

type Row = Record<string, any>;
type ScenarioInput = {
  activeHouseholdId: string;
  householdId: string;
  recommendation: Row;
  plan: Row;
  financialState: Row;
  goals: Row[];
  allPlans: Row[];
  selection: { recommendationId: string; planVersion: number; stateVersion: string; adjustmentIds: string[] };
};

const money = (value: unknown): number | null => value === null || value === undefined || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
const active = (rule: Row, today: string) => !rule.expires_on || rule.expires_on >= today;
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });

/**
 * Derive a read-only comparison from the currently persisted recommendation and canonical financial state.
 * Potential reductions are conditional behavior scenarios; they are not verified savings or cash flow.
 */
export function buildPlanScenario(input: ScenarioInput) {
  const { householdId, activeHouseholdId, recommendation, plan, financialState: state, goals, selection } = input || {} as ScenarioInput;
  if (!householdId || householdId !== activeHouseholdId) return fail("household_mismatch", "The active household could not be verified.");
  if (!recommendation || !plan || !state || !selection || !Array.isArray(goals) || !Array.isArray(input.allPlans)) return fail("invalid_input", "A current plan, recommendation, financial state, goals, active-plan catalog, and selection are required.");
  if (!Array.isArray(selection.adjustmentIds) || selection.adjustmentIds.length === 0 || selection.adjustmentIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(selection.adjustmentIds).size !== selection.adjustmentIds.length) return fail("invalid_selection", "Choose one or more unique recommendation adjustments.");
  if (!Number.isInteger(selection.planVersion) || !Number.isInteger(plan.version) || selection.planVersion !== plan.version || recommendation.plan_version !== plan.version) return fail("stale_plan", "The plan changed. Reload its current recommendation before exploring it.");
  if (typeof selection.stateVersion !== "string" || !selection.stateVersion || selection.stateVersion !== state.financialStateVersion || recommendation.financial_state_version !== state.financialStateVersion || !state.financialRevision || recommendation.financial_revision !== state.financialRevision) return fail("stale_state", "Financial data changed. Reload the current recommendation before exploring it.");
  if (selection.recommendationId !== recommendation.recommendation_id || recommendation.plan_id !== plan.plan_id || !["active", "ready", "partial"].includes(recommendation.status)) return fail("stale_recommendation", "This recommendation is no longer available.");
  if (plan.status !== "active" || plan.plan_type !== "spending_reduction" || !validDate(state.today) || !validDate(plan.starts_on) || !validDate(plan.ends_on) || state.today < plan.starts_on || state.today > plan.ends_on) return fail("invalid_plan", "Only a current active spending plan can be explored.");
  if (state.loading === true || state.error === true || state.budgetsReady !== true || state.budgetCoachingReady !== true || !Array.isArray(state.budgets) || !Array.isArray(state.budgetCoaching)) return fail("incomplete_state", "Complete current budget and Budget Coach data is required.");
  const adjustments: Row[] = Array.isArray(recommendation.adjustments) ? recommendation.adjustments : [];
  const byId = new Map<string, Row>();
  for (const adjustment of adjustments) {
    if (!adjustment || typeof adjustment.category_id !== "string" || byId.has(adjustment.category_id)) return fail("invalid_recommendation", "The recommendation contains duplicate or invalid category adjustments.");
    byId.set(adjustment.category_id, adjustment);
  }
  const selected = selection.adjustmentIds.map((id) => byId.get(id));
  if (selected.some((item) => !item || (item.status && item.status !== "pending"))) return fail("invalid_selection", "Each selected adjustment must still be pending in this recommendation.");
  if (!Array.isArray(plan.category_ids) || plan.category_ids.some((id: unknown) => typeof id !== "string" || !id) || new Set(plan.category_ids).size !== plan.category_ids.length) return fail("invalid_plan", "The plan category scope is incomplete or duplicated.");
  const scope = new Set<string>(plan.category_ids);
  const constraints: Row[] = (Array.isArray(plan.constraints) ? plan.constraints : []).filter((rule: Row) => active(rule, state.today));
  const flexible = new Set(constraints.filter((rule) => rule.kind === "flexible_category").map((rule) => rule.category_id));
  const allSelectedIds = selection.adjustmentIds;
  if (allSelectedIds.some((id) => !scope.has(id) || !flexible.has(id))) return fail("out_of_scope", "A selected category is outside the plan’s approved flexible scope.");
  const allPlans: Row[] = input.allPlans;
  const constraintPlans: Row[] = [plan, ...allPlans.filter((item) => item?.plan_id !== plan.plan_id)];
  const categories: Row[] = [];
  const scopedForecasts: Row[] = [];
  for (const id of plan.category_ids as string[]) {
    const scopedBudget = state.budgets.find((row: Row) => row.id === id);
    const scopedForecast = state.budgetCoaching.find((row: Row) => row.id === id);
    if (!scopedBudget || !scopedForecast || scopedForecast.usable !== true || money(scopedForecast.projected) === null || money(scopedForecast.projected)! < 0) return fail("incomplete_state", "Complete current projections for every category in the plan scope are required.");
    scopedForecasts.push(scopedForecast);
  }
  for (const item of selected as Row[]) {
    const budget = state.budgets.find((row: Row) => row.id === item.category_id);
    const forecast = state.budgetCoaching.find((row: Row) => row.id === item.category_id);
    if (!budget || !forecast || forecast.usable !== true) return fail("incomplete_category", "Current budget and projection evidence is missing for a selected category.");
    const current = money(budget.target), recCurrent = money(item.current_monthly_target), proposed = money(item.proposed_monthly_target), reduction = money(item.potential_reduction), decrease = money(item.target_decrease);
    const spent = money(budget.spent), reserve = money(forecast.reserve), projected = money(forecast.projected);
    if ([current, recCurrent, proposed, reduction, decrease, spent, reserve, projected].some((value) => value === null || value < 0) || Math.abs(current! - recCurrent!) > 0.01 || Math.abs(current! - proposed! - decrease!) > 0.01 || reduction! > decrease! + 0.01 || proposed! > projected! - reduction! + 0.01) return fail("invalid_amount", "The recommendation has invalid amounts, exceeds projected capacity, or no longer matches the current category target.");
    let hardFloor = spent! + reserve!;
    for (const otherPlan of constraintPlans) {
      if (otherPlan.status !== "active" || !validDate(otherPlan.starts_on) || !validDate(otherPlan.ends_on) || state.today < otherPlan.starts_on || state.today > otherPlan.ends_on) continue;
      for (const rule of (Array.isArray(otherPlan.constraints) ? otherPlan.constraints : []).filter((candidate: Row) => active(candidate, state.today) && candidate.category_id === item.category_id)) {
        if (rule.kind === "protected_category" && rule.level === "hard") return fail("protected_category", "A selected category is protected by an active plan constraint.");
        if (rule.kind === "minimum_budget" && rule.level === "hard") {
          const floor = money(rule.amount);
          if (floor === null || floor < 0) return fail("invalid_floor", "A protected category minimum is invalid.");
          hardFloor = Math.max(hardFloor, floor);
        }
      }
    }
    if (proposed! + 0.001 < hardFloor) return fail("reserve_floor", "A proposed target falls below actual spending, known reserves, or a hard category minimum.");
    categories.push({ category_id: item.category_id, category_name: item.category_name || budget.name || item.category_id, current_monthly_target: current, proposed_monthly_target: proposed, target_decrease: decrease, potential_monthly_reduction: reduction, actual_spend: spent, known_reserve: reserve, protected_minimum: hardFloor });
  }
  const goalTarget = money(plan.target_monthly), baseline = money(plan.baseline_monthly), projectedSpend = money(scopedForecasts.reduce((sum, item) => sum + Number(item.projected), 0)), proposedReduction = money(categories.reduce((sum, item) => sum + item.potential_monthly_reduction, 0));
  if (goalTarget === null || baseline === null || projectedSpend === null || proposedReduction === null || proposedReduction <= 0) return fail("invalid_amount", "The plan target, complete projected spending, or selected potential reduction is invalid.");
  const baselineReduction = Math.round((baseline - projectedSpend) * 100) / 100;
  const proposedAchieved = Math.round((baselineReduction + proposedReduction) * 100) / 100;
  const baselineGap = Math.round(Math.max(0, goalTarget - baselineReduction) * 100) / 100;
  const proposedGap = Math.round(Math.max(0, goalTarget - proposedAchieved) * 100) / 100;
  const points = state.planning?.ready === true && state.planning?.complete === true && state.planning?.reliable === true && Array.isArray(state.planning?.points) ? state.planning.points : [];
  const horizon = Number(state.planning?.horizonDays);
  const cashScope = state.planning?.scope ?? state.planning?.scopeLabel;
  const completeCashForecast = cashScope === "Connected cash accounts" && Number.isInteger(horizon) && horizon > 0 && points.length === horizon + 1 && points.every((point: Row, index: number) => {
    const expectedDate = new Date(Date.parse(`${state.today}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
    return point?.date === expectedDate && money(point.balance) !== null;
  });
  const baselineCashLow = completeCashForecast ? Math.round(Math.min(...points.map((point: Row) => Number(point.balance))) * 100) / 100 : null;
  const baselineCashLowDate = baselineCashLow === null ? null : points.find((point: Row) => Number(point.balance) === baselineCashLow)?.date || null;
  const today = state.today, savingsAlternatives = [];
  for (const goal of goals) {
    if (!goal || goal.active === false) continue;
    const savingsPlan = constraintPlans.find((item) => item.plan_type === "savings" && item.status === "active" && item.goal_id === goal.goal_id && validDate(item.starts_on) && validDate(item.ends_on) && today >= item.starts_on && today <= item.ends_on);
    if (!savingsPlan) { savingsAlternatives.push({ goal_id: goal.goal_id, status: "unavailable", reason: "No matching active savings plan and deadline." }); continue; }
    const current = money(goal.current_amount), target = money(goal.target_amount), contribution = money(savingsPlan.target_monthly), start = savingsPlan.starts_on, end = savingsPlan.ends_on;
    if (current === null || target === null || contribution === null) { savingsAlternatives.push({ goal_id: goal.goal_id, status: "unavailable", reason: "Tracked goal amounts or active plan contribution are incomplete." }); continue; }
    const project = (globalThis as any).FolioSavingsMath?.project;
    if (typeof project !== "function") continue;
    const baselineProjection = project({ today, starts_on: start, ends_on: end, current, target, monthly: contribution });
    const overlapEnd = plan.ends_on < end ? plan.ends_on : end;
    const overlapProjection = today > overlapEnd ? null : project({ today, starts_on: start, ends_on: overlapEnd, current, target, monthly: contribution + proposedReduction });
    if (baselineProjection && overlapProjection) {
      const additionalMonths = Math.min(baselineProjection.months, overlapProjection.months);
      const projected = Math.round((overlapProjection.projected + Math.max(0, baselineProjection.months - additionalMonths) * contribution) * 100) / 100;
      const alternative = { months: baselineProjection.months, projected, shortfall: Math.round(Math.max(0, target - projected) * 100) / 100, required_monthly: null, additional_contribution_months: additionalMonths, potential_reduction_until: overlapEnd };
      savingsAlternatives.push({ goal_id: goal.goal_id, goal_name: goal.name || "Savings goal", status: "available", deadline: end, current_amount: current, target_amount: target, current_monthly_contribution: contribution, alternative_monthly_contribution: Math.round((contribution + proposedReduction) * 100) / 100, baseline: baselineProjection, alternative, allocation: "separate_alternative_not_simultaneous", assumption: "Potential contribution applies only while both plans overlap. This is an individual what-if; potential spending reductions are not verified deposits or cash available to contribute." });
    }
  }
  const categoryIds = new Set(categories.map((item) => item.category_id));
  if (categoryIds.size !== categories.length) return fail("duplicate_selection", "A category can only be counted once in a scenario.");
  return { ok: true as const, scenario: {
    scenario_version: "folio-plan-scenario-v1", created_for: { plan_id: plan.plan_id, plan_version: plan.version, recommendation_id: recommendation.recommendation_id, financial_state_version: state.financialStateVersion },
    assumptions: ["Selected potential reductions occur only if the member changes behavior to meet the suggested targets.", "Category target changes do not update the connected-cash forecast.", "Savings alternatives assume the full potential reduction is separately contributed each month; they are not additive across goals."],
    monthly_plan: { goal_target: goalTarget, baseline_projected_reduction: baselineReduction, proposed_projected_reduction: proposedAchieved, potential_reduction: proposedReduction, baseline_shortfall: baselineGap, proposed_shortfall: proposedGap, unit: "monthly USD" },
    budget_impact: { baseline_selected_targets: Math.round(categories.reduce((sum, item) => sum + item.current_monthly_target, 0) * 100) / 100, proposed_selected_targets: Math.round(categories.reduce((sum, item) => sum + item.proposed_monthly_target, 0) * 100) / 100, target_decrease: Math.round(categories.reduce((sum, item) => sum + item.target_decrease, 0) * 100) / 100, categories },
    cash_impact: { status: baselineCashLow === null ? "unknown_not_modeled" : "baseline_known_proposed_unknown", baseline_low: baselineCashLow, baseline_low_date: baselineCashLowDate, proposed_low: null, proposed_low_date: null, explanation: "The complete existing forecast provides only the baseline cash low; it does not model category budget target changes, so the proposed cash low is unknown." },
    savings_alternatives: savingsAlternatives,
    recommendation: "Potential outcomes only; no savings or cash-flow change is guaranteed."
  } };
}
