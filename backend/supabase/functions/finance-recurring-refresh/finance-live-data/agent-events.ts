export type AgentEvent = {
  event_type: "budget_pace_risk" | "recurring_amount_change" | "account_sync_issue" | "cash_floor_risk" | "income_materially_different" | "budget_projection_improved" | "forecast_change" | "new_recurring_detected" | "income_received" | "income_missing" | "recurring_payment_missing" | "goal_progress_change" | "duplicate_account_suspected" | "plan_at_risk" | "refund_applied" | "savings_review_needed" | "savings_opportunity";
  fingerprint: string;
  severity: number;
  urgency: number;
  confidence: number;
  actionability: number;
  novelty: number;
  facts: Record<string, unknown>;
  title: string;
  summary: string;
  recommended_actions: Array<Record<string, unknown>>;
};
type Row = Record<string, unknown>;

const boundedNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e9 ? number : null;
};
const text = (value: unknown, max = 160): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const money = (amount: number): string => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
const currencyMoney = (amount: number, currency: string): string => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); } catch { return `${amount.toFixed(2)} ${currency}`; } };

/** Recurring events are emitted only from a complete, recently verified bank snapshot. */
export function recurringEvidenceIsFresh(state: Row, now = Date.now()): boolean {
  if (state.recurringComplete !== true) return false;
  const generated = Date.parse(String(state.recurringGeneratedAt || ""));
  const age = now - generated;
  if (!Number.isFinite(generated) || age < -5 * 60_000 || age > 24 * 60 * 60_000) return false;
  const expected = (Array.isArray(state.recurringSourceCoverage) ? state.recurringSourceCoverage : [])
    .filter((source: unknown): source is Row => !!source && typeof source === "object" && !Array.isArray(source) && (source as Row).expected === true);
  return expected.length > 0 && expected.every((source: Row) => {
    const fetched = Date.parse(String(source.fetched_at || ""));
    const sourceAge = now - fetched;
    return source.status === "success" && Number.isFinite(fetched) && sourceAge >= -5 * 60_000 && sourceAge <= 24 * 60 * 60_000;
  });
}
/** Preserve an overdue occurrence while Plaid rolls its predicted-next date forward. */
export function recurringExpectedDate(current: Row, previous: Row | null | undefined): string | null {
  const next = text(current.dateIso || current.nextDate, 10) || null;
  if (!previous) return next;
  const scheduleChanged = (previous.nextDateOverride ?? null) !== (current.nextDateOverride ?? null) || previous.frequency !== current.frequency;
  const preserveExpected = previous.lastDate === current.lastDate && !scheduleChanged;
  return preserveExpected ? text(previous.expectedDate || previous.nextDate, 10) || next : next;
}
function businessDaysLate(dueDate: string, today: string): number {
  const start = Date.parse(`${dueDate}T00:00:00Z`), end = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let count = 0;
  for (let date = start + 86_400_000; date <= end; date += 86_400_000) {
    const day = new Date(date).getUTCDay();
    if (day !== 0 && day !== 6 && !isUsBankHoliday(new Date(date).toISOString().slice(0, 10))) count++;
  }
  return count;
}
function isUsBankHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4)), holidays = new Set<string>();
  const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
  for (const holidayYear of [year - 1, year, year + 1]) {
    const fixed = (month: number, day: number) => {
      const value = new Date(Date.UTC(holidayYear, month - 1, day)), weekday = value.getUTCDay();
      if (weekday === 6) value.setUTCDate(value.getUTCDate() - 1);
      else if (weekday === 0) value.setUTCDate(value.getUTCDate() + 1);
      holidays.add(dateOnly(value));
    };
    fixed(1, 1); fixed(6, 19); fixed(7, 4); fixed(11, 11); fixed(12, 25);
    const mondayOf = (month: number, occurrence: number) => {
      const value = new Date(Date.UTC(holidayYear, month - 1, 1));
      value.setUTCDate(1 + ((8 - value.getUTCDay()) % 7) + 7 * (occurrence - 1));
      holidays.add(dateOnly(value));
    };
    mondayOf(1, 3); mondayOf(2, 3); mondayOf(9, 1); mondayOf(10, 2);
    const thanksgiving = new Date(Date.UTC(holidayYear, 10, 1));
    thanksgiving.setUTCDate(1 + ((4 - thanksgiving.getUTCDay() + 7) % 7) + 21);
    holidays.add(dateOnly(thanksgiving));
    const memorial = new Date(Date.UTC(holidayYear, 5, 0));
    memorial.setUTCDate(31 - ((memorial.getUTCDay() + 6) % 7));
    holidays.add(dateOnly(memorial));
  }
  return holidays.has(date);
}

export function detectFinancialEvents(state: Row, now = Date.now()): AgentEvent[] {
  const today = text(state.today, 10);
  const previous = state.previous && typeof state.previous === "object" ? state.previous as Row : null;
  if (!/^20\d\d-\d\d-\d\d$/.test(today)) return [];
  const month = today.slice(0, 7), events: AgentEvent[] = [];
  for (const refund of Array.isArray(state.refunds) ? state.refunds : []) {
    if (!refund || typeof refund !== "object" || Array.isArray(refund)) continue;
    const row = refund as Row, id = text(row.transaction_id, 160), amount = boundedNumber(row.amount), currency = text(row.currency, 3).toUpperCase() || "USD";
    if (!id || amount === null || amount <= 0 || row.refund_status !== "matched" || row.relationship_type !== "refund") continue;
    const value = currencyMoney(amount, currency), category = text(row.effective_category, 100), merchant = text(row.merchant, 100);
    const title = merchant ? `Applied ${merchant} refund` : "Applied refund";
    const summary = row.budget_applied === true && category ? `+${value} returned to ${category}.` : `+${value} refund matched.`;
    const facts = { transaction_id: id, original_transaction_id: text(row.original_transaction_id,160) || null, amount, currency, effective_category: category || null, merchant: merchant || null, budget_applied: row.budget_applied === true, refund_status: "matched", match_source: text(row.source,40) || null, occurred_on: text(row.date,10) || null, evidence_source: "persisted_refund_relationship" };
    events.push({ event_type: "refund_applied", fingerprint: `refund_applied:${id}`, severity: 0.4, urgency: 0.2, confidence: 1, actionability: 0.1, novelty: 0.1, facts, title, summary, recommended_actions: [] });
  }
  const coaching = new Map((Array.isArray(state.budgetCoaching) ? state.budgetCoaching : [])
    .filter((item: unknown): item is Row => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item: Row) => [text(item.id, 120), item] as const));
  for (const budget of Array.isArray(state.budgets) ? state.budgets : []) {
    if (!budget || typeof budget !== "object" || Array.isArray(budget)) continue;
    const row = budget as Row, id = text(row.id, 120), name = text(row.name, 100), target = boundedNumber(row.availableCapacity===undefined?row.target:row.availableCapacity), spent = boundedNumber(row.spent);
    if (!id || !name || target === null || target <= 0 || spent === null) continue;
    const forecast = coaching.get(id), projected = forecast?.usable === true ? boundedNumber(forecast.projected) : null;
    const ratio = spent / target, projectedOverage = projected === null ? Math.max(0, spent - target) : Math.max(0, projected - target);
    const risk = forecast?.usable === true && typeof forecast.risk === "string"
      ? forecast.risk === "over" || forecast.risk === "pressure"
      : spent >= target * 0.85;
    if (!risk) continue;
    const over = projectedOverage > 0, severity = over ? 0.9 : 0.7;
    const transfer = forecast && typeof forecast === "object" && forecast.transfer && typeof forecast.transfer === "object" ? forecast.transfer as Row : null;
    const fromId = transfer ? text(transfer.fromId, 120) : "", fromName = transfer ? text(transfer.fromName, 100) : "";
    const amount = transfer ? boundedNumber(transfer.amount) : null;
    const action = fromId && amount !== null && amount >= 25
      ? { action_type: "reallocate_budget", label: `Review ${money(amount)} transfer`, payload: { from_budget_target_id: fromId, to_budget_target_id: id, from_name: fromName, to_name: name, amount }, confidence: 0.9, risk_level: "low", reversible: true, requires_confirmation: true }
      : { action_type: "review", label: "Review budget", payload: { destination: "budget", budget_target_id: id }, confidence: 0.92, risk_level: "low", reversible: true, requires_confirmation: false };
    const facts = {
      category: name, category_id:id, budget_month:typeof state.today==='string'?state.today.slice(0,7):null,
      currency:'USD', currency_verified:state.history?.currency_verified===true,
      source_revision:Number.isSafeInteger(state.history?.generation)?`budget-history:${state.history.generation}`:null,
      // Current canonical budget period calculations use the established Denver zone.
      // Bind it into the issue so later checks do not reinterpret the month in the user's appointment zone.
      budget_timezone:'UTC',
      target, base_target:row.target, opening_carry:row.openingCarry??0, spent, remaining: Math.round((target - spent) * 100) / 100,
      projected_spend: projected, projected_overage: Math.round(projectedOverage * 100) / 100,
      utilization: Math.round(ratio * 100), known_bills_reserved: boundedNumber(forecast?.reserve),
      typical_weekend_spend: boundedNumber(forecast?.typicalWeekend), remaining_weekends: boundedNumber(forecast?.remainingWeekends),
      days_remaining: boundedNumber(forecast?.windowDays) === null ? null : forecast?.windowDays,
      evidence_source: projected === null ? "current_budget_progress" : "existing_budget_coach_forecast",
      severity,
    };
    const summary = projected !== null
      ? `${name} may finish about ${money(projectedOverage)} over. ${money(target - spent)} remains; the current spending pattern projects ${money(projected)} by month-end.`
      : over ? `${money(projectedOverage)} over the monthly target.` : `${Math.round(ratio * 100)}% of this month's target is used.`;
    events.push({ event_type: "budget_pace_risk", fingerprint: `budget_pace_risk:${month}:${id}`, severity, urgency: over ? 0.85 : 0.55, confidence: projected === null ? 0.78 : 0.94, actionability: amount !== null && fromId ? 0.92 : 0.78, novelty: 0.82, facts, title: projected !== null && over ? `${name} may finish ${money(projectedOverage)} over` : over ? `${name} is over target` : `${name} is nearing its target`, summary, recommended_actions: [action] });
  }
  const recurringFresh = recurringEvidenceIsFresh(state, now);
  for (const stream of recurringFresh && Array.isArray(state.recurring) ? state.recurring : []) {
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) continue;
    const row = stream as Row;
    if (row.status !== "Active") continue;
    const key = text(row.streamKey || row.stream_key || row.streamId || row.name, 180), name = text(row.name || row.description || "Recurring charge", 100);
    // Only subscription charges with recent, linked posted evidence qualify; a
    // user-edited expected amount or a variable utility bill is not a price increase.
    const latestSubscription = boundedNumber(row.lastAmount || row.last_amount);
    const typical = boundedNumber(row.averageAmount || row.average_amount);
    const subscriptionLastDate = text(row.lastDate || row.last_date, 10);
    const subscriptionAge = /^20\d\d-\d\d-\d\d$/.test(subscriptionLastDate) ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${subscriptionLastDate}T00:00:00Z`)) / 86400000 : Infinity;
    const linkedIds = Array.isArray(row.transactionIds) ? row.transactionIds.filter((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 180).slice(-10) : [];
    const increase = latestSubscription !== null && typical !== null ? latestSubscription - Math.abs(typical) : null;
    if (row.type === "subscription" && row.sourceType === "plaid" && row.primaryEligible === true && row.maturity === "MATURE" && row.currency === "USD" && key && increase !== null && increase >= Math.max(10, Math.abs(typical!) * 0.2) && subscriptionAge >= 0 && subscriptionAge <= 45 && linkedIds.length > 0) {
      const materialIncrease = Math.round(increase * 100) / 100;
      const facts = { stream_key: key, name, last_date: subscriptionLastDate, latest_amount: Math.round(latestSubscription! * 100) / 100, increase: materialIncrease, typical_amount: Math.round(Math.abs(typical!) * 100) / 100, transaction_ids: linkedIds, evidence_source: "recent_posted_plaid_subscription_charge", source_generated_at: state.recurringGeneratedAt };
      events.push({ event_type: "recurring_amount_change", fingerprint: `recurring_amount_change:${key}`, severity: 0.78, urgency: 0.72, confidence: 0.96, actionability: 0.9, novelty: 0.9, facts, title: `${name} subscription increased`, summary: `A recent posted charge was ${money(materialIncrease)} above its typical ${money(Math.abs(typical!))}. Review the linked charge and recurring schedule.`, recommended_actions: [{ action_type: "review", label: "Review subscription", payload: { destination: "recurring", stream_key: key, transaction_ids: linkedIds }, confidence: 0.96, risk_level: "low", reversible: true, requires_confirmation: false }] });
    }
    const income = row.type === "income";
    const mature = String(row.maturity || row.status || "").toUpperCase() === "MATURE" && row.primaryEligible === true;
    const average = boundedNumber(row.averageAmount || row.average_amount);
    const latest = boundedNumber(row.lastAmount || row.last_amount);
    const latestDate = text(row.lastDate || row.last_date, 10);
    const ageDays = /^20\d\d-\d\d-\d\d$/.test(latestDate) ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latestDate}T00:00:00Z`)) / 86400000 : Infinity;
    if (income && row.sourceType === "plaid" && mature && row.currency === "USD" && row.status === "Active" && key && average !== null && average > 0 && latest !== null && latest > 0 && ageDays >= 0 && ageDays <= 45 && Math.abs(latest - average) >= Math.max(100, average * 0.15)) {
      const delta = Math.round((latest - average) * 100) / 100;
      const facts = { stream_key: key, name, typical_amount: Math.round(average * 100) / 100, latest_amount: Math.round(latest * 100) / 100, difference: delta, last_date: latestDate, evidence_source: "mature_recurring_income_stream" };
      events.push({ event_type: "income_materially_different", fingerprint: `income_materially_different:${key}:${month}`, severity: delta < 0 ? 0.82 : 0.62, urgency: delta < 0 ? 0.72 : 0.45, confidence: 0.88, actionability: 0.65, novelty: 0.8, facts, title: delta < 0 ? `${name} was lower than usual` : `${name} was higher than usual`, summary: `The latest income was ${money(Math.abs(delta))} ${delta < 0 ? "below" : "above"} its typical amount of ${money(average)}.`, recommended_actions: [{ action_type: "review", label: "Review income", payload: { destination: "recurring" }, confidence: 0.85, risk_level: "low", reversible: true, requires_confirmation: false }] });
    }
  }
  const planning = state.planning && typeof state.planning === "object" && !Array.isArray(state.planning) ? state.planning as Row : null;
  const points = planning && Array.isArray(planning.points) ? planning.points.filter((point: unknown): point is Row => !!point && typeof point === "object" && !Array.isArray(point)) : [];
  const warnings = planning && Array.isArray(planning.warnings) ? planning.warnings : ["missing forecast quality state"];
  const horizon = boundedNumber(planning?.horizonDays);
  const pointsAreComplete = horizon !== null && points.length === horizon + 1 && points.every((point, index) => {
    const expected = new Date(Date.parse(`${today}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
    return text(point.date, 10) === expected && boundedNumber(point.balance) !== null;
  });
  if (planning?.currentForForecast === true && planning?.ready === true && planning.complete === true && planning.reliable === true && horizon !== null && horizon > 0 && pointsAreComplete) {
    const lowPoint = points.reduce((low, point) => Number(point.balance) < Number(low.balance) ? point : low);
    const projectedLow = boundedNumber(lowPoint.balance);
    const preferredFloor = boundedNumber(state.preferredCashFloor);
    // Zero is a shortfall boundary, not an invented user preference.
    const threshold = preferredFloor !== null && preferredFloor >= 0 ? preferredFloor : 0;
    if (projectedLow !== null && projectedLow < threshold) {
      const facts = { minimum_balance: Math.round(projectedLow * 100) / 100, minimum_date: text(lowPoint.date, 10), threshold, preferred_floor: preferredFloor, days_below: points.filter(point => Number(point.balance) < threshold).length, horizon_days: horizon, scope: text(planning.scope || "Connected cash accounts", 100), account_scope_key: typeof planning.accountScopeKey==='string'?planning.accountScopeKey:null, currency:planning.currency??null, currency_verified:planning.currencyVerified===true, source_revision:typeof planning.sourceRevision==='string'?planning.sourceRevision:null, evidence_source: "complete_existing_planning_forecast" };
      events.push({ event_type: "cash_floor_risk", fingerprint: `cash_floor_risk:${horizon}:${month}`, severity: 0.96, urgency: 0.92, confidence: 0.94, actionability: 0.75, novelty: 0.82, facts, title: threshold > 0 ? "Cash may fall below your preferred floor" : "Cash shortfall predicted", summary: `The existing ${horizon}-day Planning forecast reaches ${money(projectedLow)} on ${text(lowPoint.date, 10)}${threshold > 0 ? `, below your preferred ${money(threshold)} floor` : ", below zero"}.`, recommended_actions: [{ action_type: "review", label: "Review Planning", payload: { destination: "planning" }, confidence: 0.94, risk_level: "low", reversible: true, requires_confirmation: false }] });
    }
  }
  const institutions = new Map<string, { state: string; name: string; staleHours: number | null }>();
  for (const account of Array.isArray(state.accounts) ? state.accounts : []) {
    if (!account || typeof account !== "object" || Array.isArray(account)) continue;
    const row = account as Row, name = text(row.institution || row.name || "Institution", 100), status = text(row.status).toLowerCase();
    const updatedAt = Date.parse(String(row.sourceBalanceUpdatedAt || row.lastUpdate || ""));
    const staleHours = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 36e5) : null;
    const issue = /needs_attention|error|failed|disconnected|login_required|auth_required|authentication_required|reauth_required/.test(status) ? "needs_attention" : staleHours === null || staleHours > 36 ? "stale" : "current";
    const current = institutions.get(name);
    if (!current || issue !== "current" && current.state === "current" || issue === "needs_attention" && current.state !== "needs_attention") institutions.set(name, { state: issue, name, staleHours });
  }
  for (const item of institutions.values()) {
    if (item.state === "current") continue;
    const critical = item.state === "needs_attention", severity = critical ? 0.9 : 0.66;
    const facts = { institution: item.name, state: item.state, stale_hours: item.staleHours === null ? null : Math.round(item.staleHours) };
    events.push({ event_type: "account_sync_issue", fingerprint: `account_sync_issue:${item.name.toLowerCase()}`, severity, urgency: critical ? 0.9 : 0.5, confidence: critical || item.staleHours !== null ? 0.92 : 0.65, actionability: 0.9, novelty: 0.8, facts, title: `${item.name} connection`, summary: critical ? "This connection needs attention. Refresh or reconnect it." : item.staleHours === null ? "A successful update time is unavailable. Review this connection." : `The last successful update was about ${Math.round(item.staleHours)} hours ago.`, recommended_actions: [{ action_type: "review", label: "Review accounts", payload: { destination: "accounts" }, confidence: 0.95, risk_level: "low", reversible: true, requires_confirmation: false }, { action_type: "refresh_accounts", label: "Refresh connected accounts", payload: { refresh: true }, confidence: 0.9, risk_level: "low", reversible: true, requires_confirmation: false }] });
  }
  // The savings service supplies only persisted review rows and a returned,
  // reliable surplus opportunity. Missing or partial inputs intentionally
  // produce no notification.
  const savings = state.savingsNotifications && typeof state.savingsNotifications === "object"
    ? state.savingsNotifications as Row
    : state.savings_notifications && typeof state.savings_notifications === "object"
      ? state.savings_notifications as Row : null;
  if (savings) {
    const goalNames = new Map((Array.isArray(state.goals) ? state.goals : [])
      .filter((goal: unknown): goal is Row => !!goal && typeof goal === "object" && !Array.isArray(goal))
      .map((goal: Row) => [text(goal.goal_id || goal.id, 120), text(goal.name, 100)] as const));
    const reviewsByGoal = new Map<string, Row[]>();
    const seenReviewIds = new Set<string>();
    for (const item of Array.isArray(savings.unresolved_reviews) ? savings.unresolved_reviews : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const review = item as Row, activityId = text(review.activity_id, 120), goalId = text(review.goal_id, 120), date = text(review.transaction_date, 10);
      if (!activityId || !goalId || seenReviewIds.has(activityId) || seenReviewIds.size >= 100 || !/^20\d\d-\d\d-\d\d$/.test(date)) continue;
      seenReviewIds.add(activityId);
      const rows = reviewsByGoal.get(goalId) || [];
      rows.push({ activity_id: activityId, transaction_date: date });
      reviewsByGoal.set(goalId, rows);
    }
    for (const [goalId, reviews] of reviewsByGoal) {
      reviews.sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)) || String(a.activity_id).localeCompare(String(b.activity_id)));
      const activityIds = reviews.map((review) => review.activity_id as string);
      const name = goalNames.get(goalId) || "Savings goal";
      const latestId = activityIds[activityIds.length - 1];
      const facts = { goal_id: goalId, savings_activity_id: latestId, savings_activity_ids: activityIds, review_count: activityIds.length, evidence_source: "persisted_unresolved_savings_activity" };
      events.push({ event_type: "savings_review_needed", fingerprint: `savings_review_needed:${goalId}`, severity: 0.88, urgency: 0.68, confidence: 0.98, actionability: 0.92, novelty: 0.82, facts, title: `${name}: savings activity needs review`, summary: `Savings activity is waiting for your review before it is included in goal progress.`, recommended_actions: [{ action_type: "review", label: "Review savings activity", payload: { destination: "planning", goal_id: goalId, savings_activity_id: latestId }, confidence: 0.98, risk_level: "low", reversible: true, requires_confirmation: false }] });
    }
    const opportunity = savings.opportunity && typeof savings.opportunity === "object" && !Array.isArray(savings.opportunity) ? savings.opportunity as Row : null;
    const amount = opportunity ? boundedNumber(opportunity.amount) : null, currency = opportunity ? text(opportunity.currency, 3).toUpperCase() : "";
    if (opportunity?.status === "available" && opportunity.basis === "after_committed_obligations_and_cash_floor" && opportunity.forecast_current === true && opportunity.credited === false && amount !== null && amount >= 25 && currency === "USD") {
      const goalId = text(opportunity.goal_id, 120) || null;
      const name = goalId ? goalNames.get(goalId) || null : null;
      const facts = { amount: Math.round(amount * 100) / 100, currency, basis: opportunity.basis, goal_id: goalId, evidence_source: "reliable_returned_savings_opportunity" };
      events.push({ event_type: "savings_opportunity", fingerprint: `savings_opportunity:${month}${goalId ? `:${goalId}` : ""}`, severity: 0.82, urgency: 0.75, confidence: 0.95, actionability: 0.9, novelty: 0.85, facts, title: "Potential savings contribution found", summary: `${currencyMoney(amount, facts.currency)} may be available after committed obligations and your cash floor${name ? ` for ${name}` : ""}. Review it before deciding whether to contribute.`, recommended_actions: [{ action_type: "review", label: "Review savings opportunity", payload: { destination: "planning", ...(goalId ? { goal_id: goalId } : {}) }, confidence: 0.94, risk_level: "low", reversible: true, requires_confirmation: false }] });
    }
  }
  const emit = (event_type: AgentEvent["event_type"], key: string, title: string, summary: string, facts: Row, destination: string, urgency = .65) => events.push({event_type,fingerprint:`${event_type}:${key}:${month}`,severity:.85,urgency,confidence:.9,actionability:.85,novelty:.9,facts,title,summary,recommended_actions:[{action_type:"review",label:"Review",payload:{destination},confidence:.9,risk_level:"low",reversible:true,requires_confirmation:false}]});
  for(const candidate of Array.isArray(state.duplicateCandidates)?state.duplicateCandidates:[]){
    const id=text(candidate.candidate_id,80);if(!id)continue;
    emit("duplicate_account_suspected",id,"A joint account may be linked twice","Review the existing account match before choosing which connection contributes transactions.",{candidate_id:id,source:"canonical_account_match_candidates"},"accounts",.9);
  }
  if (previous) {
    if (previous.month === month) for (const b of Array.isArray(state.budgetCoaching) ? state.budgetCoaching : []) {
      const old = (Array.isArray(previous.budgets) ? previous.budgets : []).find((v: any) => v.id === b.id);
      if (old && old.projected !== null && b.usable && b.projected !== null && old.projected > old.target && b.projected <= b.target && old.projected - b.projected >= Math.max(25,b.target*.05)) emit("budget_projection_improved",b.id,`${b.name} is back within target`, `The projection improved from ${money(old.projected)} to ${money(b.projected)} against a ${money(b.target)} target.`,{category:b.name,before:old.projected,projected_spend:b.projected,target:b.target},"budget",.4);
    }
    const oldForecast=previous.forecast as any;
    if(planning?.currentForForecast===true && pointsAreComplete && horizon!==null){
      const low=points.reduce((a,b)=>Number(a.balance)<Number(b.balance)?a:b);
      const inputChanges=(Array.isArray(planning.economicChanges)?planning.economicChanges:[]).flatMap((change:unknown)=>{
        if(!change||typeof change!=="object"||Array.isArray(change))return [];
        const row=change as Row,kind=text(row.kind,40);
        if(!["balance_changed","scheduled_event_added","scheduled_event_changed","scheduled_event_removed","variable_spend_changed"].includes(kind))return [];
        const value:Row={kind};
        for(const field of ["before","after","delta","amount"]){const number=boundedNumber(row[field]);if(number!==null)value[field]=number;}
        const date=text(row.date,10);if(/^20\d\d-\d\d-\d\d$/.test(date))value.date=date;
        const reference=Math.abs(Number(value.before??value.amount??0));
        const threshold=kind==="balance_changed"?Math.max(250,reference*.05):Math.max(25,reference*.05);
        const changeAmount=typeof value.delta==="number"?Math.abs(value.delta):typeof value.amount==="number"?Math.abs(value.amount):0;
        return Object.keys(value).length>1&&changeAmount>=threshold?[value]:[];
      }).slice(0,12);
      const oldLow=oldForecast&&Number(oldForecast.horizon)===horizon&&Number.isFinite(Number(oldForecast.balance))?Number(oldForecast.balance):null;
      const difference=oldLow===null?null:Number(low.balance)-oldLow;
      const lowChanged=difference!==null&&Math.abs(difference)>=Math.max(250,Math.abs(oldLow)*.05);
      if(inputChanges.length||lowChanged){
        const variableChanges=inputChanges.filter((change:Row)=>change.kind==="variable_spend_changed");
        const scheduledChanges=variableChanges.length?[]:inputChanges.filter((change:Row)=>String(change.kind).startsWith("scheduled_event_"));
        const balanceChanges=inputChanges.filter((change:Row)=>change.kind==="balance_changed");
        const details:string[]=[];
        for(const change of variableChanges){if(typeof change.delta==="number")details.push(`projected variable spending changed by ${money(Math.abs(change.delta))}`);}
        if(scheduledChanges.length)details.push(`${scheduledChanges.length} upcoming item${scheduledChanges.length===1?"":"s"} changed`);
        if(balanceChanges.length)details.push(`${balanceChanges.length} account balance${balanceChanges.length===1?"":"s"} changed`);
        if(lowChanged)details.push(`the projected low moved by ${money(Math.abs(difference!))}`);
        const facts={minimum_balance:low.balance,minimum_date:low.date,difference,horizon_days:horizon,input_changes:inputChanges,evidence_source:"current_verified_forecast_inputs"};
        emit("forecast_change",String(horizon),"Your cash outlook inputs changed",`${details.join("; ")||"The projected cash outlook changed"}. The projected low is ${money(Number(low.balance))} on ${text(low.date,10)}.`,facts,"planning",.55);
      }
    }
    for (const goal of Array.isArray(state.goals) ? state.goals : []) {
      const id = goal.goal_id || goal.id, current = Number(goal.current_amount ?? goal.current), target = Number(goal.target_amount ?? goal.target);
      const old = (Array.isArray(previous.goals) ? previous.goals : []).find((v:any)=>v.id===id);
      if (old && target>0 && goal.goal_type!=="debt" && goal.type!=="debt" && Math.floor(current/target*4)>Math.floor(Number(old.current)/target*4)) emit("goal_progress_change",id,`${goal.name}: a savings milestone`,`${money(current)} saved toward ${money(target)}.`,{goal_id:id,current,target},"planning",.4);
    }
  }
  if (recurringFresh) for (const r of Array.isArray(state.recurring) ? state.recurring : []) {
    if(r.status!=="Active" || ["transfer","repayment"].includes(r.type) || r.currency!=="USD" || r.primaryEligible!==true)continue;
    const id=text(r.streamKey||r.streamId||r.id,180);if(!id)continue;
    const old=(Array.isArray(previous?.recurring)?previous.recurring:[]).find((v:any)=>v.id===id);
    const name=text(r.name,100), last=text(r.lastDate,10), next=text(r.dateIso,10), income=r.type==="income";
    if(previous?.recurringComplete===true && !old)emit("new_recurring_detected",id,`${name} appears recurring`,"Review this newly detected stream and its expected schedule.",{stream_key:id,name,amount:r.amount},"recurring",.45);
    if(income && old && last && last > String(old.lastDate||"") && last.slice(0,7)===month){
      const linked=Array.isArray(r.transactionIds)?r.transactionIds:Array.isArray(r.transaction_ids)?r.transaction_ids:[];
      const transaction_ids=[...new Set(linked.filter((value:any)=>typeof value==='string'&&value.length>0&&value.length<=180))].slice(0,100);
      emit("income_received",id,`${name} arrived`,`${money(Math.abs(Number(r.lastAmount||r.amount)))} of recurring income posted on ${last}.`,{stream_key:id,name,amount:r.lastAmount||r.amount,last_date:last,transaction_ids},"recurring",.4);
    }
    // Respect a changed schedule, and ignore user-paused/skipped/pending dates.
    const scheduleUnchanged = !!old && old.lastDate === r.lastDate && old.nextDate === next && old.frequency === r.frequency;
    const due = text(r.expectedDate, 10) || (scheduleUnchanged ? old.expectedDate || old.nextDate || next : next);
    const lateDays = /^20\d\d-\d\d-\d\d$/.test(String(due)) ? (Date.parse(today+"T00:00:00Z")-Date.parse(due+"T00:00:00Z"))/86400000 : 0;
    const businessLate = income ? businessDaysLate(String(due), today) : 0;
    const skipped = Array.isArray(r.lifecycleSkippedDates) && r.lifecycleSkippedDates.includes(due);
    const pending = r.pendingOccurrenceDate === due;
    const eligibleKind = income ? r.sourceType === "plaid" : ["bill", "subscription"].includes(r.type);
    const graceMet = income ? businessLate >= 5 : lateDays >= 3;
    if(eligibleKind && r.maturity === "MATURE" && r.primaryEligible === true && !r.lifecyclePaused && !skipped && !pending && graceMet && lateDays <= 14 && last && last < due && state.accountsHealthy === true) {
      const detail = income ? "recurring income may be late" : "the recurring payment may be late";
      const facts={stream_key:id,name,expected_date:due,last_date:last,grace_days:income?5:3,grace_basis:income?"business_days":"calendar_days",transaction_ids:Array.isArray(r.transactionIds)?r.transactionIds.slice(0,20):[],evidence_source:"fresh_mature_recurring_schedule",source_generated_at:state.recurringGeneratedAt};
      events.push({event_type:income?"income_missing":"recurring_payment_missing",fingerprint:`${income?"income_missing":"recurring_payment_missing"}:${id}:${due}`,severity:.85,urgency:.9,confidence:.9,actionability:.85,novelty:.9,facts,title:`${name} has not appeared yet`,summary:`The expected ${income?"income":"payment"} around ${due} is not in the latest fresh bank data; ${detail}.`,recommended_actions:[{action_type:"review",label:income?"Review recurring income":"Review recurring payment",payload:{destination:"recurring",stream_key:id,expected_date:due,transaction_ids:facts.transaction_ids},confidence:.9,risk_level:"low",reversible:true,requires_confirmation:false}]});
    }
  }
  // Stable IDs are assigned after detection; suggestions remain proposals.
  return events.map(event=>({...event,recommended_actions:event.recommended_actions.map((action,index)=>({...action,id:`${event.fingerprint}:${index}`}))}));
}

export function scoreAgentEvent(event: AgentEvent): number {
  return Math.max(0, Math.min(1, event.severity * event.confidence * event.actionability * event.novelty * event.urgency));
}

export function eventFeedbackFatigueMultiplier(recentNegativeResponses: number): number {
  return Math.max(0.5, 1 - Math.max(0, Math.floor(recentNegativeResponses) - 1) * 0.08);
}

export function agentEventHiddenForUser(disposition: string | null, snoozedUntil: string | null, now = Date.now()): boolean {
  if (!disposition || disposition === 'restored') return false;
  return disposition !== "snoozed" || (snoozedUntil !== null && Date.parse(snoozedUntil) > now);
}

export function agentEventChangedMaterially(type: string, before: Row, after: Row): boolean {
  if(type==='refund_applied')return ['transaction_id','original_transaction_id','amount','currency','effective_category','merchant','budget_applied','match_source'].some(key=>before[key]!==after[key]);
  if(type==='plan_at_risk')return before.plan_version!==after.plan_version||before.reason!==after.reason||Math.abs(Number(after.shortfall)-Number(before.shortfall))>=Math.max(25,Math.abs(Number(before.target))*0.05);
  if (type === "budget_pace_risk") {
    const delta = Math.abs((boundedNumber(after.projected_overage) ?? 0) - (boundedNumber(before.projected_overage) ?? 0));
    const target = Math.max(0, boundedNumber(after.target) ?? 0);
    return delta >= Math.max(25, target * 0.05) || before.severity !== after.severity;
  }
  if (type === "recurring_amount_change") {
    const delta = Math.abs((boundedNumber(after.increase) ?? 0) - (boundedNumber(before.increase) ?? 0));
    return delta >= Math.max(10, (boundedNumber(after.typical_amount) ?? 0) * 0.15);
  }
  if (type === "income_materially_different") {
    const delta = Math.abs((boundedNumber(after.difference) ?? 0) - (boundedNumber(before.difference) ?? 0));
    return delta >= Math.max(50, (boundedNumber(after.typical_amount) ?? 0) * 0.1);
  }
  if (type === "cash_floor_risk" || type === "forecast_change") {
    if(type==="forecast_change"&&JSON.stringify(before.input_changes??[])!==JSON.stringify(after.input_changes??[]))return true;
    const delta = Math.abs((boundedNumber(after.minimum_balance) ?? 0) - (boundedNumber(before.minimum_balance) ?? 0));
    const dayShift = Math.abs(Date.parse(String(after.minimum_date || "")) - Date.parse(String(before.minimum_date || ""))) / 86400000;
    return before.threshold !== after.threshold || delta >= Math.max(250, Math.abs(boundedNumber(before.minimum_balance) ?? 0) * 0.05) || dayShift >= 7;
  }
  if (type === "budget_projection_improved") return Math.abs(Number(after.projected_spend)-Number(before.projected_spend))>=Math.max(25,Number(after.target)*.05);
  if (type === "savings_review_needed") {
    const beforeIds = new Set(Array.isArray(before.savings_activity_ids) ? before.savings_activity_ids : []);
    return (Array.isArray(after.savings_activity_ids) ? after.savings_activity_ids : []).some((id: unknown) => !beforeIds.has(id));
  }
  if (type === "savings_opportunity") {
    const delta = Math.abs((boundedNumber(after.amount) ?? 0) - (boundedNumber(before.amount) ?? 0));
    return before.goal_id !== after.goal_id || delta >= Math.max(25, (boundedNumber(before.amount) ?? 0) * 0.05);
  }
  if (type === "goal_progress_change") return Math.floor(Number(before.current)/Number(before.target)*4)!==Math.floor(Number(after.current)/Number(after.target)*4);
  if (["income_received","income_missing","recurring_payment_missing"].includes(type)) return before.last_date!==after.last_date || before.expected_date!==after.expected_date;
  if (type === "new_recurring_detected") return Math.abs(Number(after.amount)-Number(before.amount))>=Math.max(10,Math.abs(Number(before.amount))*.2);
  return before.state !== after.state;
}
