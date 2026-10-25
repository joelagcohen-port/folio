import {callFolioOperation,isRecord} from './folio-server.ts';
import {guidedBudgetReallocationAction} from './folio-experience.ts';
export async function prepareAgentAction(args:Record<string,unknown>,authorization:string){
 return callFolioOperation('prepare_agent_action',args,authorization,{timeoutMs:30000,retry:false});
}
export async function executeAgentAction(args:Record<string,unknown>,authorization:string){
 const claim=await callFolioOperation('claim_agent_action',{action_id:args.action_id,confirm:args.confirm===true},authorization,{retry:false});
 if(!claim.ok)return claim;
 const data=claim.data as any;if(data.already_applied)return {ok:true,status:200,data:{saved:true,already_applied:true}};
 const action=data.action;if(!action||!data.claim_token)return {ok:false,status:409,data:{error:'This recommendation is no longer available.'}};
 let result;
 try{
  result=action.action_type==='reallocate_budget'
   ?await guidedBudgetReallocationAction('guided_budget_reallocation_commit',{...action.payload,confirm:true},authorization)
   :action.action_type==='refresh_accounts'
   ?await callFolioOperation('sync_transactions',{refresh:true},authorization,{timeoutMs:75000,retry:false})
   :await callFolioOperation('feedback_agent_event',action.payload,authorization,{retry:false});
 }catch{result={ok:false,status:504,data:{error:'The result could not be confirmed. Refresh before trying again.'}};}
 if(result.ok&&action.action_type==='refresh_accounts'&&isRecord(result.data)){
  const detail=result.data;
  if(Number(detail.sync_failed)>0||Number(detail.refresh_unsupported)>0||Array.isArray(detail.sync_warnings)&&detail.sync_warnings.length>0||Array.isArray(detail.refresh_warnings)&&detail.refresh_warnings.length>0)
   result={ok:false,status:409,data:{error:'The refresh finished with connection issues. Review Accounts to reconnect; this insight remains open.'}};
 }
 const refreshPending=result.ok&&action.action_type==='refresh_accounts'&&isRecord(result.data)&&(result.data.queued===true||result.data.pending===true);
 const outcome=await callFolioOperation('finish_agent_action',{action_id:action.action_id,claim_token:data.claim_token,status:result.ok?'succeeded':result.status>=500?'uncertain':'failed',message:refreshPending?'Bank refresh requested. Track completion in Accounts; connection recovery is not yet confirmed.':result.ok?'Action completed':'Action failed or needs reconciliation'},authorization,{retry:false});
 if(!result.ok)return result;
 // Mutation success is authoritative even if recording the outcome fails. Never
 // repeat it automatically. Failed/unknown execution leaves the event unresolved.
 const warning=outcome.ok&&isRecord(outcome.data)&&outcome.data.saved===true?null:'The request finished, but its action status could not be verified. Refresh to reconcile.';
 return {ok:true,status:200,data:{saved:true,actionCompleted:true,refreshPending,action_type:action.action_type,warning,result:result.data}};
}
