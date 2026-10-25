export type RecurringAmountCandidate = { amount: number | null; source: "user" | "recent" | "last" | "average" | "unknown" };

export function deriveExpectedRecurringAmount(input: {
  override?: number | null;
  recentAmounts?: number[];
  lastAmount?: number | null;
  averageAmount?: number | null;
}): RecurringAmountCandidate {
  const magnitude=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value!==0?Math.abs(value):null;
  const override=magnitude(input.override),last=magnitude(input.lastAmount),average=magnitude(input.averageAmount);
  if (override!==null) return { amount: round(override), source: "user" };
  const recent = (input.recentAmounts ?? []).map(magnitude).filter((value):value is number=>value!==null).slice(0, 3).sort((a,b)=>a-b);
  if (recent.length >= 2) {
    const middle=Math.floor(recent.length/2),median=recent.length%2?recent[middle]:(recent[middle-1]+recent[middle])/2;
    if ((recent.at(-1)!-recent[0])/Math.max(median,1)<=0.6) return { amount: round(median), source: "recent" };
  }
  if (last!==null) return { amount: round(last), source: "last" };
  if (average!==null) return { amount: round(average), source: "average" };
  return { amount: null, source: "unknown" };
}

export function sameCadence(a: unknown,b: unknown) {
  const normalize=(value:unknown)=>String(value??"").toUpperCase().replaceAll("_","").replaceAll(" ","").replace("ANNUALLY","ANNUAL");
  return normalize(a)===normalize(b);
}

function round(value:number){return Math.round(value*100)/100;}
