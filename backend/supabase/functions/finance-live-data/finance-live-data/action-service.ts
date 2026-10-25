type Row=Record<string,any>;
type Context={householdId:string;userId:string};
import {MANUAL_ACTION_POLICY,classifyActionRisk} from './action-risk.ts';
export const ACTION_POLICY=MANUAL_ACTION_POLICY;
// Keep the legacy exported name while routing every risk decision through the
// shared classifier used by live maintenance and the preview catalogue.
export function classifyAutonomyPreviewRisk(actionType:string,candidate:Record<string,any>):'low'|'medium'|'high'{
 return classifyActionRisk(actionType,candidate);
}
function checked(r:any){if(r.error)throw new Error(r.error.message||'Action storage unavailable.');return r.data;}
export async function agentActionOperation(db:any,c:Context,operation:string,body:Row){
 if(operation==='claim_agent_action')return checked(await db.rpc('claim_finance_agent_action',{p_household_id:c.householdId,p_user_id:c.userId,p_action_id:body.action_id,p_confirm:body.confirm===true}));
 if(operation==='finish_agent_action')return {saved:checked(await db.rpc('finish_finance_agent_action',{p_household_id:c.householdId,p_user_id:c.userId,p_action_id:body.action_id,p_claim_token:body.claim_token,p_status:body.status,p_outcome:{message:String(body.message||'').slice(0,200)}}))};
 if(operation!=='prepare_agent_action')throw new Error('Unsupported action operation.');
 const type=String(body.action_type),policy=ACTION_POLICY[type];if(!policy)throw new Error('This action is not supported.');
 let event:Row|null=null;
 if(body.event_id){
  event=checked(await db.from('finance_agent_events').select('*').eq('household_id',c.householdId).eq('event_id',body.event_id).maybeSingle());
  if(!event||!['new','surfaced'].includes(event.status)||Date.parse(event.expires_at)<=Date.now()||body.event_version!==undefined&&Number(body.event_version)!==event.event_version)throw new Error('Things changed since this recommendation. Review a new suggestion.');
  const user=checked(await db.from('finance_agent_event_user_state').select('*').eq('household_id',c.householdId).eq('user_id',c.userId).eq('event_id',event.event_id).maybeSingle());
  if(user&&['acted','acknowledged','dismissed','expected','wrong'].includes(user.disposition))throw new Error('This insight was already handled.');
 }
 if(type!=='reallocate_budget'&&!event)throw new Error('Choose a current household insight.');
 if(type==='refresh_accounts'&&event?.event_type!=='account_sync_issue')throw new Error('This is not a connection issue.');
 const preference=checked(await db.from('finance_notification_preferences').select('settings').eq('household_id',c.householdId).eq('user_id',c.userId).maybeSingle());
 if(preference?.settings?.autonomy_level==='recommend'&&policy.risk!=='low')throw new Error('Recommend only is enabled. Make this change in Budget or choose Ask before acting.');
 let payload:Row={},label='',revision=null;
 if(type==='reallocate_budget'){
  const candidate=event?.recommended_actions?.find((a:Row)=>a.action_type==='reallocate_budget');
  if(event&&!candidate)throw new Error('This insight no longer recommends a budget transfer.');
  const request=event?candidate.payload:body.payload;
  if(!request||typeof request.amount!=='number'||!Number.isFinite(request.amount)||request.amount<=0||request.amount>1e9||Math.abs(request.amount*100-Math.round(request.amount*100))>.00001)throw new Error('Choose a valid budget amount.');
  const before=checked(await db.rpc('finance_action_revision',{p_household_id:c.householdId}));
  const targets=checked(await db.from('finance_budget_targets').select('*').eq('household_id',c.householdId).eq('active',true));
  const from=targets.find((t:Row)=>t.budget_target_id===request.from_budget_target_id),to=targets.find((t:Row)=>t.budget_target_id===request.to_budget_target_id);
  if(!from||!to||from.budget_target_id===to.budget_target_id||from.currency_code!=='USD'||to.currency_code!=='USD'||request.amount>Number(from.monthly_target_amount))throw new Error('Choose two current USD budgets with enough allocation.');
  payload={from_budget_target_id:from.budget_target_id,to_budget_target_id:to.budget_target_id,expected_from_target:Number(from.monthly_target_amount),expected_to_target:Number(to.monthly_target_amount),amount:request.amount};
  revision=checked(await db.rpc('finance_action_revision',{p_household_id:c.householdId}));if(revision!==before)throw new Error('Financial data changed. Review a new suggestion.');
  label=`Move $${request.amount.toFixed(2)} from ${from.category} to ${to.category}`;
 }else if(type==='refresh_accounts'){
  payload={refresh:true};label='Refresh connected accounts';
 }else{
  if(type==='acknowledge_recurring_change'&&!['recurring_amount_change','income_materially_different'].includes(event!.event_type))throw new Error('This is not a recurring change.');
  const feedback={acknowledge_recurring_change:'expected',acknowledge_change:'acknowledged',dismiss_event:'dismissed',snooze_event:'snoozed'}[type];
  payload={event_id:event!.event_id,feedback,...(type==='snooze_event'?{snooze_days:7}:{})};
  label={acknowledge_recurring_change:'Mark this change as expected',acknowledge_change:'Acknowledge this change',dismiss_event:'Dismiss this insight',snooze_event:'Snooze for one week'}[type]||'';
 }
 const action=checked(await db.from('finance_agent_actions').insert({household_id:c.householdId,user_id:c.userId,event_id:event?.event_id||null,event_version:event?.event_version||null,action_type:type,payload,label,risk_level:policy.risk,requires_confirmation:policy.confirmation,financial_revision:revision}).select('action_id,event_id,event_version,action_type,label,risk_level,requires_confirmation,expires_at').single());
 return {action};
}
