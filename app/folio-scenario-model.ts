export type FolioScenarioKind = "one-time-expense" | "monthly-expense" | "monthly-income";
export type FolioScenarioPoint = { date: string; balance: number };

function dateKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function signedScenarioCents(value: unknown): number | null {
  if(typeof value!=="number"||!Number.isFinite(value))return null;const scaled=value*100,rounded=Math.round(scaled);
  return Number.isSafeInteger(rounded)&&Math.abs(scaled-rounded)<=1e-6?rounded:null;
}

export function verifiedScenarioPoints(data: Record<string, unknown>, horizon: number): FolioScenarioPoint[] | null {
  if (![30, 60, 90].includes(horizon) || data.horizon_days !== horizon || data.ready !== true || data.complete !== true || data.reliable !== true || data.current_for_forecast !== true || data.stale !== false) return null;
  if (!Array.isArray(data.points) || data.points.length !== horizon + 1) return null;
  const points: FolioScenarioPoint[] = [];
  for (const value of data.points) {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>, date = dateKey(row.date);
    const pointCents=signedScenarioCents(row.balance);
    if (!date || pointCents===null) return null;
    points.push({ date, balance: pointCents/100 });
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = new Date(`${points[index - 1].date}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() + 1);
    if (points[index].date !== previous.toISOString().slice(0, 10)) return null;
  }
  if(data.series_contract!==undefined){
    if(data.series_contract!=='dated-end-of-day-v1'||signedScenarioCents(data.starting_balance)===null||!Array.isArray(data.events))return null;
    let balance=signedScenarioCents(data.starting_balance)!;
    for(const point of points){for(const event of data.events){if(!event||typeof event!=='object')return null;const row=event as Record<string,unknown>;if(!dateKey(row.date)||signedScenarioCents(row.amount)===null||String(row.date)<points[0].date||String(row.date)>points.at(-1)!.date)return null;if(row.date===point.date){balance+=signedScenarioCents(row.amount)!;if(!Number.isSafeInteger(balance))return null;}}if(point.balance!==balance/100)return null;}
    if(data.projected_low!==Math.min(Number(data.starting_balance),...points.map(point=>point.balance)))return null;
  }
  return points;
}

function recurringDate(start: string, months: number): string {
  const date = new Date(`${start}T00:00:00Z`), day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months, 1);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export function buildScenarioComparison(points: FolioScenarioPoint[], kind: FolioScenarioKind, amount: number, start: string, startingBalance?: number) {
  const validStart = dateKey(start),amountCents=signedScenarioCents(amount);
  if (!validStart || amountCents===null || amountCents<=0 || amount>1_000_000_000 || !points.length || points.length>91 || points.some(point=>!dateKey(point.date)||signedScenarioCents(point.balance)===null) || (startingBalance!==undefined&&signedScenarioCents(startingBalance)===null) || validStart < points[0].date || validStart > points.at(-1)!.date) return null;
  const dates = [validStart];
  if (kind !== "one-time-expense") {
    for (let month = 1; month < 12; month += 1) {
      const next = recurringDate(validStart, month);
      if (next <= points.at(-1)!.date) dates.push(next);
      else break;
    }
  }
  const sign = kind === "monthly-income" ? 1 : -1;
  const scenarioPoints:FolioScenarioPoint[]=[];
  for(const point of points){const effect=sign*amountCents!*dates.filter(date=>date<=point.date).length,adjusted=signedScenarioCents(point.balance)!+effect;if(!Number.isSafeInteger(effect)||!Number.isSafeInteger(adjusted))return null;scenarioPoints.push({date:point.date,balance:adjusted/100});}
  const initial=typeof startingBalance==='number'&&Number.isFinite(startingBalance)?startingBalance:Infinity;
  const baselineLow = Math.min(initial,...points.map(point => point.balance));
  const scenarioLow = Math.min(initial,...scenarioPoints.map(point => point.balance));
  const baselineLowDate = initial===baselineLow?points[0].date:points.find(point => point.balance === baselineLow)?.date??points[0].date;
  const scenarioLowDate = initial===scenarioLow?points[0].date:scenarioPoints.find(point => point.balance === scenarioLow)?.date??points[0].date;
  const totalCents=sign*amountCents!*dates.length,lowDeltaCents=signedScenarioCents(scenarioLow)!-signedScenarioCents(baselineLow)!;
  if(!Number.isSafeInteger(totalCents)||!Number.isSafeInteger(lowDeltaCents))return null;
  const totalCashEffect=totalCents/100;
  return {
    occurrenceDates: dates,
    baselinePoints: points,
    scenarioPoints,
    baselineLow,
    baselineLowDate,
    scenarioLow,
    scenarioLowDate,
    lowDelta: lowDeltaCents / 100,
    introducesShortfall: baselineLow >= 0 && scenarioLow < 0,
    totalCashEffect,
  };
}

export function scenarioDateKey(value: unknown): string | null { return dateKey(value); }

export function scenarioAmountValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) return null;
  const cents = value * 100, rounded = Math.round(cents);
  return Number.isSafeInteger(rounded) && Math.abs(cents - rounded) <= Number.EPSILON * Math.max(1, Math.abs(cents)) * 2 ? rounded / 100 : null;
}
