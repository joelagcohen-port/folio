import {verifiedDatedSnapshot} from './forecast-series.ts';
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const amount=(value:any)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const cents=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&Number.isSafeInteger(Math.round(value*100))&&Math.abs(value*100-Math.round(value*100))<=Number.EPSILON*Math.max(1,Math.abs(value*100))*2?Math.round(value*100):null;
const same=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export function cashScopeEvidence(envelope:any,identity:{householdId:string;userId:string;planId:string;timezone:string;today:string},now=Date.now(),fundingProjection:any=null){
 const {householdId,userId,planId,timezone,today}=identity,plan=envelope?.plan;
 if(envelope?.household_id!==householdId||envelope?.actor_user_id!==userId||plan?.household_id!==householdId||plan?.plan_id!==planId||plan?.plan_type!=='cash_floor'||!Number.isSafeInteger(plan.version)||!Array.isArray(envelope.accounts))throw new Error('Unverified scope evidence');
 const scope=plan.cash_account_scope,all=scope?.mode==='all_cash_accounts'&&Object.keys(scope).length===1,fixed=scope?.mode==='selected_accounts'&&Object.keys(scope).length===2&&Array.isArray(scope.canonical_account_ids)&&scope.canonical_account_ids.length>0&&scope.canonical_account_ids.length<=100&&scope.canonical_account_ids.every((id:any)=>typeof id==='string'&&idPattern.test(id))&&new Set(scope.canonical_account_ids).size===scope.canonical_account_ids.length;
 const accounts=envelope.accounts,eligible=accounts.filter((a:any)=>a.type==='depository'&&a.lifecycle_status==='active'&&a.connection_status==='connected'&&a.match_status!=='review_required'&&idPattern.test(a.canonical_account_id));
 const ids:string[]=all?eligible.map((a:any)=>a.canonical_account_id):fixed?[...scope.canonical_account_ids]:[];
 const missing=ids.filter(id=>eligible.filter((a:any)=>a.canonical_account_id===id).length!==1),rows=eligible.filter((a:any)=>ids.includes(a.canonical_account_id));
 const validScope=(all||fixed)&&ids.length>0&&new Set(ids).size===ids.length&&missing.length===0;
 const result:any={household_id:householdId,actor_user_id:userId,plan_id:planId,plan_version:plan.version,scope:scope??null,canonical_account_ids:[...ids].sort(),missing_account_ids:missing,timezone,today,checked_at:new Date(now).toISOString(),current:{status:'unavailable',amount:null,currency:null,source_as_of:null,reason:'scope_unavailable'},forecast:{status:'unavailable',projected_low:null,points:[],reason:'scope_unavailable'}};
 if(!validScope)return result;
 const fresh=(a:any)=>cents(a.current_balance)!==null&&Number.isFinite(Date.parse(a.balance_updated_at))&&now-Date.parse(a.balance_updated_at)>=0&&now-Date.parse(a.balance_updated_at)<=36*3600000;
 const currencies=new Set(rows.map((a:any)=>a.balance_currency_code));
 if(currencies.size!==1||!currencies.has('USD')){result.current.reason='currency_unavailable';return result;}
 if(!rows.every(fresh)){result.current.reason='balance_stale_or_missing';return result;}
 const totalCents=rows.reduce((sum:number,a:any)=>sum+cents(a.current_balance)!,0),cash=totalCents/100;
 if(!Number.isSafeInteger(totalCents)){result.current.reason='balance_amount_invalid';return result;}
 result.current={status:'current',amount:cash,currency:'USD',source_as_of:rows.map((a:any)=>a.balance_updated_at).sort()[0],reason:null};
 const fullCash=accounts.filter((a:any)=>a.type==='depository'&&a.lifecycle_status!=='closed');
 if(!same(ids,fullCash.map((a:any)=>a.canonical_account_id))){
   const proof=fundingProjection?.identity;
   if(fundingProjection?.status!=='current'||fundingProjection?.coverage?.status!=='complete'||proof?.household_id!==householdId||proof?.actor_user_id!==userId||proof?.plan_id!==planId||proof?.plan_version!==plan.version||proof?.timezone!==timezone||proof?.today!==today||!same(proof?.canonical_account_ids??[],ids)){result.forecast.reason=fundingProjection?.reason??'account_attribution_unavailable';return result;}
   result.forecast={status:'current',reason:null,currency:'USD',horizon_days:fundingProjection.horizon_days,projected_low:fundingProjection.projected_low,low_date:fundingProjection.low_date,ending_balance:fundingProjection.ending_balance,points:fundingProjection.points,input_revision:fundingProjection.input_revision,source_as_of:result.current.source_as_of,attribution:fundingProjection.coverage};return result;
 }
 const payload=envelope.planning,snapshot=payload?.snapshot,inputs=snapshot?.source_provenance?.forecast_inputs;
 if(payload?.current_for_forecast!==true||snapshot?.input_quality!=='complete'||snapshot.horizon_days!==30||inputs?.timezone!==timezone||inputs?.cash_scope_currency!=='USD'||inputs?.cash_scope_currency_verified!==true||payload?.refresh?.needs_recompute===true){result.forecast.reason='forecast_not_current_or_currency_unverified';return result;}
 const generated=Date.parse(snapshot.generated_at);
 if(typeof snapshot.input_revision!=='string'||!snapshot.input_revision.trim()||!Number.isFinite(generated)||generated>now||now-generated>48*3600000){result.forecast.reason='forecast_provenance_unverified';return result;}
 const states=snapshot.account_states,points=snapshot.points;
 const currentStates=accounts.filter((a:any)=>['depository','credit'].includes(a.type)&&a.lifecycle_status!=='closed');
 const key=(a:any)=>[a.canonical_account_id,a.account_id,a.type,a.lifecycle_status].join('|');
 if(!Array.isArray(states)||!same(states.map(key),currentStates.map(key))||states.filter((a:any)=>a.type==='depository').some((a:any)=>!rows.some((r:any)=>r.canonical_account_id===a.canonical_account_id&&r.account_id===a.account_id&&r.current_balance===a.balance&&r.balance_updated_at===a.balance_updated_at))){result.forecast.reason='forecast_scope_changed';return result;}
 const sourceStates=inputs.cash_scope_source_states;
 if(!Array.isArray(sourceStates)||!same(sourceStates.map(key),currentStates.map(key))||sourceStates.some((a:any)=>!currentStates.some((r:any)=>key(a)===key(r)&&a.current_balance===r.current_balance&&a.balance_updated_at===r.balance_updated_at))){result.forecast.reason='forecast_scope_changed';return result;}
 const verified=verifiedDatedSnapshot(snapshot);
 if(!verified||snapshot.starting_balance!==cash){result.forecast.reason='forecast_series_unverified';return result;}
 result.forecast={status:'current',reason:null,currency:'USD',horizon_days:30,projected_low:snapshot.projected_low,low_date:verified.low_date,points,source_as_of:result.current.source_as_of,input_revision:snapshot.input_revision,generated_at:snapshot.generated_at,source_provenance:snapshot.source_provenance?.sources??[]};return result;
}
