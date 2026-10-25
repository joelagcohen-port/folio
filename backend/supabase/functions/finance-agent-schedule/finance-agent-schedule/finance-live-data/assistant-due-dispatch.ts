import { claimAssistantWatchRun, completeAssistantWatchRun, listDueAssistantWatches, listAssistantWatchPushOwners, claimAssistantWatchPushJobs, completeAssistantWatchPush, listAssistantMessages } from './assistant-storage.ts';
import { notificationContext } from './notification-service.ts';
import { getFolioPublicOrigin, sendPushJobs } from './push-delivery.ts';
import { validPushSubscription, quietHoursActive, quietHoursEnd } from './delivery-policy.ts';
import { loadAssistantRefundWatchEvidence, evaluateAssistantRefundObservation } from './assistant-refund-evidence.ts';
import { canonicalCommitmentObservation } from './assistant-v2-service.ts';

type Row = Record<string, any>;
type Context = { householdId: string; userId: string };
const ONE_OFF_CHECK_EVENTS: Record<string, string[]> = {
  cash_flow: ['cash_floor_risk', 'forecast_change'],
  budget: ['budget_pace_risk'],
  recurring: ['recurring_amount_change', 'recurring_payment_missing'],
  account_health: ['account_sync_issue'],
};
const MAX_BATCH = 50;
const RETRY_MS = 5 * 60_000;
function uuid(value: unknown) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function shortError() { return 'Assistant due check could not be completed.'; }
function checked(result: any, message = shortError()) { if (result?.error) throw new Error(message); return result?.data; }
function addMs(now: Date, ms: number, expiry: number) { return new Date(Math.min(now.getTime() + ms, Number.isFinite(expiry) && expiry > now.getTime() ? expiry : now.getTime() + ms)).toISOString(); }
function runTimestamp(ms: number) { return new Date(ms).toISOString().replace(/[-:.]/g, ''); }
function issueRunTimestamp(ms: number) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }

/** Uses the stored schedule timestamp, not the worker's arrival time, for stable retries. */
export function assistantWatchRunKey(watch: Row, now = new Date()): { run_key: string; due_at: string } | null {
  if (watch?.template === 'issue_follow_through') {
    const next = typeof watch.next_check_at === 'string' ? Date.parse(watch.next_check_at) : Date.parse(watch.commitment?.schedule?.due_at);
    if (!Number.isFinite(next)) return null;
    const slot = issueRunTimestamp(Math.floor(next / 900_000) * 900_000);
    return { run_key: `issue:${watch.watch_id}:v${watch.version}:${slot}`, due_at: new Date(Math.floor(next / 900_000) * 900_000).toISOString() };
  }
  if (watch?.template === 'one_time_follow_up' && typeof watch.schedule?.due_at === 'string' && Number.isFinite(Date.parse(watch.schedule.due_at))) {
    const due = new Date(watch.schedule.due_at).toISOString();
    return { run_key: `once:${runTimestamp(Date.parse(due))}`, due_at: due };
  }
  if (watch?.template === 'expected_refund') {
    const next = typeof watch.next_check_at === 'string' ? Date.parse(watch.next_check_at) : Date.parse(watch.schedule?.due_at);
    if (!Number.isFinite(next)) return null;
    const slot = runTimestamp(Math.floor(next / 900_000) * 900_000);
    const expiry = typeof watch.expires_at === 'string' ? Date.parse(watch.expires_at) : NaN;
    const deadline = typeof watch.schedule?.due_at === 'string' ? Date.parse(watch.schedule.due_at) : NaN;
    const phase = Number.isFinite(expiry) && now.getTime() >= expiry ? 'expired' : Number.isFinite(deadline) && next >= deadline ? 'deadline' : 'observe';
    return { run_key: `${phase}:${slot}`, due_at: new Date(next).toISOString() };
  }
  return null;
}

function dueOutcome(watch: Row, now: Date, snapshot: Row | null, events: Row[] | null): Row {
  const expiry = typeof watch.expires_at === 'string' ? Date.parse(watch.expires_at) : NaN;
  if (Number.isFinite(expiry) && now.getTime() >= expiry) return { outcome: { status: 'missed', dedupe_key: 'missed' }, message_content: 'I couldn’t complete this follow-up before its reviewed catch-up window ended. You can set a new time from Ask Folio.', next_check_at: null, terminal: true };
  const dueAt = typeof watch.schedule?.due_at === 'string' ? Date.parse(watch.schedule.due_at) : NaN;
  const delayed = Number.isFinite(dueAt) && now.getTime() - dueAt > 60_000;
  const delayNote = delayed ? 'This follow-up ran later than scheduled.' : '';
  const withDelay = (content: string) => delayNote ? `${delayNote}\n\n${content}` : content;
  const check = watch.follow_up?.check;
  const retry = () => ({ outcome: { status: 'unavailable', dedupe_key: 'once:unavailable' }, message_content: withDelay('I couldn’t verify the current Folio data for this follow-up yet. I’ll try again before the reviewed catch-up window ends; this is not an all-clear.'), next_check_at: addMs(now, RETRY_MS, expiry), terminal: false });
  if (check === 'reminder') {
    const text = typeof watch.follow_up?.reminder_text === 'string' ? watch.follow_up.reminder_text.trim().slice(0, 280) : '';
    if (!text) return retry();
    return { outcome: { status: 'completed', dedupe_key: 'once:completed' }, message_content: withDelay(`You asked me to remind you: ${text}`), next_check_at: null, terminal: true };
  }
  if (!Object.prototype.hasOwnProperty.call(ONE_OFF_CHECK_EVENTS, check) || !snapshot || !Array.isArray(events?.events) || events.complete !== true) return retry();
  const evaluated = typeof snapshot.evaluated_at === 'string' ? Date.parse(snapshot.evaluated_at) : NaN;
  if (!Number.isFinite(evaluated) || evaluated > now.getTime() + 5 * 60_000 || now.getTime() - evaluated > 15 * 60_000) return retry();
  const state: Row = snapshot.snapshot && typeof snapshot.snapshot === 'object' ? snapshot.snapshot : {};
  if (check === 'cash_flow' && (state.forecast_current !== true || Number(state.forecast_contract_revision) !== 1)) return retry();
  if (check === 'budget' && (state.budgets_ready !== true || state.budget_coaching_ready !== true)) return retry();
  if (check === 'recurring' && state.recurringComplete !== true) return retry();
  if (check === 'account_health' && (state.accounts_ready !== true || !Array.isArray(state.accounts))) return retry();
  const relevant = events.events.filter((event: Row) => {
    if (!ONE_OFF_CHECK_EVENTS[check].includes(String(event.event_type || '')) || !['new', 'surfaced'].includes(String(event.status || ''))) return false;
    if (['acted', 'acknowledged', 'dismissed', 'expected', 'wrong'].includes(String(event.user_disposition || ''))) return false;
    if (event.expires_at && Date.parse(String(event.expires_at)) <= now.getTime()) return false;
    if (check === 'budget' && watch.follow_up?.category_name) {
      const facts = event.facts && typeof event.facts === 'object' ? event.facts : {};
      if (facts.category !== watch.follow_up.category_name && facts.category_name !== watch.follow_up.category_name) return false;
    }
    return true;
  });
  if (relevant.some((event: Row) => typeof event.last_seen_at !== 'string' || !Number.isFinite(Date.parse(event.last_seen_at)) || now.getTime() - Date.parse(event.last_seen_at) > 48 * 60 * 60_000)) return retry();
  const labels: Record<string, string> = { cash_flow: 'cash flow', budget: watch.follow_up?.category_name ? `${String(watch.follow_up.category_name).slice(0, 100)} budget` : 'budget', recurring: 'recurring payments', account_health: 'account connections' };
  const lines = [`I checked your ${labels[check] || 'Folio follow-up'} using the latest saved evaluation from ${new Date(evaluated).toISOString().slice(0, 10)}.`];
  if (relevant.length) {
    lines.push('Here’s what Folio reported:');
    for (const event of relevant.slice(0, 4)) {
      const title = typeof event.title === 'string' ? event.title.trim().slice(0, 120) : 'A current item needs review';
      const summary = typeof event.summary === 'string' ? event.summary.trim().slice(0, 360) : '';
      lines.push(`• ${title}${summary ? `: ${summary}` : ''}`);
    }
  } else {
    lines.push('No current matching alert was reported in that evaluation. This does not confirm that every account or data source is current.');
  }
  return { outcome: { status: 'completed', dedupe_key: 'once:completed' }, message_content: withDelay(lines.join('\n').slice(0, 5800)), next_check_at: null, terminal: true };
}
export const evaluateAssistantOneOffResult = dueOutcome;

async function evaluateClaimedWatch(db: any, context: Context, watch: Row, deps: Row, now: Date): Promise<Row | null> {
  if (watch.template === 'issue_follow_through') return evaluateAssistantCommitment(db, context, watch, deps, now);
  if (watch.template === 'one_time_follow_up') {
    const dueAt = Date.parse(watch.schedule?.due_at);
    if (!Number.isFinite(dueAt) || now.getTime() < dueAt) return null;
    if (now.getTime() >= Date.parse(watch.expires_at)) return dueOutcome(watch, now, null, null);
    if (watch.follow_up?.check === 'reminder') return dueOutcome(watch, now, null, null);
    try {
      if (typeof deps.refreshAgentState !== 'function') return dueOutcome(watch, now, null, null);
      await deps.refreshAgentState(context);
      const check = watch.follow_up?.check, eventTypes = ONE_OFF_CHECK_EVENTS[check];
      if (!eventTypes) return dueOutcome(watch, now, null, null);
      const [snapshotResult, eventsResult] = await Promise.all([
        db.from('finance_agent_state_snapshots').select('snapshot,state_version,evaluated_at').eq('household_id', context.householdId).maybeSingle(),
        db.from('finance_agent_events').select('event_id,event_type,event_version,title,summary,facts,status,attention_score,last_seen_at,expires_at').eq('household_id', context.householdId).in('event_type', eventTypes).in('status', ['new', 'surfaced', 'acknowledged']).gte('attention_score', 0.2).gt('expires_at', now.toISOString()).order('attention_score', { ascending: false }).limit(101),
      ]);
      if (snapshotResult?.error || !snapshotResult?.data || eventsResult?.error || !Array.isArray(eventsResult?.data) || eventsResult.data.length > 100) return dueOutcome(watch, now, null, null);
      const rows = eventsResult.data;
      let states: Row[] = [];
      if (rows.length) {
        const stateResult = await db.from('finance_agent_event_user_state').select('event_id,disposition,snoozed_until').eq('household_id', context.householdId).eq('user_id', context.userId).in('event_id', rows.map((event: Row) => event.event_id));
        if (stateResult?.error || !Array.isArray(stateResult?.data)) return dueOutcome(watch, now, null, null);
        states = stateResult.data;
      }
      const stateByEvent = new Map(states.map((state: Row) => [String(state.event_id), state]));
      const visible = rows.filter((event: Row) => {
        const state = stateByEvent.get(String(event.event_id));
        const disposition = String(state?.disposition || '');
        if (['acted', 'acknowledged', 'dismissed', 'expected', 'wrong'].includes(disposition)) return false;
        if (disposition === 'snoozed' && (!Number.isFinite(Date.parse(String(state?.snoozed_until || ''))) || Date.parse(String(state?.snoozed_until)) > now.getTime())) return false;
        return true;
      }).map((event: Row) => ({ ...event, user_disposition: stateByEvent.get(String(event.event_id))?.disposition || null }));
      return dueOutcome(watch, now, snapshotResult.data, { events: visible, complete: true });
    } catch { return dueOutcome(watch, now, null, null); }
  }
  if (watch.template !== 'expected_refund') return null;
  if (now.getTime() >= Date.parse(watch.expires_at)) return { outcome: { status: 'missed', dedupe_key: 'missed' }, message_content: 'I could not verify the expected refund before this watch expired. You can review the purchase in Folio’s refund review screen.', next_check_at: null, terminal: true };
  try {
    const evidence = await loadAssistantRefundWatchEvidence(db, context, watch.refund?.original_transaction_id, now);
    const messageKey = (dedupeKey: string) => `watch:${watch.watch_id}:${watch.version}:${dedupeKey}`;
    const notReceived = await listAssistantMessages(db, context, { source: 'watch', source_key: messageKey('not_received'), limit: 1 });
    let result = await evaluateAssistantRefundObservation(watch, evidence, now, { not_received_seen: notReceived.length > 0 });
    if (result.outcome.status === 'partial' && result.outcome.dedupe_key) {
      const priorPartial = await listAssistantMessages(db, context, { source: 'watch', source_key: messageKey(result.outcome.dedupe_key), limit: 1 });
      if (priorPartial.length) result = { ...result, outcome: { status: 'pending' }, message_content: null };
    }
    return result;
  } catch {
    return { outcome: { status: 'unavailable', dedupe_key: 'once:unavailable' }, message_content: 'I can’t verify the current bank evidence for this expected refund yet. I’ll check again; this is not confirmation that a refund is missing.', next_check_at: addMs(now, 15 * 60_000, Date.parse(watch.schedule?.due_at)), terminal: false };
  }
}

function compatiblePeriod(a: Row, b: Row) {
 if(a?.kind!==b?.kind)return false;
 if(a.kind==='forecast')return a.horizon_days===b.horizon_days&&a.account_scope===b.account_scope&&a.account_scope_key===b.account_scope_key;
 if(a.kind==='budget')return a.month===b.month&&a.category_id===b.category_id&&a.category_name===b.category_name&&a.target_minor===b.target_minor&&a.timezone===b.timezone;
 return false;
}
async function hashJson(value: unknown) { const bytes = new TextEncoder().encode(JSON.stringify(value)); const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return [...sum].map(x => x.toString(16).padStart(2, '0')).join(''); }
function issueResultText(watch: Row, obs: Row, prior: Row, now: Date) {
 const condition=watch.commitment.condition, baseline=watch.commitment.baseline;
 if(condition.metric==='cash_buffer'){
  const delta=Number(prior.value_minor)-Number(obs.value), floor=Number(condition.comparator.floor_minor);
  const oldDate=String(prior.low_date||prior.period?.low_date||baseline.period.low_date), newDate=String(obs.period.low_date);
  return `I rechecked the same cash-flow issue using a fresh verified ${obs.period.horizon_days}-day forecast. Its projected low is now $${(Number(obs.value)/100).toFixed(2)} on ${newDate}, compared with $${(Number(prior.value_minor)/100).toFixed(2)} on ${oldDate} at the last reviewed/delivered check. That is materially worse under your reviewed rule${Number(obs.value)<floor?` and is below the $${(floor/100).toFixed(2)} floor`:''}. I’m flagging it so you can review Planning; I have not moved money or changed a budget.`;
 }
 const rise=Number(obs.value)-Number(prior.value_minor);
 return `I rechecked the same ${obs.period.category_name} budget issue using fresh verified current-period data. Its projected overage is now $${(Number(obs.value)/100).toFixed(2)}, up from $${(Number(prior.value_minor)/100).toFixed(2)} at the last reviewed/delivered check. That is materially worse under your reviewed rule. You can review the category budget; ordinary purchases alone did not trigger this notice.`;
}
export async function evaluateAssistantCommitment(db:any,context:Context,watch:Row,deps:Row,now:Date):Promise<Row>{
 const expiry=Date.parse(String(watch.expires_at||watch.commitment?.expires_at||''));
 const safeFailure='Folio could not verify fresh, comparable data for this commitment. This is not an all-clear. Review the saved check or create a new one before relying on it.';
 const retryAt=()=>new Date(Math.min(now.getTime()+15*60_000,Number.isFinite(expiry)&&expiry>now.getTime()?expiry:now.getTime()+15*60_000)).toISOString();
 const unavailable=(failure=safeFailure,final=Number(watch.consecutive_data_failures||0)>=2):Row=>{
  if(!final)return {outcome:{status:'data_unavailable',failure},next_check_at:retryAt(),terminal:false};
  const hash='issue:'+watch.watch_id+':v'+watch.version+':';
  return {outcome:{status:'data_unavailable',failure,final_failure:true,dedupe_key:hash+'0'.repeat(64),message_content:safeFailure,value_minor:Number(watch.commitment.baseline.value_minor),source_revision:String(watch.commitment.baseline.source_revision)},next_check_at:null,terminal:true};
 };
 if(Number.isFinite(expiry)&&now.getTime()>=expiry)return {outcome:{status:'missed',failure:'This reviewed conditional check reached its fixed end date without a verified result. No all-clear was inferred; review a new check if you still need one.'},next_check_at:null,terminal:true};
 try{
  if(typeof deps.refreshAgentState!=='function')return unavailable();
  await deps.refreshAgentState(context);
  const snapResult=await db.from('finance_agent_state_snapshots').select('snapshot,evaluated_at').eq('household_id',context.householdId).maybeSingle();
  if(snapResult?.error||!snapResult?.data||!snapResult.data.snapshot||!Number.isFinite(Date.parse(snapResult.data.evaluated_at))||now.getTime()-Date.parse(snapResult.data.evaluated_at)>15*60_000||Date.parse(snapResult.data.evaluated_at)>now.getTime()+5*60_000)return unavailable();
  const snapshot=snapResult.data.snapshot;
  if(watch.commitment.condition.metric==='cash_buffer'&&(snapshot.forecast_current!==true||Number(snapshot.forecast_contract_revision)!==1))return unavailable();
  if(watch.commitment.condition.metric==='category_budget'&&(snapshot.budgets_ready!==true||snapshot.budget_coaching_ready!==true))return unavailable();
  const eventResult=await db.from('finance_agent_events').select('event_id,event_type,event_version,title,summary,facts,status,updated_at,expires_at').eq('household_id',context.householdId).eq('event_id',watch.origin_event_id).maybeSingle();
  if(eventResult?.error)return unavailable();
  const event=eventResult.data;
  if(!event){
   // Missing source is not treated as resolved: canonical deletion/retention cannot prove resolution.
   return unavailable('The original issue is no longer available as a canonical record. No all-clear was inferred; review this commitment.');
  }
  if(watch.commitment.end_condition.kind==='issue_resolved'&&['resolved','completed'].includes(String(event.status)))return {outcome:{status:'improved'},next_check_at:null,terminal:true};
  if(!['new','surfaced','acknowledged'].includes(String(event.status))||event.expires_at&&Date.parse(event.expires_at)<=now.getTime()){if(watch.commitment.condition.kind==='only_if_worse'&&['resolved','completed'].includes(String(event.status)))return {outcome:{status:'improved'},next_check_at:null,terminal:true};return unavailable('The original issue changed status and its current comparison is not verifiable. No all-clear was inferred.');}
  const verifiedEvent={...event,updated_at:snapResult.data.evaluated_at};
  const obs=canonicalCommitmentObservation(verifiedEvent,now.getTime()), baseline=watch.commitment.baseline, condition=watch.commitment.condition;
  if(obs.metric!==baseline.metric||obs.currency!=='USD'||!compatiblePeriod(obs.period,baseline.period)||Date.parse(event.updated_at)<Date.parse(baseline.captured_at))return unavailable('The current evidence no longer matches the reviewed currency, period, horizon, or account/category scope. Review a new baseline.');
  if(watch.commitment.end_condition.kind==='verified_payday'){
   const payroll=await db.from('finance_agent_events').select('event_id,facts,updated_at').eq('household_id',context.householdId).eq('event_type','income_received').gt('updated_at',baseline.captured_at).order('updated_at',{ascending:false}).limit(20);
   if(payroll?.error)return unavailable();
   const end=watch.commitment.end_condition,baselineLocal=(function(){try{return new Intl.DateTimeFormat('en-CA',{timeZone:end.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(baseline.captured_at));}catch{return '';}})();
   const selected=(payroll.data||[]).filter((r:Row)=>r.facts&&typeof r.facts==='object'&&r.facts.stream_key===end.stream_key&&/^20\d\d-\d\d-\d\d$/.test(String(r.facts.last_date||''))&&String(r.facts.last_date)>=baselineLocal&&String(r.facts.last_date)<=new Date(Date.parse(end.expected_date+'T00:00:00Z')+7*86400000).toISOString().slice(0,10)&&Array.isArray(r.facts.transaction_ids)).slice(0,20);
   const linkedIds=[...new Set(selected.flatMap((r:Row)=>r.facts.transaction_ids).filter((id:any)=>typeof id==='string'&&id.length>0&&id.length<=180&&!/[\u0000-\u001f\u007f]/.test(id)))].slice(0,100);
   let verifiedTransactions:Row[]=[];
   if(linkedIds.length){const tx=await db.from('finance_effective_transactions').select('transaction_id,effective_transaction_date,amount,iso_currency_code,effective_type,pending,excluded_from_totals,transaction_excluded_from_cash_flow,transfer_network,transfer_direction').eq('household_id',context.householdId).in('transaction_id',linkedIds).limit(100);if(tx?.error)return unavailable();verifiedTransactions=Array.isArray(tx.data)?tx.data.filter((row:Row)=>row.pending===false&&row.excluded_from_totals!==true&&row.transaction_excluded_from_cash_flow!==true&&row.effective_type==='income'&&Number(row.amount)<0&&row.iso_currency_code==='USD'&&!row.transfer_network&&!row.transfer_direction&&selected.some((r:Row)=>r.facts.last_date===String(row.effective_transaction_date||'').slice(0,10)&&r.facts.transaction_ids.includes(row.transaction_id))):[];}
   if(verifiedTransactions.length)return {outcome:{status:'completed'},next_check_at:null,terminal:true};
  }
  if(watch.commitment.end_condition.kind==='budget_period_end'){
   const currentMonth=new Intl.DateTimeFormat('en-CA',{timeZone:watch.commitment.end_condition.timezone,year:'numeric',month:'2-digit'}).format(now);
   if(currentMonth>baseline.period.month)return {outcome:{status:'completed'},next_check_at:null,terminal:true};
  }
  const lastValue=Number.isSafeInteger(watch.last_delivered_value_minor)?Number(watch.last_delivered_value_minor):Number(baseline.value_minor);
  const prior={metric:baseline.metric,value_minor:lastValue,reference_minor:Number(baseline.reference_minor),currency:'USD',period:baseline.period,low_date:watch.last_delivered_low_date||baseline.period.low_date};
  const wasWorse=materiallyWorseCommitment(prior,obs,condition);
  if(wasWorse){
   const fingerprint=await hashJson({metric:obs.metric,value_minor:obs.value,low_date:obs.period.low_date||null,period:obs.period});
   const comparison={value_minor:obs.value,low_date:obs.period.low_date||undefined,source_revision:obs.source_revision};
   const terminal=condition.metric==='cash_buffer'&&watch.commitment.schedule.kind!=='event_driven'||watch.commitment.schedule.kind!=='event_driven';
   return {outcome:{status:'worsened',dedupe_key:`issue:${watch.watch_id}:v${watch.version}:${fingerprint}`,message_content:issueResultText(watch,obs,prior,now),...comparison},next_check_at:terminal?null:new Date(now.getTime()+15*60_000).toISOString(),terminal};
  }
  const improved=condition.metric==='cash_buffer'?obs.value>Number(baseline.value_minor):obs.value<Number(baseline.value_minor);
  const terminal=watch.commitment.schedule.kind!=='event_driven';
  return {outcome:{status:improved?'improved':'unchanged'},next_check_at:terminal?null:new Date(now.getTime()+15*60_000).toISOString(),terminal};
 }catch{return unavailable();}
}
function materiallyWorseCommitment(prior:Row,obs:Row,condition:Row){
 if(!compatiblePeriod(prior.period,obs.period))return false;
 if(condition.metric==='cash_buffer'){
  const delta=Number(prior.value_minor)-Number(obs.value),floor=Number(condition.comparator.floor_minor);
  const crossed=Number(prior.value_minor)>=floor&&Number(obs.value)<floor;
  const earlier=(Date.parse(String(prior.low_date||prior.period.low_date)+'T00:00:00Z')-Date.parse(String(obs.period.low_date)+'T00:00:00Z'))/86400000;
  return crossed||delta>=Math.max(Number(condition.comparator.min_decline_minor),Math.abs(Number(prior.value_minor)*Number(condition.comparator.relative_percent)/100))||earlier>=Number(condition.comparator.earlier_low_date_days);
 }
 const increase=Number(obs.value)-Number(prior.value_minor);
 return increase>=Math.max(Number(condition.comparator.min_increase_minor),Math.abs(Number(condition.comparator.target_minor)*Number(condition.comparator.relative_percent)/100));
}

/** Lightweight due-only worker: never enters household maintenance or refresh paths. */
export async function runAssistantDueWatches(db: any, deps: Row = {}, now = new Date()) {
  const nowIso = now.toISOString();
  let candidates: Row[] = [];
  const owners = new Map<string, Context>();
  const settingsByOwner = new Map<string, Row | null>();
  const refreshByHousehold=new Map<string,Promise<any>>();
  const refreshEvidence=(context:Context)=>{
    if(typeof deps.refreshAgentState!=='function')throw new Error('assistant_evidence_refresh_unavailable');
    let promise=refreshByHousehold.get(context.householdId);
    if(!promise){promise=Promise.resolve().then(()=>deps.refreshAgentState(context));refreshByHousehold.set(context.householdId,promise);}
    return promise;
  };
  const evaluationDeps={...deps,refreshAgentState:refreshEvidence};
  const totals = { scanned: 0, claimed: 0, completed: 0, messages: 0, pushed: 0, failed: 0, llm_calls: 0 };
  try { candidates = await listDueAssistantWatches(db, nowIso, MAX_BATCH); totals.scanned = candidates.length; }
  catch { totals.failed++; }
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, MAX_BATCH) : []) {
    const context: Context = { householdId: String(candidate.household_id || ''), userId: String(candidate.user_id || '') };
    if (!context.householdId || !context.userId || !uuid(candidate.watch_id) || !Number.isSafeInteger(candidate.version)) continue;
    const key = `${context.householdId}:${context.userId}`;
    let settings = settingsByOwner.get(key);
    if (settings === undefined) {
      try { settings = await notificationContext(db, context); settingsByOwner.set(key, settings); }
      catch { settingsByOwner.set(key, null); totals.failed++; continue; }
    }
    if (!settings) continue;
    // Existing in-app opt-out remains a hard stop for watch messages and outbox creation.
    if (settings?.preferences?.in_app_enabled === false) continue;
    owners.set(key, context);
    const slot = assistantWatchRunKey(candidate, now);
    if (!slot) continue;
    let claimed: any;
    try {
      claimed = await claimAssistantWatchRun(db, context, { watch_id: candidate.watch_id, watch_version: Number(candidate.version), run_key: slot.run_key, due_at: slot.due_at }, nowIso);
    } catch { totals.failed++; continue; }
    if (!claimed || !claimed.watch) continue;
    totals.claimed++;
    const watch: Row = claimed.watch;
    let result: Row | null = null;
    try { result = await evaluateClaimedWatch(db, context, watch, evaluationDeps, now); } catch { totals.failed++; }
    if (!result) continue;
    try {
      const saved = await completeAssistantWatchRun(db, context, {
        run_id: claimed.run_id, claim_token: claimed.claim_token, watch_version: Number(watch.version),
        outcome: { ...result.outcome, ...(typeof result.message_content === 'string' && result.message_content ? { message_content: result.message_content } : {}) },
        next_check_at: result.next_check_at, terminal: result.terminal === true, template: watch.template,
      }, nowIso);
      if (saved?.status === 'stale_source') totals.failed++;
      else totals.completed++;
      if (saved?.message_id || claimed?.message_id) totals.messages++;
    } catch { totals.failed++; }
  }
  // Deferred outbox owners are scanned independently from due watches so terminal
  // messages with quiet-hour/cap deferrals are not stranded on later ticks.
  try {
    const pushOwners = await listAssistantWatchPushOwners(db, nowIso, MAX_BATCH);
    for (const item of pushOwners) {
      const context = { householdId: item.household_id, userId: item.user_id };
      owners.set(`${context.householdId}:${context.userId}`, context);
    }
  } catch { totals.failed++; }
  // The private outbox claim uses the same transport/endpoint verifier and its SQL
  // claim shares the rolling cap/advisory lock with legacy event pushes.
  if (typeof deps.buildPushPayload === 'function') for (const context of owners.values()) {
    try {
      const ownerKey = `${context.householdId}:${context.userId}`;
      let settings = settingsByOwner.get(ownerKey);
      if (settings === undefined) { settings = await notificationContext(db, context); settingsByOwner.set(ownerKey, settings); }
      if (!settings || settings.preferences?.in_app_enabled === false || settings.preferences?.push_enabled !== true) continue;
      const deferUntil = quietHoursActive(settings.preferences, now) ? quietHoursEnd(settings.preferences, now) : null;
      const jobs: any[] = await claimAssistantWatchPushJobs(db, context, nowIso, deferUntil);
      if (!jobs.length) continue;
      const keys = checked(await db.rpc('finance_agent_push_keys'));
      if (!keys?.privateKey || !keys?.publicKey) { totals.failed += jobs.length; continue; }
      const result = await sendPushJobs(jobs, { ...keys, subject: getFolioPublicOrigin() }, deps.buildPushPayload,
        (args: any) => {
          const status = args.results.some((item: Row) => item.http_status === 0) ? 'uncertain' : args.results.length && args.results.every((item: Row) => item.http_status >= 200 && item.http_status < 300) ? 'sent' : 'failed';
          const job = jobs.find((item: Row) => item.delivery_id === args.delivery_id);
          if (!job?.run_id) throw new Error('Assistant push claim is invalid.');
          return completeAssistantWatchPush(db, context, { run_id: job.run_id, claim_token: args.claim_token, status, results: args.results, attempted_at: nowIso });
        }, validPushSubscription);
      totals.pushed += result.sent; totals.failed += result.failed;
    } catch { totals.failed++; }
  }
  return totals;
}

/** Refresh-triggered checks are limited to each member's already-active event-driven issue commitments. */
export async function runAssistantCommitmentsAfterRefresh(db:any,context:Context,deps:Row={},now=new Date()){
 const result={scanned:0,claimed:0,completed:0,messages:0,failed:0};
 const rows=await db.from('finance_assistant_watches').select('watch_id,version,household_id,user_id,template,status,commitment,origin_event_id,origin_event_version,expires_at,next_check_at,last_outcome,last_checked_at,last_failure,consecutive_data_failures,last_delivered_value_minor,last_delivered_low_date,last_delivered_source_revision').eq('household_id',context.householdId).eq('user_id',context.userId).eq('template','issue_follow_through').eq('status','active').limit(20);
 if(rows?.error||!Array.isArray(rows?.data))throw new Error('assistant_commitment_refresh_scan_failed');
 for(const candidate of rows.data){
  if(candidate.commitment?.schedule?.kind!=='event_driven')continue;result.scanned++;
  let claim:any;try{claim=checked(await db.rpc('finance_claim_assistant_commitment_refresh',{p_household_id:context.householdId,p_user_id:context.userId,p_watch_id:candidate.watch_id,p_watch_version:candidate.version,p_now:now.toISOString()}),'Assistant commitment refresh could not be claimed.');}catch{result.failed++;continue;}
  if(!claim||!claim.run_id)continue;result.claimed++;
  let evaluated:Row;try{evaluated=await evaluateAssistantCommitment(db,context,claim.watch,{...deps,refreshAgentState:async()=>{}},now);}catch{result.failed++;continue;}
  try{
   const outcome=evaluated.outcome||{status:'data_unavailable',failure:shortError()};
   const saved=await completeAssistantWatchRun(db,context,{run_id:claim.run_id,claim_token:claim.claim_token,watch_version:Number(claim.watch.version),outcome,...(typeof evaluated.message_content==='string'?{}:{}),next_check_at:evaluated.next_check_at??null,terminal:evaluated.terminal===true,template:candidate.template},now.toISOString());
   if(saved?.status==='stale_source')result.failed++;else result.completed++;if(saved?.message_id)result.messages++;
  }catch{result.failed++;}
 }
 return result;
}
