type Row=Record<string,any>;
const DAY=86400000;
const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v);
export const investmentCents=(v:any):number|null=>finite(v)&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<0.00001?Math.round(v*100):null;
const time=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
const date=(v:any)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export function investmentCalendarDate(at:number,timeZone:string):string{
 const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);const part=(type:string)=>parts.find(p=>p.type===type)!.value;return `${part('year')}-${part('month')}-${part('day')}`;
}
function postingNoon(day:string,timeZone:string):number{
 const target=Date.parse(day+'T12:00:00Z');let at=target;
 for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(at),p=(type:string)=>parts.find(r=>r.type===type)!.value;const represented=Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}Z`);at+=target-represented;}return at;
}
/** Observation time is collection time, never a claimed institution end-of-day time. */
export function investmentObservation(account:Row,holdings:Row[],securities:Row[],observedAt:string):Row{
 const reasons:string[]=[],total=investmentCents(account.balances?.current),asOf=time(observedAt),securityMap=new Map(securities.map(s=>[s.security_id,s]));
 if(!Number.isFinite(asOf))reasons.push('observation_timestamp_invalid');
 if(account.type!=='investment'||account.balances?.iso_currency_code!=='USD'||account.balances?.unofficial_currency_code||total===null||total<0)reasons.push('unsupported_account_value');
 if(account.balances?.margin_loan_amount!=null&&account.balances.margin_loan_amount!==0)reasons.push('margin_not_supported');
 let sum=0,cash=0;const quoteDates:string[]=[];const ids=new Set();
 for(const h of holdings){const s=securityMap.get(h.security_id),value=finite(h.institution_value)&&Number.isSafeInteger(Math.round(h.institution_value*100))?Math.round(h.institution_value*100):null;if(!s||ids.has(h.security_id)||h.account_id!==account.account_id||value===null||value<0||h.iso_currency_code!=='USD'||h.unofficial_currency_code){reasons.push('invalid_or_duplicate_holding');continue;}ids.add(h.security_id);sum+=h.institution_value;
  if(s.type==='cash'){if(h.institution_price!==1||!finite(h.quantity)||investmentCents(h.quantity)!==value)reasons.push('cash_position_not_verified');cash+=value;}
  else{const stamp=h.institution_price_datetime??(date(h.institution_price_as_of)?h.institution_price_as_of+'T00:00:00Z':null),t=time(stamp);if(!Number.isFinite(t)||t>asOf||asOf-t>4*DAY)reasons.push('holding_quote_stale_or_undated');else quoteDates.push(new Date(t).toISOString());}
 }
 if(!Number.isSafeInteger(Math.round(sum*100))||Math.round(sum*100)!==total)reasons.push('holdings_total_does_not_reconcile');
 if(!holdings.length&&total!==0)reasons.push('holdings_missing');
 return{source_account_id:account.account_id,observed_at:observedAt,observed_date:observedAt.slice(0,10),value_cents:total,cash_cents:cash,currency_code:account.balances?.iso_currency_code??null,quote_oldest_at:quoteDates.sort()[0]??null,status:reasons.length?'unavailable':'verified_observation',reasons:[...new Set(reasons)],valuation_basis:'provider_total_reconciled_to_holdings',rounding:'USD holdings summed before rounding once to cents',timing:'collection_observation',raw_account:account,raw_holdings:holdings,raw_securities:securities.filter(s=>ids.has(s.security_id))};
}
/** Resolve cancellations before classifying: provider signs are cash out positive. */
export function reconcileInvestmentActivity(rows:Row[]):{rows:Row[],reasons:string[]}{
 const reasons:string[]=[],byId=new Map<string,Row>(),removed=new Set<string>();
 for(const row of rows){if(!row.investment_transaction_id||byId.has(row.investment_transaction_id)){reasons.push('duplicate_or_missing_activity_id');continue;}byId.set(row.investment_transaction_id,row);}
 for(const row of byId.values())if(row.type==='cancel'||row.cancel_transaction_id){const original=byId.get(row.cancel_transaction_id);if(row.type!=='cancel'||!original||original.type==='cancel'||original.account_id!==row.account_id||removed.has(original.investment_transaction_id)){reasons.push('cancellation_unresolved');continue;}removed.add(row.investment_transaction_id);removed.add(original.investment_transaction_id);}
 const result:Row[]=[];
 for(const row of byId.values()){if(removed.has(row.investment_transaction_id))continue;const amount=investmentCents(row.amount),fees=investmentCents(row.fees??0),type=String(row.type),subtype=String(row.subtype);let external=0;
  if(amount===null||fees===null||!date(row.date)||row.iso_currency_code!=='USD'||row.unofficial_currency_code||row.pending===true||/pending/.test(subtype)){reasons.push('unsupported_activity_value');continue;}
  if(type==='cash'&&['deposit','contribution','withdrawal','distribution'].includes(subtype)){
   if(row.security_id||Number(row.quantity??0)!==0||Number(row.price??0)!==0||fees!==0||(subtype==='deposit'||subtype==='contribution'?amount>=0:amount<=0)){reasons.push('external_flow_ambiguous');continue;}external=-amount;
  }else if(type==='cash'&&['dividend','qualified dividend','non-qualified dividend','interest','long-term capital gain','short-term capital gain','return of principal'].includes(subtype)){if(amount>0){reasons.push('retained_income_sign');continue;}}
  else if(type==='buy'&&['buy','dividend reinvestment','interest reinvestment','long-term capital gain reinvestment','short-term capital gain reinvestment'].includes(subtype)){if(amount<0){reasons.push('trade_sign');continue;}}
  else if(type==='sell'&&subtype==='sell'){if(amount>0){reasons.push('trade_sign');continue;}}
  else if(type==='fee'&&amount>=0){}else{reasons.push('unclassified_external_or_in_kind_flow');continue;}
  // Reinvestment encodes income and purchase in one row, hence no cash movement.
  const reinvestment=type==='buy'&&subtype.includes('reinvestment');
  result.push({...row,amount_cents:amount,cash_change_cents:reinvestment?0:-amount,external_cents:external,flow_time:null});
 }
 return{rows:result,reasons:[...new Set(reasons)]};
}
const unavailable=(reasons:string[],extra:Row={})=>({status:'unavailable',method:'observation_modified_dietz_v1',estimated:true,return_percent:null,investment_gain_cents:null,net_contributions_cents:null,series:[],reasons:[...new Set(reasons)],...extra});
export function estimateInvestmentPerformance(input:Row):Row{
 const scope=[...new Set(input.account_scope??[])].sort(),timeZone=input.timezone??'UTC',sourceObservations:Row[]=input.observations??[],raw:Row[]=input.activity??[],now=time(input.generated_at),start=input.start_date,end=input.end_date;
 try{if(typeof timeZone!=='string'||timeZone.length>100)throw Error();investmentCalendarDate(now,timeZone);}catch{return unavailable(['invalid_calendar_context']);}
 const observations=sourceObservations.filter(o=>Number.isFinite(time(o.observed_at))).map(o=>({...o,observed_date:investmentCalendarDate(time(o.observed_at),timeZone)}));
 const common={timezone:timeZone,account_scope:scope,requested_start_date:start,requested_end_date:end,currency_code:'USD',timing_convention:`Local noon (${timeZone}) of the provider posting date for interior activity. Provider order-initiation timestamps are not settlement times; activity on either observation boundary date is unavailable.`,valuation_convention:'Collected account totals reconciled to holdings; prices may precede collection by up to four calendar days. Estimated, not end-of-day time-weighted return.',benchmark:{status:'unavailable',reason:'compatible_total_return_benchmark_missing'}};
 if(!scope.length||scope.some(x=>typeof x!=='string'||!x)||scope.length!==(input.account_scope??[]).length||!date(start)||!date(end)||start>end||!Number.isFinite(now))return unavailable(['invalid_scope_or_period'],common);
 if(input.coverage?.complete!==true||!input.coverage?.scan_id||!date(input.coverage.start_date)||!date(input.coverage.end_date)||!Number.isFinite(time(input.coverage.completed_at))||JSON.stringify([...(input.coverage.account_scope??[])].sort())!==JSON.stringify(scope)||now-time(input.coverage.completed_at)>36*3600000||now<time(input.coverage.completed_at))return unavailable(['activity_coverage_not_current'],common);
 const groups=new Map<string,Row[]>();for(const o of observations){if(!scope.includes(o.canonical_account_id)||o.observed_date<start||o.observed_date>end)continue;const list=groups.get(o.scan_id)??[];list.push(o);groups.set(o.scan_id,list);}
 const snapshots=[...groups.values()].filter(rows=>rows.length===scope.length&&scope.every(id=>rows.filter(r=>r.canonical_account_id===id).length===1)&&rows.every(r=>r.observed_date===rows[0].observed_date&&r.status==='verified_observation'&&r.currency_code==='USD'&&Number.isSafeInteger(r.value_cents)&&Number.isSafeInteger(r.cash_cents))).map(rows=>({at:Math.max(...rows.map(r=>time(r.observed_at))),date:rows[0].observed_date,value:rows.reduce((n,r)=>n+r.value_cents,0),cash:rows.reduce((n,r)=>n+r.cash_cents,0),rows})).filter(s=>Number.isFinite(s.at)&&s.rows.every(r=>time(r.observed_at)>=s.at-5*60000)&&Number.isSafeInteger(s.value)&&Number.isSafeInteger(s.cash)).sort((a,b)=>a.at-b.at);
 if(snapshots.length<2)return unavailable(['need_two_supported_observations'],{...common,collection_started_at:observations.map(o=>o.observed_at).sort()[0]??null});
 const first=snapshots[0],last=snapshots.at(-1)!;
 if(first.date===last.date||first.value<=0)return unavailable(['insufficient_period_or_opening_value'],common);
 if(input.coverage.end_date<last.date)return unavailable(['closing_activity_coverage_missing'],common);
 if(raw.some(r=>scope.includes(r.canonical_account_id)&&!date(r.date)))return unavailable(['activity_date_invalid'],common);
 if(input.coverage.start_date>first.date)return unavailable(['opening_activity_coverage_missing'],common);
 const periodRows=raw.filter(r=>scope.includes(r.canonical_account_id)&&r.date>=first.date&&r.date<=last.date),cancelIds=new Set(periodRows.map(r=>r.cancel_transaction_id).filter(Boolean));
 const classified=reconcileInvestmentActivity([...periodRows,...raw.filter(r=>scope.includes(r.canonical_account_id)&&cancelIds.has(r.investment_transaction_id)&&!periodRows.includes(r))]);if(classified.reasons.length)return unavailable(classified.reasons,common);
 const selected=classified.rows.filter(r=>scope.includes(r.canonical_account_id));
 const boundary=selected.some(r=>!r.flow_time&&(r.date===first.date||r.date===last.date));if(boundary)return unavailable(['date_only_activity_on_observation_boundary'],{...common,supported_start:first.date,supported_end:last.date});
 let cashChange=0,net=0,weighted=0;for(const row of selected){const t=row.flow_time?time(row.flow_time):postingNoon(row.date,timeZone);if(t<=first.at||t>last.at)continue;cashChange+=row.cash_change_cents;net+=row.external_cents;weighted+=row.external_cents*(last.at-t)/(last.at-first.at);}
 for(const id of scope){const a=first.rows.find(r=>r.canonical_account_id===id)!,b=last.rows.find(r=>r.canonical_account_id===id)!;const movement=selected.filter(r=>r.canonical_account_id===id).reduce((sum,r)=>{const t=r.flow_time?time(r.flow_time):postingNoon(r.date,timeZone);return sum+(t>time(a.observed_at)&&t<=time(b.observed_at)?r.cash_change_cents:0);},0);if(b.cash_cents-a.cash_cents!==movement)return unavailable(['account_cash_activity_does_not_reconcile'],{...common,supported_start:first.date,supported_end:last.date});}
 if(!Number.isSafeInteger(net)||!Number.isSafeInteger(cashChange)||last.cash-first.cash!==cashChange)return unavailable(['cash_activity_does_not_reconcile'],{...common,supported_start:first.date,supported_end:last.date});
 const denominator=first.value+weighted,gain=last.value-first.value-net;if(!Number.isFinite(denominator)||denominator<=0||!Number.isSafeInteger(gain))return unavailable(['invalid_return_denominator'],common);
 const partial=first.date!==start||last.date!==end;
 return{...common,status:partial?'partial':'available',method:'observation_modified_dietz_v1',estimated:true,return_percent:gain/denominator*100,investment_gain_cents:gain,net_contributions_cents:net,opening_value_cents:first.value,closing_value_cents:last.value,supported_start:first.date,supported_end:last.date,opening_observed_at:new Date(first.at).toISOString(),closing_observed_at:new Date(last.at).toISOString(),source_revision:input.coverage.scan_id,series:[],period_estimate:{start_date:first.date,end_date:last.date,return_percent:gain/denominator*100},reasons:partial?['requested_period_has_missing_older_or_latest_observations']:[]};
}
