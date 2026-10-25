type Row = Record<string, any>;
import { notificationContext } from './notification-service.ts';
import { quietHoursActive, quietHoursEnd, validPushSubscription } from './delivery-policy.ts';
import { getFolioPublicOrigin, sendPushJobs } from './push-delivery.ts';
const encoder = new TextEncoder();
async function sha256(value: string) { const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))); return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function local(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (key: string) => parts.find(item => item.type === key)?.value || "";
  return { weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday")), date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
function scheduledLocalTimeInstant(day: string, time: string, timezone: string): number | null {
  const [year, month, date] = day.split("-").map(Number), [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, date, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 5; attempt++) {
    const parts = local(new Date(candidate), timezone);
    if (parts.date === day && parts.time === time) return candidate;
    const [localYear, localMonth, localDate] = parts.date.split("-").map(Number), [localHour, localMinute] = parts.time.split(":").map(Number);
    const represented = Date.UTC(localYear, localMonth - 1, localDate, localHour, localMinute);
    candidate += desired - represented;
  }
  return null;
}
export function assistantTaskPeriodKey(task: Row, now: Date) {
  let current: ReturnType<typeof local>;
  try { current = local(now, task.timezone); } catch { return null; }
  const addDays = (day: string, count: number) => {
    const at = new Date(`${day}T12:00:00Z`); at.setUTCDate(at.getUTCDate() + count);
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
  };
  let occurrenceDate = task.cadence === "daily"
    ? current.date
    : addDays(current.date, -current.weekday + Number(task.weekday));
  const nowLocal = `${current.date}T${current.time}`;
  let occurrence = `${occurrenceDate}T${task.local_time}`;
  // If the next occurrence is still ahead today/this week, retain the latest
  // missed slot so a delayed scheduler can catch up before the next cadence.
  if (occurrence > nowLocal) {
    occurrenceDate = addDays(occurrenceDate, task.cadence === "daily" ? -1 : -7);
    occurrence = `${occurrenceDate}T${task.local_time}`;
  }
  const scheduledAt = scheduledLocalTimeInstant(occurrenceDate, task.local_time, task.timezone);
  // Catch up the current local slot if the scheduler was delayed, but never
  // consume an occurrence at or before creation/edit confirmation.
  if (occurrence > nowLocal || scheduledAt === null || scheduledAt > now.getTime() || scheduledAt <= Date.parse(task.starts_at)) return null;
  return `task:${task.task_id}:v${task.version}:${task.cadence}:${occurrenceDate}`;
}
function randomCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Queues due tasks and runs the bounded Site callback in EdgeRuntime background work. */
export async function dispatchDueAssistantTasks(db: any, now = new Date()) {
  const { data, error } = await db.from("finance_assistant_scheduled_tasks").select("task_id,version,cadence,weekday,local_time,timezone,starts_at,next_run_at,last_run_id,last_outcome,retryable,household_id,user_id").eq("enabled", true).limit(500);
  if (error || !Array.isArray(data)) throw new Error("assistant_task_scan_failed");
  const siteUrl = getFolioPublicOrigin();
  const results: Array<{ task_id: string; status: string }> = [];
  const pending: Promise<unknown>[] = [];
  const persistFailure=async(runId:string,capabilityHash:string)=>{
    try{const saved=await db.rpc('finance_fail_assistant_task_run',{p_run_id:runId,p_capability_hash:capabilityHash,p_failure:'The scheduled check could not be completed. Folio will retry if an attempt remains; otherwise review its saved status in Assistant settings.'});return !saved?.error;}
    catch{return false;}
  };
  for (const task of data as Row[]) {
    let sourceKey:string|null=null;
    const scheduledAt=typeof task.next_run_at==='string'?Date.parse(task.next_run_at):NaN;
    if(Number.isFinite(scheduledAt)){
      if(scheduledAt>now.getTime())continue;
      // A failed or lease-expired attempt retries the exact original period,
      // never a newly inferred period from the current local clock.
      if(task.last_run_id&&['failed','running','pending'].includes(String(task.last_outcome))){
        const prior=await db.from('finance_assistant_task_runs').select('run_id,source_key,status,attempt_count,lease_expires_at').eq('household_id',task.household_id).eq('user_id',task.user_id).eq('task_id',task.task_id).eq('run_id',task.last_run_id).maybeSingle();
        if(prior?.error){results.push({task_id:task.task_id,status:'unavailable'});continue;}
        if(prior?.data&&['failed','pending','running'].includes(String(prior.data.status))&&Number(prior.data.attempt_count)<3&&Date.parse(prior.data.lease_expires_at)<=now.getTime())sourceKey=String(prior.data.source_key||'');
        else if(prior?.data&&['pending','running'].includes(String(prior.data.status))&&Date.parse(prior.data.lease_expires_at)>now.getTime())continue;
      }
      if(!sourceKey){
        const grace=task.cadence==='daily'?24*60*60_000:7*24*60*60_000;
        if(now.getTime()-scheduledAt>grace){
          const missed=await db.rpc('finance_mark_missed_assistant_task_due',{p_task_id:task.task_id,p_expected_version:task.version,p_now:now.toISOString()});
          if(missed?.error)results.push({task_id:task.task_id,status:'unavailable'});
          else if(missed?.data?.status)results.push({task_id:task.task_id,status:String(missed.data.status)});
          continue;
        }
        try{
          const slot=local(new Date(scheduledAt),task.timezone);
          const resolved=scheduledLocalTimeInstant(slot.date,task.local_time,task.timezone);
          if(slot.time!==task.local_time||resolved===null||resolved!==scheduledAt||scheduledAt<=Date.parse(task.starts_at))continue;
          if(task.cadence==='weekly'&&slot.weekday!==Number(task.weekday))continue;
          sourceKey=`task:${task.task_id}:v${task.version}:${task.cadence}:${slot.date}`;
        }catch{continue;}
      }
    }else sourceKey=assistantTaskPeriodKey(task,now);
    if (!sourceKey) continue;
    const capability = randomCapability(), capabilityHash = await sha256(capability);
    const expiresAt = new Date(now.getTime() + 4 * 60_000).toISOString();
    const claim = await db.rpc("finance_claim_assistant_task_run", { p_task_id: task.task_id, p_source_key: sourceKey, p_capability_hash: capabilityHash, p_lease_expires_at: expiresAt });
    if (claim.error || !claim.data) { results.push({ task_id: task.task_id, status: "unavailable" }); continue; }
    if (claim.data.status !== "pending") { results.push({ task_id: task.task_id, status: String(claim.data.status) }); continue; }
    const runId = String(claim.data.run_id);
    results.push({ task_id: task.task_id, status: "queued" });
    pending.push((async () => {
      const tokenResult = await db.rpc("finance_folio_sites_service_token");
      const serviceToken = tokenResult?.data;
      if (tokenResult?.error || typeof serviceToken !== "string" || !serviceToken) {
        console.warn("Scheduled Folio task callback could not load its private Site credential.", { run_id: runId });
        await persistFailure(runId,capabilityHash);
        return;
      }
      try{
        const response = await fetch(`${siteUrl}/api/folio-assistant-run`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(100_000), headers: { "content-type": "application/json", "OAI-Sites-Authorization": `Bearer ${serviceToken}` }, body: JSON.stringify({ run_id: runId, capability }) });
        if (!response.ok) {console.warn("Scheduled Folio task callback failed.", { run_id: runId, http_status: response.status });await persistFailure(runId,capabilityHash);}
      }catch{console.warn("Scheduled Folio task callback failed.",{run_id:runId});await persistFailure(runId,capabilityHash);}
    })().catch(async() => { console.warn("Scheduled Folio task callback failed.", { run_id: runId });await persistFailure(runId,capabilityHash); }));
  }
  const runtime = (globalThis as any).EdgeRuntime;
  if (pending.length && typeof runtime?.waitUntil === "function") runtime.waitUntil(Promise.allSettled(pending));
  else if (pending.length) console.warn("Scheduled Folio task background runtime is unavailable; claimed runs will retry after their lease.");
  return { scanned: data.length, queued: results.filter(result => result.status === "queued").length, results: results.slice(0, 50) };
}

/** Delivers the exact saved task reply through the shared private push outbox. */
export async function dispatchAssistantTaskPushes(db:any,deps:any,now=new Date()){
 const nowIso=now.toISOString(),ownerResult=await db.rpc('finance_list_assistant_task_push_owners',{p_now:nowIso,p_limit:50});
 if(ownerResult?.error||!Array.isArray(ownerResult.data)||ownerResult.data.length>50)throw new Error('assistant_task_push_owners_unavailable');
 let sent=0,failed=0,deferred=0,claimed=0;
 for(const row of ownerResult.data){
  const context={householdId:String(row.household_id||''),userId:String(row.user_id||'')};if(!/^[0-9a-f-]{36}$/i.test(context.householdId)||!/^[0-9a-f-]{36}$/i.test(context.userId))continue;
  const delivery=await notificationContext(db,context);if(delivery.preferences.in_app_enabled===false||delivery.preferences.push_enabled!==true)continue;
  const defer=quietHoursActive(delivery.preferences,now)?quietHoursEnd(delivery.preferences,now):null;
  const claim=await db.rpc('finance_claim_assistant_task_push_jobs',{p_household_id:context.householdId,p_user_id:context.userId,p_now:nowIso,p_limit:20,p_defer_until:defer});
  if(claim?.error||!Array.isArray(claim.data))throw new Error('assistant_task_push_claim_failed');
  const jobs=claim.data;if(!jobs.length)continue;claimed+=jobs.length;if(defer){deferred+=jobs.length;continue;}
  const keys=await db.rpc('finance_agent_push_keys');
  if(keys?.error||!keys.data?.privateKey||!keys.data?.publicKey){for(const job of jobs){await db.rpc('finance_complete_assistant_task_push',{p_household_id:context.householdId,p_user_id:context.userId,p_delivery_id:job.delivery_id,p_claim_token:job.claim_token,p_status:'failed',p_results:[],p_attempted_at:nowIso});failed++;}continue;}
  const eligibleJobs:any[]=[];
  for(const job of jobs){
   const messageId=job?.payload?.message_id;if(typeof messageId!=='string'||!/^[0-9a-f-]{36}$/i.test(messageId))throw new Error('assistant_task_push_message_invalid');
   const message=await db.from('finance_assistant_messages').select('message_id,role,generation_status,source').eq('household_id',context.householdId).eq('user_id',context.userId).eq('message_id',messageId).maybeSingle();
   if(message?.error||!message?.data||message.data.role!=='assistant'||message.data.generation_status!=='complete'||message.data.source!=='scheduled_task'){
    await db.rpc('finance_complete_assistant_task_push',{p_household_id:context.householdId,p_user_id:context.userId,p_delivery_id:job.delivery_id,p_claim_token:job.claim_token,p_status:'failed',p_results:[],p_attempted_at:nowIso});failed++;continue;
   }
   const current=await db.from('finance_assistant_scheduled_tasks').select('task_id,version,enabled').eq('household_id',context.householdId).eq('user_id',context.userId).eq('task_id',job.task_id).maybeSingle();
   if(current?.error||!current?.data||current.data.enabled!==true||Number(current.data.version)!==Number(job.task_version)){
    await db.rpc('finance_complete_assistant_task_push',{p_household_id:context.householdId,p_user_id:context.userId,p_delivery_id:job.delivery_id,p_claim_token:job.claim_token,p_status:'cancelled',p_results:[],p_attempted_at:nowIso});failed++;continue;
   }
   // Keep private report text off lock screens. The exact saved message ID is
   // the deep link target; opening Folio reveals the full response in chat.
   eligibleJobs.push({...job,payload:{category:'assistant_task',message_id:messageId}});
  }
  const result=await sendPushJobs(eligibleJobs,{...keys.data,subject: getFolioPublicOrigin()},deps.buildPushPayload,async(args:any)=>{
   const status=args.results.some((x:Row)=>x.http_status===0)?'uncertain':args.results.length&&args.results.every((x:Row)=>x.http_status>=200&&x.http_status<300)?'sent':'failed';
   const r=await db.rpc('finance_complete_assistant_task_push',{p_household_id:context.householdId,p_user_id:context.userId,p_delivery_id:args.delivery_id,p_claim_token:args.claim_token,p_status:status,p_results:args.results,p_attempted_at:nowIso});if(r?.error)throw new Error('assistant_task_push_completion_failed');
  },validPushSubscription);
  sent+=result.sent;failed+=result.failed;
 }
 return {owners:ownerResult.data.length,claimed,sent,failed,deferred};
}
