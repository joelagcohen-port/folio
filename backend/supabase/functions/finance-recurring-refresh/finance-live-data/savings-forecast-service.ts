import { buildSavingsForecastSafety } from "./savings-forecast.ts";

type Row = Record<string, any>;

/**
 * Reuse the saved planning forecast and add a household savings opportunity
 * only when the safety read is complete and tied to that exact snapshot.
 * Every dependency is injected so the execution path can be exercised with
 * Supabase-shaped fixtures without loading Edge Runtime code in Node.
 */
export async function cachedSavingsForecastResponse(
  context: { householdId: string },
  horizon: number,
  timezone: string,
  dependencies: {
    loadForecast: (context: { householdId: string }, horizon: number, timezone: string) => Promise<Row>;
    db: { rpc: (name: string, args: Row) => Promise<{ data?: any; error?: any }> };
    today: string;
    now: string;
  },
) {
  const forecast = await dependencies.loadForecast(context, horizon, timezone);
  const unavailableInputs = {};
  if (!forecast || typeof forecast !== "object") return forecast;
  if (forecast.current_for_forecast !== true || forecast.complete !== true || forecast.reliable !== true) {
    return buildSavingsForecastSafety(forecast, unavailableInputs, { today: dependencies.today, timezone, now: dependencies.now });
  }
  let inputs: Row = unavailableInputs;
  try {
    const result = await dependencies.db.rpc("finance_get_savings_forecast_safety_inputs", {
      p_household_id: context.householdId,
      p_horizon_days: horizon,
      p_timezone: timezone,
      p_today: dependencies.today,
      p_forecast_input_revision: forecast.input_revision ?? null,
      p_forecast_generated_at: forecast.generated_at ?? null,
    });
    const data = Array.isArray(result?.data) ? result.data[0] : result?.data;
    if (!result?.error && data && typeof data === "object") inputs = data.safety_inputs && typeof data.safety_inputs === "object" ? data.safety_inputs : data;
  } catch { /* Missing safety data fails closed in the pure adapter below. */ }
  return buildSavingsForecastSafety(forecast, inputs, { today: dependencies.today, timezone, now: dependencies.now });
}
