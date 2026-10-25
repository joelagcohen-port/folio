import { callFolioOperation, isRecord } from "../../folio-server.ts";
import { hasActiveFolioSession, takeFolioModelToken } from "../../folio-model-security.ts";
import { buildScenarioComparison, scenarioAmountValue, scenarioDateKey, verifiedScenarioPoints } from "../../folio-scenario-model.ts";

type ScenarioKind = "one-time-expense" | "monthly-expense" | "monthly-income";
function responseText(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => isRecord(item) && item.type === "message" && Array.isArray(item.content)
    ? item.content.flatMap((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string" ? [part.text] : []) : []).join("\n").trim();
}
function usd(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value); }

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return Response.json({ error: "Sign in required." }, { status: 401 });
  const session = await hasActiveFolioSession(authorization);
  if (!session.active) return Response.json({ error: session.unavailable ? "Folio could not verify your session. Try again shortly." : "Your session has ended. Sign in again." }, { status: session.unavailable ? 503 : 401, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null);
  if (!isRecord(body)) return Response.json({ error: "Expected a scenario." }, { status: 400 });
  const kind: ScenarioKind | null = body.kind === "one-time-expense" || body.kind === "monthly-expense" || body.kind === "monthly-income" ? body.kind : null;
  const amount = scenarioAmountValue(body.amount), start = scenarioDateKey(body.start), horizonValue = body.horizon_days === undefined ? 30 : body.horizon_days;
  if (typeof horizonValue !== "number" || ![30, 60, 90].includes(horizonValue)) return Response.json({ error: "Choose a 30, 60, or 90 day forecast period." }, { status: 400 });
  if (!kind || amount===null || !start) return Response.json({ error: "Enter a valid scenario amount and start date." }, { status: 400 });
  const timezone = typeof body.timezone === "string" && body.timezone.length <= 100 ? body.timezone : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { return Response.json({ error: "Choose a valid device timezone." }, { status: 400 }); }

  const planning = await callFolioOperation("get_planning", { horizon_days: horizonValue, timezone }, authorization);
  if (!planning.ok || !isRecord(planning.data)) return Response.json({ error: isRecord(planning.data) && typeof planning.data.error === "string" ? planning.data.error : "Folio could not load the current forecast." }, { status: planning.status || 502 });
  const points = verifiedScenarioPoints(planning.data, horizonValue);
  if (!points) return Response.json({ error: "Folio needs a complete, current forecast for the selected period before it can explore this scenario." }, { status: 422 });
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const today = `${dateParts.find((part) => part.type === "year")?.value}-${dateParts.find((part) => part.type === "month")?.value}-${dateParts.find((part) => part.type === "day")?.value}`;
  if (points[0].date !== today) return Response.json({ error: "Folio needs a forecast starting today in your device timezone." }, { status: 422 });
  const comparison = buildScenarioComparison(points, kind, amount, start, planning.data.series_contract === "dated-end-of-day-v1" ? Number(planning.data.starting_balance) : undefined);
  if (!comparison) return Response.json({ error: "Choose a start date within the current forecast period." }, { status: 400 });
  const { baselineLow, baselineLowDate, scenarioLow, scenarioLowDate, lowDelta, introducesShortfall } = comparison;
  const impact = { kind, amount, start, horizon: horizonValue, baselineLow, baselineLowDate, scenarioLow, scenarioLowDate, lowDelta, introducesShortfall };
  const comparisonSeries = { horizon_days: horizonValue, timezone, start_date: points[0].date, end_date: points.at(-1)!.date, occurrence_dates: comparison.occurrenceDates, occurrence_count: comparison.occurrenceDates.length, total_cash_effect: comparison.totalCashEffect, baseline_points: comparison.baselinePoints, scenario_points: comparison.scenarioPoints };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ impact, comparison: comparisonSeries, answer: "Folio calculated the scenario, but Ask Folio is not connected to explain it." }, { headers: { "cache-control": "no-store" } });
  const prompt = `Explain this verified, read-only Folio scenario in no more than 70 words. Lead with whether it changes a cash-risk date or has no meaningful planning implication. Do not merely restate that an expense lowers cash. Do not use “safe to spend,” invent a recommendation, suggest a budget transfer, or describe a financial action. Mention uncertainty only if forecast assumptions matter. Facts: ${JSON.stringify(impact)}.`;
  const modelToken = await takeFolioModelToken("scenario", authorization);
  if (!modelToken.allowed && ["session_revoked", "household_unavailable"].includes(modelToken.code)) return Response.json({ error: modelToken.code === "session_revoked" ? "Your session has ended. Sign in again." : "Household access could not be verified." }, { status: modelToken.code === "session_revoked" ? 401 : 403, headers: { "cache-control": "no-store" } });
  let ai: Response | null = null;
  try { if (modelToken.allowed) ai = await fetch("https://api.openai.com/v1/responses", { method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: "gpt-5.6-luna", instructions: "You are Ask Folio. Use only the supplied verified scenario facts. Be concise, calm, and decision-focused.", input: prompt, reasoning: { effort: "none" }, max_output_tokens: 180, store: false }) }); } catch { /* The verified deterministic comparison remains available if explanation is offline. */ }
  const aiData = await ai?.json().catch(() => null);
  const answer = ai?.ok && isRecord(aiData) ? responseText(aiData.output) : `The projected low changes from ${usd(baselineLow)} on ${baselineLowDate} to ${usd(scenarioLow)} on ${scenarioLowDate}.`;
  return Response.json({ impact, comparison: comparisonSeries, answer: answer || `The projected low changes from ${usd(baselineLow)} on ${baselineLowDate} to ${usd(scenarioLow)} on ${scenarioLowDate}.` }, { headers: { "cache-control": "no-store" } });
}
