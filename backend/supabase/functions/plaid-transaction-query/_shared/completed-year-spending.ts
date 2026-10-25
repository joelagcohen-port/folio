import { countsTowardBudget } from './accounting.ts';
import { calendarDate, resolveCalendarTimeZone } from './date-context.ts';

type Row = Record<string, any>;
const readFailure=(code:string,message:string)=>Object.assign(new Error(message),{code});
// Same typical-average policy as the existing comparison; never alters ledger totals.
      function percentile(values: number[],ratio: number){if(!values.length)return 0;const sorted=values.slice().sort((a,b)=>a-b),position=(sorted.length-1)*ratio,lower=Math.floor(position),upper=Math.ceil(position);return lower===upper?sorted[lower]:sorted[lower]+(sorted[upper]-sorted[lower])*(position-lower);}
      export function typicalSpendingMonths(months: Row[][]){
        const candidates: {row: Row, monthIndex: number, amount: number}[]=[];months.forEach((rows,monthIndex)=>(rows||[]).filter(countsTowardBudget).forEach(row=>{const amount=Number(row.amount);if(Number.isFinite(amount)&&amount>0)candidates.push({row,monthIndex,amount});}));
        const amounts=candidates.map(item=>item.amount),q1=percentile(amounts,.25),q3=percentile(amounts,.75),threshold=Math.max(1000,q3+Math.max(0,q3-q1)*3),merchantHistory=new Map();
        const merchantKey=(row: Row)=>String(row.original_description||row.statement||row.name||row.merchant_name||row.effective_merchant_name||'').toLowerCase().replace(/\d+/g,' ').replace(/[^a-z]+/g,' ').trim();
        for(const item of candidates){const key=merchantKey(item.row);if(!key)continue;const history=merchantHistory.get(key)||[];history.push(item);merchantHistory.set(key,history);}
        const isRecurringLarge=(item: {row: Row, monthIndex: number, amount: number})=>(merchantHistory.get(merchantKey(item.row))||[]).some(other=>other.monthIndex!==item.monthIndex&&Math.abs(other.amount-item.amount)<=Math.max(100,item.amount*.15));
        const excluded=new Set(candidates.filter(item=>item.amount>=threshold&&!isRecurringLarge(item)).map(item=>item.row));
        return {months:months.map(rows=>(rows||[]).filter(row=>!excluded.has(row))),excludedCount:excluded.size,excludedTotal:[...excluded].reduce((sum,row)=>sum+(Number(row.amount)||0),0),threshold};
      }

// Search pages carry one canonical parent row for split transactions. Expand it
// using the same completeness rules as the dashboard's allocationRows helper;
// an unknown or malformed split must make the average unavailable, never count
// the unsplit parent amount as if its allocation coverage were complete.
function spendingAllocationRows(rows: Row[]) {
  const output: Row[] = [];
  const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ''));
  const booleanFields = ['pending','excluded_from_totals','category_excluded_from_budget','transaction_excluded_from_budget','category_excluded_from_cash_flow','transaction_excluded_from_cash_flow'];
  const inheritedFlags = ['pending','excluded_from_totals','transaction_excluded_from_budget','transaction_excluded_from_cash_flow'];
  for (const parent of rows) {
    // The currently deployed prepared search contract predates split metadata.
    // Its effective-transaction rows are unsplit; accept only the exact legacy
    // shape. Any partial split contract still fails closed below.
    if (parent.split_status === undefined && parent.split_allocations === undefined) { output.push(parent); continue; }
    const parentId = String(parent.transaction_id || parent.id || ''), parentCents = Number(parent.amount) * 100, currency = String(parent.iso_currency_code || parent.currency_code || '');
    if (parent.split_status === 'passthrough') {
      if (!Array.isArray(parent.split_allocations) || parent.split_allocations.length) return { rows: [], available: false };
      output.push(parent); continue;
    }
    if (parent.split_status !== 'available' || !Array.isArray(parent.split_allocations) || parent.split_allocations.length < 2 || parent.split_allocations.length > 40 || !parentId || !currency || !Number.isSafeInteger(Math.round(parentCents)) || Math.abs(parentCents - Math.round(parentCents)) > 1e-6 || typeof parent.pending !== 'boolean' || !String(parent.account_id || '') || booleanFields.slice(1).some(field => typeof parent[field] !== 'boolean')) return { rows: [], available: false };
    const ids = new Set<string>(), indexes = new Set<number>(), prepared: Row[] = [];
    let sum = 0, valid = true;
    for (const allocation of parent.split_allocations) {
      const cents = allocation?.amount_cents, allocationId = String(allocation?.allocation_id || ''), index = allocation?.allocation_index, category = String(allocation?.category_name || '').trim(), type = String(allocation?.effective_type || '').toLowerCase();
      if (!uuid(allocationId) || ids.has(allocationId) || !Number.isSafeInteger(index) || index < 0 || indexes.has(index) || allocation?.allocation_status !== 'split' || String(allocation?.parent_transaction_id || '') !== parentId || String(allocation?.currency_code || '') !== currency || !Number.isSafeInteger(cents) || !category || !uuid(allocation?.category_id) || !['income','expense','refund','other_inflow','transfer'].includes(type) || type !== String(parent.effective_type || '').toLowerCase() || String(allocation?.account_id || '') !== String(parent.account_id || '') || allocation.pending !== parent.pending || allocation.effective_transaction_date !== parent.effective_transaction_date || booleanFields.some(field => typeof allocation[field] !== 'boolean') || inheritedFlags.some(field => allocation[field] !== parent[field]) || (parentCents > 0 && cents < 0) || (parentCents < 0 && cents > 0)) { valid = false; break; }
      ids.add(allocationId); indexes.add(index); sum += cents;
      prepared.push({...parent,...allocation,transaction_id:parentId,parent_transaction_id:parentId,allocation_id:allocationId,amount:cents/100,effective_category:category,user_category:category,category,effective_group:String(allocation.effective_group||'Other'),effective_type:type,split_parent:true,split_status:'passthrough',split_allocations:[]});
    }
    if (!valid || sum !== Math.round(parentCents)) return { rows: [], available: false };
    output.push(...prepared);
  }
  return { rows: output, available: true };
}

export function completedSpendingMonths(timezone: unknown, now = new Date()) {
  const zone = resolveCalendarTimeZone(timezone), month = calendarDate(now, zone).slice(0, 7);
  const [year, number] = month.split('-').map(Number);
  const months = Array.from({length: 12}, (_, i) => {
    const start = new Date(Date.UTC(year, number - 13 + i, 1));
    const end = new Date(Date.UTC(year, number - 12 + i, 1));
    return {key: start.toISOString().slice(0, 7), start: start.toISOString().slice(0, 10), endExclusive: end.toISOString().slice(0, 10), end: new Date(+end - 86400000).toISOString().slice(0, 10)};
  });
  return {timezone: zone, forMonth: month, months};
}

/** Dedicated completed-year read model. Never passes twelve months to Budget Coach. */
export async function readSpendingAverage(timezone: unknown, load: (args: Row, signal?: AbortSignal) => Promise<any>, now = new Date(), signal?: AbortSignal, loadSnapshot?: (signal?: AbortSignal) => Promise<Row[]>) {
  const window = completedSpendingMonths(timezone, now);
  const months: Row[] = Array(12);
  const eligibleMonths: Row[][] = Array.from({length:12},()=>[]);
  let cursor = 1, snapshotGeneration: number | null = null, snapshotRevision: number | null = null;
  const snapshotRows = loadSnapshot ? await loadSnapshot(signal) : null;
  const loadMonth = async (index: number) => {
    if (signal?.aborted) throw new DOMException('This request is no longer needed.', 'AbortError');
    const range = window.months[index], rows: Row[] = [];
    let offset = 0;
    if (snapshotRows) rows.push(...snapshotRows.filter(row=>String(row.effective_transaction_date||row.transaction_date||'')>=range.start&&String(row.effective_transaction_date||row.transaction_date||'')<range.endExclusive));
    else for (;;) {
      const result = await load({start_date: range.start, end_date: range.end, include_pending: true, limit: 200, offset, ...(snapshotGeneration === null ? {} : {generation:snapshotGeneration})}, signal);
      if (signal?.aborted) throw new DOMException('This request is no longer needed.', 'AbortError');
      const data = result.data;
      if (!result.ok || !Array.isArray(data?.transactions)) throw readFailure('upstream','Spending history could not be loaded. Please retry.');
      if (data.restart_required !== false || data.fresh !== true || data.stale !== false || !Number.isSafeInteger(data.generation) || !Number.isSafeInteger(data.revision)) throw readFailure('snapshot_changed','Spending history changed while it was loading. Please retry.');
      if (snapshotGeneration === null) { snapshotGeneration = data.generation; snapshotRevision = data.revision; }
      else if (data.generation !== snapshotGeneration || data.revision !== snapshotRevision) throw readFailure('snapshot_changed','Spending history changed while it was loading. Please retry.');
      rows.push(...data.transactions);
      const next = data.next_offset;
      if (next === null) break;
      if (!Number.isInteger(next) || next <= offset || next > 20000) throw readFailure('incomplete','Spending history is incomplete. Please retry.');
      offset = next;
    }
    const seen = new Set<string>(), replaced = new Set(rows.filter(r => !r.pending).map(r => r.pending_transaction_id).filter(Boolean));
    for (const row of rows) {
      const id = String(row.transaction_id || ''), date = String(row.effective_transaction_date || row.transaction_date || '');
      if (seen.has(id) || (row.pending && replaced.has(id))) continue;
      seen.add(id);
      const expanded = spendingAllocationRows([row]);
      if (!expanded.available) throw readFailure('allocation_invalid','Spending history contains an incomplete transaction allocation.');
      if (date < range.start || date >= range.endExclusive || (row.iso_currency_code || 'USD') !== 'USD') continue;
      for (const allocation of expanded.rows) {
        if (!countsTowardBudget(allocation)) continue;
        const amount = Number(allocation.amount);
        if (!Number.isFinite(amount)) throw readFailure('allocation_invalid','Spending history contains an invalid amount.');
        eligibleMonths[index].push({...allocation,effective_transaction_date:date});
      }
    }
  };
  // Establish a snapshot generation before parallelizing the other months.
  // Every subsequent page is pinned to it and every revision must match.
  if (snapshotRows) { for (let index=0; index<12; index++) await loadMonth(index); }
  else { await loadMonth(0); await Promise.all(Array.from({length:4}, async () => { while (cursor < 12) { const index = cursor++; await loadMonth(index); } })); }
  const typical=typicalSpendingMonths(eligibleMonths);
  // Keep the named-month series independent from the outlier-adjusted typical
  // baseline. Individual months represent actual eligible ledger totals.
  const actualMonths = eligibleMonths.map((rows, index) => {
    const range = window.months[index], days = Array(31).fill(0);
    for (const row of rows) {
      const day = Number(String(row.effective_transaction_date).slice(8, 10)) - 1;
      if (day >= 0 && day < days.length) days[day] += Math.round(Number(row.amount) * 100);
    }
    let total = 0;
    const cumulative = days.map(cents => (total += cents) / 100);
    return { ...range, total: total / 100, cumulative };
  });
  typical.months.forEach((rows,index)=>{
      const range=window.months[index],days=Array(31).fill(0);
      for(const row of rows) days[Number(row.effective_transaction_date.slice(8,10))-1]+=Math.round(Number(row.amount)*100);
      let total = 0;
      const cumulative = days.map(cents => (total += cents) / 100);
      months[index] = {...range, spending: total / 100, cumulative};
  });
  const totalCents = months.reduce((sum, m) => sum + Math.round(m.spending * 100), 0);
  return {schemaVersion: 2, allocation_coverage: {status:'complete', month_count:12, currency:'USD', unavailable_parent_count:0}, excludedCount: typical.excludedCount, excludedTotal: Math.round(typical.excludedTotal*100)/100, timezone: window.timezone, forMonth: window.forMonth, start: months[0].start, endExclusive: months[11].endExclusive, currency: 'USD', monthCount: 12, months, actualMonths, total: totalCents / 100, average: Math.round(totalCents / 12) / 100, cumulativeAverage: Array.from({length: 31}, (_, day) => Math.round(months.reduce((sum, m) => sum + Math.round(m.cumulative[day] * 100), 0) / 12) / 100), generatedAt: now.toISOString()};
}
