/** Daily end-of-day external-flow adjusted TWR. Server-owned attestations only.
 * Never infer EOD valuation or period completeness from recorded_at/pagination. */
type Row = Record<string, any>;
const DAY = 86_400_000;
const day = (s: unknown): number | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? n : null;
};
const cents = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const text = (s: unknown): s is string => typeof s === 'string' && !!s.trim();
const same = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && a.every(v => b.includes(v));
const unavailable = (reasons: string[], scope: unknown = [], start: unknown = null, end: unknown = null) => ({
  status: 'unavailable', method: 'daily_eod_time_weighted_v1', timing: 'end_of_day',
  account_scope: scope, start_date: start, end_date: end, currency_code: null,
  return_percent: null, investment_gain_cents: null, net_contributions_cents: null,
  series: [], reasons: [...new Set(reasons)], benchmark: { status: 'unavailable', reason: 'compatible_benchmark_not_attested' },
});

/** No HTTP body may provide this object. A future trusted source adapter must
 * supply complete, canonical, source-revision-bound evidence for every account.
 * Valuation is total account value incl retained cash. Flows occur after daily
 * performance; interval is (start_date, end_date], with opening flows excluded. */
export function calculateAttestedInvestmentPerformance(input: Row) {
  const ids = input?.account_scope;
  const start = day(input?.start_date), end = day(input?.end_date);
  const fail = (reason: string) => unavailable([reason], ids, input?.start_date, input?.end_date);
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !text(id)) || new Set(ids).size !== ids.length || start === null || end === null || start >= end || (end-start)/DAY > 36600) return fail('invalid_scope_or_period');
  const coverage = input.coverage;
  if (!coverage || !text(coverage.evidence_id) || !text(coverage.source_revision) || !same(coverage.account_scope, ids) || coverage.start_date !== input.start_date || coverage.end_date !== input.end_date || coverage.complete !== true || coverage.pagination_complete !== true || coverage.classification_complete !== true || coverage.timing !== 'end_of_day' || coverage.valuation_basis !== 'total_account_value_including_cash' || coverage.interval !== '(start,end]') return fail('coverage_not_attested');
  if (input.currency_code !== 'USD') return fail('unsupported_currency');
  if (!Array.isArray(input.valuations) || !Array.isArray(input.activity)) return fail('evidence_missing');
  const revision = coverage.source_revision;
  const sourceValid = (row: Row) => row && text(row.evidence_id) && row.source_revision === revision && row.currency_code === input.currency_code && ids.includes(row.canonical_account_id);
  const values = new Map<string, number>();
  for (const row of input.valuations) {
    const d = day(row?.date);
    if (!sourceValid(row) || d === null || d < start || d > end || row.timing !== 'end_of_day' || !cents(row.value_cents) || row.value_cents < 0) return fail('invalid_valuation');
    const key = row.canonical_account_id + '|' + row.date;
    if (values.has(key)) return fail('duplicate_valuation');
    values.set(key, row.value_cents);
  }
  const totals = new Map<string, number>();
  for (let d=start; d<=end; d+=DAY) {
    const date = new Date(d).toISOString().slice(0,10);
    let total=0;
    for (const id of ids) { const value=values.get(id+'|'+date); if(value===undefined) return fail('missing_daily_valuation'); total+=value; }
    if(!cents(total)) return fail('unsafe_amount');
    totals.set(date,total);
  }
  const rows = new Map<string, Row>();
  for (const row of input.activity) {
    const d=day(row?.date);
    if(!sourceValid(row) || !text(row.id) || d===null || d<=start || d>end || row.timing!=='end_of_day' || row.classification_verified!==true || !cents(row.external_value_cents) || row.cancellation_resolved!==true) return fail('invalid_or_unclassified_activity');
    if(rows.has(row.id)) return fail('duplicate_activity');
    rows.set(row.id,row);
  }
  const dailyFlows=new Map<string,number>();
  for(const row of rows.values()) {
    let flow=row.external_value_cents;
    if(['trade','retained_dividend','retained_interest','fee'].includes(row.kind)) {
      if(flow!==0) return fail('internal_activity_has_external_value');
    } else if(row.kind==='deposit') { if(flow<=0) return fail('invalid_deposit'); }
    else if(row.kind==='withdrawal') { if(flow>=0) return fail('invalid_withdrawal'); }
    else if(row.kind==='transfer') {
      if(!text(row.counterparty_canonical_account_id) || row.counterparty_canonical_account_id===row.canonical_account_id || !text(row.transfer_evidence_id) || flow===0) return fail('transfer_counterparty_unverified');
      if(row.asset_form!=='cash' && !(row.asset_form==='in_kind' && row.dated_fair_value_verified===true)) return fail('transfer_value_unverified');
      if(ids.includes(row.counterparty_canonical_account_id)) {
        const other=rows.get(row.counterparty_activity_id);
        if(!other || other.kind!=='transfer' || other.canonical_account_id!==row.counterparty_canonical_account_id || other.counterparty_canonical_account_id!==row.canonical_account_id || other.counterparty_activity_id!==row.id || other.date!==row.date || other.transfer_evidence_id!==row.transfer_evidence_id || other.external_value_cents!==-flow || other.asset_form!==row.asset_form) return fail('internal_transfer_unmatched');
        flow=0;
      }
    } else return fail('unknown_activity_kind');
    const sum=(dailyFlows.get(row.date)??0)+flow;
    if(!cents(sum)) return fail('unsafe_amount');
    dailyFlows.set(row.date,sum);
  }
  let previous=totals.get(input.start_date)!, factor=1, net=0;
  const opening=previous;
  const series=[{date:input.start_date,value_cents:opening,net_contributions_cents:0,investment_gain_cents:0,return_percent:0}];
  for(let d=start+DAY;d<=end;d+=DAY) {
    const date=new Date(d).toISOString().slice(0,10), value=totals.get(date)!, flow=dailyFlows.get(date)??0;
    if(previous<=0) return fail('nonpositive_opening_value_or_restart');
    const adjusted=value-flow;
    if(!cents(adjusted) || adjusted<0) return fail('invalid_flow_adjusted_value');
    factor*=adjusted/previous; net+=flow;
    const valueChange=value-opening;
    if(!cents(valueChange)) return fail('unsafe_amount');
    const gain=valueChange-net;
    if(!Number.isFinite(factor) || !cents(net) || !cents(gain)) return fail('unsafe_amount');
    series.push({date,value_cents:value,net_contributions_cents:net,investment_gain_cents:gain,return_percent:(factor-1)*100});
    previous=value;
  }
  const last=series[series.length-1];
  return {status:'available',method:'daily_eod_time_weighted_v1',timing:'end_of_day',interval:'(start,end]',account_scope:ids,start_date:input.start_date,end_date:input.end_date,currency_code:input.currency_code,source_revision:revision,evidence_id:coverage.evidence_id,return_percent:last.return_percent,investment_gain_cents:last.investment_gain_cents,net_contributions_cents:net,series,reasons:[],benchmark:{status:'unavailable',reason:'compatible_benchmark_not_attested'}};
}

/** Existing snapshot/Plaid contract lacks trustworthy timing, coverage, and
 * classification attestations. Expose why; never promote provider success to
 * performance completeness. It is intentionally impossible for request fields
 * or raw evidence attributes to turn this response into a numeric return. */
export function investmentPerformanceReadiness(evidence: Row) {
  const reasons=['valuation_timing_not_attested','historical_period_not_attested','external_flow_classification_not_attested'];
  if(!Array.isArray(evidence?.account_scope) || !evidence.account_scope.length) reasons.push('empty_scope');
  if(evidence?.account_source_quality?.status!=='primary_source_selected') reasons.push('account_source_unavailable');
  if(evidence?.history?.pagination_complete!==true || evidence?.activity?.pagination_complete!==true) reasons.push('incomplete_source_pages');
  if(evidence?.history?.conflicting_snapshot_keys?.length) reasons.push('conflicting_snapshot_evidence');
  if(evidence?.history?.rows?.some((r: Row)=>!r.currency_code || r.current_balance===null) || evidence?.activity?.rows?.some((r: Row)=>!r.currency_code || r.amount===null)) reasons.push('missing_currency_or_amount');
  const currencies=new Set([...(evidence?.history?.rows??[]),...(evidence?.activity?.rows??[])].map((r:Row)=>r.currency_code).filter(Boolean));
  if(currencies.size>1) reasons.push('mixed_currency');
  return unavailable(reasons,evidence?.account_scope,evidence?.activity?.requested_start_date,evidence?.activity?.requested_end_date);
}
