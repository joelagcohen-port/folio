import { loadAssistantVerificationKeys } from './assistant-verification-keys.ts';
type Row = Record<string, any>;
type Context = { householdId: string; userId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();
function record(v: unknown): v is Row { return !!v && typeof v === 'object' && !Array.isArray(v); }
function uuid(v: unknown): v is string { return typeof v === 'string' && UUID.test(v); }
function fail(message: string, status = 400): never { const e: any = new Error(message); e.status = status; throw e; }
function checked(r: any, message = 'Assistant state is unavailable.', status = 503): any { if (r?.error) { const m = String(r.error.message || ''); fail(message, /access denied|membership|scope/i.test(m) ? 403 : /changed|conflict|expired|stale|not found/i.test(m) ? 409 : status); } return r?.data; }
function b64(bytes: Uint8Array) { let s=''; for (const b of bytes) s+=String.fromCharCode(b); return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function unb64(s: string) { if (!/^[A-Za-z0-9_-]+$/.test(s)||s.length>20000) fail('Assistant proof is invalid.',401); const x=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)); return Uint8Array.from(x,c=>c.charCodeAt(0)); }
async function sha(s: string) { const d=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s))); return [...d].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function stable(v: any): any { return Array.isArray(v)?v.map(stable):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v; }
function clean(body: Row, allowed: string[]) { if (Object.keys(body).some(k=>!allowed.includes(k))) fail('Unknown Assistant request field.'); }
function minor(v: unknown): number | null { if((typeof v!=='number'&&typeof v!=='string')||typeof v==='string'&&!v.trim())return null; const n=Number(v); if (!Number.isFinite(n)||Math.abs(n)>9e12) return null; const m=Math.round(n*100); return Number.isSafeInteger(m)?m:null; }
function text(v: unknown, n=160) { return typeof v==='string'?v.trim().slice(0,n):''; }
function validTimezone(value:unknown){if(typeof value!=='string'||value.length>80)return false;try{new Intl.DateTimeFormat('en',{timeZone:value}).format(new Date());return true;}catch{return false;}}
function localDateEnd(date:string,timezone:string){
 if(!/^20\d\d-\d\d-\d\d$/.test(date)||!validTimezone(timezone))fail('A verified local end date and time zone are required.',422);
 const [y,m,d]=date.split('-').map(Number),next=new Date(Date.UTC(y,m-1,d+1));
 const target={year:next.getUTCFullYear(),month:next.getUTCMonth()+1,day:next.getUTCDate()};
 let guess=Date.UTC(target.year,target.month-1,target.day,0,0,0);
 for(let i=0;i<4;i++){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
  const get=(k:string)=>Number(parts.find(x=>x.type===k)?.value||0), represented=Date.UTC(get('year'),get('month')-1,get('day'),get('hour'),get('minute'),get('second'));
  const want=Date.UTC(target.year,target.month-1,target.day);const diff=represented-want;if(!diff)break;guess-=diff;
 }
 return new Date(guess-1).toISOString();
}
function localToday(now:Date,timezone:string){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function eventFromFacts(e: Row,nowMs=Date.now()) {
 const facts=record(e.facts)?e.facts:{}; const type=String(e.event_type||'');
 const time=Date.parse(String(e.updated_at||'')); if(!Number.isFinite(time)||nowMs-time>15*60_000||time>nowMs+5*60_000) fail('The canonical issue evidence is stale. Refresh the issue and review again.',409);
 if(type==='cash_floor_risk'){
  if(facts.currency!=='USD'||facts.currency_verified!==true||typeof facts.source_revision!=='string'||!/^([0-9a-f]{64}|planning:[0-9a-f]{64})$/.test(facts.source_revision)||typeof facts.account_scope_key!=='string'||!/^[0-9a-f]{64}$/.test(facts.account_scope_key)) fail('This issue has no verified, comparable USD forecast scope.',409);
  const value=minor(facts.minimum_balance),floor=minor(facts.threshold),horizon=Number(facts.horizon_days),lowDate=text(facts.minimum_date,10),scope=text(facts.scope,100);
  if(value===null||floor===null||!Number.isInteger(horizon)||horizon<1||horizon>365||!/^20\d\d-\d\d-\d\d$/.test(lowDate)||!scope) fail('A current verified forecast baseline is unavailable.',409);
  return {metric:'cash_buffer',value,reference:floor,currency:'USD',source_revision:text(facts.source_revision,200),period:{kind:'forecast',horizon_days:horizon,low_date:lowDate,account_scope:scope,account_scope_key:facts.account_scope_key},facts};
 }
 if(type==='budget_pace_risk'){
  if(facts.currency!=='USD'||facts.currency_verified!==true||typeof facts.source_revision!=='string'||!/^budget-history:[1-9][0-9]{0,15}$/.test(facts.source_revision)) fail('This issue has no verified comparable USD budget evidence.',409);
  const value=minor(facts.projected_overage),target=minor(facts.target),month=text(facts.budget_month,7),id=text(facts.category_id,160),name=text(facts.category||facts.category_name,100);
  if(value===null||target===null||!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)||!id||!name) fail('A current canonical category budget baseline is unavailable.',409);
  const timezone=text(facts.budget_timezone,80)||'UTC';try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format(new Date());}catch{fail('The canonical budget period time zone is unavailable.',409);}
  return {metric:'category_budget',value,reference:target,currency:'USD',source_revision:text(facts.source_revision,200),period:{kind:'budget',month,category_id:id,category_name:name,target_minor:target,timezone},facts};
 }
 fail('Only a current cash-buffer or category-budget issue can be followed conditionally.',422);
}
export function canonicalCommitmentObservation(event:Row,now=Date.now()){return eventFromFacts(event,now);}
function materiallyWorse(base: Row, next: Row, condition: Row) {
 if(base.metric!==next.metric||base.currency!=='USD'||next.currency!=='USD'||!record(base.period)||!record(next.period)||!sameCommitmentScope(base.period,next.period)) return false;
 if(condition.metric==='cash_buffer'){
  const cmp=condition.comparator; const drop=Number(base.value_minor)-Number(next.value_minor);
  const floorCross=Number(base.value_minor)>=Number(cmp.floor_minor)&&Number(next.value_minor)<Number(cmp.floor_minor);
  const materiallyLower=drop>=Math.max(Number(cmp.min_decline_minor),Math.abs(Number(base.value_minor)*Number(cmp.relative_percent)/100));
  const old=Date.parse(`${base.period.low_date}T00:00:00Z`),fresh=Date.parse(`${next.period.low_date}T00:00:00Z`);
  return floorCross||materiallyLower||Number.isFinite(old)&&Number.isFinite(fresh)&&old-fresh>=Number(cmp.earlier_low_date_days)*86400000;
 }
 const increase=Number(next.value_minor)-Number(base.value_minor);
 return increase>=Math.max(Number(condition.comparator.min_increase_minor),Math.abs(Number(condition.comparator.target_minor)*Number(condition.comparator.relative_percent)/100));
}
function sameCommitmentScope(a:Row,b:Row){
 if(a.kind!==b.kind)return false;
 if(a.kind==='forecast')return a.horizon_days===b.horizon_days&&a.account_scope===b.account_scope&&a.account_scope_key===b.account_scope_key;
 if(a.kind==='budget')return a.month===b.month&&a.category_id===b.category_id&&a.category_name===b.category_name&&a.target_minor===b.target_minor&&a.timezone===b.timezone;
 return false;
}
function materiallyChangedCommitment(base:Row,next:Row,condition:Row){
 if(base.metric!==next.metric||base.currency!=='USD'||next.currency!=='USD'||!record(base.period)||!record(next.period)||!sameCommitmentScope(base.period,next.period))return true;
 if(condition.metric==='cash_buffer'){const c=condition.comparator,delta=Math.abs(Number(next.value_minor)-Number(base.value_minor)),threshold=Math.max(Number(c.min_decline_minor),Math.abs(Number(base.value_minor)*Number(c.relative_percent)/100));const old=Date.parse(`${base.period.low_date}T00:00:00Z`),fresh=Date.parse(`${next.period.low_date}T00:00:00Z`);return Number(next.reference_minor)!==Number(base.reference_minor)||delta>=threshold||Number.isFinite(old)&&Number.isFinite(fresh)&&Math.abs(old-fresh)>=Number(c.earlier_low_date_days)*86400000;}
 const delta=Math.abs(Number(next.value_minor)-Number(base.value_minor)),threshold=Math.max(Number(condition.comparator.min_increase_minor),Math.abs(Number(condition.comparator.target_minor)*Number(condition.comparator.relative_percent)/100));return Number(next.reference_minor)!==Number(base.reference_minor)||delta>=threshold;
}
async function canonicalOrigin(db: any,c: Context,origin: Row) {
 if(!record(origin)||!['message','event','issue'].includes(origin.kind)) fail('Choose an exact saved Folio issue to follow.',422);
 let eventId:string,version:number,message:Row|null=null;
 if(origin.kind==='message'){
  if(!uuid(origin.message_id)) fail('The saved issue message is unavailable.',404);
  message=checked(await db.from('finance_assistant_messages').select('message_id,role,generation_status,source,lifecycle,lifecycle_version,event_id,event_version').eq('household_id',c.householdId).eq('user_id',c.userId).eq('message_id',origin.message_id).maybeSingle(),'The saved issue message is unavailable.',404);
  if(!message||message.role!=='assistant'||message.generation_status!=='complete'||message.source!=='event'||message.lifecycle==='superseded'||!uuid(message.event_id)||!Number.isSafeInteger(message.event_version)) fail('The message is not linked to a current canonical issue.',409);
  eventId=message.event_id;version=Number(message.event_version);
 }else{
  eventId=origin.kind==='event'?String(origin.event_id||''):String(origin.issue_id||'');
  version=Number(origin.event_version||0);
  if(!uuid(eventId)||origin.kind==='event'&&(!Number.isSafeInteger(version)||version<1)) fail('The canonical issue ID is invalid.',404);
 }
 let query=db.from('finance_agent_events').select('event_id,event_type,event_version,title,summary,facts,status,updated_at,expires_at').eq('household_id',c.householdId).eq('event_id',eventId);
 if(version>0) query=query.eq('event_version',version);
 const event=checked(await query.maybeSingle(),'The canonical issue is unavailable.',404);
 if(!event||!Number.isSafeInteger(event.event_version)||!['new','surfaced'].includes(event.status)||event.expires_at&&Date.parse(event.expires_at)<=Date.now()) fail('The canonical issue changed or expired. Refresh and review again.',409);
 return {event,message,origin:origin.kind==='message'?{kind:'message',message_id:origin.message_id}:origin.kind==='event'?{kind:'event',event_id:event.event_id,event_version:event.event_version}:{kind:'issue',issue_id:event.event_id}};
}
function commitmentView(w: Row) { return {watch_id:w.watch_id,origin:w.commitment?.origin,condition:w.commitment?.condition,baseline:w.commitment?.baseline,schedule:w.commitment?.schedule,end_condition:w.commitment?.end_condition,notify:w.commitment?.notify,delivery:w.delivery,label:w.label,status:w.status,version:w.version,snoozed_until:w.snoozed_until??null,expires_at:w.expires_at??null,created_at:w.created_at,updated_at:w.updated_at,next_check_at:w.next_check_at??null,last_checked_at:w.last_checked_at??null,last_outcome:w.last_outcome??null,last_failure:w.last_failure??null,completed_at:w.completed_at??null}; }
function toWatch(w: Row) { return {watch_id:w.watch_id,template:w.template,...(w.category_name?{category_name:w.category_name}:{}),...(w.schedule?{schedule:w.schedule}:{}),...(w.follow_up?{follow_up:w.follow_up}:{}),...(w.refund?{refund:w.refund}:{}),delivery:w.delivery,label:w.label,status:w.status,version:w.version,snoozed_until:w.snoozed_until??null,expires_at:w.expires_at??null,created_at:w.created_at,updated_at:w.updated_at,next_check_at:w.next_check_at??null,last_checked_at:w.last_checked_at??null,last_outcome:w.last_outcome??null,last_failure:w.last_failure??null,completed_at:w.completed_at??null,...(w.template==='issue_follow_through'?{commitment:commitmentView(w)}:{})}; }
async function commitmentHash(token:string,c:Context,version:number,commitment:Row,ack:Row|null){return sha(JSON.stringify(stable({aud:'folio-assistant-commitment-review',household_id:c.householdId,user_id:c.userId,version,token,commitment,acknowledge_origin:ack})));}
async function pushAvailable(db:any,c:Context,delivery:string){if(delivery!=='chat_and_push')return false;const p=checked(await db.from('finance_notification_preferences').select('settings').eq('household_id',c.householdId).eq('user_id',c.userId).maybeSingle(),'Assistant notification settings are unavailable.');const s=record(p?.settings)?p.settings:{};if(s.in_app_enabled===false||s.push_enabled!==true)return false;const sub=checked(await db.from('finance_push_subscriptions').select('subscription_id').eq('household_id',c.householdId).eq('user_id',c.userId).eq('enabled',true).eq('permission','granted').limit(1).maybeSingle(),'Push availability could not be checked.');return !!sub;}
async function reviewCommitment(db:any,c:Context,b:Row,deps:Row={}){
 clean(b,['action','household_id','origin','condition','schedule','end_condition','delivery','acknowledge_origin']);
 if(!record(b.condition)||b.condition.kind!=='only_if_worse'||!['cash_buffer','category_budget'].includes(b.condition.metric)||!record(b.schedule)||!record(b.end_condition)||!['one_check','verified_payday','budget_period_end','issue_resolved'].includes(b.end_condition.kind)||!['chat','chat_and_push'].includes(b.delivery||'chat')) fail('Choose an exact supported issue, comparison, schedule, and end condition.',422);
 const resolved=await canonicalOrigin(db,c,b.origin); const obs=eventFromFacts(resolved.event);
 if(obs.metric!==b.condition.metric) fail('The selected issue does not match the requested metric.',422);
 const now=new Date(), schedule=b.schedule, end=b.end_condition;
 if(end.kind==='verified_payday'){
  if(Object.keys(end).sort().join(',')!=='expected_date,kind,stream_key,timezone'||typeof end.stream_key!=='string'||end.stream_key.length>180||!/^20\d\d-\d\d-\d\d$/.test(end.expected_date)||!validTimezone(end.timezone)||typeof deps.loadRecurring!=='function')fail('Choose one exact verified recurring income stream, expected date, and time zone.',422);
 }else if(end.kind==='budget_period_end'){
  if(Object.keys(end).sort().join(',')!=='kind')fail('The category budget period end is bound to its canonical source time zone.',422);
 }else if(end.kind==='issue_resolved'){
  if(Object.keys(end).sort().join(',')!=='kind')fail('This issue ending is not supported.',422);
 }else if(end.kind==='one_check'&&Object.keys(end).sort().join(',')!=='kind')fail('This one-time ending is not supported.',422);
 if(schedule.kind==='event_driven'){
  if(Object.keys(schedule).length!==1||b.end_condition.kind==='one_check'||b.condition.metric==='cash_buffer'&&!['verified_payday','issue_resolved'].includes(b.end_condition.kind)||b.condition.metric==='category_budget'&&!['budget_period_end','issue_resolved'].includes(b.end_condition.kind)) fail('This event-driven ending is not supported for the selected metric.',422);
 }else{
  if(Object.keys(schedule).some(k=>!['due_at','local_date','local_time','timezone','utc_offset_minutes'].includes(k))||!schedule.due_at||!/^20\d\d-\d\d-\d\dT.*Z$/.test(schedule.due_at)||!/^20\d\d-\d\d-\d\d$/.test(schedule.local_date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.local_time)||typeof schedule.timezone!=='string'||!Number.isInteger(schedule.utc_offset_minutes)||b.end_condition.kind!=='one_check') fail('A one-time check needs the exact reviewed local date, time, time zone, and UTC offset.',422);
  const due=Date.parse(schedule.due_at); if(!Number.isFinite(due)||due<=now.getTime()||due>now.getTime()+366*86400000) fail('The reviewed check time must be in the future and within one year.',422);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(due)); const get=(k:string)=>parts.find(x=>x.type===k)?.value||'';
  if(`${get('year')}-${get('month')}-${get('day')}`!==schedule.local_date||`${get('hour')}:${get('minute')}`!==schedule.local_time) fail('The reviewed local date/time does not match its exact UTC instant.',409);
 }
 let condition:Row;
 if(obs.metric==='cash_buffer'){
  if(obs.facts.threshold===undefined) fail('The forecast does not provide a canonical floor to compare.',409);
  condition={kind:'only_if_worse',metric:'cash_buffer',comparator:{field:'forecast_low_vs_floor',direction:'lower',crosses_below_floor:true,floor_minor:obs.reference,horizon_days:obs.period.horizon_days,account_scope:obs.period.account_scope,account_scope_key:obs.period.account_scope_key,min_decline_minor:25000,relative_percent:5,earlier_low_date_days:7,currency:'USD'}};
 }else{
  if(b.condition.category_name!==obs.period.category_name) fail('The selected category does not match the canonical issue.',409);
  condition={kind:'only_if_worse',metric:'category_budget',category_name:obs.period.category_name,comparator:{field:'projected_overage',direction:'higher',budget_month:obs.period.month,category_id:obs.period.category_id,target_minor:obs.reference,min_increase_minor:2500,relative_percent:5,currency:'USD'}};
 }
 let reviewedEnd:Row={...end};
 let expiry:string;
 let paydayPreview:Row|null=null;
 if(end.kind==='verified_payday'){
  if(obs.metric!=='cash_buffer'||schedule.kind!=='event_driven')fail('Verified payday is supported only for an event-driven cash-buffer commitment.',422);
  const recurring=await deps.loadRecurring(c,end.timezone);
  const sources=recurring?.coverage?.sources;
  const freshSources=Array.isArray(sources)&&sources.length>0&&sources.every((source:Row)=>source?.status==='success'&&typeof source.fetched_at==='string'&&Number.isFinite(Date.parse(source.fetched_at))&&now.getTime()-Date.parse(source.fetched_at)<=24*60*60_000&&Date.parse(source.fetched_at)<=now.getTime()+5*60_000);
  const matches=(recurring?.streams||[]).filter((stream:Row)=>stream?.stream_key===end.stream_key&&stream.flow_type==='inflow'&&stream.recurring_kind==='income'&&stream.is_active===true&&stream.primary_eligible===true&&stream.source_currency_verified===true&&stream.currency_code==='USD'&&typeof stream.predicted_next_date==='string'&&/^20\d\d-\d\d-\d\d$/.test(stream.predicted_next_date)&&stream.predicted_next_date===end.expected_date&&!(stream.review_reasons||[]).length);
  if(recurring?.coverage?.complete!==true||!freshSources||matches.length!==1||localToday(now,end.timezone)>=end.expected_date)fail('That recurring income stream or expected payday is not uniquely verified and current. Review the exact stream and date again.',409);
  paydayPreview=matches[0];
  reviewedEnd={kind:'verified_payday',stream_key:end.stream_key,expected_date:end.expected_date,timezone:end.timezone};
  const catchup=new Date(Date.parse(end.expected_date+'T00:00:00Z')+7*86400000).toISOString().slice(0,10); expiry=localDateEnd(catchup,end.timezone);
 }else if(end.kind==='budget_period_end'){
  if(obs.metric!=='category_budget'||schedule.kind!=='event_driven')fail('Budget-period end is supported only for an event-driven category check.',422);
  const monthEnd=new Date(Date.UTC(Number(obs.period.month.slice(0,4)),Number(obs.period.month.slice(5,7)),0)).toISOString().slice(0,10);
  if(localToday(now,obs.period.timezone)>monthEnd)fail('The canonical budget period has already ended. Review a current period first.',409);
  reviewedEnd={kind:'budget_period_end'};
  const catchup=new Date(Date.parse(monthEnd+'T00:00:00Z')+2*86400000).toISOString().slice(0,10); expiry=localDateEnd(catchup,obs.period.timezone);
 }else{
  expiry=new Date((schedule.kind==='event_driven'?now.getTime()+30*86400000:Date.parse(schedule.due_at)+7*86400000)).toISOString();
 }
 const baseline={metric:obs.metric,value_minor:obs.value,reference_minor:obs.reference,currency:'USD',captured_at:resolved.event.updated_at,source_revision:obs.source_revision,source:'canonical',period:obs.period};
 const commitment={origin:resolved.origin,condition,baseline,schedule,end_condition:reviewedEnd,notify:'only_if_worse',delivery:b.delivery||'chat',label:obs.metric==='cash_buffer'?'Cash buffer check':`${obs.period.category_name} budget check`,expires_at:expiry};
 const ack=b.acknowledge_origin===true?resolved.message&&resolved.message.lifecycle!=='resolved'?{message_id:resolved.message.message_id,expected_version:Number(resolved.message.lifecycle_version||1)}:null:null;
 if(b.acknowledge_origin===true&&!ack) fail('The exact source issue message cannot be acknowledged by this review.',409);
 const token=b64(crypto.getRandomValues(new Uint8Array(32))), reviewExpires=new Date(Date.now()+15*60_000).toISOString(), watchId=crypto.randomUUID();
 const hash=await commitmentHash(token,c,1,commitment,ack);
 const saved=checked(await db.rpc('finance_review_assistant_commitment',{p_household_id:c.householdId,p_user_id:c.userId,p_watch_id:watchId,p_review_token_hash:hash,p_review_token_expires_at:reviewExpires,p_expected_version:null,p_commitment:commitment,p_acknowledge_origin:ack}),'Conditional follow-through review could not be saved.',409);
 const watch=record(saved)?saved:{}; if(watch.watch_id!==watchId||watch.status!=='draft') fail('Conditional follow-through review could not be verified.',503);
 const ackResponse=ack?{...ack,event_id:resolved.event.event_id,event_version:resolved.event.event_version,lifecycle:'resolved',will_resolve:true,disposition:'expected'}:undefined;
 return {commitment:commitmentView(watch),review_token:token,review_expires_at:reviewExpires,summary:`${commitment.label}: ${obs.metric==='cash_buffer'?`compare the ${obs.period.horizon_days}-day forecast low against the verified $${(obs.reference/100).toFixed(2)} floor for ${obs.period.account_scope}. Notify only if it crosses below that floor, drops by at least the greater of $250 or 5% of the prior low, or the low date moves at least 7 days earlier.`:`compare projected ${obs.period.category_name} overage for ${obs.period.month}; normal purchases alone do not count. Notify only if projected overage grows by at least the greater of $25 or 5% of the target.`} Baseline: $${(obs.value/100).toFixed(2)}; captured ${new Date(resolved.event.updated_at).toISOString()}; scope ${obs.period.kind==='forecast'?obs.period.account_scope:obs.period.category_name}; ${end.kind==='verified_payday'?`until the verified ${end.expected_date} payday from ${paydayPreview?.description||paydayPreview?.merchant_name||'the selected recurring income stream'} (${end.stream_key}), in ${end.timezone}; exact stream/date evidence closes it, with a fixed catch-up expiry ${new Date(expiry).toISOString()}`:end.kind==='budget_period_end'?`through ${obs.period.month} in the canonical ${obs.period.timezone} budget time zone, with a fixed catch-up expiry ${new Date(expiry).toISOString()}`:schedule.kind==='event_driven'?'until the reviewed issue is resolved, with a 30-day safety expiry':'one check '+schedule.local_date+' at '+schedule.local_time+' '+schedule.timezone}.`,push_available:await pushAvailable(db,c,b.delivery||'chat'),...(ackResponse?{acknowledge_origin:ackResponse}:{})};
}
async function confirmCommitment(db:any,c:Context,b:Row){
 clean(b,['action','household_id','commitment_id','watch_id','expected_version','review_token','confirm']); const id=b.commitment_id??b.watch_id;
 if(!uuid(id)||!Number.isSafeInteger(b.expected_version)||typeof b.review_token!=='string'||b.review_token.length<40||b.confirm!==true) fail('Confirm this exact reviewed commitment to activate it.');
 const row=checked(await db.from('finance_assistant_watches').select('*').eq('household_id',c.householdId).eq('user_id',c.userId).eq('watch_id',id).maybeSingle(),'Conditional follow-through review is unavailable.',404);
 if(!row||row.template!=='issue_follow_through') fail('This commitment review changed. Review the current issue again.',409);
 // A lost response after a successful confirm must be safely reconcilable without
 // requiring the draft row or rereading evidence that the same atomic confirm
 // has already consumed. Only the exact original owner/version/token can replay.
 const hash=await commitmentHash(b.review_token,c,Number(row.review_version),row.commitment,row.acknowledge_origin??null);
 if(row.confirmed_review_token_hash===hash&&Number(row.review_version)===b.expected_version){
  return {saved:true,commitment:commitmentView(row),summary:`Saved ${row.label}. The exact comparison stays linked to its original issue; unchanged results remain quiet.`};
 }
 if(row.status!=='draft'||row.version!==b.expected_version||Number(row.review_version)!==b.expected_version) fail('This commitment review changed. Review the current issue again.',409);
 const origin=await canonicalOrigin(db,c,{kind:'event',event_id:row.origin_event_id,event_version:row.origin_event_version}); const current=eventFromFacts(origin.event);
 const reviewed={metric:row.commitment.baseline.metric,value_minor:row.commitment.baseline.value_minor,currency:'USD',period:row.commitment.baseline.period};
 if(current.metric!==reviewed.metric||!sameCommitmentScope(current.period,reviewed.period)) fail('The canonical metric scope changed since review. Review the updated baseline before confirming.',409);
 if(materiallyChangedCommitment({...reviewed,reference_minor:Number(row.commitment.baseline.reference_minor)},{metric:current.metric,value_minor:current.value,reference_minor:current.reference,currency:'USD',period:current.period},row.commitment.condition)) fail('Canonical data changed materially since the review. Review the updated baseline before confirming.',409);
 const result=checked(await db.rpc('finance_confirm_assistant_commitment',{p_household_id:c.householdId,p_user_id:c.userId,p_watch_id:id,p_review_token_hash:hash,p_expected_version:Number(b.expected_version)}),'Conditional follow-through could not be confirmed.',409);
 if(!record(result)||result.saved!==true||!record(result.commitment)) fail('Conditional follow-through could not be confirmed.',409);
 const ack=result.acknowledged_origin; return {saved:true,commitment:commitmentView(result.commitment),...(record(ack)?{acknowledged_origin:ack}:{}),summary:`Saved ${result.commitment.label}. The exact comparison stays linked to its original issue; unchanged results remain quiet.`};
}
async function memorySave(db:any,c:Context,b:Row){
 clean(b,['action','household_id','key','kind','summary','effective_from','effective_until','source_message_id','confirm']);
 if(b.confirm!==true||typeof b.key!=='string'||! /^[a-z0-9][a-z0-9:_-]{0,79}$/.test(b.key)||!['goal','decision','completed_change'].includes(b.kind)||typeof b.summary!=='string'||b.summary.trim().length<8||b.summary.trim().length>280||b.source_message_id!==undefined&&!uuid(b.source_message_id)) fail('Confirm one concise saved Folio context item.',422);
 for(const k of ['effective_from','effective_until'])if(b[k]!==undefined&&!/^20\d\d-\d\d-\d\d$/.test(String(b[k]))) fail('Memory date must be an exact calendar date.',422);
 const data=checked(await db.rpc('finance_save_assistant_memory',{p_household_id:c.householdId,p_user_id:c.userId,p_key:b.key,p_kind:b.kind,p_summary:b.summary.trim(),p_effective_from:b.effective_from??null,p_effective_until:b.effective_until??null,p_source_message_id:b.source_message_id??null}),'Saved context could not be committed.',409);
 if(!record(data)||data.saved!==true||!Array.isArray(data.memories)) fail('Saved context could not be verified.',503);
 return data;
}
async function listPersonalMemories(db:any,c:Context,b:Row){
 clean(b,['action','household_id']);
 const row=checked(await db.from('finance_user_preferences').select('ask_folio_memories').eq('user_id',c.userId).maybeSingle(),'Personal Assistant memories are unavailable.');
 const memories=row?.ask_folio_memories===null||row?.ask_folio_memories===undefined?[]:row.ask_folio_memories;
 if(!Array.isArray(memories)||memories.length>24||memories.some((x:any)=>!record(x)||!uuid(x.id)||typeof x.key!=='string'||!/^[a-z0-9][a-z0-9:_-]{0,79}$/.test(x.key)||!['goal','decision','completed_change'].includes(x.kind)||typeof x.summary!=='string'||x.summary.trim().length<8||x.summary.length>280||typeof x.createdAt!=='string'||!Number.isFinite(Date.parse(x.createdAt))||x.effectiveFrom!==undefined&&!/^20\d\d-\d\d-\d\d$/.test(x.effectiveFrom)||x.effectiveUntil!==undefined&&!/^20\d\d-\d\d-\d\d$/.test(x.effectiveUntil)))fail('Personal Assistant memories are unavailable.',503);
 return {personal_memories:memories};
}
async function lifecycle(db:any,c:Context,b:Row){
 clean(b,['action','household_id','message_id','expected_version','lifecycle','snoozed_until']);
 if(!uuid(b.message_id)||!Number.isSafeInteger(b.expected_version)||!['active','snoozed','resolved'].includes(b.lifecycle)||b.lifecycle==='snoozed'&&(typeof b.snoozed_until!=='string'||!Number.isFinite(Date.parse(b.snoozed_until)))) fail('Choose a valid message state.',422);
 const result=checked(await db.rpc('finance_set_assistant_message_lifecycle',{p_household_id:c.householdId,p_user_id:c.userId,p_message_id:b.message_id,p_expected_version:b.expected_version,p_lifecycle:b.lifecycle,p_snoozed_until:b.lifecycle==='snoozed'?b.snoozed_until:null}),'Assistant message state changed. Refresh and try again.',409);
 if(!record(result)||!record(result.message)) fail('Assistant message state could not be verified.',409); return {message:result.message};
}
async function commitmentState(db:any,c:Context,b:Row){
 clean(b,['action','household_id','watch_id','expected_version','status','snoozed_until']); if(!uuid(b.watch_id)||!Number.isSafeInteger(b.expected_version)||!['active','snoozed','resolved'].includes(b.status)||b.status==='snoozed'&&(typeof b.snoozed_until!=='string'||!Number.isFinite(Date.parse(b.snoozed_until)))) fail('Choose a valid commitment state.',422);
 const w=checked(await db.rpc('finance_set_assistant_commitment_state',{p_household_id:c.householdId,p_user_id:c.userId,p_watch_id:b.watch_id,p_expected_version:b.expected_version,p_status:b.status,p_snoozed_until:b.status==='snoozed'?b.snoozed_until:null}),'Commitment state changed. Refresh and try again.',409);
 if(!record(w)||w.template!=='issue_follow_through') fail('Commitment state could not be verified.',409); return {commitment:commitmentView(w)};
}
const KEYS: Record<string, JsonWebKey> = loadAssistantVerificationKeys();
async function receipt(db:any,c:Context,b:Row){
 clean(b,['action','household_id','message_id','proposal_id','tool','proposal_sha256','outcome','evidence_kind','evidence_id','proof']);
 if(!uuid(b.message_id)||!uuid(b.proposal_id)||typeof b.tool!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(b.tool)||typeof b.proposal_sha256!=='string'||!/^[0-9a-f]{64}$/.test(b.proposal_sha256)||!['applied','declined','failed','unknown'].includes(b.outcome)) fail('Assistant decision receipt is invalid.',422);
 // A decline is the authenticated owner's explicit disposition, not a claim
 // that an operation ran. It is stored without a server-result proof.
 if(b.outcome==='declined'&&(b.proof!==undefined||b.evidence_kind!==undefined||b.evidence_id!==undefined)) fail('Declined outcomes cannot carry applied evidence.',422);
 let proofHash:string|null=null;
 if(b.outcome!=='declined'){
  if(typeof b.proof!=='string') fail('Assistant decision proof is required.',401);
  const parts=b.proof.split('.'); if(parts.length!==3) fail('Assistant decision proof is invalid.',401);
  let h:Row,p:Row; try{h=JSON.parse(new TextDecoder().decode(unb64(parts[0])));p=JSON.parse(new TextDecoder().decode(unb64(parts[1])));}catch{fail('Assistant decision proof is invalid.',401);}
  const key=KEYS[h.kid]; if(h.alg!=='ES256'||h.typ!=='JWT'||!key||!record(p)) fail('Assistant decision proof is invalid.',401);
  const pk=await crypto.subtle.importKey('jwk',key,{name:'ECDSA',namedCurve:'P-256'},false,['verify']); if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pk,unb64(parts[2]),enc.encode(`${parts[0]}.${parts[1]}`))) fail('Assistant decision proof is invalid.',401);
  const now=Math.floor(Date.now()/1000), issued=Number(p.iat), expires=Number(p.exp);
  if(p.aud!=='folio-assistant-receipt'||p.household_id!==c.householdId||p.user_id!==c.userId||p.message_id!==b.message_id||p.proposal_id!==b.proposal_id||p.tool!==b.tool||p.proposal_sha256!==b.proposal_sha256||p.outcome!==b.outcome||p.evidence_kind!==(b.evidence_kind??null)||p.evidence_id!==(b.evidence_id??null)||!Number.isSafeInteger(issued)||!Number.isSafeInteger(expires)||issued>now+30||now-issued>900||expires<now||typeof p.operation_sha256!=='string'||!/^[0-9a-f]{64}$/.test(p.operation_sha256)) fail('Assistant decision proof does not match the reviewed proposal.',401);
  // The signed route claim contains only the operation digest, not the source
  // result. Verify the signature and its digest shape, then persist that proof
  // only for the applied outcome as required by the SQL receipt invariant.
  if(b.outcome==='applied') proofHash=await sha(b.proof);
 }
 if(b.outcome==='applied'&&(!b.evidence_kind||!b.evidence_id)) fail('Applied receipt needs exact committed evidence.',422);
 if(b.outcome!=='applied'&&(b.evidence_kind!==undefined||b.evidence_id!==undefined)) fail('Unverified outcome cannot carry applied evidence.',422);
 const data=checked(await db.rpc('finance_record_assistant_decision_receipt',{p_household_id:c.householdId,p_user_id:c.userId,p_message_id:b.message_id,p_proposal_id:b.proposal_id,p_tool:b.tool,p_proposal_sha256:b.proposal_sha256,p_outcome:b.outcome,p_evidence_kind:b.evidence_kind??null,p_evidence_id:b.evidence_id??null,p_proof_hash:proofHash}),'Assistant decision receipt could not be saved.',409);
 if(!record(data)||data.proposal_sha256!==b.proposal_sha256||data.tool!==b.tool) fail('Assistant decision receipt could not be verified.',503); return {receipt:data};
}
async function claimProposalExecution(db:any,c:Context,b:Row){
 clean(b,['action','household_id','message_id','proposal_id','tool','proposal_sha256']);
 if(!uuid(b.message_id)||!uuid(b.proposal_id)||typeof b.tool!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(b.tool)||typeof b.proposal_sha256!=='string'||!/^[0-9a-f]{64}$/.test(b.proposal_sha256))fail('Assistant action proposal is invalid.',422);
 const data=checked(await db.rpc('finance_claim_assistant_proposal_execution',{p_household_id:c.householdId,p_user_id:c.userId,p_message_id:b.message_id,p_proposal_id:b.proposal_id,p_tool:b.tool,p_proposal_sha256:b.proposal_sha256}),'Assistant action was already processed or could not be claimed.',409);
 if(!record(data)||typeof data.claimed!=='boolean'||!record(data.receipt)||data.receipt.message_id!==b.message_id||data.receipt.proposal_id!==b.proposal_id||data.receipt.tool!==b.tool||data.receipt.proposal_sha256!==b.proposal_sha256)fail('Assistant proposal execution state could not be verified.',503);
 return {claimed:data.claimed,receipt:data.receipt};
}
function localParts(date:Date,zone:string){const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date),g=(x:string)=>p.find(y=>y.type===x)?.value||''; return {weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(g('weekday')),date:`${g('year')}-${g('month')}-${g('day')}`,time:`${g('hour')}:${g('minute')}`}; }
async function taskToken(payload:Row){const secret=(globalThis as any).Deno?.env?.get('SUPABASE_SERVICE_ROLE_KEY');if(!secret)fail('Scheduled task review is not configured.',503);const data=b64(enc.encode(JSON.stringify(stable(payload))));const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(data)));return `${data}.${b64(sig)}`;}
async function readTaskToken(token:string){const parts=token.split('.');if(parts.length!==2)fail('Assistant review is invalid.',401);const secret=(globalThis as any).Deno?.env?.get('SUPABASE_SERVICE_ROLE_KEY');if(!secret)fail('Assistant review is not configured.',503);const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);if(!await crypto.subtle.verify('HMAC',key,unb64(parts[1]),enc.encode(parts[0])))fail('Assistant review is invalid.',401);let p:Row;try{p=JSON.parse(new TextDecoder().decode(unb64(parts[0])));}catch{fail('Assistant review is invalid.',401);}if(!record(p)||!Number.isFinite(p.expires_at)||p.expires_at<Date.now())fail('Assistant review expired.',409);return p;}
async function reviewWatchState(db:any,c:Context,b:Row){
 clean(b,['action','household_id','watch_id','expected_version','status','snoozed_until']);
 if(!uuid(b.watch_id)||!Number.isSafeInteger(b.expected_version)||!['active','snoozed','resolved'].includes(b.status)||b.status==='snoozed'&&(typeof b.snoozed_until!=='string'||!Number.isFinite(Date.parse(b.snoozed_until)))||b.status!=='snoozed'&&b.snoozed_until!==undefined)fail('Choose a valid reviewed watch state.',422);
 const row=checked(await db.from('finance_assistant_watches').select('watch_id,template,label,status,version,next_check_at,snoozed_until,expires_at').eq('household_id',c.householdId).eq('user_id',c.userId).eq('watch_id',b.watch_id).maybeSingle(),'Watch is unavailable.',404);
 if(!row||!['active','snoozed'].includes(row.status)||row.version!==b.expected_version||row.template==='issue_follow_through')fail('This watch changed or requires the commitment controls. Refresh before reviewing.',409);
 const expiry=Date.now()+15*60_000,token=await taskToken({aud:'folio-assistant-watch-state',household_id:c.householdId,user_id:c.userId,watch_id:row.watch_id,expected_version:row.version,status:b.status,snoozed_until:b.snoozed_until??null,expires_at:expiry});
 return {review_token:token,review_expires_at:new Date(expiry).toISOString(),summary:`${row.label}: change from ${row.status} to ${b.status}${b.status==='snoozed'?` until ${b.snoozed_until}`:''}.`,watch_preview:{watch_id:row.watch_id,label:row.label,template:row.template,status:row.status,current_version:row.version,next_check_at:row.next_check_at??null,proposed_status:b.status,snoozed_until:b.snoozed_until??null}};
}
async function confirmWatchState(db:any,c:Context,b:Row){
 clean(b,['action','household_id','watch_id','expected_version','review_token','confirm']);if(!uuid(b.watch_id)||!Number.isSafeInteger(b.expected_version)||typeof b.review_token!=='string'||b.confirm!==true)fail('Confirm the exact reviewed watch change.',422);
 const p=await readTaskToken(b.review_token);if(p.aud!=='folio-assistant-watch-state'||p.household_id!==c.householdId||p.user_id!==c.userId||p.watch_id!==b.watch_id||p.expected_version!==b.expected_version)fail('Watch review does not match this account or item.',401);
 const row=checked(await db.from('finance_assistant_watches').select('watch_id,template,label,status,version,next_check_at,snoozed_until').eq('household_id',c.householdId).eq('user_id',c.userId).eq('watch_id',b.watch_id).maybeSingle(),'Watch is unavailable.',404);if(!row||row.version!==b.expected_version||!['active','snoozed'].includes(row.status))fail('Watch changed. Refresh and review again.',409);
 const saved=checked(await db.rpc('finance_set_assistant_watch_state',{p_household_id:c.householdId,p_user_id:c.userId,p_watch_id:b.watch_id,p_expected_version:b.expected_version,p_status:p.status,p_snoozed_until:p.status==='snoozed'?p.snoozed_until:null}),'Watch state could not be updated.',409);if(!record(saved))fail('Watch state could not be verified.',409);return {watch:toWatch(saved),saved:true};
}
async function taskReview(db:any,c:Context,b:Row){
 clean(b,['action','household_id','task_id','expected_version','instruction','cadence','weekday','time','timezone','enabled','delivery']);
 if(typeof b.instruction!=='string'||!b.instruction.trim()||b.instruction.length>1500||!['daily','weekly'].includes(b.cadence)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)||typeof b.timezone!=='string'||!['chat','chat_and_push'].includes(b.delivery||'chat')||b.cadence==='daily'&&b.weekday!==undefined||b.cadence==='weekly'&&(!Number.isInteger(b.weekday)||b.weekday<0||b.weekday>6)||b.enabled!==undefined&&typeof b.enabled!=='boolean'||b.task_id!==undefined&&(!uuid(b.task_id)||!Number.isSafeInteger(b.expected_version)))fail('Review a complete scheduled instruction, schedule, and delivery.',422);
 const taskId=b.task_id??crypto.randomUUID(), version=b.expected_version??1, enabled=b.enabled!==false, delivery=b.delivery||'chat';
 const at=new Date(), expires=at.getTime()+15*60_000;
 const next=enabled?checked(await db.rpc('finance_next_assistant_task_run',{p_after:at.toISOString(),p_cadence:b.cadence,p_weekday:b.weekday??null,p_local_time:b.time,p_timezone:b.timezone}),'Next scheduled time could not be resolved.',422):null;
 if(enabled&&(typeof next!=='string'||!Number.isFinite(Date.parse(next))))fail('Next scheduled time could not be resolved.',422);
 const task={household_id:c.householdId,user_id:c.userId,task_id:taskId,expected_version:version,created_new:b.task_id===undefined,instruction:b.instruction.trim(),cadence:b.cadence,weekday:b.weekday??null,local_time:b.time,timezone:b.timezone,enabled,delivery,expires_at:expires};
 const review_token=await taskToken(task), next_run_at=next;
 const pref=checked(await db.from('finance_notification_preferences').select('settings').eq('household_id',c.householdId).eq('user_id',c.userId).maybeSingle(),'Assistant notification settings are unavailable.');
 const settings=record(pref?.settings)?pref.settings:{}; const sub=delivery==='chat_and_push'&&settings.in_app_enabled!==false&&settings.push_enabled===true?checked(await db.from('finance_push_subscriptions').select('subscription_id').eq('household_id',c.householdId).eq('user_id',c.userId).eq('enabled',true).eq('permission','granted').limit(1).maybeSingle(),'Push availability could not be checked.'):null;
 return {review_token,review_expires_at:new Date(expires).toISOString(),next_run_at,push_available:!!sub,task_preview:{task_id:taskId,instruction:task.instruction,cadence:task.cadence,weekday:task.weekday,local_time:task.local_time,timezone:task.timezone,enabled,version,starts_at:at.toISOString(),delivery},summary:`${task.instruction} · ${task.cadence}${task.cadence==='weekly'?` on weekday ${task.weekday}`:''} at ${task.local_time} ${task.timezone}. Delivery: ${delivery==='chat_and_push'?'saved chat and current push settings':'saved chat only'}. First run: ${next_run_at??'paused'}.`};
}
async function taskConfirm(db:any,c:Context,b:Row){clean(b,['action','household_id','review_token','confirm']);if(b.confirm!==true||typeof b.review_token!=='string')fail('Confirm this exact scheduled task review.',422);const p=await readTaskToken(b.review_token);if(!uuid(p.task_id)||p.household_id!==c.householdId||p.user_id!==c.userId)fail('Scheduled task review is not available.',403);
 const saved=checked(await db.rpc('finance_confirm_assistant_task_v2',{p_household_id:c.householdId,p_user_id:c.userId,p_task_id:p.task_id,p_expected_version:p.expected_version===1&&p.created_new===true?null:p.expected_version,p_instruction:p.instruction,p_cadence:p.cadence,p_weekday:p.weekday,p_local_time:p.local_time,p_timezone:p.timezone,p_enabled:p.enabled,p_delivery:p.delivery}),'Scheduled task could not be confirmed.',409);
 if(!record(saved)||saved.saved!==true||!record(saved.task))fail('Scheduled task could not be confirmed.',409);return {saved:true,task:saved.task,summary:'Saved the reviewed scheduled instruction.'};}
async function enrichState(db:any,c:Context,state:Row){
 const [taskResult,commitmentResult,receiptResult]=await Promise.all([
  db.from('finance_assistant_scheduled_tasks').select('task_id,instruction,cadence,weekday,local_time,timezone,enabled,version,created_at,updated_at,starts_at,delivery,next_run_at,last_run_at,last_outcome,last_failure,retryable,last_message_id,last_delivery_status').eq('household_id',c.householdId).eq('user_id',c.userId).order('enabled',{ascending:false}).order('updated_at',{ascending:false}).limit(100),
  Promise.all([
   db.from('finance_assistant_watches').select('watch_id,template,commitment,status,version,snoozed_until,expires_at,created_at,updated_at,next_check_at,last_checked_at,last_outcome,last_failure,delivery,label,category_name,schedule,follow_up,refund').eq('household_id',c.householdId).eq('user_id',c.userId).eq('template','issue_follow_through').in('status',['active','snoozed','draft']).order('next_check_at',{ascending:true}).limit(100),
   db.from('finance_assistant_watches').select('watch_id,template,commitment,status,version,snoozed_until,expires_at,created_at,updated_at,next_check_at,last_checked_at,last_outcome,last_failure,delivery,label,category_name,schedule,follow_up,refund').eq('household_id',c.householdId).eq('user_id',c.userId).eq('template','issue_follow_through').in('status',['resolved','superseded']).order('updated_at',{ascending:false}).limit(20),
  ]),
  (state.messages||[]).some((m:Row)=>uuid(m.message_id))?db.from('finance_assistant_decision_receipts').select('receipt_id,proposal_id,message_id,outcome,evidence_kind,evidence_id,verified_at,created_at,updated_at').eq('household_id',c.householdId).eq('user_id',c.userId).in('message_id',(state.messages||[]).map((m:Row)=>m.message_id).filter((id:string)=>uuid(id))).order('updated_at',{ascending:false}).limit(200):Promise.resolve({data:[],error:null}),
 ]);
 const unavailable:string[]=[];
 if(taskResult?.error||!Array.isArray(taskResult?.data)){unavailable.push('scheduled_tasks');delete state.scheduled_tasks;}else state.scheduled_tasks=taskResult.data;
 if(!Array.isArray(commitmentResult)||commitmentResult.length!==2||commitmentResult.some((r:any)=>r?.error||!Array.isArray(r?.data))){unavailable.push('commitments');delete state.commitments;}else{const rows=[...commitmentResult[0].data,...commitmentResult[1].data];state.commitments=[...new Map(rows.map((r:any)=>[r.watch_id,r])).values()].map(commitmentView);}
 if(receiptResult?.error||!Array.isArray(receiptResult?.data))unavailable.push('decision_receipts');else{
  const byMessage=new Map<string,Row[]>();for(const r of receiptResult.data){const a=byMessage.get(r.message_id)||[];a.push(r);byMessage.set(r.message_id,a);}
  state.messages=(state.messages||[]).map((m:Row)=>({...m,...(byMessage.has(m.message_id)?{decision_receipts:byMessage.get(m.message_id)}:{})}));
 }
 if(unavailable.length)state.management_unavailable=unavailable;return state;
}
export async function assistantV2Operation(action:string,b:Row,c:Context,db:any,deps:Row={}):Promise<any|undefined>{
 if(action==='review_assistant_commitment')return reviewCommitment(db,c,b,deps);
 if(action==='confirm_assistant_commitment')return confirmCommitment(db,c,b);
 if(action==='set_assistant_commitment_state')return commitmentState(db,c,b);
 if(action==='set_assistant_message_lifecycle')return lifecycle(db,c,b);
 if(action==='save_assistant_memory')return memorySave(db,c,b);
 if(action==='list_assistant_memories')return listPersonalMemories(db,c,b);
 if(action==='record_assistant_decision_receipt')return receipt(db,c,b);
 if(action==='claim_assistant_decision_receipt')return claimProposalExecution(db,c,b);
 if(action==='review_assistant_task')return taskReview(db,c,b);
 if(action==='confirm_assistant_task')return taskConfirm(db,c,b);
 if(action==='review_assistant_watch_state')return reviewWatchState(db,c,b);
 if(action==='confirm_assistant_watch_state')return confirmWatchState(db,c,b);
 if(action==='list_assistant_tasks'){clean(b,['action','household_id']);const s=await enrichState(db,c,{messages:[],scheduled_tasks:[],commitments:[]});if(!Array.isArray(s.scheduled_tasks)||s.management_unavailable?.includes('scheduled_tasks'))fail('Scheduled task management is temporarily unavailable.',503);return {scheduled_tasks:s.scheduled_tasks};}
 if(action==='get_assistant_task_status'){clean(b,['action','household_id','task_id']);const s=await enrichState(db,c,{messages:[],scheduled_tasks:[],commitments:[]});if(!Array.isArray(s.scheduled_tasks)||s.management_unavailable?.includes('scheduled_tasks'))fail('Scheduled task management is temporarily unavailable.',503);const task=s.scheduled_tasks.find((x:Row)=>x.task_id===b.task_id);if(!task)fail('Scheduled task is unavailable.',404);return {task};}
 if(action==='list_assistant_watches'){clean(b,['action','household_id']);const s=await enrichState(db,c,{messages:[],scheduled_tasks:[],commitments:[]});if(!Array.isArray(s.commitments)||s.management_unavailable?.includes('commitments'))fail('Commitment management is temporarily unavailable.',503);const ws=checked(await db.from('finance_assistant_watches').select('*').eq('household_id',c.householdId).eq('user_id',c.userId).in('status',['active','snoozed']).limit(20),'Assistant watches could not be loaded.',503);return {watches:[...(ws||[]).filter((w:Row)=>w.template!=='issue_follow_through').map(toWatch),...s.commitments]};}
 return undefined;
}
export async function enrichAssistantStateV2(db:any,c:Context,state:Row){return enrichState(db,c,state);}
