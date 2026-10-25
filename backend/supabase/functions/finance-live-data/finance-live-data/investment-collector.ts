import {investmentObservation,estimateInvestmentPerformance} from './investment-estimate.ts';
type Row=Record<string,any>;
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const stable=(x:any)=>JSON.stringify(canonical(x));
const check=(r:any)=>{if(r?.error)throw new Error('Investment evidence storage unavailable');return r?.data;};
/** Caller must apply household release/worker gates before invoking this shared seam.
 * loadItems supplies already-authorized/decrypted native items; no token is persisted.
 */
export async function collectInvestmentHousehold(db:any,context:{householdId:string,userId:string},deps:{loadItems:()=>Promise<Row[]>,request:(item:Row,path:string,body:Row,deadline:number)=>Promise<{ok:boolean,data:Row}>,now?:()=>Date}):Promise<Row>{
 const clock=deps.now??(()=>new Date()),begin=check(await db.rpc('finance_begin_investment_collection',{p_household_id:context.householdId,p_user_id:context.userId}));
 if(begin?.status!=='collecting')return begin??{status:'unavailable'};
 const finish=(payload:Row)=>db.rpc('finance_finish_investment_collection',{p_household_id:context.householdId,p_user_id:context.userId,p_scan_id:begin.scan_id,p_payload:payload});
 try{
  const scope:Row[]=begin.source_scope;if(!Array.isArray(scope)||!scope.length||scope.length>50)throw new Error('source_scope_invalid');
  const items=await deps.loadItems(),observations:Row[]=[],activity:Row[]=[],itemEvidence:Row[]=[],deadline=Date.now()+60000;
  for(const itemId of [...new Set(scope.map(s=>s.item_id))]){
   const matches=items.filter(i=>i.item_id===itemId&&i.household_id===context.householdId);if(matches.length!==1)throw new Error('item_source_unavailable');const item=matches[0],accounts=scope.filter(s=>s.item_id===itemId),ids=accounts.map(s=>s.source_account_id).sort();
   const request=async(path:string,body:Row)=>{if(Date.now()>=deadline)throw new Error('collection_deadline');const result=await deps.request(item,path,{access_token:item.access_token,...body},deadline);if(!result.ok||!result.data||result.data.item?.item_id!==itemId)throw new Error('provider_source_unavailable');return result.data;};
   const holdings=async()=>{const r=await request('/investments/holdings/get',{options:{account_ids:ids}});if(!Array.isArray(r.accounts)||!Array.isArray(r.holdings)||!Array.isArray(r.securities)||ids.some(id=>r.accounts.filter((a:Row)=>a.account_id===id).length!==1)||r.holdings.some((h:Row)=>!ids.includes(h.account_id)))throw new Error('holdings_scope_unavailable');return r;};
   const before=await holdings();
   const scan=async()=>{const rows:Row[]=[],seen=new Set<string>();let expected:number|null=null,pages=0;
    for(let offset=0;pages<20;offset+=500){const r=await request('/investments/transactions/get',{start_date:begin.start_date,end_date:begin.end_date,options:{account_ids:ids,count:500,offset,async_update:false}}),total=r.total_investment_transactions,page=r.investment_transactions;pages++;
     if(!Number.isSafeInteger(total)||total<0||total>10000||!Array.isArray(page)||page.length>500||(expected!==null&&expected!==total)||page.length!==Math.min(500,total-offset))throw new Error('activity_pages_changed_or_incomplete');expected=total;
     for(const row of page){if(!row.investment_transaction_id||seen.has(row.investment_transaction_id)||!ids.includes(row.account_id)||typeof row.date!=='string'||row.date<begin.start_date||row.date>begin.end_date)throw new Error('activity_identity_or_scope_changed');seen.add(row.investment_transaction_id);rows.push(row);}
     if(rows.length===total)return{rows:rows.sort((a,b)=>String(a.investment_transaction_id).localeCompare(String(b.investment_transaction_id))),total,pages};
    }throw new Error('activity_page_limit');};
   const first=await scan(),second=await scan();if(stable(first.rows)!==stable(second.rows))throw new Error('activity_changed_between_complete_scans');
   const after=await holdings(),fingerprint=(r:Row)=>stable({accounts:r.accounts.filter((a:Row)=>ids.includes(a.account_id)).map((a:Row)=>({id:a.account_id,type:a.type,balances:a.balances})).sort((a:Row,b:Row)=>a.id.localeCompare(b.id)),holdings:[...r.holdings].sort((a:Row,b:Row)=>`${a.account_id}:${a.security_id}`.localeCompare(`${b.account_id}:${b.security_id}`))});
   if(fingerprint(before)!==fingerprint(after))throw new Error('valuation_changed_during_activity_scan');
   const observedAt=clock().toISOString();for(const mapping of accounts){const account=after.accounts.find((a:Row)=>a.account_id===mapping.source_account_id);observations.push({...investmentObservation(account,after.holdings.filter((h:Row)=>h.account_id===mapping.source_account_id),after.securities,observedAt),canonical_account_id:mapping.canonical_account_id});}
   activity.push(...second.rows);itemEvidence.push({item_id:itemId,source_account_ids:ids,start_date:begin.start_date,end_date:begin.end_date,provider_total:second.total,pages_read:first.pages+second.pages,complete:true,consistency:'two_equal_complete_scans_and_stable_valuation',request_ids:[],observed_at:observedAt});
  }
  return check(await finish({observations,activity,items:itemEvidence}));
 }catch(error){const message=error instanceof Error?error.message:'';const reason=/^(source_scope_invalid|item_source_unavailable|collection_deadline|provider_source_unavailable|holdings_scope_unavailable|activity_pages_changed_or_incomplete|activity_identity_or_scope_changed|activity_page_limit|activity_changed_between_complete_scans|valuation_changed_during_activity_scan)$/.test(message)?message:'collection_failed';try{await finish({failure:reason});}catch{}return{status:'unavailable',reason};}
}
export async function readInvestmentEstimate(db:any,context:{householdId:string,userId:string},scope:string[],startDate:string,endDate:string,now=new Date(),timeZone='UTC'):Promise<Row>{
 try{const shift=(day:string,n:number)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);const data=check(await db.rpc('finance_read_investment_collection',{p_household_id:context.householdId,p_user_id:context.userId,p_account_ids:scope,p_start_date:shift(startDate,-1),p_end_date:shift(endDate,1)}));return estimateInvestmentPerformance({...data,account_scope:scope,start_date:startDate,end_date:endDate,generated_at:now.toISOString(),timezone:timeZone});}
 catch{return{status:'unavailable',method:'observation_modified_dietz_v1',estimated:true,return_percent:null,investment_gain_cents:null,net_contributions_cents:null,series:[],reasons:['stored_investment_evidence_unavailable']};}
}
