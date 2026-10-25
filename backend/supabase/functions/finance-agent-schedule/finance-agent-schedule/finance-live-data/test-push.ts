import {getFolioPublicOrigin,sendPushJobs} from './push-delivery.ts';
import {validPushSubscription} from './delivery-policy.ts';
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function checked(r:any){if(r.error)throw new Error('Test notification storage unavailable.');return r.data;}
// Called only AFTER the scheduler's service-secret authentication. No browser
// API exposes this operation. Explicitly targets one opted-in user's device.
export async function sendTestPush(db:any,body:any,buildPayload:any){
 if(!['household_id','user_id','subscription_id','request_id'].every(k=>uuid(body[k])))throw new Error('A household, user, device and unique request ID are required.');
 const {household_id:household,user_id:user,subscription_id:device,request_id:requestId}=body;
 const member=checked(await db.from('finance_household_members').select('user_id').eq('household_id',household).eq('user_id',user).maybeSingle());
 if(!member)throw new Error('Household membership required.');
 const preferences=checked(await db.from('finance_notification_preferences').select('settings').eq('household_id',household).eq('user_id',user).maybeSingle());
 if(!preferences?.settings?.push_enabled)throw new Error('Push notifications are disabled.');
 const sub=checked(await db.from('finance_push_subscriptions').select('subscription_id,endpoint,p256dh,auth').eq('household_id',household).eq('user_id',user).eq('subscription_id',device).eq('enabled',true).eq('permission','granted').maybeSingle());
 if(!sub)throw new Error('No enabled notification device matches this user.');
 const keys=checked(await db.rpc('finance_agent_push_keys'));if(!keys?.publicKey||!keys?.privateKey)throw new Error('Push signing unavailable.');
 // Separate diagnostic key; never creates a financial event or affects fatigue.
 // Existing claim RPC treats succeeded as terminal, including unknown delivery.
 const runKey='push-test:'+user+':'+requestId;
 if(!checked(await db.rpc('claim_finance_agent_run',{p_household_id:household,p_key:runKey,p_trigger:'push_test'})))return {already_attempted:true,sent:0};
 checked(await db.from('finance_agent_schedule_runs').update({status:'succeeded',finished_at:new Date().toISOString(),metrics:{test:true,outcome:'attempt_reserved'}}).eq('household_id',household).eq('run_key',runKey));
 let httpStatus=0;
 const result=await sendPushJobs([{delivery_id:requestId,subscriptions:[{subscription_id:device,endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}}],payload:{category:'test',priority:'normal',test_id:requestId,title:'Folio · Test notification',body:'Your Folio test notification arrived. No financial changes were made.'}}],{...keys,subject: getFolioPublicOrigin()},buildPayload,async(args:any)=>{
  httpStatus=args.results[0].http_status;
  const success=httpStatus>=200&&httpStatus<300;
  checked(await db.from('finance_push_subscriptions').update({[success?'last_success_at':'last_failure_at']:new Date().toISOString(),...([404,410].includes(httpStatus)?{enabled:false}:{})}).eq('household_id',household).eq('user_id',user).eq('subscription_id',device));
 },validPushSubscription);
 checked(await db.from('finance_agent_schedule_runs').update({metrics:{test:true,...result,http_status:httpStatus,llm_calls:0},finished_at:new Date().toISOString()}).eq('household_id',household).eq('run_key',runKey));
 return {...result,http_status:httpStatus,accepted_by_push_service:result.sent===1};
}
