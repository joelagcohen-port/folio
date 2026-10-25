import {runRolloverBoundary,refreshWithRolloverBoundary} from './rollover-boundary.ts';
import {notificationOperation,notificationContext} from './notification-service.ts';
import {validPushSubscription} from './delivery-policy.ts';
import {getFolioPublicOrigin,sendPushJobs} from './push-delivery.ts';
import {scheduledTriggers,weeklyReviewSummary} from './schedule-policy.ts';
import {runAssistantScheduleForMember} from './assistant-schedule.ts';
import {projectAssistantEvents} from './assistant-projection.ts';
import {runAutonomyMaintenance} from './autonomy-service.ts';
import {reconcileAutonomyRefreshBatch} from './autonomy-reconciliation.ts';
import {runAssistantCommitmentsAfterRefresh} from './assistant-due-dispatch.ts';
function checked(r:any){if(r.error)throw new Error('Scheduled storage unavailable');return r.data;}
/** Coalesced, update-triggered chat projection after a durable verified forecast refresh. */
export async function runAssistantProjectionUpdate(db:any,householdId:string,sourceKey:string,deps:any,now=new Date()){
 if(!/^[0-9a-f-]{36}$/i.test(householdId)||!/^assistant-refresh:[0-9a-f-]{36}:g[0-9]{1,12}$/i.test(sourceKey))throw new Error('Invalid assistant projection trigger');
 const claim=checked(await db.rpc('claim_finance_agent_run',{p_household_id:householdId,p_key:sourceKey,p_trigger:'assistant_projection'}));
 if(!claim)return{status:'deduplicated',projected:0};
 try{
  const members=checked(await db.from('finance_household_members').select('household_id,user_id,role').eq('household_id',householdId).order('user_id').limit(100));
  if(!Array.isArray(members)||members.length>100)throw new Error('Assistant projection owner set is unavailable');
  if(!members.length){checked(await db.from('finance_agent_schedule_runs').update({status:'succeeded',finished_at:now.toISOString(),metrics:{projected:0}}).eq('household_id',householdId).eq('run_key',sourceKey));return{status:'completed',projected:0};}
  const owner=members.find((member:any)=>member.role==='owner')||members[0],ownerContext={householdId,userId:owner.user_id};
  // The recurring worker already completed canonical refresh + rollover work.
  // This follow-through pass is evaluation-only and must not mutate plans or
  // re-run maintenance while checking actor-owned issue commitments.
  await deps.refreshAgentState(ownerContext);
  let projected=0;
  for(const member of members){
   const context={householdId,userId:member.user_id};
   const [settings,eventResult]=await Promise.all([notificationContext(db,context),deps.listAgentEvents(context)]);
   const events=Array.isArray(eventResult?.events)?eventResult.events:null;
   if(!events)throw new Error('Canonical Assistant projection events are unavailable');
   if(settings.preferences.in_app_enabled!==false){const outcomes=await runAssistantCommitmentsAfterRefresh(db,context,{refreshAgentState:async()=>{}},now);if(outcomes.failed)console.warn('Some issue-bound Assistant checks need another bounded attempt',{failed:outcomes.failed});}
   const result=await projectAssistantEvents(db,context,events,settings.preferences,now,{dailyCheckDue:false});
   projected+=Number(result.created)||0;
  }
  checked(await db.from('finance_agent_schedule_runs').update({status:'succeeded',finished_at:now.toISOString(),metrics:{projected,llm_calls:0,source:'verified_forecast_refresh'}}).eq('household_id',householdId).eq('run_key',sourceKey));
  return{status:'completed',projected};
 }catch(error){
  await db.from('finance_agent_schedule_runs').update({status:'failed',finished_at:now.toISOString(),metrics:{error:'assistant_projection_update_failed',llm_calls:0}}).eq('household_id',householdId).eq('run_key',sourceKey);
  throw error;
 }
}
export async function runAgentSchedule(db:any,deps:any,now=new Date()){
 const {refreshAgentState:rawRefreshAgentState,listAgentEvents,getAgentState,buildPushPayload,loadMemories,loadFinancialState}=deps;
 const refreshAssistantEvidenceOnly=deps.refreshAssistantEvidenceOnly||rawRefreshAgentState,assistantRefreshedHouseholds=new Set<string>();
 const refreshAgentState=(context:any)=>refreshWithRolloverBoundary(db,context,rawRefreshAgentState);
 const members=checked(await db.from('finance_household_members').select('household_id,user_id,role').order('household_id').limit(100));
 const groups=new Map<string,any[]>();for(const member of members){const rows=groups.get(member.household_id)||[];rows.push(member);groups.set(member.household_id,rows);}
 const totals={evaluated:0,pushed:0,failed:0,archived:0,automatic_executed:0,automatic_blocked:0,llm_calls:0,assistant_messages:0};
 const refreshedHouseholds=new Set<string>();
 for(const [householdId,users] of groups){
  await runRolloverBoundary(db,householdId);
  const owner=users.find(u=>u.role==='owner')||users[0],context={householdId,userId:owner.user_id};
  // Optional collection is gated per household; its SQL begin/finish also gate in-transaction.
  if(deps.collectDailyInvestmentEvidence)try{await deps.collectDailyInvestmentEvidence(context);}catch{/* Keep ordinary legacy schedule work running. */}
  // Recovery runs on every worker invocation, independent of daily/weekly
  // notification gates. It refreshes only when durable jobs are due.
  try{const reconciliation=await reconcileAutonomyRefreshBatch(db,context,refreshAgentState,now);if(reconciliation.processed>0&&!reconciliation.refresh_error)refreshedHouseholds.add(householdId);if(reconciliation.refresh_error)console.warn('Folio state recovery needs another attempt',reconciliation.refresh_error);}
  catch{console.warn('Folio state recovery could not be checked');}
  // One complete evaluation per due trigger, then route separately for each user.
  for(const trigger of scheduledTriggers(now)){
   const claim=checked(await db.rpc('claim_finance_agent_run',{p_household_id:householdId,p_key:trigger.key,p_trigger:trigger.type}));if(!claim)continue;
   try{
    await refreshAgentState(context);
    refreshedHouseholds.add(householdId);
    totals.evaluated++;
    if(trigger.type!=='weekly')try{const automatic=await runAutonomyMaintenance(db,context,{refreshAgentState,loadMemories,loadFinancialState});totals.automatic_executed+=automatic.executed||0;totals.automatic_blocked+=automatic.blocked||0;}catch{/* Automatic maintenance failures must not interrupt ordinary Folio updates. */}
    if(trigger.type==='weekly')for(const user of users){
     const c={householdId,userId:user.user_id},delivery=await notificationContext(db,c);if(!delivery.preferences.weekly_review)continue;
     const result=await getAgentState(c),state=result.agent_state;
     const feedback=checked(await db.from('finance_agent_event_feedback').select('event_type,feedback').eq('household_id',householdId).eq('actor_user_id',user.user_id).gte('created_at',new Date(now.getTime()-7*86400000).toISOString()).limit(100));
     const summary=weeklyReviewSummary(result.events,feedback,state.active_goals,state.current_forecast_summary);
     if(summary.events.length||summary.resolved.length)checked(await db.from('finance_agent_weekly_reviews').upsert({household_id:householdId,user_id:user.user_id,week:trigger.key.slice(7),summary},{onConflict:'household_id,user_id,week'}));
    }
    checked(await db.from('finance_agent_schedule_runs').update({status:'succeeded',finished_at:new Date().toISOString(),metrics:{llm_calls:0,automatic_evaluated:totals.evaluated,automatic_executed:totals.automatic_executed,automatic_blocked:totals.automatic_blocked}}).eq('household_id',householdId).eq('run_key',trigger.key));
   }catch{totals.failed++;await db.from('finance_agent_schedule_runs').update({status:'failed',finished_at:new Date().toISOString(),metrics:{error:'evaluation_failed',llm_calls:0}}).eq('household_id',householdId).eq('run_key',trigger.key);}
  }
  for(const user of users){
   const c={householdId,userId:user.user_id};
   try{
    try{
     const assistant=await runAssistantScheduleForMember(db,c,{
      refreshAgentState:async()=>{if(!assistantRefreshedHouseholds.has(householdId)){await refreshWithRolloverBoundary(db,context,refreshAssistantEvidenceOnly);assistantRefreshedHouseholds.add(householdId);}},
      listAgentEvents,getAgentState,weeklyReviewSummary,
     },now);
     totals.assistant_messages+=assistant.projected||0;
    }catch{totals.failed++;}
    const settings=await notificationContext(db,c);
    // Phase 4A is preview-only: legacy housekeeping preferences must never
    // archive insights or write action tickets automatically.
    if(!settings.preferences.push_enabled)continue;
    const keys=checked(await db.rpc('finance_agent_push_keys'));if(!keys?.privateKey||!keys?.publicKey)throw new Error('Push signing unavailable');
    const batch=await notificationOperation('claim_agent_notifications',{},c,db,()=>listAgentEvents(c));
    const result=await sendPushJobs(batch.jobs||[],{...keys,subject: getFolioPublicOrigin()},buildPushPayload,(args:any)=>notificationOperation('complete_agent_notifications',args,c,db,()=>listAgentEvents(c)),validPushSubscription);
    totals.pushed+=result.sent;totals.failed+=result.failed;
   }catch{totals.failed++;}
  }
 }
 console.info('Folio scheduled check',totals);return totals;
}
