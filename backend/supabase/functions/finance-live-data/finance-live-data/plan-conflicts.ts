import { evaluateFinancialPlan, recommendSpendingAdjustments } from "./plan-engine.ts";

type Row = Record<string, any>;
const money = (value: unknown): number | null => value === null || value === undefined || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
const ownsHousehold = (row: Row, householdId: string) => row && (row.household_id === undefined || row.household_id === null || row.household_id === householdId);

/**
 * Read-only, deterministic cross-plan analysis. Category reductions are potential behavior,
 * never verified savings or free cash. No plan or goal is modified by this function.
 */
export function analyzePlanConflicts(input: {
  householdId: string;
  activeHouseholdId: string;
  plans: Row[];
  financialState: Row;
  goals: Row[];
  recommendations?: Row[];
  memories?: Row[];
}) {
  const { householdId, activeHouseholdId, plans, financialState: state, goals, recommendations = [], memories = [] } = input || {} as any;
  if (!householdId || householdId !== activeHouseholdId) return fail("household_mismatch", "The active household could not be verified.");
  if (!Array.isArray(plans) || !state || !Array.isArray(goals) || !Array.isArray(recommendations) || !validDate(state.today)) return fail("invalid_input", "Current plans, financial state, goals, and a valid date are required.");
  if (![...plans, ...goals, ...recommendations].every((row: Row) => ownsHousehold(row, householdId)) || !ownsHousehold(state, householdId)) return fail("household_mismatch", "Household data did not match the active household.");

  const today = state.today;
  const current = plans.filter((p: Row) => p?.status === "active" && validDate(p.starts_on) && validDate(p.ends_on) && today >= p.starts_on && today <= p.ends_on).map((p: Row) => ({
    ...p,
    // An invalid expiry must not silently disable a hard protection. Treat it as unexpired.
    constraints: (Array.isArray(p.constraints) ? p.constraints : []).map((rule: Row) => rule?.level === "hard" && rule.expires_on && !validDate(rule.expires_on) ? { ...rule, expires_on: null } : rule)
  }));
  const sorted = [...current].sort((a: Row, b: Row) => priority(a) - priority(b) || String(a.plan_id || "").localeCompare(String(b.plan_id || "")));
  const goalById = new Map(goals.filter((g: Row) => g?.goal_id).map((g: Row) => [g.goal_id, g]));
  const evaluations = new Map<string, Row>();
  const recByPlan = new Map<string, Row>();
  for (const rec of recommendations) {
    if (rec?.plan_id && !recByPlan.has(String(rec.plan_id))) recByPlan.set(String(rec.plan_id), rec);
  }
  const planResults: Row[] = sorted.map((plan: Row) => {
    const evaluation = evaluateFinancialPlan(plan, state, plan.goal_id ? goalById.get(plan.goal_id) || null : null);
    evaluations.set(String(plan.plan_id), evaluation);
    return { plan_id: plan.plan_id, version: plan.version, name: plan.name || evaluation.plan_name, plan_type: plan.plan_type, priority: priority(plan), assessment: evaluation.assessment, evaluation, conflicts: [], allocation: { status: "not_applicable", monthly_potential: 0, categories: [], unresolved_shortfall: null } };
  });
  const resultById = new Map(planResults.map((r: Row) => [String(r.plan_id), r]));
  const conflictRows: Row[] = [];
  const opportunities: Row[] = [];
  const spending = sorted.filter((p: Row) => p.plan_type === "spending_reduction");

  // Report every real same-category claim, including when capacity is not measurable.
  const categoryOwners = new Map<string, Row[]>();
  for (const plan of spending) {
    const ids = Array.isArray(plan.category_ids) ? [...new Set(plan.category_ids.filter((id: unknown) => typeof id === "string" && id.length))] : [];
    for (const id of ids) categoryOwners.set(id, [...(categoryOwners.get(id) || []), plan]);
  }
  for (const [categoryId, owners] of categoryOwners) if (owners.length > 1) {
    const ordered = [...owners].sort((a, b) => priority(a) - priority(b) || String(a.plan_id).localeCompare(String(b.plan_id)));
    const conflict = { type: "overlapping_category_claim", category_id: categoryId, plan_ids: ordered.map(p => p.plan_id), priority_order: ordered.map(p => ({ plan_id: p.plan_id, priority: priority(p) })), status: "shared_claim", evidence: { source: "active_plan_category_scope", category_id: categoryId, claim_count: owners.length } };
    conflictRows.push(conflict);
    for (const p of ordered) resultById.get(String(p.plan_id))?.conflicts.push(conflict);
  }

  // Hard protections are household-wide; priority never removes one.
  const protectedByCategory = new Map<string, { protected: boolean; minimum: number; invalid: boolean; planIds: string[] }>();
  for (const p of sorted) for (const c of (Array.isArray(p.constraints) ? p.constraints : [])) {
    if (!c || (c.expires_on && validDate(c.expires_on) && c.expires_on < today) || !c.category_id || c.level !== "hard") continue;
    if (c.kind !== "protected_category" && c.kind !== "minimum_budget") continue;
    const entry = protectedByCategory.get(c.category_id) || { protected: false, minimum: 0, invalid: false, planIds: [] };
    if (!entry.planIds.includes(p.plan_id)) entry.planIds.push(p.plan_id);
    if (c.kind === "protected_category") entry.protected = true;
    else { const floor = money(c.amount); if (floor === null || floor < 0) entry.invalid = true; else entry.minimum = Math.max(entry.minimum, floor); }
    protectedByCategory.set(c.category_id, entry);
  }

  // Per-category measured capacity comes only from existing recommendation evidence.
  // Allocate it once, in priority order, and keep each plan's unmet gap visible.
  const capacityLeft = new Map<string, number>();
  const capacityEvidence = new Map<string, Row>();
  const allocationTotals = new Map<string, number>();
  const allocationOwnerByCategory = new Map<string, Row>();
  for (const plan of spending) {
    const evaluation = evaluations.get(String(plan.plan_id))!;
    const stored = recByPlan.get(String(plan.plan_id));
    const fresh = recommendSpendingAdjustments(plan, state, sorted, memories);
    const recommendation = stored && stored.plan_version === plan.version && stored.financial_state_version === state.financialStateVersion && stored.financial_revision === state.financialRevision ? stored : fresh;
    const recIsCurrent = recommendation === fresh || !!(stored && recommendation === stored);
    const adjustments: Row[] = Array.isArray(recommendation.adjustments) ? recommendation.adjustments : [];
    const freshEvidence = Array.isArray(fresh.causal_evidence) ? fresh.causal_evidence : [];
    const usableRec = ["ready", "insufficient_capacity"].includes(recommendation.status) && (recommendation === fresh || recIsCurrent);
    let gap = evaluation.shortfall === null ? null : Math.max(0, Number(evaluation.shortfall));
    const initialGap = gap;
    const allocated: Row[] = [];
    const priorityBlocked: Row[] = [];
    if (usableRec && gap !== null) for (const adj of adjustments) {
      const id = typeof adj?.category_id === "string" ? adj.category_id : "";
      const priorOwner = id ? allocationOwnerByCategory.get(id) : null;
      if (priorOwner) { priorityBlocked.push({ category_id: id, allocated_to_plan_id: priorOwner.plan_id, allocated_to_priority: priorOwner.priority }); continue; }
      let evidence = freshEvidence.find((e: Row) => e?.source === "existing_budget_coach" && e.category_id === id);
      // A valid one-off decline can make a later category the current alternative even
      // though the default fresh recommendation stops after the first eligible category.
      // Ask the same deterministic recommender to validate this single category against
      // current budgets and every active hard constraint.
      if (!evidence && id) {
        const excluded = new Set([...(Array.isArray(state.declinedCategoryIds) ? state.declinedCategoryIds : []), ...(Array.isArray(plan.category_ids) ? plan.category_ids.filter((categoryId: string) => categoryId !== id) : [])]);
        const categoryCheck = recommendSpendingAdjustments(plan, { ...state, declinedCategoryIds: [...excluded] }, sorted, []);
        evidence = (Array.isArray(categoryCheck.causal_evidence) ? categoryCheck.causal_evidence : []).find((e: Row) => e?.source === "existing_budget_coach" && e.category_id === id);
      }
      const proposed = money(adj.potential_reduction), measured = money(evidence?.eligible_capacity);
      if (!id || proposed === null || measured === null || proposed <= 0) continue;
      if (!capacityLeft.has(id)) { capacityLeft.set(id, measured); capacityEvidence.set(id, evidence); }
      const amount = Math.max(0, Math.min(proposed, capacityLeft.get(id) || 0, gap));
      const rounded = Math.round(amount * 100) / 100;
      capacityLeft.set(id, Math.round(Math.max(0, (capacityLeft.get(id) || 0) - rounded) * 100) / 100);
      gap = Math.round(Math.max(0, gap - rounded) * 100) / 100;
      if (rounded > 0) {
        allocated.push({ category_id: id, category_name: adj.category_name || evidence.category_name || id, monthly_potential: rounded, source: "existing_budget_coach", shared_capacity_remaining: capacityLeft.get(id) });
        allocationOwnerByCategory.set(id, { plan_id: plan.plan_id, priority: priority(plan) });
      }
    }
    const total = Math.round(allocated.reduce((n, a) => n + a.monthly_potential, 0) * 100) / 100;
    allocationTotals.set(String(plan.plan_id), total);
    const allocationStatus = gap === null ? "unknown" : initialGap === 0 || recommendation.status === "no_material_gap" ? "no_material_gap" : recommendation.status === "no_flexible_categories" ? "no_eligible_flexible_categories" : !usableRec ? "unknown" : gap > 0 ? (total > 0 ? "partially_allocated" : priorityBlocked.length ? "priority_reconsideration" : "no_verified_capacity") : total > 0 ? "allocated" : "no_verified_capacity";
    const planResult = resultById.get(String(plan.plan_id));
    planResult.allocation = { status: allocationStatus, monthly_potential: total, categories: allocated, priority_blocked_categories: priorityBlocked, unresolved_shortfall: gap, recommendation_status: recommendation.status, evidence_source: total ? "existing_budget_coach" : null };
    for (const blocked of priorityBlocked) {
      const conflict = { type: "priority_reconsideration", plan_id: plan.plan_id, priority: priority(plan), category_id: blocked.category_id, allocated_to_plan_id: blocked.allocated_to_plan_id, allocated_to_priority: blocked.allocated_to_priority, status: "higher_priority_claim", evidence: { source: "priority_allocation", category_id: blocked.category_id, assigned_once: true } };
      planResult.conflicts.push(conflict); conflictRows.push(conflict);
    }
    if (allocationStatus === "unknown") planResult.conflicts.push({ type: "funding_capacity_unknown", plan_id: plan.plan_id, status: "unknown", reason: evaluation.shortfall === null ? "Plan gap is not measurable from complete current evidence." : "No current usable structured recommendation establishes eligible category capacity." });
    if (total > 0) opportunities.push({ type: "priority_allocation", plan_id: plan.plan_id, priority: priority(plan), monthly_potential: total, categories: allocated.map(({ category_id, monthly_potential }) => ({ category_id, monthly_potential })), explanation: "Potential spending reductions are allocated once by plan priority; they are not verified savings or cash available to contribute." });
  }

  // Capacity in recurring-only cash projections is intentionally never interpreted as funding.
  const savingsOrCash = sorted.filter((p: Row) => p.plan_type === "savings" || p.plan_type === "cash_floor");
  for (const p of savingsOrCash) {
    const evaluation = evaluations.get(String(p.plan_id))!;
    const funding = { type: "funding_capacity_unknown", plan_id: p.plan_id, status: "unknown", reason: "Recurring-only cash projections and goal contributions do not establish free income or savings capacity.", evidence: evaluation.evidence || [] };
    resultById.get(String(p.plan_id))?.conflicts.push(funding);
  }
  const unknownPlanIds = planResults.filter((p: Row) => p.allocation.status === "unknown" || p.plan_type === "savings" || p.plan_type === "cash_floor").map((p: Row) => p.plan_id);
  const allocatedTotal = Math.round([...allocationTotals.values()].reduce((a, b) => a + b, 0) * 100) / 100;
  const hardConstraints = [...protectedByCategory.entries()].map(([category_id, rule]) => ({ category_id, protected: rule.protected, minimum_budget: rule.minimum, invalid_minimum: rule.invalid, enforced_across_priorities: true, plan_ids: rule.planIds }));
  for (const [categoryId, rule] of protectedByCategory) {
    const claiming = spending.filter((p: Row) => (Array.isArray(p.category_ids) ? p.category_ids : []).includes(categoryId));
    if (!claiming.length) continue;
    const conflict = { type: rule.protected ? "protected_category_claim" : rule.invalid ? "invalid_hard_minimum" : "hard_minimum_applies", category_id: categoryId, plan_ids: claiming.map((p: Row) => p.plan_id), constraint_plan_ids: rule.planIds, status: rule.invalid ? "unknown" : "enforced", evidence: { source: "active_plan_hard_constraints", minimum_budget: rule.minimum, protected: rule.protected } };
    conflictRows.push(conflict);
    for (const p of claiming) resultById.get(String(p.plan_id))?.conflicts.push(conflict);
  }
  // A cash-floor breach is meaningful only when the canonical forecast explicitly declares
  // the connected-cash scope. The plan engine supplies all projection arithmetic.
  for (const p of sorted.filter((plan: Row) => plan.plan_type === "cash_floor")) {
    const evalResult = evaluations.get(String(p.plan_id))!;
    const scope = state.planning?.scope ?? state.planning?.scopeLabel;
    if (scope !== "Connected cash accounts" && evalResult.assessment !== "unknown") {
      evaluations.set(String(p.plan_id), { ...evalResult, assessment: "unknown", metric: null, shortfall: null, evidence: [], reasons: ["A valid connected-cash forecast scope is unavailable."] });
      const planResult = resultById.get(String(p.plan_id));
      planResult.evaluation = evaluations.get(String(p.plan_id));
      planResult.assessment = "unknown";
      planResult.conflicts.push({ type: "cash_floor_risk_unknown", plan_id: p.plan_id, status: "unknown", reason: "Cash-floor risk requires an authoritative forecast scoped to connected cash accounts." });
    }
  }
  const output = {
    analysis_version: "folio-plan-conflicts-v1",
    priority_order: planResults.map((p: Row) => ({ plan_id: p.plan_id, priority: p.priority })),
    plans: planResults,
    conflicts: conflictRows,
    opportunities,
    capacity: { status: unknownPlanIds.length ? "partially_unknown" : "known_for_measured_category_reductions_only", known_allocated_monthly: allocatedTotal, unit: "monthly USD", unknown_plan_ids: unknownPlanIds },
    hard_constraints: hardConstraints,
    evidence: [...capacityEvidence.values()],
    assumptions: ["Priority 1 is highest; equal priorities use stable plan_id order.", "Category capacity is potential behavior from Budget Coach evidence and is allocated once across active plans.", "Category target changes do not create cash or savings capacity.", "Recurring-only cash forecasts do not establish available income, savings capacity, or free cash.", "Hard protected categories and minimum budgets apply across all active plans regardless of priority.", "No plans, budgets, recommendations, goals, or balances are modified."]
  };
  return { ok: true as const, analysis: output };
}

/** Compare two saved evaluation snapshots without claiming why they changed. */
export function comparePlanSnapshots(previous: Row | null, current: Row | null) {
  if (!previous || !current || previous.plan_id !== current.plan_id) return fail("invalid_snapshot", "Two snapshots for the same plan are required.");
  const before = previous.evaluation || previous;
  const after = current.evaluation || current;
  const metricDelta = money(after.metric) === null || money(before.metric) === null ? null : Math.round((Number(after.metric) - Number(before.metric)) * 100) / 100;
  const targetDelta = money(after.target) === null || money(before.target) === null ? null : Math.round((Number(after.target) - Number(before.target)) * 100) / 100;
  const shortfallDelta = money(after.shortfall) === null || money(before.shortfall) === null ? null : Math.round((Number(after.shortfall) - Number(before.shortfall)) * 100) / 100;
  const categoryMetrics = new Map<string, Row>();
  const collect = (snapshot: Row, side: "before" | "after") => {
    const evidence: Row[] = [...(Array.isArray(snapshot.evidence) ? snapshot.evidence : []), ...(Array.isArray(snapshot.causal_evidence) ? snapshot.causal_evidence : [])];
    for (const row of evidence) {
      if (!row?.category_id) continue;
      const entry = categoryMetrics.get(String(row.category_id)) || { category_id: row.category_id };
      for (const key of ["projected_spend", "projected", "current_target", "target_decrease", "potential_behavioral_reduction", "eligible_capacity"]) {
        const value = money(row[key]); if (value !== null) entry[`${side}_${key}`] = value;
      }
      categoryMetrics.set(String(row.category_id), entry);
    }
  };
  collect(before, "before"); collect(after, "after");
  const observations = [...categoryMetrics.values()].map((row: Row) => {
    for (const key of ["projected_spend", "projected", "current_target", "target_decrease", "potential_behavioral_reduction", "eligible_capacity"]) {
      const a = row[`before_${key}`], b = row[`after_${key}`];
      if (a !== undefined && b !== undefined) row[`${key}_delta`] = Math.round((b - a) * 100) / 100;
    }
    return row;
  });
  return { ok: true as const, comparison: { plan_id: current.plan_id, previous_version: previous.version ?? before.plan_version ?? null, current_version: current.version ?? after.plan_version ?? null, metric: { previous: money(before.metric), current: money(after.metric), delta: metricDelta }, target: { previous: money(before.target), current: money(after.target), delta: targetDelta }, shortfall: { previous: money(before.shortfall), current: money(after.shortfall), delta: shortfallDelta }, assessment: { previous: before.assessment || null, current: after.assessment || null }, observed_category_evidence: observations, attribution: "Observed changes only; this comparison does not infer causation." } };
}

function priority(plan: Row): number { return Number.isInteger(Number(plan?.priority)) && Number(plan.priority) >= 1 && Number(plan.priority) <= 5 ? Number(plan.priority) : 3; }
