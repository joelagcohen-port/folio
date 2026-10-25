type Row = Record<string, any>;

type SafetyInput = {
  preferred_cash_floor?: Row | null;
  active_plans?: Row[];
  active_plans_read_complete?: boolean;
  active_savings_reserve?: { amount?: number | string | null; currency?: string | null; complete?: boolean } | null;
  currency_coverage?: { complete?: boolean; currency?: string | null; all_accounts_usd?: boolean; account_count?: number | null } | null;
  obligations?: {
    complete?: boolean;
    currency?: string | null;
    forecast_input_revision?: string | null;
    forecast_generated_at?: string | null;
    horizon_days?: number | null;
    pending_outflow_reserve?: number | string | null;
    committed_savings_contribution_reserve?: number | string | null;
    recurring_covered_by_forecast?: boolean;
    provenance?: {
      pending_history_complete?: boolean;
      pending_source?: string | null;
      recurring_sources_complete?: boolean;
      recurring_source?: string | null;
      committed_savings_source?: string | null;
    } | null;
  } | null;
};

type SafetyOptions = { today: string; timezone: string; now: string };

const finiteAmount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};

function unavailable(forecast: Row, reason: string) {
  return {
    ...forecast,
    potential_surplus_amount: null,
    potential_surplus_currency: null,
    surplus_basis: null,
    savings_surplus_safety: { status: "unavailable", reason },
  };
}

/**
 * Add a household potential-surplus estimate to an existing cached forecast.
 * The estimate never changes the forecast itself. It is withheld unless saved
 * forecast coverage, explicit USD coverage, floors, savings reserves, and the
 * pending/committed obligation assumptions all carry complete provenance.
 */
export function buildSavingsForecastSafety(forecast: Row, inputs: SafetyInput, options: SafetyOptions) {
  const { today, timezone } = options;
  const projectedLow = finiteAmount(forecast?.projected_low);
  const horizonDays = finiteAmount(forecast?.horizon_days);
  const nowDate = typeof options.now === "string" ? Date.parse(options.now) : NaN;
  const forecastDate = typeof forecast?.generated_at === "string" ? Date.parse(forecast.generated_at) : NaN;
  const coverageSources = forecast?.coverage?.sources;
  const requiredSources = Array.isArray(coverageSources) ? coverageSources.filter((source: Row) => source?.expected === true) : [];
  const currentSources = Array.isArray(coverageSources) && requiredSources.length > 0
    && coverageSources.every((source: Row) => {
      if (!source || (source.expected !== true && source.expected !== false)) return false;
      if (source.expected === false) return source.status === "not_applicable" && (source.fetched_at === null || source.fetched_at === undefined);
      const fetchedAt = typeof source.fetched_at === "string" ? Date.parse(source.fetched_at) : NaN;
      return source.status === "success" && Number.isFinite(fetchedAt) && fetchedAt <= nowDate && nowDate - fetchedAt <= 24 * 60 * 60 * 1000;
    });
  let timezoneValid = false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0)); timezoneValid = true; } catch { timezoneValid = false; }
  if (!validDate(today) || !timezoneValid || !Number.isFinite(nowDate)) return unavailable(forecast, "invalid_local_date_context");
  if (forecast?.ready !== true || forecast?.complete !== true || forecast?.reliable !== true || forecast?.current_for_forecast !== true || forecast?.stale === true || projectedLow === null || horizonDays === null || !Number.isInteger(horizonDays) || horizonDays <= 0 || !Number.isFinite(forecastDate) || forecastDate > nowDate || nowDate - forecastDate > 48 * 60 * 60 * 1000 || !currentSources || forecast?.coverage?.complete !== true) {
    return unavailable(forecast, "forecast_not_current_and_complete");
  }
  if (!inputs?.active_plans_read_complete || !Array.isArray(inputs.active_plans)) return unavailable(forecast, "active_plan_floor_read_incomplete");

  const memory = inputs.preferred_cash_floor;
  const floors: number[] = [];
  if (memory?.active === true) {
    if (memory.effective_from != null && !validDate(String(memory.effective_from)) || memory.effective_until != null && !validDate(String(memory.effective_until))) return unavailable(forecast, "preferred_cash_floor_invalid_or_expired");
    const startsInFuture = memory.effective_from != null && String(memory.effective_from) > today;
    const alreadyExpired = memory.effective_until != null && String(memory.effective_until) < today;
    if (!startsInFuture && !alreadyExpired) {
      const memoryAmount = finiteAmount(memory.value);
      if (memoryAmount === null || memoryAmount < 0) return unavailable(forecast, "preferred_cash_floor_invalid_or_expired");
      floors.push(memoryAmount);
    }
  }
  for (const plan of inputs.active_plans) {
    if (!plan || typeof plan !== "object") return unavailable(forecast, "active_plan_floor_invalid");
    if (plan.status !== "active") continue;
    if (!validDate(plan.starts_on) || !validDate(plan.ends_on)) return unavailable(forecast, "active_plan_window_invalid");
    if (plan.starts_on > today || plan.ends_on < today) continue;
    if (!Array.isArray(plan.constraints)) return unavailable(forecast, "active_plan_constraints_unavailable");
    if (plan.plan_type === "cash_floor") {
      const planFloor = finiteAmount(plan.floor_amount);
      if (planFloor === null || planFloor < 0) return unavailable(forecast, "active_plan_cash_floor_invalid");
      floors.push(planFloor);
    }
    for (const constraint of plan.constraints) {
      if (!constraint || typeof constraint !== "object") return unavailable(forecast, "active_plan_constraint_invalid");
      if (constraint.kind !== "cash_floor" || constraint.level !== "hard") continue;
      if (constraint.expires_on != null && !validDate(String(constraint.expires_on))) return unavailable(forecast, "active_plan_constraint_expiry_invalid");
      if (constraint.expires_on != null && String(constraint.expires_on) < today) continue;
      const amount = finiteAmount(constraint.amount);
      if (amount === null || amount < 0) return unavailable(forecast, "active_plan_cash_floor_invalid");
      floors.push(amount);
    }
  }
  if (!floors.length) return unavailable(forecast, "protected_cash_floor_unavailable");

  const currency = inputs.currency_coverage;
  if (!currency || currency.complete !== true || String(currency.currency || "").toUpperCase() !== "USD" || currency.all_accounts_usd !== true || finiteAmount(currency.account_count) === null || Number(currency.account_count) < 1) {
    return unavailable(forecast, "currency_coverage_unavailable_or_mixed");
  }
  const savingsReserve = inputs.active_savings_reserve;
  const savedAmount = finiteAmount(savingsReserve?.amount);
  if (!savingsReserve || savingsReserve.complete !== true || String(savingsReserve.currency || "").toUpperCase() !== "USD" || savedAmount === null || savedAmount < 0) {
    return unavailable(forecast, "active_savings_reserve_unavailable");
  }
  const obligations = inputs.obligations;
  const pendingReserve = finiteAmount(obligations?.pending_outflow_reserve);
  const committedReserve = finiteAmount(obligations?.committed_savings_contribution_reserve);
  const provenance = obligations?.provenance;
  if (!obligations || obligations.complete !== true || String(obligations.currency || "").toUpperCase() !== "USD" || obligations.forecast_input_revision !== forecast.input_revision || obligations.forecast_generated_at !== forecast.generated_at || finiteAmount(obligations.horizon_days) !== horizonDays || obligations.recurring_covered_by_forecast !== true || !provenance || provenance.pending_history_complete !== true || provenance.pending_source !== "finance_prepared_transactions" || provenance.recurring_sources_complete !== true || provenance.recurring_source !== "cached_forecast_source_coverage" || provenance.committed_savings_source !== "active_monthly_goal_contributions_max_cycles" || pendingReserve === null || pendingReserve < 0 || committedReserve === null || committedReserve < 0) {
    return unavailable(forecast, "forecast_obligations_or_committed_savings_unverified");
  }

  const protectedFloor = Math.max(...floors);
  const amount = Math.round(Math.max(0, projectedLow - protectedFloor - savedAmount - pendingReserve - committedReserve) * 100) / 100;
  return {
    ...forecast,
    potential_surplus_amount: amount,
    potential_surplus_currency: "USD",
    surplus_basis: "after_committed_obligations_and_cash_floor",
    reserved_goal_amount: savedAmount,
    protected_cash_floor: protectedFloor,
    pending_outflow_reserve: pendingReserve,
    committed_savings_contribution_reserve: committedReserve,
    savings_surplus_safety: { status: "available", reason: null },
  };
}
