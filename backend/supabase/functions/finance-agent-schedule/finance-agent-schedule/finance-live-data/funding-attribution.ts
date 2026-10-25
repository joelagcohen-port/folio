const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cents=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&Number.isSafeInteger(Math.round(value*100))&&Math.abs(value*100-Math.round(value*100))<1e-7?Math.round(value*100):null;
const validDay=(value:any)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const day=(date:string,offset:number)=>{const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
const unavailable=(reason:string,unresolved:string[]=[])=>({status:'unavailable',reason,unresolved,points:[],projected_low:null,ending_balance:null});
export function recurringFundingIdentity(stream:any){
 return JSON.stringify({stream_key:String(stream?.stream_key??''),account_id:String(stream?.account_id??''),canonical_account_id:String(stream?.canonical_account_id??''),flow_type:String(stream?.flow_type??''),recurring_kind:String(stream?.recurring_kind??''),currency_code:String(stream?.currency_code??''),source_currency_verified:stream?.source_currency_verified===true});
}
export function budgetTargetFundingIdentity(target:any,category:any){
 return JSON.stringify({budget_target_id:String(target?.budget_target_id??''),category:String(target?.category??''),subcategory:target?.subcategory??null,currency_code:String(target?.currency_code??''),active:target?.active===true,category_type:String(category?.category_type??''),category_active:category?.active===true,excluded_from_budget:category?.excluded_from_budget===true});
}

/** Resolve a selected-account forecast only from explicit account evidence.
 * No history-based funding guesses are made. Amounts are rounded/checked as cents
 * before they enter the daily series, and each source occurrence is applied once.
 */
export function projectCashScopeFromFunding(input:any){
 const {today,accountIds,accounts,streams,occurrences,variableSpend,categoryFunding,horizonDays=30,now=Date.now(),recurringCoverageComplete=false,historyFresh=false,sourceRevision=null}=input??{};
 if(!validDay(today)||!Array.isArray(accountIds)||!accountIds.length||!Array.isArray(accounts)||!Array.isArray(streams)||!Array.isArray(occurrences)||!Array.isArray(categoryFunding)||!Number.isFinite(now))return unavailable('scope_or_inputs_unavailable');
 if(recurringCoverageComplete!==true||historyFresh!==true)return unavailable('recurring_or_history_stale');
 if(!Number.isInteger(horizonDays)||horizonDays<1||horizonDays>90)return unavailable('horizon_unavailable');
 const selected=new Set(accountIds),accountMap=new Map(accounts.map((a:any)=>[a.canonical_account_id,a]));
 if(accountMap.size!==accounts.length||selected.size!==accountIds.length||[...selected].some(id=>!uuid.test(String(id))||accountMap.get(id)?.type!=='depository'||accountMap.get(id)?.lifecycle_status!=='active'||accountMap.get(id)?.connection_status!=='connected'||accountMap.get(id)?.match_status==='review_required'||accountMap.get(id)?.balance_currency_code!=='USD'||cents(accountMap.get(id)?.current_balance)===null||!Number.isFinite(Date.parse(accountMap.get(id)?.balance_updated_at??''))||now-Date.parse(accountMap.get(id)?.balance_updated_at)<0||now-Date.parse(accountMap.get(id)?.balance_updated_at)>36*3600000))return unavailable('selected_account_unavailable');
 if(new Set(streams.map((s:any)=>s?.stream_key)).size!==streams.length||streams.some((s:any)=>typeof s?.stream_key!=='string'||!s.stream_key))return unavailable('stream_identity_ambiguous');
 if(new Set(categoryFunding.map((a:any)=>a?.budget_target_id)).size!==categoryFunding.length)return unavailable('category_funding_ambiguous');
 const streamMap=new Map(streams.map((s:any)=>[s.stream_key,s])),unresolved=new Set<string>(),resolved=new Map<string,{source:string;destination:string|null;kind:string}>();
 for(const s of streams){
   const kind=String(s.recurring_kind??'');
   if(s.is_active!==true||s.override_not_recurring===true||(kind!=='internal_transfer'&&(s.include_in_forecast===false||s.primary_eligible===false)))continue;
   const account=accountMap.get(s.canonical_account_id)??accountMap.get(s.account_id),assoc=s.funding_association;
   if(!['income','expense','subscription','credit_card_repayment','internal_transfer'].includes(kind))continue;
   if(s.currency_code!=='USD'||s.source_currency_verified!==true){unresolved.add(`stream:${s.stream_key}:currency_unverified`);continue;}
   let source:string|null=null,destination:string|null=null;
   if(kind==='internal_transfer'){
     if(!assoc||assoc.stream_identity_fingerprint!==recurringFundingIdentity(s)||!uuid.test(String(assoc.source_canonical_account_id??''))||!uuid.test(String(assoc.destination_canonical_account_id??''))||!uuid.test(String(assoc.transfer_pair_id??''))||assoc.source_canonical_account_id===assoc.destination_canonical_account_id){unresolved.add(`stream:${s.stream_key}:transfer_pair_unreviewed`);continue;}
     source=assoc.source_canonical_account_id;destination=assoc.destination_canonical_account_id;
   }else if(String(account?.type).toLowerCase()==='credit'&&kind!=='credit_card_repayment'){
     const settlement=streamMap.get(assoc?.settled_by_stream_key),settlementAssoc=settlement?.funding_association;
     if(!assoc||assoc.stream_identity_fingerprint!==recurringFundingIdentity(s)||!settlement||settlement.recurring_kind!=='credit_card_repayment'||settlement.is_active!==true||settlementAssoc?.stream_identity_fingerprint!==recurringFundingIdentity(settlement)||!Array.isArray(settlementAssoc.settled_credit_account_ids)||!settlementAssoc.settled_credit_account_ids.includes(account.canonical_account_id)){unresolved.add(`stream:${s.stream_key}:card_settlement_unreviewed`);continue;}
     resolved.set(String(s.stream_key),{source:'',destination:null,kind:'settled_credit_purchase'});continue;
   }else if(kind==='credit_card_repayment'||String(account?.type).toLowerCase()==='credit'){
     if(!assoc||assoc.stream_identity_fingerprint!==recurringFundingIdentity(s)||!uuid.test(String(assoc.funding_canonical_account_id??''))){unresolved.add(`stream:${s.stream_key}:funding_account_unreviewed`);continue;}
     source=assoc.funding_canonical_account_id;
   }else if(account?.type==='depository'&&account.lifecycle_status!=='closed'){
     if(assoc){if(assoc.stream_identity_fingerprint!==recurringFundingIdentity(s)||!uuid.test(String(assoc.funding_canonical_account_id??''))){unresolved.add(`stream:${s.stream_key}:funding_association_stale`);continue;}source=assoc.funding_canonical_account_id;}
     else source=account.canonical_account_id;
   }
   else {unresolved.add(`stream:${s.stream_key}:funding_account_unreviewed`);continue;}
   if(!accountMap.has(source)||accountMap.get(source)?.type!=='depository'||accountMap.get(source)?.lifecycle_status!=='active'||(destination&&(!accountMap.has(destination)||accountMap.get(destination)?.type!=='depository'||accountMap.get(destination)?.lifecycle_status!=='active'))){unresolved.add(`stream:${s.stream_key}:account_unavailable`);continue;}
   resolved.set(String(s.stream_key),{source,destination,kind});
 }
 const eventKeys=new Set<string>(),transferOccurrenceKeys=new Set<string>(),transferSignatures=new Map<string,any>(),transferSignals:any[]=[],deltas=new Map<string,number>();
 for(const e of occurrences){
   const date=String(e?.date??''),key=`${e?.stream_key}|${date}`;
   if(!validDay(date)||date<today||date>day(today,horizonDays)||eventKeys.has(key)){unresolved.add(`occurrence:${key}:invalid_or_duplicate`);continue;}
   eventKeys.add(key);
   const s=streamMap.get(e.stream_key),mapping=resolved.get(e.stream_key),amount=typeof e.amount==='number'?cents(Math.abs(e.amount)):null;
   if(mapping?.kind==='settled_credit_purchase')continue;
   if(!s||!mapping||amount===null||amount<=0){unresolved.add(`occurrence:${key}:unattributed`);continue;}
   if(mapping.destination){
     const pairOccurrence=`${s.funding_association.transfer_pair_id}|${date}`;if(transferOccurrenceKeys.has(pairOccurrence)){unresolved.add(`transfer:${pairOccurrence}:duplicate_pair`);continue;}transferOccurrenceKeys.add(pairOccurrence);
     const endpoints=[mapping.source,mapping.destination].sort().join('|'),signature=`${endpoints}|${date}|${amount}`;
     if(transferSignatures.has(signature)){unresolved.add(`transfer:${signature}:ambiguous_counterpart`);continue;}transferSignatures.set(signature,String(s.stream_key));
     const ids=new Set([...(Array.isArray(s.transaction_ids)?s.transaction_ids:[]),...(Array.isArray(s.source_stream_keys)?s.source_stream_keys:[]),...(typeof s.transfer_relation_key==='string'?[s.transfer_relation_key]:[])]);
     const related=transferSignals.some(prior=>{
       if(prior.endpoints!==endpoints||prior.stream_key===String(s.stream_key))return false;
       const sourceLinked=prior.keys.some((key:string)=>ids.has(key));
       const days=Math.abs(Date.parse(`${date}T00:00:00Z`)-Date.parse(`${prior.date}T00:00:00Z`))/86400000;
       // Recurring source feeds often expose the two legs as separate streams
       // with different IDs, posting dates, and small amount differences. If
       // both are mapped to the same account pair within one week, there is no
       // reviewed provider identity proving they are distinct transfers.
       return sourceLinked||(days<=7&&prior.flow_type!==e.flow_type);
     });
     if(related){unresolved.add(`transfer:${endpoints}|${date}:provider_counterpart_ambiguous`);continue;}
     transferSignals.push({endpoints,keys:[...ids],stream_key:String(s.stream_key),date,flow_type:e.flow_type});
   }
   const direction=e.flow_type==='inflow'?1:e.flow_type==='outflow'?-1:0;
   if(!direction){unresolved.add(`occurrence:${key}:direction_unavailable`);continue;}
   let signed=amount*direction;
   if(mapping.destination){const sourceSelected=selected.has(mapping.source),destinationSelected=selected.has(mapping.destination);if(sourceSelected===destinationSelected)continue;signed=sourceSelected?-amount:amount;}
   else if(!selected.has(mapping.source))continue;
   const combined=(deltas.get(date)??0)+signed;if(!Number.isSafeInteger(combined)){unresolved.add(`occurrence:${key}:amount_overflow`);continue;}deltas.set(date,combined);
 }
 if(!variableSpend||variableSpend.status!=='available'||!Array.isArray(variableSpend.categories))unresolved.add('variable_spend:unavailable');
 else {
   if(!Number.isSafeInteger(variableSpend.unknown_bills)||variableSpend.unknown_bills!==0)unresolved.add('variable_spend:unknown_recurring_category');
   const funding=new Map((Array.isArray(categoryFunding)?categoryFunding:[]).map((a:any)=>[a.budget_target_id,a]));
   for(const c of variableSpend.categories){
     const amount=typeof c.remaining==='number'?cents(c.remaining):null;
     if(amount===null||amount<0){unresolved.add(`budget:${c.id}:amount_unavailable`);continue;}
     if(amount===0)continue;
     const a=funding.get(c.id);
     if(!validDay(c.forecast_date)||c.forecast_date<today||c.forecast_date>day(today,horizonDays)||!a||a.category_identity_fingerprint!==c.identity_fingerprint||!uuid.test(String(a.canonical_account_id??''))||accountMap.get(a.canonical_account_id)?.type!=='depository'||accountMap.get(a.canonical_account_id)?.lifecycle_status!=='active') {unresolved.add(`budget:${c.id}:funding_account_unreviewed`);continue;}
     if(selected.has(a.canonical_account_id)){
       const combined=(deltas.get(c.forecast_date)??0)-amount;if(!Number.isSafeInteger(combined)){unresolved.add(`budget:${c.id}:amount_overflow`);continue;}deltas.set(c.forecast_date,combined);
     }
   }
 }
 if(unresolved.size)return unavailable('funding_attribution_incomplete',[...unresolved].sort());
 const opening=accounts.filter((a:any)=>selected.has(a.canonical_account_id)).reduce((sum:number,a:any)=>sum+cents(a.current_balance)!,0);
 if(!Number.isSafeInteger(opening))return unavailable('opening_balance_invalid');
 let balance=opening;const points=[];
 for(let i=0;i<=horizonDays;i++){balance+=deltas.get(day(today,i))??0;if(!Number.isSafeInteger(balance))return unavailable('projected_balance_invalid');points.push({date:day(today,i),balance:balance/100});}
 const low=Math.min(opening/100,...points.map(p=>p.balance));
 return {status:'current',reason:null,input_revision:sourceRevision,coverage:{status:'complete',scope_account_ids:[...selected].sort(),recurring_stream_count:resolved.size,category_target_count:(variableSpend.categories as any[]).filter(c=>Number(c.remaining)>0).length,recurring_complete:true,prepared_history_fresh:true},points,projected_low:low,low_date:points.find(p=>p.balance===low)?.date??today,ending_balance:points.at(-1)?.balance??null};
}
