import "../lib/server-shared/savings-math.js";

type Row = Record<string, any>;
type Scope = "this_month" | "plan_duration" | "permanent";
type ProposalInput = {
  operation: "update_plan" | "create_draft" | "activate_draft" | "correction_candidate" | "priority_candidate";
  activeHouseholdId: string;
  recordHouseholdId?: string;
  currentPlan?: Row | null;
  linkedGoal?: Row | null;
  expectedPlanVersion?: number | null;
  expectedFinancialRevision: string;
  currentFinancialRevision: string;
  activeCategoryIds: string[];
  categoryNames?: Record<string, string>;
  today: string;
  changes: Row;
  confirm?: boolean;
  clientRequestId?: string;
};

const fields = ["name", "priority", "target_monthly", "baseline_monthly", "floor_amount", "category_ids", "starts_on", "ends_on"] as const;
const money = (value: unknown): number | null => value === null || value === undefined || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100;
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
const round = (n: number) => Math.round(n * 100) / 100;
const label = (key: string) => ({ target_monthly: "Monthly contribution or reduction target", baseline_monthly: "Monthly baseline", floor_amount: "Cash floor", starts_on: "Start date", ends_on: "End date", priority: "Priority", category_ids: "Plan categories", constraints: "Plan protections and flexibility", status: "Status", name: "Plan name", plan_type: "Plan type", goal_update: "Linked savings goal target", linked_goal: "Linked savings goal", new_goal: "New savings goal" } as Record<string, string>)[key] || key;
function equalRule(a: Row, b: Row) { return a.kind === b.kind && (a.category_id || null) === (b.category_id || null) && money(a.amount) === money(b.amount) && (a.expires_on || null) === (b.expires_on || null) && a.level === b.level; }
function ruleKey(r: Row) { return `${r.kind}:${r.category_id || ""}:${r.amount ?? ""}:${r.expires_on || ""}`; }
function hasCategoryNames(names: Record<string, string> | undefined, categories: unknown, constraints: unknown) {
  const ids = new Set<string>(Array.isArray(categories) ? categories.filter((id): id is string => typeof id === "string") : []);
  if (Array.isArray(constraints)) for (const rule of constraints) if (rule && typeof rule.category_id === "string") ids.add(rule.category_id);
  return [...ids].every((id) => typeof names?.[id] === "string" && Boolean(names[id].trim()));
}
function cleanRule(rule: Row, categoryIds: Set<string>, activeIds: Set<string>, startsOn: string) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  if (!["cash_floor", "protected_category", "flexible_category", "minimum_budget"].includes(rule.kind) || !["hard", "soft"].includes(rule.level)) return null;
  const permitted = rule.kind === "cash_floor" ? ["kind", "level", "amount", "expires_on"] : rule.kind === "minimum_budget" ? ["kind", "level", "category_id", "amount", "expires_on"] : ["kind", "level", "category_id", "expires_on"];
  if (Object.keys(rule).some((key) => !permitted.includes(key))) return null;
  const expires = rule.expires_on == null ? null : rule.expires_on;
  if (expires !== null && (!validDate(expires) || expires < startsOn)) return null;
  if (rule.kind === "cash_floor") {
    const amount = money(rule.amount);
    return rule.level === "hard" && amount !== null && amount >= 0 ? { kind: rule.kind, level: rule.level, amount, ...(expires ? { expires_on: expires } : {}) } : null;
  }
  if (typeof rule.category_id !== "string" || !activeIds.has(rule.category_id)) return null;
  if (["flexible_category", "minimum_budget"].includes(rule.kind) && !categoryIds.has(rule.category_id)) return null;
  if (rule.kind === "flexible_category" && rule.level !== "soft" || rule.kind === "minimum_budget" && rule.level !== "hard") return null;
  if (rule.kind === "minimum_budget") {
    const amount = money(rule.amount);
    return amount !== null && amount >= 0 ? { kind: rule.kind, level: rule.level, category_id: rule.category_id, amount, ...(expires ? { expires_on: expires } : {}) } : null;
  }
  return { kind: rule.kind, level: rule.level, category_id: rule.category_id, ...(expires ? { expires_on: expires } : {}) };
}
function diffRows(before: Row, after: Row, categoryNames: Record<string, string> = {}) {
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const pretty = (key: string, value: any): string => {
    if (value === null || value === undefined) return "not set";
    if (["target_monthly", "baseline_monthly", "floor_amount"].includes(key)) return usd.format(Number(value));
    if (key === "plan_type") return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    if (key === "status") return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    if (key === "category_ids" && Array.isArray(value)) return value.map((id) => categoryNames[id] || "budget category").join(", ") || "none";
    if (key === "constraints" && Array.isArray(value)) return value.map((rule) => `${rule.kind.replaceAll("_", " ")}${rule.category_id ? ` for ${categoryNames[rule.category_id] || "budget category"}` : ""}${rule.amount != null ? ` at ${usd.format(Number(rule.amount))}` : ""}${rule.level ? ` (${rule.level})` : ""}${rule.expires_on ? ` until ${rule.expires_on}` : ""}`).join("; ") || "none";
    if (key === "goal_update" && value && typeof value === "object") return `target ${usd.format(value.target_amount)}; current tracked amount ${usd.format(value.current_amount)}; monthly contribution ${usd.format(value.monthly_contribution)}`;
    if (key === "new_goal" && value && typeof value === "object") return `${value.name}: target ${usd.format(value.target_amount)}; current tracked amount ${usd.format(value.current_amount)}; monthly contribution ${usd.format(value.monthly_contribution)}`;
    if (key === "linked_goal") return String(value);
    return String(value);
  };
  const technical = new Set(["client_request_id", "goal_id", "plan_id", "expected_version", "financial_revision", "financial_state_version", "expected_goal_current_amount", "confirm"]);
  return Object.keys(after).filter((key) => !technical.has(key) && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)).map((key) => {
    const beforeValue = before[key] ?? null, afterValue = after[key] ?? null;
    const displayValue = (value: any) => ["category_ids", "constraints", "goal_update", "new_goal"].includes(key) ? pretty(key, value) : value;
    return { field: key, label: label(key), before: displayValue(beforeValue), after: displayValue(afterValue), text: `${label(key)}: ${pretty(key, beforeValue)} → ${pretty(key, afterValue)}` };
  });
}
function feasibility(today: string, starts: string, ends: string, current: number, target: number, monthly: number) {
  const project = (globalThis as any).FolioSavingsMath?.project;
  return typeof project === "function" ? project({ today, starts_on: starts, ends_on: ends, current, target, monthly }) : null;
}

/** Pure structured proposal builder. It does not call an LLM, read storage, or write financial data. */
export function buildPlanProposal(input: ProposalInput) {
  if (!input || !input.activeHouseholdId || input.recordHouseholdId !== input.activeHouseholdId) return fail("household_mismatch", "The active household does not match the plan or goal record.");
  if (!validDate(input.today) || typeof input.expectedFinancialRevision !== "string" || !input.expectedFinancialRevision || input.expectedFinancialRevision !== input.currentFinancialRevision) return fail("stale_financial_revision", "Financial data changed. Refresh the plan before preparing this proposal.");
  if (!Array.isArray(input.activeCategoryIds) || !input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) return fail("invalid_input", "Current category IDs and structured changes are required.");
  const activeIds = new Set(input.activeCategoryIds);
  if (activeIds.size !== input.activeCategoryIds.length || [...activeIds].some((id) => typeof id !== "string" || !id)) return fail("invalid_catalog", "The active household category catalog is invalid.");
  const plan = input.currentPlan || null, goal = input.linkedGoal || null, c = input.changes;
  if (plan?.household_id && plan.household_id !== input.activeHouseholdId || goal?.household_id && goal.household_id !== input.activeHouseholdId) return fail("household_mismatch", "The plan or linked goal belongs to another household.");
  const base = { plan_id: plan?.plan_id || null, plan_version: plan?.version ?? null, financial_revision: input.expectedFinancialRevision };
  const success = (operation: string, args: Row, before: Row, after: Row, extra: Row = {}) => ({ ok: true as const, proposal: { operation, expected: base, args, diff: diffRows(before, after, input.categoryNames), confirmationRequired: true, ...extra } });
  if (["priority_candidate", "correction_candidate", "update_plan", "activate_draft"].includes(input.operation) && (!plan || !Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion !== plan.version)) return fail("stale_plan", "Refresh the existing plan before preparing this proposal.");

  if (input.operation === "correction_candidate") {
    const allowed = new Set(["scope", "category_id", "correction"]);
    if (Object.keys(c).some((key) => !allowed.has(key)) || !plan || !["this_month", "plan_duration", "permanent"].includes(c.scope) || typeof c.correction !== "string" || !c.correction.trim() || c.correction.length > 240 || c.category_id != null && !activeIds.has(c.category_id)) return fail("invalid_correction", "Provide a concise correction and its supported scope; any category must match the active household catalog.");
    return success("correction_candidate", {}, {}, {}, { candidate: { plan_id: plan.plan_id, scope: c.scope as Scope, category_id: c.category_id || null, correction: c.correction.trim(), route: "existing_memory_or_plan_constraint", requiresPersistenceMapping: true } });
  }
  if (input.operation === "priority_candidate") {
    if (Object.keys(c).some((key) => key !== "priority") || !plan || !Number.isInteger(c.priority) || c.priority < 1 || c.priority > 5) return fail("invalid_priority", "Plan priority must be an integer from 1 to 5.");
    const args = { ...saveFields(plan), plan_id: plan.plan_id, expected_version: plan.version, priority: c.priority, confirm: true };
    return success("priority_candidate", args, { priority: plan.priority ?? 3 }, { priority: c.priority }, { candidate: { plan_id: plan.plan_id, priority: c.priority } });
  }
  if (input.operation === "create_draft") {
    const allowed = new Set(["plan_type", ...fields, "goal_id", "new_goal", "constraints"]);
    if (Object.keys(c).some((key) => !allowed.has(key)) || plan || input.expectedPlanVersion != null) return fail("invalid_draft", "A draft must use a supported structured goal and cannot overwrite an existing plan.");
    const kind = c.plan_type;
    if (!["savings", "spending_reduction", "cash_floor"].includes(kind)) return fail("invalid_plan_type", "This structured plan type is not supported.");
    if (typeof input.clientRequestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.clientRequestId)) return fail("invalid_request_id", "A stable client request ID is required to prepare a new plan.");
    const shaped = normalizePlan(c, null, activeIds, input.today);
    if (!shaped.ok) return shaped;
    if (!hasCategoryNames(input.categoryNames, shaped.value.category_ids, shaped.value.constraints)) return fail("invalid_catalog", "Exact active category names are required to prepare a human-readable plan proposal.");
    if (kind === "savings") {
      if (typeof c.goal_id === "string" && c.new_goal || !c.goal_id && (!c.new_goal || typeof c.new_goal !== "object" || Array.isArray(c.new_goal))) return fail("invalid_goal", "Choose one active goal or provide a structured new savings goal.");
      if (c.goal_id && (!goal || goal.goal_id !== c.goal_id || goal.active !== true || goal.goal_type !== "save")) return fail("invalid_goal", "The selected savings goal is not active in this household.");
      if (c.new_goal) {
        const newGoal = c.new_goal, target = money(newGoal.target_amount), current = money(newGoal.current_amount ?? 0);
        if (Object.keys(newGoal).some((key) => !["name", "target_amount", "current_amount"].includes(key)) || typeof newGoal.name !== "string" || !newGoal.name.trim() || newGoal.name.length > 80 || target === null || target <= 0 || current === null || current < 0) return fail("invalid_goal", "The new savings goal needs a name and finite nonnegative current amount and positive target.");
        shaped.value.new_goal = { name: newGoal.name.trim(), target_amount: target, current_amount: current, monthly_contribution: shaped.value.target_monthly };
        shaped.value.name ||= newGoal.name.trim();
      }
      shaped.value.goal_id = c.goal_id || null;
      const current = c.new_goal ? money(c.new_goal.current_amount ?? 0)! : money(goal?.current_amount);
      const targetAmount = c.new_goal ? money(c.new_goal.target_amount)! : money(goal?.target_amount);
      const projected = current === null || targetAmount === null ? null : feasibility(input.today, shaped.value.starts_on, shaped.value.ends_on, current, targetAmount, shaped.value.target_monthly);
      if (!projected) return fail("invalid_savings_dates", "The savings timeline could not be calculated from the supplied dates and amounts.");
      const args = { ...shaped.value, client_request_id: input.clientRequestId, plan_type: kind, status: "draft" };
      const display = { ...args, ...(goal ? { linked_goal: goal.name || "Savings goal" } : {}) };
      return success("create_draft", args, {}, display, { savings_feasibility: { ...projected, feasible_by_deadline: projected.shortfall === 0, claim: "Assumption only; future contributions are not verified savings." } });
    }
    if (c.goal_id || c.new_goal) return fail("invalid_goal", "Only a savings plan can link or create a savings goal.");
    const args = { ...shaped.value, client_request_id: input.clientRequestId, plan_type: kind, status: "draft" };
    return success("create_draft", args, {}, args);
  }
  if (input.operation === "activate_draft") {
    if (Object.keys(c).length || !plan || plan.status !== "draft" || !Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion !== plan.version) return fail("stale_plan", "Only the current draft version can be activated.");
    if (input.confirm !== true) return fail("confirmation_required", "Activating a draft requires the member's separate explicit confirmation.");
    if (!validDate(plan.starts_on) || !validDate(plan.ends_on) || plan.ends_on < input.today || plan.plan_type === "savings" && (!goal || goal.goal_id !== plan.goal_id || goal.active !== true)) return fail("invalid_draft", "The draft period or linked savings goal is no longer valid.");
    const args = { ...saveFields(plan), plan_id: plan.plan_id, expected_version: plan.version, status: "active", confirm: true };
    return success("activate_draft", args, { status: plan.status }, { status: "active" });
  }
  if (input.operation !== "update_plan" || !plan || !Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion !== plan.version || plan.version !== input.expectedPlanVersion) return fail("stale_plan", "Refresh the existing plan before preparing an update.");
  const allowed = new Set([...fields, "constraintEdits", "goal_target_amount", "expected_goal_current_amount"]);
  if (Object.keys(c).some((key) => !allowed.has(key))) return fail("unsupported_field", "This plan field cannot be edited through a proposal.");
  if (Object.keys(c).some((key) => (fields as readonly string[]).includes(key) && c[key] === undefined)) return fail("invalid_input", "Plan edits must contain explicit structured values.");
  const shaped = normalizePlan(c, plan, activeIds, input.today);
  if (!shaped.ok) return shaped;
  const merged = { ...saveFields(plan), ...shaped.value };
  if (("category_ids" in c || "constraintEdits" in c) && !hasCategoryNames(input.categoryNames, merged.category_ids, merged.constraints)) return fail("invalid_catalog", "Exact active category names are required to prepare a human-readable plan proposal.");
  const args: Row = { ...merged, plan_id: plan.plan_id, expected_version: plan.version, confirm: true };
  const before: Row = {}, after: Row = {};
  for (const key of Object.keys(shaped.value)) { before[key] = plan[key] ?? null; after[key] = shaped.value[key]; }
  const hasTargetEdit = Object.prototype.hasOwnProperty.call(c, "goal_target_amount"), hasContributionEdit = Object.prototype.hasOwnProperty.call(c, "target_monthly"), hasTimelineEdit = Object.prototype.hasOwnProperty.call(c, "starts_on") || Object.prototype.hasOwnProperty.call(c, "ends_on");
  if ((hasTargetEdit || Object.prototype.hasOwnProperty.call(c, "expected_goal_current_amount")) && plan.plan_type !== "savings") return fail("invalid_goal", "Only a savings plan can change a linked goal target or use a goal amount expectation.");
  if (Object.prototype.hasOwnProperty.call(c, "expected_goal_current_amount") && !hasTargetEdit && !hasContributionEdit) return fail("unsupported_field", "An expected goal amount is only used with a goal target or contribution edit.");
  if (plan.plan_type === "savings" && (hasTargetEdit || hasContributionEdit || hasTimelineEdit)) {
    if (!goal || goal.goal_id !== plan.goal_id || goal.active !== true) return fail("invalid_goal", "A current linked active savings goal is required to change its contribution, target, or deadline.");
    const target = hasTargetEdit ? money(c.goal_target_amount) : money(goal.target_amount), expectedCurrent = hasTargetEdit || hasContributionEdit ? money(c.expected_goal_current_amount) : money(goal.current_amount), current = money(goal.current_amount), oldTarget = money(goal.target_amount), oldContribution = money(goal.monthly_contribution), contribution = money(merged.target_monthly), start = merged.starts_on, end = merged.ends_on;
    if (target === null || target <= 0 || current === null || oldTarget === null || oldContribution === null || contribution === null || expectedCurrent === null || expectedCurrent !== current || !validDate(start) || !validDate(end)) return fail("stale_goal", "The linked savings goal changed or has incomplete amounts. Refresh it before editing.");
    const goalProjection = feasibility(input.today, start, end, current, target, contribution);
    if (!goalProjection) return fail("invalid_savings_dates", "The savings timeline could not be calculated from the proposed contribution and deadline.");
    if (hasTargetEdit || hasContributionEdit) {
      args.goal_update = { target_amount: target, expected_target_amount: oldTarget, expected_monthly_contribution: oldContribution, expected_current_amount: current };
      before.goal_update = { target_amount: oldTarget, current_amount: current, monthly_contribution: oldContribution };
      after.goal_update = { target_amount: target, current_amount: current, monthly_contribution: contribution };
    }
    return success("update_plan", args, before, after, { savings_feasibility: { ...goalProjection, feasible_by_deadline: goalProjection.shortfall === 0, claim: "Assumption only; future contributions are not verified savings." } });
  }
  if (hasTargetEdit) return fail("invalid_goal", "Only a savings plan can change a linked goal target.");
  return success("update_plan", args, before, after);
}

function saveFields(plan: Row) {
  return { goal_id: plan.goal_id ?? null, name: plan.name ?? null, plan_type: plan.plan_type, status: plan.status, priority: plan.priority ?? 3, target_monthly: plan.target_monthly ?? null, baseline_monthly: plan.baseline_monthly ?? null, floor_amount: plan.floor_amount ?? null, category_ids: Array.isArray(plan.category_ids) ? [...plan.category_ids] : [], constraints: Array.isArray(plan.constraints) ? plan.constraints.map((rule: Row) => ({ ...rule })) : [], starts_on: plan.starts_on, ends_on: plan.ends_on };
}

function normalizePlan(changes: Row, existing: Row | null, activeIds: Set<string>, today: string) {
  const candidate: Row = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(changes, field)) candidate[field] = changes[field];
  for (const field of ["name", "priority"]) {
    if (!(field in candidate)) continue;
    if (field === "name" && (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 80)) return fail("invalid_name", "Plan name must be 1–80 characters.");
    if (field === "priority" && (!Number.isInteger(candidate.priority) || candidate.priority < 1 || candidate.priority > 5)) return fail("invalid_priority", "Priority must be an integer from 1 to 5.");
    if (field === "name") candidate.name = candidate.name.trim();
  }
  for (const field of ["target_monthly", "baseline_monthly", "floor_amount"]) {
    if (!(field in candidate)) continue;
    const amount = money(candidate[field]);
    if (amount === null || amount < 0 || field !== "floor_amount" && amount <= 0 || amount > 1e9) return fail("invalid_amount", `${field} must be a finite valid nonnegative amount.`);
    candidate[field] = amount;
  }
  if ("category_ids" in candidate) {
    if (!Array.isArray(candidate.category_ids) || candidate.category_ids.length > 12 || candidate.category_ids.some((id: unknown) => typeof id !== "string" || !activeIds.has(id)) || new Set(candidate.category_ids).size !== candidate.category_ids.length) return fail("invalid_category", "Every plan category must be a unique exact ID from the active household category catalog.");
  }
  const type = existing?.plan_type || changes.plan_type;
  const start = candidate.starts_on ?? existing?.starts_on, end = candidate.ends_on ?? existing?.ends_on;
  if ("starts_on" in candidate && !validDate(candidate.starts_on) || "ends_on" in candidate && !validDate(candidate.ends_on) || !validDate(start) || !validDate(end) || end < start || Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > 5 * 366 * 86400000) return fail("invalid_date", "Choose valid plan dates in order and within five years.");
  if ("constraints" in changes) {
    if (existing || !Array.isArray(changes.constraints)) return fail("unsupported_field", "Existing plans must use scoped constraintEdits so unchanged protections are preserved.");
    const categoryIds = new Set<string>((candidate.category_ids ?? []) as string[]), normalized: Row[] = [];
    for (const raw of changes.constraints) {
      const rule = cleanRule(raw, categoryIds, activeIds, start);
      if (!rule || normalized.some((item) => equalRule(item, rule))) return fail("invalid_constraint", "Draft constraints must be unique supported rules using current categories and valid amounts/dates.");
      normalized.push(rule);
    }
    candidate.constraints = normalized;
  }
  if ("constraintEdits" in changes) {
    if (!Array.isArray(changes.constraintEdits) || changes.constraintEdits.some((edit: Row) => !edit || Object.keys(edit).some((key) => !["action", "rule"].includes(key)) || !["add", "remove"].includes(edit.action) || !edit.rule || typeof edit.rule !== "object" || Array.isArray(edit.rule))) return fail("invalid_constraint", "Constraint edits must add or remove one structured supported rule.");
    const current = Array.isArray(existing?.constraints) ? existing!.constraints.map((r: Row) => ({ ...r })) : [];
    const ids = new Set<string>((candidate.category_ids ?? existing?.category_ids ?? []) as string[]);
    for (const edit of changes.constraintEdits) {
      const rule = cleanRule(edit.rule, ids, activeIds, start);
      if (!rule) return fail("invalid_constraint", "A protection or flexibility rule has an invalid kind, scope, amount, category, or date.");
      const index = current.findIndex((item) => equalRule(item, rule));
      if (edit.action === "remove") { if (index < 0) return fail("stale_constraint", "The constraint to remove is no longer present."); current.splice(index, 1); }
      else { if (index >= 0) return fail("duplicate_constraint", "That plan constraint already exists."); current.push(rule); }
    }
    const unique = new Set(current.map(ruleKey));
    if (unique.size !== current.length) return fail("duplicate_constraint", "The proposed plan would contain duplicate constraints.");
    candidate.constraints = current;
  }
  const target = candidate.target_monthly ?? existing?.target_monthly, baseline = candidate.baseline_monthly ?? existing?.baseline_monthly, floor = candidate.floor_amount ?? existing?.floor_amount;
  if (type === "savings" && (!money(target) || money(target)! <= 0) || type === "spending_reduction" && (!money(target) || !money(baseline) || money(target)! >= money(baseline)!) || type === "cash_floor" && money(floor) === null) return fail("invalid_amount", "The plan's required goal amounts are missing or inconsistent.");
  const categoryIds = candidate.category_ids ?? existing?.category_ids ?? [];
  if (type === "spending_reduction" && (!Array.isArray(categoryIds) || !categoryIds.length)) return fail("invalid_category", "A spending-reduction plan needs at least one active budget category.");
  const finalRules = candidate.constraints ?? existing?.constraints ?? [];
  if (!Array.isArray(categoryIds) || categoryIds.some((id: unknown) => typeof id !== "string" || !activeIds.has(id)) || !Array.isArray(finalRules) || finalRules.some((rule: Row) => rule?.category_id && !activeIds.has(rule.category_id))) return fail("invalid_category", "Every existing and proposed category reference must remain in the active household catalog.");
  const flexibleIds = new Set(finalRules.filter((rule: Row) => rule.kind === "flexible_category").map((rule: Row) => rule.category_id));
  if (type !== "spending_reduction" && finalRules.some((rule: Row) => ["flexible_category", "minimum_budget"].includes(rule.kind)) || finalRules.some((rule: Row) => ["flexible_category", "minimum_budget"].includes(rule.kind) && !categoryIds.includes(rule.category_id) || rule.kind === "minimum_budget" && !flexibleIds.has(rule.category_id))) return fail("invalid_constraint", "Flexible categories and minimums must remain within the spending plan's category scope.");
  const result: Row = { ...candidate };
  if ("starts_on" in result) result.starts_on = start;
  if ("ends_on" in result) result.ends_on = end;
  return { ok: true as const, value: result };
}
