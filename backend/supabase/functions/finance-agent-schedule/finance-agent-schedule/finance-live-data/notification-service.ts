import { NOTIFICATION_DEFAULTS, routeEvent, validPushSubscription, validatePreferences, notificationPayload } from './delivery-policy.ts';
import { currentPlanRiskEvents } from './agent-state.ts';
import { listAssistantMessages, listAssistantWatches } from './assistant-storage.ts';
import { matchAssistantWatch } from './assistant-watch-policy.ts';
type Row=Record<string,any>;
type Context={householdId:string;userId:string};
function check(result:any){if(result.error)throw new Error('Notification storage is temporarily unavailable.');return result.data;}
export async function notificationContext(db:any,c:Context){
 const [p,h]=await Promise.all([
  db.from('finance_notification_preferences').select('settings,updated_at').eq('household_id',c.householdId).eq('user_id',c.userId).maybeSingle(),
  db.from('finance_agent_deliveries').select('event_id,event_version,event_type,channel,status,severity,created_at,attempted_at,delivered_at,opened_at,available_at').eq('household_id',c.householdId).eq('user_id',c.userId).order('created_at',{ascending:false}).limit(200)
 ]);
 return {preferences:{...NOTIFICATION_DEFAULTS,...check(p)?.settings},updated_at:p.data?.updated_at||null,history:check(h)||[]};
}
export async function notificationOperation(action:string,body:Row,c:Context,db:any,listEvents:()=>Promise<any>){
 const scope=(query:any)=>query.eq('household_id',c.householdId).eq('user_id',c.userId);
 if(action==='get_notification_settings'){
  const context=await notificationContext(db,c);
  const devices=check(await scope(db.from('finance_push_subscriptions').select('subscription_id,installation_id,device_label,permission,enabled,created_at,last_success_at,last_failure_at')).order('created_at',{ascending:false}));
  return {preferences:context.preferences,devices};
 }
 if(action==='save_notification_settings'){
  if(!body.preferences||typeof body.preferences!=='object'||Array.isArray(body.preferences))throw new Error('Invalid preferences.');
  const patch=validatePreferences(body.preferences),old=check(await scope(db.from('finance_notification_preferences').select('settings')).maybeSingle());
  check(await db.from('finance_notification_preferences').upsert({household_id:c.householdId,user_id:c.userId,settings:{...old?.settings,...patch},updated_at:new Date().toISOString()},{onConflict:'household_id,user_id'}));
  return {saved:true,preferences:{...NOTIFICATION_DEFAULTS,...old?.settings,...patch}};
 }
 if(action==='save_push_subscription'){
  if(!validPushSubscription(body.subscription))throw new Error('Unsupported push subscription.');
  if(typeof body.installation_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.installation_id))throw new Error('Invalid device identity. Enable notifications again.');
  const sub=body.subscription;
  check(await db.rpc('save_finance_push_subscription',{p_household_id:c.householdId,p_user_id:c.userId,p_installation_id:body.installation_id,p_endpoint:sub.endpoint,p_p256dh:sub.keys.p256dh,p_auth:sub.keys.auth,p_device_label:String(body.device_label||'This device').slice(0,80)}));
  return {saved:true};
 }
 if(action==='remove_push_subscription'){
  if(typeof body.endpoint!=='string'&&typeof body.subscription_id!=='string')throw new Error('Choose a device.');
  let query=scope(db.from('finance_push_subscriptions').update({enabled:false,permission:body.permission==='denied'?'denied':'default',updated_at:new Date().toISOString()}));
  query=body.subscription_id?query.eq('subscription_id',body.subscription_id):query.eq('endpoint',body.endpoint);
  check(await query);return {saved:true};
 }
 if(action==='get_agent_event_detail'){
  if(typeof body.event_id!=='string'||!/^[0-9a-f-]{36}$/i.test(body.event_id))throw new Error('Invalid event.');
  const event=check(await db.from('finance_agent_events').select('event_id,event_version,event_type,title,summary,facts,recommended_actions,status,expires_at').eq('household_id',c.householdId).eq('event_id',body.event_id).maybeSingle());
  if(!event)return {event:null};
  if(event.event_type==='plan_at_risk'){
   const plan=check(await db.from('finance_household_plans').select('plan_id,version,status').eq('household_id',c.householdId).eq('plan_id',event.facts?.plan_id).maybeSingle());
   if(!plan||plan.status!=='active')return {event:null};
   const snapshot=check(await db.from('finance_agent_state_snapshots').select('state_version').eq('household_id',c.householdId).maybeSingle());
   const evaluation=snapshot?.state_version?check(await db.from('finance_plan_evaluations').select('plan_id,plan_version,snapshot').eq('household_id',c.householdId).eq('plan_id',plan.plan_id).eq('plan_version',plan.version).eq('financial_state_version',snapshot.state_version).maybeSingle()):null;
   const latest=evaluation?.snapshot?{...evaluation.snapshot,plan_version:evaluation.plan_version}:null;
   if(!currentPlanRiskEvents([event],[{...plan,latest}]).length)return {event:null};
  }
  const state=check(await scope(db.from('finance_agent_event_user_state').select('disposition,snoozed_until')).eq('event_id',event.event_id).maybeSingle());
  if(body.mark_opened===true){
   check(await scope(db.from('finance_agent_deliveries').update({opened_at:new Date().toISOString()})).eq('event_id',event.event_id));
   check(await db.from('finance_agent_deliveries').upsert({household_id:c.householdId,user_id:c.userId,event_id:event.event_id,event_version:event.event_version,event_type:event.event_type,severity:0,channel:'assistant_inbox',status:'sent',opened_at:new Date().toISOString()},{onConflict:'user_id,event_id,event_version,channel'}));
  }
  return {event:{...event,user_disposition:state?.disposition||null}};
 }
 if(action==='claim_agent_notifications'){
  const context=await notificationContext(db,c);
  if(!context.preferences.push_enabled)return {jobs:[]};
  const {events}=await listEvents();
  const jobs=[];
  const assistantEnabled=context.preferences.in_app_enabled!==false;
  let assistantWatches:any[]=[];
  let watchStates=new Map<string,any>();
  // Read the same owner-scoped watch set once. If this check is unavailable,
  // fail the generic event-push claim closed rather than sending a duplicate
  // alert for a commitment-owned issue.
  const allAssistantWatches=await listAssistantWatches(db,c);
  const committedIssueIds=new Set(allAssistantWatches.filter((watch:any)=>watch.template==='issue_follow_through'&&['active','snoozed'].includes(String(watch.status))).map((watch:any)=>String(watch.origin_event_id||watch.commitment?.origin?.event_id||watch.commitment?.origin_event_id||'')).filter((id:string)=>/^[0-9a-f-]{36}$/i.test(id)));
  if(assistantEnabled&&context.preferences.assistant_proactive_enabled!==true){
   try{
    assistantWatches=allAssistantWatches.filter((watch:any)=>['active','snoozed'].includes(String(watch.status)));
    const ids=events.map((event:any)=>event.event_id).filter((id:any)=>typeof id==='string');
    if(assistantWatches.length&&ids.length){
     const rows=check(await scope(db.from('finance_agent_event_user_state').select('event_id,disposition,snoozed_until').in('event_id',ids)));
     watchStates=new Map((Array.isArray(rows)?rows:[]).map((row:any)=>[String(row.event_id),row]));
    }
   }catch{assistantWatches=[];watchStates=new Map();}
  }
  for(const event of events){
   if(event.restored_in_app)continue;
   if(committedIssueIds.has(String(event.event_id)))continue; // A user-requested in-app restore never schedules another push.
   const decision=routeEvent(event,context.preferences,context.history);
   if(!decision.channels.includes('push')&&!decision.defer_until)continue;
   let messageId:string|null=null;
   const watchState=watchStates.get(String(event.event_id));
   const watchEvent={...event,user_snoozed_until:watchState?.snoozed_until||null,user_disposition:watchState?.disposition||event.user_disposition||null};
   const watchMatched=assistantWatches.some((watch:any)=>matchAssistantWatch(watch,watchEvent,new Date()));
   const assistantCandidate=assistantEnabled&&decision.channels.includes('assistant_inbox')&&(context.preferences.assistant_proactive_enabled===true||watchMatched);
   if(assistantCandidate){
    // Projection must already have committed the exact conversation row. If it
    // did not, defer this opted-in assistant push instead of making a broken link.
    try{
     const messages=await listAssistantMessages(db,c,{source:'event',event_id:event.event_id,limit:100});
     const exact=messages.find((message:any)=>Number(message.event_version)===Number(event.event_version)&&message.lifecycle==='active'&&message.source_key===`event:${event.event_id}:${Number(event.event_version)}`);
     if(!exact)continue;
     messageId=exact.message_id;
    }catch{continue;}
   }
   const claimed=check(await db.rpc('claim_finance_push',{p_household_id:c.householdId,p_user_id:c.userId,p_event_id:event.event_id,p_event_version:event.event_version,p_preferences_updated_at:context.updated_at,p_defer_until:decision.defer_until,p_reasons:decision.reason_codes}));
   if(claimed?.subscriptions){
    const payload={...notificationPayload(claimed.event),...(messageId?{message_id:messageId,deep_link:`/?folio_message=${encodeURIComponent(messageId)}&folio_event=${encodeURIComponent(claimed.event.event_id)}`}:{ }),badge_count:events.filter((e:any)=>(e.delivery_channels||[]).includes('assistant_inbox')).length};
    jobs.push({...claimed,payload});delete jobs[jobs.length-1].event;
   }
   if(jobs.length>=3)break;
  }
  return {jobs};
 }
 if(action==='complete_agent_notifications'){
  if(!Array.isArray(body.results)||body.results.length>10||body.results.some((r:Row)=>!r||!Number.isInteger(r.http_status)||r.http_status<0||r.http_status>599||typeof r.subscription_id!=='string'))throw new Error('Invalid delivery result.');
  const saved=check(await db.rpc('complete_finance_push',{p_household_id:c.householdId,p_user_id:c.userId,p_delivery_id:body.delivery_id,p_claim_token:body.claim_token,p_results:body.results}));
  return {saved};
 }
 throw new Error('Unsupported notification operation.');
}
