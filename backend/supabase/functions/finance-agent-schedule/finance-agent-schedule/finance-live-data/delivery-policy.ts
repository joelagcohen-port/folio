// One deterministic routing policy. Financial detection and delivery never call AI.
import { deliveryChannels } from './agent-state.ts';
type Row = Record<string, any>;
export const NOTIFICATION_DEFAULTS = {
  push_enabled: false, in_app_enabled: true, autonomy_level: 'ask', cash_flow: true, budgets: true,
  recurring: true, income: true, account_health: true, transactions: true,
  weekly_review: true, investments: false, quiet_hours_enabled: false,
  quiet_hours_start: '22:00', quiet_hours_end: '07:00', timezone: 'UTC',
  assistant_proactive_enabled: false, assistant_daily_check_enabled: false, assistant_daily_check_time: '08:00',
  assistant_weekly_review_enabled: false, assistant_weekly_review_day: 0, assistant_weekly_review_time: '09:00',
};
export const PUSH_TYPES = ['account_sync_issue', 'cash_floor_risk', 'recurring_amount_change', 'plan_at_risk'];
export function eventCategory(type: string): string {
  if (type.startsWith('budget_') || type==='plan_at_risk') return 'budgets';
  if (['cash_floor_risk','forecast_change'].includes(type)) return 'cash_flow';
  if (type.includes('recurring')) return 'recurring';
  if (type.startsWith('income_')) return 'income';
  if (['account_sync_issue','duplicate_account_suspected'].includes(type)) return 'account_health';
  if (['net_worth_change','investment_change'].includes(type)) return 'investments';
  return 'transactions';
}
export function validatePreferences(input: Row): Row {
  const result: Row = {};
  for (const [key,value] of Object.entries(input)) {
    if (!Object.hasOwn(NOTIFICATION_DEFAULTS,key)) throw new Error('Unknown notification preference.');
    if(key==='autonomy_level'){if(!['recommend','ask','housekeeping'].includes(value))throw new Error('Choose a supported autonomy level.');}
    else if (key === 'assistant_weekly_review_day') {
      if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 6) throw new Error('Choose a weekday from Sunday through Saturday.');
    } else if (['assistant_daily_check_time', 'assistant_weekly_review_time'].includes(key)) {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Assistant schedule times must use valid local times.');
    } else if (typeof NOTIFICATION_DEFAULTS[key as keyof typeof NOTIFICATION_DEFAULTS] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('Notification switches must be true or false.');
    } else if (key === 'timezone') {
      if (typeof value !== 'string' || value.length > 80) throw new Error('Choose a valid time zone.');
      try { new Intl.DateTimeFormat('en',{timeZone:value}).format(); } catch { throw new Error('Choose a valid time zone.'); }
    } else if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Quiet hours must use valid times.');
    result[key] = value;
  }
  return result;
}
function minutesAt(now: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  return Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value);
}
export function quietHoursActive(p: Row, now: Date): boolean {
  if (!p.quiet_hours_enabled) return false;
  const parse = (s: string) => Number(s.slice(0,2))*60+Number(s.slice(3));
  const start=parse(p.quiet_hours_start),end=parse(p.quiet_hours_end),minute=minutesAt(now,p.timezone);
  // Equal start/end means quiet all day, never an accidental bypass.
  return start===end || (start<end ? minute>=start&&minute<end : minute>=start||minute<end);
}
export function quietHoursEnd(p: Row, now: Date): string {
  // Walk real instants to honor DST gaps and repeated wall-clock hours.
  for(let i=1;i<=1500;i++) { const next=new Date(Math.floor(now.getTime()/60000)*60000+i*60000);if(!quietHoursActive(p,next))return next.toISOString(); }
  return new Date(now.getTime()+86400000).toISOString();
}
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const closeMoney = (a: number, b: number) => Math.abs(a - b) <= 0.011;
/** Only deterministic, material plan evidence may authorize a plan push. */
export function materialPlanRisk(event: Row): boolean {
  if (event.event_type !== 'plan_at_risk' || !event.facts || typeof event.facts !== 'object') return false;
  const facts = event.facts as Row, evidence = Array.isArray(facts.evidence) ? facts.evidence : [];
  if (!['spending_reduction', 'savings', 'cash_floor'].includes(facts.plan_type) || typeof facts.plan_id !== 'string' || !facts.plan_id || !Number.isInteger(facts.plan_version) || !finiteNonnegative(facts.target) || !finiteNonnegative(facts.shortfall) || facts.shortfall <= 0 || !evidence.length) return false;
  const cashFloor = evidence.find((row: Row) => row?.source === 'existing_planning_forecast');
  if (cashFloor) {
    const item = cashFloor;
    const gap = item && finiteNumber(item.projected_low) && finiteNonnegative(item.floor) ? item.floor - item.projected_low : 0;
    const material = item && finiteNonnegative(item.floor) ? Math.max(25, item.floor * 0.05) : Infinity;
    return !!item && Number.isInteger(item.horizon_days) && item.horizon_days > 0 && item.scope === 'Connected cash accounts' && finiteNumber(item.projected_low) && finiteNonnegative(item.floor) && gap >= material && closeMoney(gap, facts.shortfall) && closeMoney(item.floor, facts.target);
  }
  if (facts.plan_type === 'cash_floor') return false;
  if (facts.plan_type === 'spending_reduction') {
    const item = evidence.find((row: Row) => row?.source === 'existing_budget_coach');
    if (!item || !finiteNonnegative(item.baseline_monthly) || !finiteNonnegative(item.projected_spend) || !Array.isArray(item.category_ids) || !item.category_ids.length || item.category_ids.some((id: unknown) => typeof id !== 'string' || !id)) return false;
    const measured = facts.target - (item.baseline_monthly - item.projected_spend), material = Math.max(25, facts.target * 0.05);
    return closeMoney(measured, facts.shortfall) && facts.shortfall >= material;
  }
  const item = evidence.find((row: Row) => row?.source === 'existing_goal_tracked_amount');
  if (!item || !Number.isInteger(item.months_remaining) || item.months_remaining < 0 || !finiteNonnegative(item.current) || !finiteNonnegative(item.activation_amount) || !finiteNonnegative(item.monthly_contribution) || !finiteNonnegative(item.projected_at_end)) return false;
  const projectedGap = Math.max(0, facts.target - item.projected_at_end), material = Math.max(25, facts.target * 0.05);
  return projectedGap > 0 && closeMoney(projectedGap, facts.shortfall) && (projectedGap >= material || item.months_remaining === 0);
}
export function routeEvent(event: Row, preferences: Row={}, history: Row[]=[], now=new Date()) {
  const p={...NOTIFICATION_DEFAULTS,...preferences},category=eventCategory(event.event_type);
  const result={event_id:event.event_id,channels:[] as string[],reason_codes:[] as string[],push_priority:'normal',defer_until:null as string|null};
  const stop=(reason:string)=>{result.reason_codes.push(reason);if(!result.channels.length)result.channels=['silent'];return result;};
  if (!['new','surfaced'].includes(event.status) || event.hidden || (event.expires_at&&Date.parse(event.expires_at)<=now.getTime())) return stop('resolved_or_hidden');
  if (!Number.isFinite(event.attention_score) || !p[category as keyof typeof p]) return stop('category_disabled');
  result.channels=deliveryChannels(event.attention_score).filter(c=>p.in_app_enabled || !['in_app','home','chat','assistant_inbox'].includes(c)).filter(c=>c!=='weekly_review'||p.weekly_review);
  const same=history.filter(d=>d.event_id===event.event_id&&Number(d.event_version)===Number(event.event_version));
  if(same.some(d=>d.opened_at||(d.channel==='push'&&['sent','sending','retry','uncertain'].includes(d.status)))) result.channels=result.channels.filter(c=>!['home','chat'].includes(c));
  if(p.in_app_enabled&&same.some(d=>d.channel==='push')&&!result.channels.includes('assistant_inbox'))result.channels.push('assistant_inbox');
  if(!p.push_enabled)return stop('push_disabled');
  if(!PUSH_TYPES.includes(event.event_type))return stop('type_not_push_eligible');
  if(event.event_type==='plan_at_risk'&&!materialPlanRisk(event))return stop('insufficient_plan_evidence');
  // Phase 1 scores multiply five factors. Meaningful recurring changes score
  // about .24; critical connection/cash risks about .5. Do not invent severity.
  const threshold=event.event_type==='recurring_amount_change'?.23:.4;
  if(event.attention_score<threshold||event.confidence<.85||event.novelty<.65||event.severity<.65||(event.actionability<.75&&event.urgency<.8))return stop('insufficient_value');
  if(event.last_seen_at&&now.getTime()-Date.parse(event.last_seen_at)>48*3600000)return stop('stale_evidence');
  if(same.some(d=>d.channel==='push'&&['sending','sent','uncertain','failed','cancelled'].includes(d.status)))return stop('already_attempted');
  if(same.some(d=>d.opened_at))return stop('already_opened');
  const recent=history.filter(d=>d.channel==='push'&&['sending','sent','uncertain','retry'].includes(d.status)&&!(d.event_id===event.event_id&&d.event_version===event.event_version)&&Date.parse(d.attempted_at||d.created_at)>now.getTime()-86400000);
  if(recent.length>=3)return stop('daily_cap');
  if(recent.some(d=>d.event_type===event.event_type&&Date.parse(d.attempted_at||d.created_at)>now.getTime()-6*3600000&&event.severity<Number(d.severity)+.2))return stop('type_cooldown');
  result.push_priority=event.urgency>=.9?'high':'normal';
  if(quietHoursActive(p,now)){result.defer_until=quietHoursEnd(p,now);return stop('quiet_hours');}
  result.channels.push('push');
  // A notification leads to an exact Inbox item even if the score was only
  // weekly-review level. In-app surfaces still obey the user's switch.
  if(p.in_app_enabled&&!result.channels.includes('assistant_inbox'))result.channels.push('assistant_inbox');
  return stop('eligible');
}
export function notificationPayload(event: Row) {
  const body: Record<string,string>={account_sync_issue:'An account connection needs attention.',cash_floor_risk:'Your cash forecast needs a review.',recurring_amount_change:'A recurring bill changed more than usual.',plan_at_risk:'A household plan needs review.'};
  return {event_id:event.event_id,event_version:event.event_version,title:'Folio · Financial alert',body:body[event.event_type]||'A financial change needs a review.',deep_link:`/?folio_event=${encodeURIComponent(event.event_id)}`,category:eventCategory(event.event_type),priority:event.urgency>=.9?'high':'normal'};
}
export function validPushSubscription(value: any): boolean {
  if(!value || typeof value.endpoint!=='string'||value.endpoint.length>2048)return false;
  try {const url=new URL(value.endpoint);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)return false;
    // Never let a client turn the sender into an arbitrary URL fetcher.
    if(!['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','web.push.apple.com'].includes(url.hostname)&&!url.hostname.endsWith('.push.apple.com'))return false;
  } catch{return false;}
  return typeof value.keys?.p256dh==='string'&&/^B[A-Za-z0-9_-]{86}={0,2}$/.test(value.keys.p256dh)&&typeof value.keys?.auth==='string'&&/^[A-Za-z0-9_-]{22}={0,2}$/.test(value.keys.auth);
}
