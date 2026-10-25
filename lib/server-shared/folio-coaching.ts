// All amounts and recommendations are calculated here. AI may explain them,
// but never supplies targets, spending amounts, destinations, or write payloads.
export type DaySpend = { date: string; category: string; amount: number };
export type Budget = { id: string; name: string; group: string; target: number; spent: number };
export type CoachingInput = {
  today: string; updatedAt: string; budgets: Budget[]; days: DaySpend[];
  historyMonths: string[]; historyReady: boolean; recurringReady: boolean;
  bills: { id: string; name: string; category: string | null; date: string; amount: number }[];
};
const round = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
const date = (s: string) => new Date(s + 'T12:00:00Z');
const key = (d: Date) => d.toISOString().slice(0,10);
const validDate = (s: unknown): s is string => typeof s === 'string' && /^20\d\d-\d\d-\d\d$/.test(s) && Number.isFinite(date(s).getTime()) && key(date(s))===s;
const finite = (n: unknown): n is number => typeof n==='number' && Number.isFinite(n) && Math.abs(n)<=1e9;
const median = (ns: number[]) => { const a=[...ns].sort((a,b)=>a-b);return a.length ? (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2 : 0; };
export function validateCoachingInput(s: any, now = Date.now()): s is CoachingInput {
  return !!s && validDate(s.today) && Math.abs(now-date(s.today).getTime())<36*3600000 &&
    Number.isFinite(Date.parse(s.updatedAt)) && now-Date.parse(s.updatedAt)<24*3600000 && now-Date.parse(s.updatedAt)>-300000 &&
    Array.isArray(s.budgets) && s.budgets.length<=300 && s.budgets.every((b:any)=>b && typeof b.id==='string' && typeof b.name==='string' && b.name.length<=120 && ['Fixed','Flexible','Non-monthly'].includes(b.group) && finite(b.target) && b.target>=0 && finite(b.spent)) &&
    new Set(s.budgets.map((b:any)=>b.id)).size===s.budgets.length &&
    Array.isArray(s.days) && s.days.length<=15000 && s.days.every((r:any)=>r && validDate(r.date) && r.date<=s.today && typeof r.category==='string' && r.category.length<=120 && finite(r.amount)) &&
    Array.isArray(s.historyMonths) && s.historyMonths.length<=3 && new Set(s.historyMonths).size===s.historyMonths.length && s.historyMonths.every((m:any)=>typeof m==='string' && /^20\d\d-(0[1-9]|1[0-2])$/.test(m) && m<s.today.slice(0,7)) &&
    typeof s.historyReady==='boolean' && typeof s.recurringReady==='boolean' &&
    Array.isArray(s.bills) && s.bills.length<=300 && s.bills.every((b:any)=>b && typeof b.id==='string' && typeof b.name==='string' && b.name.length<=120 && (b.category===null||typeof b.category==='string') && validDate(b.date) && finite(b.amount) && b.amount>=0);
}
function weekend(d: Date) { return d.getUTCDay()===0 || d.getUTCDay()===6; }
function weekendKey(s: string) { const d=date(s);if(d.getUTCDay()===0)d.setUTCDate(d.getUTCDate()-1);return key(d); }
export function buildCoaching(s: CoachingInput, donorOrder: string[] = []) {
  const today=date(s.today),month=s.today.slice(0,7),end=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+1,0,12));
  const future:string[]=[];for(const d=new Date(today); d<end;){d.setUTCDate(d.getUTCDate()+1);future.push(key(d));}
  const current=s.days.filter(r=>r.date.startsWith(month));
  const history=s.historyReady?s.days.filter(r=>s.historyMonths.includes(r.date.slice(0,7))):[];
  const recentStart=new Date(today);recentStart.setUTCDate(recentStart.getUTCDate()-6);
  const bills=s.recurringReady?s.bills.filter(b=>b.date>s.today&&b.date<=key(end)):[];
  const categories=s.budgets.map(b=>{
    const rows=history.filter(r=>r.category===b.name),positive=rows.filter(r=>r.amount>0);
    const purchaseDays=new Set(positive.map(r=>r.date)),weekends=new Map<string,number>();
    for(const r of rows)if(weekend(date(r.date)))weekends.set(weekendKey(r.date),(weekends.get(weekendKey(r.date))||0)+r.amount);
    const total=Math.max(0,rows.reduce((n,r)=>n+r.amount,0)),weekendTotal=Math.max(0,[...weekends.values()].reduce((n,a)=>n+a,0));
    const hasPattern=s.historyReady && s.historyMonths.length>=2 && purchaseDays.size>=8 && weekends.size>=6 && total>0 && weekendTotal/total>=.65;
    const remainingWeekends=new Set(future.filter(d=>weekend(date(d))).map(weekendKey));
    // If this weekend already contains a purchase, do not assume another full shop.
    for(const r of current)if(r.category===b.name&&r.amount>0&&weekend(date(r.date))&&r.date>=weekendKey(s.today))remainingWeekends.delete(weekendKey(r.date));
    const typicalWeekend=round(median([...weekends.values()].filter(n=>n>0)));
    const historicalDays=s.historyMonths.reduce((n,m)=>n+new Date(Number(m.slice(0,4)),Number(m.slice(5,7)),0).getDate(),0);
    const historyRate=historicalDays?total/historicalDays:0;
    const recent=Math.max(0,current.filter(r=>r.category===b.name&&r.date>=key(recentStart)).reduce((n,r)=>n+r.amount,0));
    const recentRate=recent/Math.min(7,today.getUTCDate());
    const rate=s.historyReady&&s.historyMonths.length>=2 ? historyRate*.6+recentRate*.4 : recentRate;
    const reserve=round(bills.filter(x=>x.category===b.name).reduce((n,x)=>n+x.amount,0));
    const remaining=round(b.target-b.spent),available=Math.max(0,remaining-reserve);
    // Forecasts are alternative estimates, not additive (avoids counting recurring spend twice).
    let historicalWeekdays=0;for(const m of s.historyMonths){for(let d=date(m+'-01');key(d).startsWith(m);d.setUTCDate(d.getUTCDate()+1))if(!weekend(d))historicalWeekdays++;}
    const weekdayReserve=hasPattern&&historicalWeekdays?Math.max(0,total-weekendTotal)/historicalWeekdays*future.filter(d=>!weekend(date(d))).length:0;
    const behavior=hasPattern?typicalWeekend*remainingWeekends.size+weekdayReserve:rate*future.length;
    const projected=round(b.spent+Math.max(reserve,behavior));
    const windowDays=Math.min(7,future.length),allowance=round(future.length?available*windowDays/future.length:0);
    const weekendAllowance=hasPattern&&remainingWeekends.size?round(Math.max(0,remaining-Math.max(reserve,weekdayReserve))/remainingWeekends.size):null;
    const confidence=s.historyReady&&s.historyMonths.length>=2?'History + recent spending':'Recent spending only';
    const usable=b.group==='Flexible'&&s.recurringReady&&s.historyReady&&s.historyMonths.length>=2;
    const gap=round(Math.max(0,projected-b.target));
    let title=b.name,summary='';
    if(b.group!=='Flexible')summary=b.group==='Fixed'?'Review known bills before changing this target. Fixed expenses are not paced evenly through the month.':'Keep this allocation for planned irregular expenses. An unused balance is not automatically spare money.';
    else if(!usable)summary='More complete spending history and recurring data are needed for a personalized recommendation.';
    else if(remaining<0)summary=`${b.name} is ${usd(-remaining)} over target. Review spending or move an allocation before adding more.`;
    else if(hasPattern&&remainingWeekends.size){title=`${b.name}: ${remainingWeekends.size} shopping weekend${remainingWeekends.size===1?'':'s'} left`;summary=`You usually spend here on weekends. With ${remainingWeekends.size} weekend${remainingWeekends.size===1?'':'s'} left, aim for about ${usd(weekendAllowance!)} each (usual: ${usd(typicalWeekend)})${weekdayReserve||reserve?', after allowing for other expected spending':''}.`;}
    else summary=`Aim for about ${usd(allowance)} over the next ${windowDays} day${windowDays===1?'':'s'}${reserve?`, after reserving ${usd(reserve)} for known bills`:''}. ${gap>0?`Recent spending and history suggest ${usd(gap)} above target at month-end.`:'This spreads the remaining allocation through month-end.'}`;
    if(!future.length&&b.group==='Flexible'&&usable)summary='This is the last day of the month. Review the remaining allocation before the next budget period.';
    const risk=remaining<0?'over':usable&&gap>Math.max(25,b.target*.05)?'pressure':'steady';
    return {...b,title,summary,remaining,reserve,projected:usable?projected:null,allowance:usable?allowance:null,windowDays,weekendAllowance:usable?weekendAllowance:null,remainingWeekends:hasPattern?remainingWeekends.size:null,typicalWeekend:hasPattern?typicalWeekend:null,weekendShare:hasPattern?round(weekendTotal/total):null,historyMonths:s.historyMonths.length,purchaseDays:purchaseDays.size,confidence,usable,risk,gap:usable?gap:0,transfer:null as null|{fromId:string;fromName:string;amount:number},key:`coach:${month}:${b.id}:${risk}:${b.target}:${hasPattern?remainingWeekends.size:'pace'}`};
  });
  for(const c of categories.filter(c=>c.usable&&c.gap>=25&&!bills.some(b=>!b.category))){
    const donors=categories.filter(d=>d.id!==c.id&&d.usable&&d.group==='Flexible'&&d.projected!==null)
      .map(d=>({d,spare:Math.floor(Math.max(0,d.target-Math.max(d.projected!,d.spent+d.reserve)-Math.max(25,d.target*.1))/25)*25})).filter(x=>x.spare>=25).sort((a,b)=>{const rank=(name:string)=>donorOrder.includes(name)?donorOrder.indexOf(name):donorOrder.length;return rank(a.d.name)-rank(b.d.name)||b.spare-a.spare;});
    if(donors[0])c.transfer={fromId:donors[0].d.id,fromName:donors[0].d.name,amount:Math.min(donors[0].spare,Math.ceil(c.gap/25)*25)};
  }
  categories.sort((a,b)=>Number(b.usable)-Number(a.usable)||Number(b.risk==='over')-Number(a.risk==='over')||b.gap-a.gap||Number(b.remainingWeekends!==null)-Number(a.remainingWeekends!==null)||a.name.localeCompare(b.name));
  return {month,today:s.today,updatedAt:s.updatedAt,categories,unknownBills:bills.filter(b=>!b.category).length,totalTarget:round(s.budgets.reduce((n,b)=>n+b.target,0)),totalSpent:round(s.budgets.reduce((n,b)=>n+b.spent,0)),nextBills:bills.filter(b=>b.date<=key(new Date(today.getTime()+7*86400000))).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3)};
}
