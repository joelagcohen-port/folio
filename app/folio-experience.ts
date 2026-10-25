import { callFolioOperation, isRecord } from "./folio-server.ts";

export function experienceFlags() {
  const enabled = process.env.FOLIO_GUIDED_ENABLED === "true" && process.env.FOLIO_GUIDED_KILL_SWITCH !== "true";
  return { enabled, weeklyReview: enabled && process.env.FOLIO_WEEKLY_REVIEW_ENABLED === "true", coaching: enabled && process.env.FOLIO_GUIDANCE_KILL_SWITCH !== "true" };
}

// One existing target per confirmation. Cross-category transfers need an atomic
// upstream operation and are deliberately not emulated with sequential writes.
export async function guidedBudgetAction(tool: string, args: Record<string, unknown>, authorization: string) {
  const fail = (status: number, error: string) => ({ ok: false, status, data: { error } });
  if (!experienceFlags().enabled) return fail(403, "The new experience is currently unavailable. Your existing budgets are unchanged.");
  const committing = tool === "guided_budget_commit";
  if (committing && args.confirm !== true) return fail(400, "Confirm the preview before saving.");
  const amount = args.monthly_target_amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001)
    return fail(400, "Enter a valid target with at most two decimal places.");
  if (typeof args.expected_target !== "number" || !Number.isFinite(args.expected_target) || typeof args.budget_target_id !== "string" || typeof args.category !== "string")
    return fail(400, "Select an existing budget target.");
  const catalog = await callFolioOperation("list_budget_targets", {}, authorization);
  if (!catalog.ok) return catalog;
  if (!isRecord(catalog.data)) return fail(503, "Budget details could not be verified.");
  const categories = Array.isArray(catalog.data.categories) ? catalog.data.categories : [];
  const targets = Array.isArray(catalog.data.targets) ? catalog.data.targets : [];
  const category = categories.find((row) => isRecord(row) && row.category_name === args.category && row.category_type === "expense" && row.is_active !== false && row.excluded_from_budget !== true);
  const target = targets.find((row) => isRecord(row) && row.budget_target_id === args.budget_target_id && row.category === args.category && row.is_active !== false);
  if (!category || !isRecord(target)) return fail(422, "This budget or category is no longer active. Refresh Budget and try again.");
  if (target.currency_code && target.currency_code !== "USD") return fail(422, "This experience currently supports USD budgets only.");
  const current = Number(target.monthly_target_amount);
  if (!Number.isFinite(current)) return fail(503, "The current target could not be verified.");
  if (committing && current === amount) return { ok: true, status: 200, data: { saved: true, already_applied: true, target } };
  if (current !== args.expected_target) return fail(409, "This target changed since you opened it. Refresh Budget and review a new preview.");
  const proposal = { budget_target_id: args.budget_target_id, category: args.category, expected_target: current, monthly_target_amount: amount, currency_code: "USD" };
  if (!committing) return { ok: true, status: 200, data: { proposal } };
  if (!experienceFlags().enabled) return fail(403, "The new experience has been turned off.");
  const result = await callFolioOperation("save_budget_target", { budget_target_id: proposal.budget_target_id, category: proposal.category, monthly_target_amount: amount, currency_code: "USD" }, authorization);
  if (!result.ok) return result;
  return { ok: true, status: 200, data: { saved: true, target: isRecord(result.data) ? result.data.target : null } };
}

export async function guidedBudgetReallocationAction(tool: string, args: Record<string, unknown>, authorization: string) {
  const fail = (status: number, error: string) => ({ ok: false, status, data: { error } });
  if (!experienceFlags().enabled) return fail(403, "The new experience is currently unavailable. Your existing budgets are unchanged.");
  const committing = tool === "guided_budget_reallocation_commit";
  if (committing && args.confirm !== true) return fail(400, "Confirm the preview before moving budget money.");
  const amount = args.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e9 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001)
    return fail(400, "Enter a valid amount with at most two decimal places.");
  const ids = [args.from_budget_target_id, args.to_budget_target_id];
  const expected = [args.expected_from_target, args.expected_to_target];
  if (ids.some(value => typeof value !== "string") || ids[0] === ids[1] || expected.some(value => typeof value !== "number" || !Number.isFinite(value)))
    return fail(400, "Choose two existing budget targets and refresh the preview.");
  const catalog = await callFolioOperation("list_budget_targets", {}, authorization);
  if (!catalog.ok) return catalog;
  if (!isRecord(catalog.data)) return fail(503, "Budget details could not be verified.");
  const targets = Array.isArray(catalog.data.targets) ? catalog.data.targets : [];
  const from = targets.find(row => isRecord(row) && row.budget_target_id === ids[0] && row.is_active !== false);
  const to = targets.find(row => isRecord(row) && row.budget_target_id === ids[1] && row.is_active !== false);
  if (!isRecord(from) || !isRecord(to)) return fail(422, "One of these active budget targets is no longer available. Refresh Budget and try again.");
  const fromTarget = Number(from.monthly_target_amount), toTarget = Number(to.monthly_target_amount);
  if (!Number.isFinite(fromTarget) || !Number.isFinite(toTarget) || from.currency_code !== "USD" || to.currency_code !== "USD") return fail(422, "This experience currently supports USD budgets only.");
  if (fromTarget !== expected[0] || toTarget !== expected[1]) return fail(409, "A budget target changed since this preview. Refresh Budget and review a new preview.");
  if (amount > fromTarget) return fail(422, "The source target cannot go below zero.");
  const proposal = { from_budget_target_id: ids[0], to_budget_target_id: ids[1], expected_from_target: fromTarget, expected_to_target: toTarget, amount, from_category: from.category, to_category: to.category };
  if (!committing) return { ok: true, status: 200, data: { proposal } };
  if (!experienceFlags().enabled) return fail(403, "The new experience has been turned off.");
  // Category names are useful to render the preview, but the locked budget
  // operation accepts only the atomic transfer fields.
  const result = await callFolioOperation("reallocate_budget_targets", {
    from_budget_target_id: proposal.from_budget_target_id,
    to_budget_target_id: proposal.to_budget_target_id,
    expected_from_target: proposal.expected_from_target,
    expected_to_target: proposal.expected_to_target,
    amount: proposal.amount,
    confirm: true,
  }, authorization);
  if (!result.ok) return result;
  return { ok: true, status: 200, data: { saved: true, transfer: isRecord(result.data) ? result.data.transfer : null } };
}
