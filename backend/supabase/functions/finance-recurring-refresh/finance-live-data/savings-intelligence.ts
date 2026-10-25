type MonthlySavingsHistory = { month: string; net: number };

type SavingsGoalInput = {
  goalId: string;
  currentAmount: number;
  targetAmount: number;
  monthlyNetContributions: number | null;
  monthlyHistory: MonthlySavingsHistory[];
  planPriority?: number | null;
  targetDate?: string | null;
  complete_month_count: number;
  history_complete: boolean;
  history_reliable: boolean;
  internal_transfers_excluded: boolean;
};

type SavingsForecastInput = {
  ready: boolean;
  complete: boolean;
  reliable: boolean;
  current_for_forecast: boolean;
  projected_low?: number | null;
  ending_balance?: number | null;
  potential_surplus_amount?: number | null;
  surplus_basis?: string | null;
  potential_surplus_currency?: string | null;
};

type SavingsIntelligenceInput = {
  goals: SavingsGoalInput[];
  today: string;
  timezone: string;
  forecast: SavingsForecastInput | null;
};

type GoalSavingsEstimate = {
  goalId: string;
  monthly_savings_pace: number | null;
  estimated_completion_date: string | null;
  months_to_goal: number | null;
};

type PrioritizedSavingsGoal = { goalId: string; rank: number; basis: "user_priority" | "target_date" };

export type SavingsIntelligenceResult = {
  goals: GoalSavingsEstimate[];
  prioritized_goals: PrioritizedSavingsGoal[];
  potential_surplus: { amount: number; basis: "after_committed_obligations_and_cash_floor"; status: "available" } | null;
  forecast_status: "current" | "stale" | "incomplete" | "unavailable";
};

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function monthNumber(month: string): number | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, monthOfYear] = month.split("-").map(Number);
  return year >= 1 && year <= 9999 ? year * 12 + monthOfYear - 1 : null;
}

function localTodayMonth(today: string, timezone: string): number | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(`${today}T12:00:00Z`));
  } catch {
    return null;
  }
  if (!validDateOnly(today)) return null;
  return monthNumber(today.slice(0, 7));
}

function lastThreeCompleteMonths(goal: SavingsGoalInput, currentMonth: number): number[] | null {
  if (goal.history_complete !== true || goal.history_reliable !== true || goal.internal_transfers_excluded !== true) return null;
  if (!Number.isInteger(goal.complete_month_count) || goal.complete_month_count < 3 || !Array.isArray(goal.monthlyHistory)) return null;
  const months = new Map<number, number>();
  for (const row of goal.monthlyHistory) {
    const month = monthNumber(row.month);
    if (month === null || month >= currentMonth || !Number.isFinite(row.net) || months.has(month)) return null;
    months.set(month, row.net);
  }
  if (months.size < 3 || months.size < goal.complete_month_count) return null;
  const observed = [currentMonth - 1, currentMonth - 2, currentMonth - 3].map(month => months.get(month));
  return observed.length === 3 && observed.every((value): value is number => value !== undefined) ? observed : null;
}

function completionDate(today: string, monthsToGoal: number): string | null {
  if (!Number.isSafeInteger(monthsToGoal) || monthsToGoal < 0) return null;
  const [year, month, day] = today.split("-").map(Number);
  const currentMonth = year * 12 + month - 1;
  const targetMonth = currentMonth + monthsToGoal;
  if (targetMonth < 12 || targetMonth >= 9999 * 12) return null;
  const targetYear = Math.floor(targetMonth / 12);
  const targetMonthOfYear = targetMonth % 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthOfYear, 0, 12)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonthOfYear).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function forecastStatus(forecast: SavingsForecastInput | null): SavingsIntelligenceResult["forecast_status"] {
  if (!forecast || forecast.ready !== true) return "unavailable";
  if (forecast.current_for_forecast !== true) return "stale";
  if (forecast.complete !== true || forecast.reliable !== true) return "incomplete";
  return "current";
}

/** Builds deterministic savings pace and safe household surplus from already authoritative inputs. */
export function buildSavingsIntelligence(input: SavingsIntelligenceInput): SavingsIntelligenceResult {
  const currentMonth = localTodayMonth(input.today, input.timezone);
  const currentDateValid = currentMonth !== null;
  const forecastState = forecastStatus(input.forecast);
  const reliableForecast = forecastState === "current";
  const goals = input.goals.map((goal): GoalSavingsEstimate => {
    const currentAmount = Number(goal.currentAmount);
    const targetAmount = Number(goal.targetAmount);
    if (!currentDateValid || !reliableForecast || !Number.isFinite(currentAmount) || currentAmount < 0 || !Number.isFinite(targetAmount) || targetAmount <= 0) {
      return { goalId: goal.goalId, monthly_savings_pace: null, estimated_completion_date: null, months_to_goal: null };
    }
    if (currentAmount >= targetAmount) return { goalId: goal.goalId, monthly_savings_pace: null, estimated_completion_date: input.today, months_to_goal: 0 };
    const samples = lastThreeCompleteMonths(goal, currentMonth!);
    if (!samples) return { goalId: goal.goalId, monthly_savings_pace: null, estimated_completion_date: null, months_to_goal: null };
    const pace = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    if (!Number.isFinite(pace) || pace <= 0) return { goalId: goal.goalId, monthly_savings_pace: null, estimated_completion_date: null, months_to_goal: null };
    const months = Math.ceil((targetAmount - currentAmount) / pace);
    const estimatedDate = completionDate(input.today, months);
    return estimatedDate ? { goalId: goal.goalId, monthly_savings_pace: Math.round(pace * 100) / 100, estimated_completion_date: estimatedDate, months_to_goal: months } : { goalId: goal.goalId, monthly_savings_pace: Math.round(pace * 100) / 100, estimated_completion_date: null, months_to_goal: null };
  });
  const priorityInputs = input.goals.map(goal => {
    const hasPriority = Number.isInteger(goal.planPriority) && Number(goal.planPriority) >= 1 && Number(goal.planPriority) <= 5;
    const hasTargetDate = typeof goal.targetDate === "string" && validDateOnly(goal.targetDate);
    return hasPriority || hasTargetDate ? { goal, hasPriority, hasTargetDate } : null;
  });
  const prioritized_goals: PrioritizedSavingsGoal[] = priorityInputs.length && priorityInputs.every(Boolean)
    ? priorityInputs.filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => {
        if (a.hasPriority !== b.hasPriority) return a.hasPriority ? -1 : 1;
        if (a.hasPriority && b.hasPriority && a.goal.planPriority !== b.goal.planPriority) return Number(a.goal.planPriority) - Number(b.goal.planPriority);
        const aDate = a.hasTargetDate ? a.goal.targetDate! : "9999-12-31";
        const bDate = b.hasTargetDate ? b.goal.targetDate! : "9999-12-31";
        return aDate.localeCompare(bDate) || a.goal.goalId.localeCompare(b.goal.goalId);
      })
      .map((value, index) => ({ goalId: value.goal.goalId, rank: index + 1, basis: value.hasPriority ? "user_priority" as const : "target_date" as const }))
    : [];
  const forecast = input.forecast;
  const surplusAmount = Number(forecast?.potential_surplus_amount);
  const potential_surplus = currentDateValid && reliableForecast && forecast?.surplus_basis === "after_committed_obligations_and_cash_floor" && String(forecast?.potential_surplus_currency || "").toUpperCase() === "USD" && Number.isFinite(surplusAmount) && surplusAmount > 0
    ? { amount: Math.round(surplusAmount * 100) / 100, basis: "after_committed_obligations_and_cash_floor" as const, status: "available" as const }
    : null;
  return { goals, prioritized_goals, potential_surplus, forecast_status: currentDateValid ? forecastState : "unavailable" };
}
