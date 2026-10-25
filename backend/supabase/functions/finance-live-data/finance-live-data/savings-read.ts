import { calendarDate, resolveCalendarTimeZone } from "./date-context.ts";
import { buildSavingsIntelligence } from "./savings-intelligence.ts";

type DbResult<T = any> = { data: T | null; error: { message?: string } | null };
type ReadContext = { userId: string; householdId: string };
type ReadOptions = { now?: Date; loadForecast?: (context: ReadContext, timezone: string) => Promise<any> };
type Row = Record<string, any>;

const PAGE_SIZE = 500;
const MAX_ACTIVITY_ROWS = 2500;

function fail(message: string): never { throw new Error(message); }
function isObject(value: unknown): value is Row { return !!value && typeof value === "object" && !Array.isArray(value); }
function validMonth(value: unknown): value is string { return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1, 12));
  return { from: `${month}-01`, through: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01` };
}
function localMidnightUtc(date: string, timezone: string) {
  const target = Date.parse(`${date}T00:00:00Z`);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}
function localMonthTimestampBounds(month: string, timezone: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1, 12));
  const nextMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    from: localMidnightUtc(`${month}-01`, timezone),
    through: localMidnightUtc(`${nextMonth}-01`, timezone),
  };
}
function asRows(value: unknown): Row[] { return Array.isArray(value) ? value.filter(isObject) : value && isObject(value) ? [value] : []; }
function rpcRows(result: DbResult, name: string): Row[] {
  if (result.error) fail(`${name}: ${result.error.message || "query failed"}`);
  return asRows(result.data);
}
function check(result: DbResult, name: string) {
  if (result.error) fail(`${name}: ${result.error.message || "query failed"}`);
  return result.data;
}
function toFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function validDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function readPages(makeQuery: (from: number, to: number) => any, maximum: number) {
  const rows: Row[] = [];
  let hasMore = false;
  for (let from = 0; from < maximum; from += PAGE_SIZE) {
    const result: DbResult<Row[]> = await makeQuery(from, Math.min(from + PAGE_SIZE - 1, maximum - 1));
    const page = check(result, "Savings data");
    if (!Array.isArray(page)) break;
    rows.push(...page.filter(isObject));
    if (page.length < PAGE_SIZE) break;
    if (from + page.length >= maximum) { hasMore = true; break; }
  }
  return { rows, hasMore };
}

/**
 * Read persisted savings goals and activity only. This function never runs a detector,
 * reconciles transactions, recomputes balances, or writes to the database.
 */
export async function getSavingsActivityRead(
  context: ReadContext,
  body: Row,
  db: any,
  options: ReadOptions = {},
) {
  if (!isObject(body)) fail("Request body must be an object.");
  const allowed = new Set(["action", "household_id", "goal_id", "activity_id", "month", "timezone", "audit_before_created_at", "audit_before_id"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) fail("Unsupported savings activity request field.");
  if (body.household_id !== undefined && body.household_id !== context.householdId) fail("Household access denied.");
  if (body.goal_id !== undefined && (typeof body.goal_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(body.goal_id))) fail("goal_id must be a UUID.");
  if (body.activity_id !== undefined && (typeof body.activity_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(body.activity_id))) fail("activity_id must be a UUID.");
  if (body.audit_before_created_at !== undefined && (typeof body.audit_before_created_at !== "string" || !Number.isFinite(Date.parse(body.audit_before_created_at)))) fail("audit_before_created_at must be a timestamp.");
  if (body.audit_before_id !== undefined && (typeof body.audit_before_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(body.audit_before_id))) fail("audit_before_id must be a UUID.");
  const timezone = resolveCalendarTimeZone(body.timezone);
  const today = calendarDate(options.now ?? new Date(), timezone);
  let month = body.month === undefined ? today.slice(0, 7) : body.month;
  if (!validMonth(month)) fail("month must use YYYY-MM.");
  let requestedActivity: Row | null = null;
  if (typeof body.activity_id === "string") {
    const activityResult: DbResult<Row[]> = await db.from("finance_goal_savings_activity").select("activity_id,goal_id,canonical_account_id,transaction_date")
      .eq("household_id", context.householdId).eq("activity_id", body.activity_id).limit(1);
    const activityRows = check(activityResult, "Savings activity") as Row[];
    requestedActivity = Array.isArray(activityRows) && isObject(activityRows[0]) ? activityRows[0] : null;
    if (!requestedActivity || !validDateOnly(requestedActivity.transaction_date)) fail("Savings activity not found.");
    month = String(requestedActivity.transaction_date).slice(0, 7);
  }
  const { from, through } = monthBounds(month);
  const requestedGoalId = typeof body.goal_id === "string" ? body.goal_id : null;
  const auditMonthBounds = localMonthTimestampBounds(month, timezone);

  const goalQuery = db.from("finance_planning_goals")
    .select("goal_id,name,goal_type,target_amount,current_amount,monthly_contribution,active,tracking_mode,savings_policy,goal_category,deadline_date")
    .eq("household_id", context.householdId).eq("goal_type", "save").eq("active", true);
  const goalResult: DbResult<Row[]> = await goalQuery.order("name", { ascending: true });
  const goals = check(goalResult, "Savings goals") as Row[];
  if (!Array.isArray(goals)) fail("Savings goals could not be loaded.");
  if (requestedGoalId && !goals.some((goal) => String(goal.goal_id) === requestedGoalId)) fail("Savings goal not found.");
  const goalIds = goals.map((goal) => String(goal.goal_id));
  const goalIdSet = new Set(goalIds);

  // Savings plan priority lives on the active plan, not on the goal row.
  const planRows = goalIds.length
    ? rpcRows(await db.from("finance_household_plans").select("plan_id,goal_id,priority,status,plan_type")
      .eq("household_id", context.householdId).eq("status", "active").eq("plan_type", "savings").in("goal_id", goalIds), "Savings plan priorities")
    : [];
  const priorityByGoal = new Map<string, number>();
  for (const plan of planRows) {
    const priority = toFinite(plan.priority);
    const goalId = String(plan.goal_id || "");
    if (goalIdSet.has(goalId) && priority !== null && Number.isInteger(priority) && priority >= 1 && priority <= 5) {
      priorityByGoal.set(goalId, priority);
    }
  }

  const linksResult: DbResult<Row[]> = goalIds.length
    ? await db.from("finance_goal_savings_account_links")
      .select("link_id,goal_id,canonical_account_id,allocated_amount,allocation_offset_amount,effective_from")
      .eq("household_id", context.householdId).in("goal_id", goalIds)
    : { data: [], error: null };
  const links = (check(linksResult, "Savings account links") as Row[] || []).filter(isObject);
  const accountIds = [...new Set(links.map((link) => String(link.canonical_account_id)).filter(Boolean))];

  const historyStart = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - 36, 1, 12)).toISOString().slice(0, 10);
  const [balancesResult, monthlyResult, historyResult] = await Promise.all([
    db.rpc("finance_get_goal_savings_account_balances", { p_household_id: context.householdId }),
    goalIds.length ? db.rpc("finance_get_savings_month_summary", { p_household_id: context.householdId, p_goal_ids: goalIds, p_from: from, p_through: through }) : Promise.resolve({ data: [], error: null }),
    goalIds.length ? db.rpc("finance_get_savings_monthly_history", { p_household_id: context.householdId, p_goal_ids: goalIds, p_from: historyStart, p_through: `${today.slice(0, 7)}-01` }) : Promise.resolve({ data: [], error: null }),
  ]);
  const balanceRows = rpcRows(balancesResult, "Savings account balances");
  const monthlyRows = rpcRows(monthlyResult, "Savings month summary");
  const historyRows = rpcRows(historyResult, "Savings monthly history");
  const currentBalances = new Map<string, number>();
  for (const row of balanceRows) if (goalIdSet.has(String(row.goal_id)) && accountIds.includes(String(row.canonical_account_id))) {
    const value = toFinite(row.current_allocated_balance);
    if (value !== null) currentBalances.set(`${row.goal_id}:${row.canonical_account_id}`, value);
  }
  const monthlyByGoal = new Map(monthlyRows.map((row) => [String(row.goal_id), row]));
  const historyByGoal = new Map<string, Row[]>();
  for (const row of historyRows) {
    const key = String(row.goal_id);
    historyByGoal.set(key, [...(historyByGoal.get(key) || []), row]);
  }

  const [canonicalResult, sourceResult] = await Promise.all([
    db.from("finance_canonical_household_accounts").select("canonical_account_id,display_name,account_type,account_subtype,mask,seed_source_account_id").eq("household_id", context.householdId),
    db.from("finance_canonical_account_sources").select("source_account_id,canonical_account_id,source_role,transaction_source_enabled").eq("household_id", context.householdId),
  ]);
  const canonicalAccounts = (check(canonicalResult as DbResult<Row[]>, "Canonical accounts") as Row[] || []).filter(isObject);
  const sources = (check(sourceResult as DbResult<Row[]>, "Connected account sources") as Row[] || []).filter(isObject);
  const sourceIds = [...new Set(sources.map((source) => String(source.source_account_id)).filter(Boolean))];
  const plaidResult: DbResult<Row[]> = sourceIds.length
    ? await db.from("plaid_accounts").select("account_id,current_balance,balance_updated_at,lifecycle_status,balance_currency_code,item_id").in("account_id", sourceIds)
    : { data: [], error: null };
  const plaidAccounts = (check(plaidResult, "Connected account balances") as Row[] || []).filter(isObject);
  const itemIds = [...new Set(plaidAccounts.map((account) => String(account.item_id || "")).filter(Boolean))];
  const itemResult: DbResult<Row[]> = itemIds.length
    ? await db.from("plaid_items").select("item_id,connection_status").eq("household_id", context.householdId).in("item_id", itemIds)
    : { data: [], error: null };
  const items = (check(itemResult, "Connected account status") as Row[] || []).filter(isObject);
  const itemById = new Map(items.map((item) => [String(item.item_id), item]));
  const plaidById = new Map(plaidAccounts.map((account) => [String(account.account_id), account]));
  const sourcesByCanonical = new Map<string, Row[]>();
  for (const source of sources) sourcesByCanonical.set(String(source.canonical_account_id), [...(sourcesByCanonical.get(String(source.canonical_account_id)) || []), source]);
  const linkAllocations = new Map<string, number>();
  for (const link of links) {
    const key = String(link.canonical_account_id);
    linkAllocations.set(key, (linkAllocations.get(key) || 0) + (toFinite(link.allocated_amount) ?? 0));
  }
  const allAccountRecords = canonicalAccounts.map((canonical) => {
    const sourceOptions = (sourcesByCanonical.get(String(canonical.canonical_account_id)) || []).map((source) => ({
      source,
      account: plaidById.get(String(source.source_account_id)),
    })).sort((a, b) => {
      const enabled = Number(b.source.transaction_source_enabled === true) - Number(a.source.transaction_source_enabled === true);
      if (enabled) return enabled;
      const role = Number(String(b.source.source_role).toLowerCase() === "primary") - Number(String(a.source.source_role).toLowerCase() === "primary");
      if (role) return role;
      return String(b.account?.balance_updated_at || "").localeCompare(String(a.account?.balance_updated_at || "")) || String(a.source.source_account_id).localeCompare(String(b.source.source_account_id));
    });
    const selected = sourceOptions[0];
    const account = selected?.account;
    const verifiedAt = typeof account?.balance_updated_at === "string" ? account.balance_updated_at : null;
    const updatedAtMs = verifiedAt ? Date.parse(verifiedAt) : NaN;
    const freshBalance = Number.isFinite(updatedAtMs) && updatedAtMs <= (options.now ?? new Date()).getTime() && (options.now ?? new Date()).getTime() - updatedAtMs <= 7 * 24 * 60 * 60 * 1000 && String(account?.balance_currency_code || "").toUpperCase() === "USD";
    const status = !selected || !account || selected.source.transaction_source_enabled !== true ? "unavailable" : itemById.get(String(account.item_id))?.connection_status === "connected" && account.lifecycle_status === "active" && freshBalance ? "available" : "stale";
    return {
      canonical_account_id: canonical.canonical_account_id,
      name: canonical.display_name,
      display_name: canonical.display_name,
      account_type: canonical.account_type,
      account_subtype: canonical.account_subtype,
      mask: canonical.mask,
      balance: status === "available" ? toFinite(account?.current_balance) : null,
      current_balance: status === "available" ? toFinite(account?.current_balance) : null,
      balance_verified_at: verifiedAt,
      balance_status: status,
      connection_status: selected ? itemById.get(String(account?.item_id))?.connection_status ?? null : "unavailable",
      allocated_amount: Math.round((linkAllocations.get(String(canonical.canonical_account_id)) || 0) * 100) / 100,
      household_current_allocated_balance: (() => {
        const linkedGoals = goals.filter((goal) => links.some((link) => String(link.goal_id) === String(goal.goal_id) && String(link.canonical_account_id) === String(canonical.canonical_account_id)));
        if (!linkedGoals.length) return 0;
        const values = linkedGoals.map((goal) => currentBalances.get(`${goal.goal_id}:${canonical.canonical_account_id}`));
        return values.every((value): value is number => value !== undefined)
          ? values.reduce((sum, value) => sum + value, 0)
          : null;
      })(),
      goal_current_allocated_balance: requestedGoalId ? currentBalances.get(`${requestedGoalId}:${canonical.canonical_account_id}`) ?? null : null,
      already_linked: links.some((link) => String(link.canonical_account_id) === String(canonical.canonical_account_id)),
      selectable: selected?.source.transaction_source_enabled === true && itemById.get(String(account?.item_id))?.connection_status === "connected" && ["depository", "investment", "brokerage"].includes(String(canonical.account_type || "").toLowerCase()),
    };
  });
  const accountOptions = allAccountRecords.filter((account) => account.selectable || account.already_linked);
  const allocatedBalanceByLink = new Map<string, number>();
  for (const goal of goals) for (const link of links.filter((entry) => String(entry.goal_id) === String(goal.goal_id))) {
    const value = currentBalances.get(`${goal.goal_id}:${link.canonical_account_id}`);
    if (value !== undefined) allocatedBalanceByLink.set(`${goal.goal_id}:${link.canonical_account_id}`, value);
  }
  const linksByGoal = new Map<string, Row[]>();
  for (const link of links) linksByGoal.set(String(link.goal_id), [...(linksByGoal.get(String(link.goal_id)) || []), {
    ...link,
    current_allocated_balance: allocatedBalanceByLink.get(`${link.goal_id}:${link.canonical_account_id}`) ?? null,
  }]);

  const bounds = monthBounds(month);
  let activityQuery = () => db.from("finance_goal_savings_activity").select("*").eq("household_id", context.householdId).gte("transaction_date", bounds.from).lt("transaction_date", bounds.through).order("transaction_date", { ascending: false }).order("activity_id", { ascending: false });
  const [eventPages, directGoalPages] = await Promise.all([
    accountIds.length
      ? readPages((start, end) => activityQuery().in("canonical_account_id", accountIds).range(start, end), MAX_ACTIVITY_ROWS)
      : Promise.resolve({ rows: [] as Row[], hasMore: false }),
    goalIds.length
      ? readPages((start, end) => activityQuery().in("goal_id", goalIds).range(start, end), MAX_ACTIVITY_ROWS)
      : Promise.resolve({ rows: [] as Row[], hasMore: false }),
  ]);
  const activityById = new Map<string, Row>();
  for (const event of [...eventPages.rows, ...directGoalPages.rows]) if (typeof event.activity_id === "string") activityById.set(event.activity_id, event);
  if (requestedActivity && typeof body.activity_id === "string") {
    const activityResult: DbResult<Row[]> = await db.from("finance_goal_savings_activity").select("*").eq("household_id", context.householdId).eq("activity_id", body.activity_id).limit(1);
    const eventRows = check(activityResult, "Savings activity") as Row[];
    if (Array.isArray(eventRows) && isObject(eventRows[0])) activityById.set(String(eventRows[0].activity_id), eventRows[0]);
  }
  const activities = [...activityById.values()].sort((a, b) => String(b.transaction_date || "").localeCompare(String(a.transaction_date || ""))).slice(0, MAX_ACTIVITY_ROWS);
  const activityIds = activities.map((event) => String(event.activity_id));
  const allocationRows: Row[] = [];
  for (let offset = 0; offset < activityIds.length; offset += 200) {
    const ids = activityIds.slice(offset, offset + 200);
    const result: DbResult<Row[]> = await db.from("finance_goal_savings_activity_allocations")
      .select("allocation_id,activity_id,goal_id,allocated_signed_amount,status,decision_reason,revision")
      .eq("household_id", context.householdId).in("activity_id", ids);
    allocationRows.push(...((check(result, "Savings allocations") as Row[]) || []).filter(isObject));
  }
  const reviewMetadata = activityIds.length
    ? rpcRows(await db.rpc("finance_get_savings_activity_review_metadata", { p_household_id: context.householdId, p_activity_ids: activityIds }), "Savings review metadata")
    : [];
  const metadataByActivity = new Map(reviewMetadata.map((row) => [String(row.activity_id), row]));
  const allocationsByActivity = new Map<string, Row[]>();
  for (const allocation of allocationRows) allocationsByActivity.set(String(allocation.activity_id), [...(allocationsByActivity.get(String(allocation.activity_id)) || []), allocation]);
  const normalizedActivities = activities.map((event) => {
    const allocations = allocationsByActivity.get(String(event.activity_id)) || [];
    const metadata = metadataByActivity.get(String(event.activity_id)) || {};
    const eligibleGoalIds = Array.isArray(metadata.eligible_goal_ids) ? metadata.eligible_goal_ids.map(String).filter((id: string) => goalIdSet.has(id)) : [];
    const confirmableGoalIds = Array.isArray(metadata.confirmable_goal_ids) ? metadata.confirmable_goal_ids.map(String).filter((id: string) => goalIdSet.has(id)) : [];
    return {
      ...event,
      allocations,
      eligible_goal_ids: eligibleGoalIds,
      confirmable_goal_ids: confirmableGoalIds,
      eligible_actions: Array.isArray(metadata.eligible_actions) ? metadata.eligible_actions : [],
      audit_id: metadata.undo_eligible === true && typeof metadata.audit_id === "string" ? metadata.audit_id : null,
      undo_eligible: metadata.undo_eligible === true && typeof metadata.audit_id === "string",
    };
  });

  const auditResult = await db.rpc("finance_get_savings_audit_history", {
    p_household_id: context.householdId,
    p_goal_id: requestedGoalId,
    p_from: auditMonthBounds.from,
    p_through: auditMonthBounds.through,
    p_before_created_at: body.audit_before_created_at ?? null,
    p_before_audit_id: body.audit_before_id ?? null,
    p_limit: 101,
  });
  const auditRows = rpcRows(auditResult, "Savings correction history");
  const correctionHistoryHasMore = auditRows.length > 100;
  const correctionRows = auditRows.slice(0, 100);
  const correctionCursor = correctionHistoryHasMore && correctionRows.length
    ? { created_at: correctionRows[correctionRows.length - 1].created_at, audit_id: correctionRows[correctionRows.length - 1].audit_id }
    : null;

  const monthlyMap = new Map(monthlyRows.map((row) => [String(row.goal_id), row]));
  const goalsWithSummary = goals.map((goal) => {
    const summary = monthlyMap.get(String(goal.goal_id));
    const monthlyHistory = historyByGoal.get(String(goal.goal_id)) || [];
    const historyQuality = historyByGoal.get(String(goal.goal_id))?.find((row) => row.history_quality)?.history_quality
      || historyByGoal.get(String(goal.goal_id))?.find((row) => row.complete_month_count !== undefined) || {};
    return {
      ...goal,
      month_net_contributions: toFinite(summary?.month_net_contributions),
      month_needs_review_amount: toFinite(summary?.month_needs_review_amount),
      account_links: linksByGoal.get(String(goal.goal_id)) || [],
      monthly_history: monthlyHistory,
      history_quality: historyQuality,
    };
  });
  const forecast = options.loadForecast ? await options.loadForecast(context, timezone).catch(() => null) : null;
  const intelligence = buildSavingsIntelligence({
    today,
    timezone,
    forecast: isObject(forecast) ? forecast : null,
    goals: goalsWithSummary.map((goal) => ({
      goalId: String(goal.goal_id),
      currentAmount: toFinite(goal.current_amount) ?? NaN,
      targetAmount: toFinite(goal.target_amount) ?? NaN,
      monthlyNetContributions: toFinite(goal.month_net_contributions),
      monthlyHistory: (goal.monthly_history || []).map((row: Row) => ({ month: String(row.month_start || row.month || "").slice(0, 7), net: Number(row.month_net_contributions ?? row.net) })),
      complete_month_count: Number(goal.history_quality?.complete_month_count) || 0,
      history_complete: goal.history_quality?.history_complete === true,
      history_reliable: goal.history_quality?.history_reliable === true,
      internal_transfers_excluded: goal.history_quality?.internal_transfers_excluded === true,
      planPriority: priorityByGoal.get(String(goal.goal_id)) ?? null,
      targetDate: validDateOnly(goal.deadline_date) ? goal.deadline_date : null,
    })),
  });
  const estimates = new Map(intelligence.goals.map((row) => [row.goalId, row]));
  const goalsWithIntelligence = goalsWithSummary.map((goal) => ({ ...goal, ...(estimates.get(String(goal.goal_id)) || {}) }));
  const currentGoal = requestedGoalId ? goalsWithIntelligence.find((goal) => String(goal.goal_id) === requestedGoalId) || null : null;
  return {
    month,
    timezone,
    goals: goalsWithIntelligence,
    activities: normalizedActivities,
    activity_has_more: eventPages.hasMore || directGoalPages.hasMore,
    corrections: correctionRows,
    correction_history_has_more: correctionHistoryHasMore,
    correction_history_cursor: correctionCursor,
    current_goal: currentGoal,
    account_options: accountOptions,
    canonical_accounts: allAccountRecords,
    prioritized_goals: intelligence.prioritized_goals,
    potential_surplus: intelligence.potential_surplus,
    forecast_status: intelligence.forecast_status,
  };
}
