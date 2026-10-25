import {expandPreparedBudgetRows} from './allocation-budget-rows.ts';
type Row=Record<string,any>;
const cents=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<=1e-6?Math.round(v*100):null;
export function verifiedCurrentRefund(row:Row){
 const amount=cents(row.amount),currency=typeof row.iso_currency_code==='string'&&/^[A-Z]{3}$/.test(row.iso_currency_code)?row.iso_currency_code:null;
 if(typeof row.transaction_id!=='string'||!row.transaction_id||row.refund_relationship_type!=='refund'||!['matched','review','unmatched'].includes(row.refund_status))return null;
 const base={transaction_id:row.transaction_id,original_transaction_id:typeof row.refund_original_transaction_id==='string'?row.refund_original_transaction_id:null,date:row.effective_transaction_date,amount:amount!==null&&amount<0?-amount/100:null,currency,merchant:row.effective_merchant_name??null,refund_status:row.refund_status,relationship_type:'refund',source:row.refund_match_source??null,needs_review:row.refund_status==='review'};
 const unavailable={...base,effective_category:null,budget_applied:false,budget_applied_amount:null,budget_attribution:'unavailable',budget_allocations:[]};
 if(amount===null||amount>=0||!currency||typeof row.pending!=='boolean'||typeof row.excluded_from_totals!=='boolean'||typeof row.category_excluded_from_budget!=='boolean'||typeof row.transaction_excluded_from_budget!=='boolean')return unavailable;
 const proof=expandPreparedBudgetRows([row]);if(!proof.available)return unavailable;
 const eligible=row.refund_status==='matched'&&row.pending===false&&row.effective_type==='expense'&&currency==='USD'&&row.excluded_from_totals===false&&row.transaction_excluded_from_budget===false;
 const allocations=proof.rows.filter(child=>child.amount<0).map(child=>({category:typeof child.effective_category==='string'?child.effective_category:null,subcategory:child.effective_subcategory??null,amount:-child.amount,budget_applied:eligible&&child.category_excluded_from_budget===false}));
 if(allocations.some(child=>!child.category))return unavailable;
 const applied=allocations.filter(child=>child.budget_applied).reduce((sum,child)=>sum+Math.round(child.amount*100),0);
 if(!Number.isSafeInteger(applied)||applied<0||applied>-amount)return unavailable;
 const distinct=[...new Set(allocations.map(child=>child.category))];
 return{...base,effective_category:distinct.length===1?distinct[0]:null,budget_applied:applied===-amount,budget_applied_amount:applied/100,budget_attribution:applied===0?'not_applied':applied===-amount?'full':'partial',budget_allocations:allocations};
}
export async function loadRefundActivityEvidence(db:any,c:{householdId:string;userId:string},transactionIds:string[]|null=null){
 const unavailable={available:false,rows:[] as Row[],summary:null as Row|null};
 try{const {data,error}=await db.rpc('finance_get_refund_activity_evidence',{p_household_id:c.householdId,p_user_id:c.userId,p_transaction_ids:transactionIds});
 if(error||data?.household_id!==c.householdId||data.actor_user_id!==c.userId||data.source!=='current_bank_parent_and_composed_split_proof'||!Array.isArray(data.rows)||data.rows.length>50)return unavailable;
 const seen=new Set<string>(),rows:Row[]=[];for(const raw of data.rows){if(seen.has(raw.transaction_id)||transactionIds&&!transactionIds.includes(raw.transaction_id))return unavailable;seen.add(raw.transaction_id);const row=verifiedCurrentRefund(raw);if(!row)return unavailable;rows.push(row);}
 const matched=rows.filter(row=>row.refund_status==='matched'),byCurrency:Row={};let amountCoverage=true;
 for(const row of matched){if(!row.currency||row.amount===null){amountCoverage=false;continue;}const sum=(byCurrency[row.currency]??0)+Math.round(row.amount*100);if(!Number.isSafeInteger(sum)){amountCoverage=false;continue;}byCurrency[row.currency]=sum;}
 return{available:true,rows,summary:{scope:transactionIds?'selected_refund_records':'latest_50_refund_records',period_start:rows.map(r=>r.date).filter(Boolean).sort()[0]??null,period_end:rows.map(r=>r.date).filter(Boolean).sort().at(-1)??null,matched_count:matched.length,matched_amount_by_currency:amountCoverage?Object.fromEntries(Object.entries(byCurrency).map(([currency,value])=>[currency,Number(value)/100])):null,amount_coverage:amountCoverage?'complete':'unavailable',budget_attribution_complete:rows.every(r=>r.budget_attribution!=='unavailable'),needs_review_count:rows.filter(r=>r.needs_review).length,truncated:rows.length>=50}};
 }catch{return unavailable;}
}
// Historical event identity/time is preserved; economic statements are current verified facts.
export function verifiedRefundActivity(events:Row[],refunds:Row[]){
 const byId=new Map(refunds.filter(r=>r.refund_status==='matched').map(r=>[r.transaction_id,r]));
 return events.filter(event=>byId.has(event.facts?.transaction_id)).map(event=>{const row=byId.get(event.facts.transaction_id)!;return{...row,event_id:event.event_id,created_at:event.created_at,title:'Refund matched',summary:row.budget_attribution==='full'?'The refund is reflected in its verified budget categories.':row.budget_attribution==='partial'?'Part of this refund is reflected in budget categories.':row.budget_attribution==='not_applied'?'This refund is not applied to budget spending.':'Budget attribution is unavailable.',attribution_basis:'current_verified_refund'};});
}
