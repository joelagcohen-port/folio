type Row=Record<string,any>;
type Context={householdId:string;userId:string};

export function classifyReconciliationFailure(error:unknown){
 const value=error as Row,code=String(value?.code||value?.status||'').toUpperCase(),message=String(value?.message||error||'').toLowerCase();
 if(['408','429','502','503','504'].includes(code))return{retryable:true,code:`http_${code}`};
 if(['400','401','403','404','422'].includes(code))return{retryable:false,code:`http_${code}`};
 if(/^(42501|23514|23503|22[A-Z0-9]{3}|PGRST20[0-9])$/.test(code)||/permission denied|invalid input|does not exist|schema cache|constraint violation|unauthorized|forbidden/.test(message))return{retryable:false,code:code||'refresh_permanent'};
 if(/^(08[A-Z0-9]{3}|40P01|53300|55P03|57014|57P01|57P02|57P03)$/.test(code)||/fetch failed|network|timed? ?out|timeout|connection reset|temporarily unavailable|bad gateway|service unavailable|gateway timeout/.test(message))return{retryable:true,code:code||'refresh_transient'};
 return{retryable:false,code:code||'refresh_unclassified'};
}

/** Retry only the identical, database-idempotent mutation ticket. */
export async function retryIdempotentMutation<T>(operation:()=>Promise<{data:T;error?:unknown}>,delay:(ms:number)=>Promise<void>=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))){
 let last:unknown;
 for(let attempt=0;attempt<3;attempt++){
  let result:{data:T;error?:unknown}|undefined;
  try{result=await operation();}catch(error){last=error;}
  if(result&&!result.error)return result.data;
  if(result?.error)last=result.error;
  const classification=classifyReconciliationFailure(last);
  if(!classification.retryable||attempt===2)throw last;
  await delay(attempt===0?150:450);
 }
 throw last;
}

export async function pendingAutonomyReconciliations(db:any,householdId:string,now=new Date().toISOString()){
 const {data,error}=await db.from('finance_autonomy_reconciliation').select('action_id,attempts,created_at,next_attempt_at').eq('household_id',householdId).eq('status','pending').lte('next_attempt_at',now).order('created_at',{ascending:true}).limit(100);
 if(error)throw error;
 return(Array.isArray(data)?data:[]).filter((row:Row)=>Number.isInteger(row.attempts)&&row.attempts<6);
}

export async function completeAutonomyReconciliation(db:any,householdId:string,row:Row,refreshStartedAt:string,result:{success:boolean;retryable?:boolean;errorCode?:string}){
 const {data,error}=await db.rpc('complete_finance_autonomy_reconciliation',{p_household_id:householdId,p_action_id:row.action_id,p_refresh_started_at:refreshStartedAt,p_expected_attempts:row.attempts,p_success:result.success,p_retryable:result.retryable===true,p_error_code:result.errorCode||null});
 if(error)throw error;
 return data;
}

/**
 * Refresh one explicit batch captured before the refresh began. Actions enqueued
 * while refreshing remain pending for the next pass. The batch is read-only;
 * the authoritative database mutation already committed with its audit row.
 */
export async function reconcileAutonomyRefreshBatch(db:any,context:Context,refreshAgentState:(context:Context)=>Promise<unknown>,now=new Date()){
 const startedAt=now.toISOString(),rows=await pendingAutonomyReconciliations(db,context.householdId,startedAt);
 if(!rows.length)return{processed:0,completed:0,needs_review:0,refresh_error:null};
 let failure:unknown=null;
 try{await refreshAgentState(context);}catch(error){failure=error;}
 const classified=failure?classifyReconciliationFailure(failure):null;let completed=0,needsReview=0;
 for(const row of rows){
  try{const result=await completeAutonomyReconciliation(db,context.householdId,row,startedAt,failure?{success:false,retryable:classified!.retryable,errorCode:classified!.code}:{success:true});if(result?.status==='complete')completed++;if(result?.status==='needs_review')needsReview++;}
  catch{/* Keep the durable queue row pending when outcome persistence is unavailable. */}
 }
 return{processed:rows.length,completed,needs_review:needsReview,refresh_error:failure?classified?.code:null};
}

/** Read one post-mutation queue item, refresh, and settle only that item. */
export async function reconcileAutonomyActionRefresh(db:any,context:Context,auditId:string,refreshAgentState?:((context:Context)=>Promise<unknown>)){
 if(!refreshAgentState||!auditId)return{status:'pending'};
 const {data,error}=await db.from('finance_autonomy_reconciliation').select('action_id,attempts,created_at,next_attempt_at').eq('household_id',context.householdId).eq('action_id',auditId).eq('status','pending').maybeSingle();
 if(error||!data||!Number.isInteger(data.attempts)||data.attempts>=6||Date.parse(String(data.next_attempt_at||''))>Date.now())return{status:'pending'};
 const startedAt=new Date().toISOString();
 try{await refreshAgentState(context);}
 catch(refreshError){const classified=classifyReconciliationFailure(refreshError);try{return await completeAutonomyReconciliation(db,context.householdId,data,startedAt,{success:false,retryable:classified.retryable,errorCode:classified.code});}catch{return{status:'pending',persistence_error:true};}}
 // If durable completion fails, leave the job pending and do not report success.
 try{return await completeAutonomyReconciliation(db,context.householdId,data,startedAt,{success:true});}catch{return{status:'pending',persistence_error:true};}
}
