import { notificationContext } from './notification-service.ts';
import { projectAssistantEvents } from './assistant-projection.ts';
import { insertTrustedAssistantMessage, listAssistantMessages, type AssistantOwner } from './assistant-storage.ts';

type Row = Record<string, any>;
type AssistantSlot = { key: string; trigger: 'assistant_daily' | 'assistant_weekly'; local_date: string; local_week_start: string };
type Context = AssistantOwner;
const WEEKDAY = new Map([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]);

function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim() || zone.length > 80) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(new Date(0)); return true; } catch { return false; }
}
function clockMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function assistantLocalParts(now: Date, timezone: string) {
  if (!validZone(timezone) || !(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (name: string) => parts.find(part => part.type === name)?.value || '';
  const weekday = WEEKDAY.get(get('weekday'));
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour')), minute = Number(get('minute'));
  if (weekday === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { date, weekday, minute_of_day: hour * 60 + minute };
}
function localWeekStartSunday(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - utc.getUTCDay());
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}
function shiftLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number), utc = new Date(Date.UTC(year, month - 1, day + days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

/** Returns the due personal slots for this invocation using local wall-clock time. */
export function assistantScheduleSlots(now: Date, userId: string, preferences: Row): AssistantSlot[] {
  const timezone = preferences?.timezone;
  const local = assistantLocalParts(now, timezone);
  if (!local || typeof userId !== 'string' || !userId) return [];
  const weekStart = localWeekStartSunday(local.date), slots: AssistantSlot[] = [];
  if (preferences.assistant_daily_check_enabled === true) {
    const targetMinute = clockMinutes(preferences.assistant_daily_check_time);
    if (targetMinute !== null && local.minute_of_day >= targetMinute) {
      slots.push({ key: `assistant:${userId}:daily:${local.date}`, trigger: 'assistant_daily', local_date: local.date, local_week_start: weekStart });
    }
  }
  if (preferences.assistant_weekly_review_enabled === true) {
    const targetDay = preferences.assistant_weekly_review_day;
    const targetMinute = clockMinutes(preferences.assistant_weekly_review_time);
    if (Number.isInteger(targetDay) && targetDay >= 0 && targetDay <= 6 && targetMinute !== null) {
      const targetDate = shiftLocalDate(weekStart, targetDay);
      const targetIsEarlierDay = local.date > targetDate;
      const targetTimePassed = local.date === targetDate && local.minute_of_day >= targetMinute;
      if (targetIsEarlierDay || targetTimePassed) {
        slots.push({ key: `assistant:${userId}:weekly:${weekStart}`, trigger: 'assistant_weekly', local_date: local.date, local_week_start: weekStart });
      }
    }
  }
  return slots;
}

function fallbackWeeklyReviewSummary(events: any[], decisions: any[], goals: any[], forecast: any) {
  return { events: events.filter((event: any) => (event.delivery_channels || []).includes('weekly_review')).map((event: any) => ({ event_id: event.event_id, title: event.title, summary: event.summary, status: event.status })).slice(0, 12), resolved: decisions.filter((item: any) => ['approved', 'acknowledged', 'expected'].includes(item.feedback)).map((item: any) => ({ event_type: item.event_type, feedback: item.feedback })).slice(0, 12), goals: goals.map((goal: any) => ({ name: goal.name, current: goal.current_amount, target: goal.target_amount })), forecast };
}
function checked(result: any) { if (result?.error) throw new Error('Assistant scheduled check could not be saved.'); return result?.data; }
function eventKey(id: unknown, version: unknown) { return `event:${String(id)}:${Number(version)}`; }
function digestText(summary: Row, state: Row): string | null {
  const events = Array.isArray(summary.events) ? summary.events : [];
  const resolved = Array.isArray(summary.resolved) ? summary.resolved : [];
  const goals = Array.isArray(summary.goals) ? summary.goals : [];
  const forecastCurrent = state.forecast_current === true && !!summary.forecast;
  // Forecast freshness is supporting context, not a reason to emit a no-op digest.
  if (!events.length && !resolved.length && !goals.length) return null;
  const lines = ['Your Folio weekly review'];
  for (const event of events.slice(0, 5)) {
    const title = typeof event?.title === 'string' ? event.title.trim().slice(0, 120) : 'A financial item needs review';
    const detail = typeof event?.summary === 'string' ? event.summary.trim().slice(0, 240) : '';
    lines.push(`• ${title}${detail ? `: ${detail}` : ''}`);
  }
  if (resolved.length) lines.push(`• ${resolved.length} recent item${resolved.length === 1 ? '' : 's'} were marked resolved, expected, or acknowledged.`);
  const goalNames = goals.slice(0, 4).map((goal: Row) => typeof goal?.name === 'string' ? goal.name.trim().slice(0, 70) : '').filter(Boolean);
  if (goalNames.length) lines.push(`• Active goals: ${goalNames.join(', ')}.`);
  if (forecastCurrent) {
    const evaluatedAt = typeof state.evaluated_at === 'string' && Number.isFinite(Date.parse(state.evaluated_at)) ? ` as of ${state.evaluated_at.slice(0, 10)}` : '';
    lines.push(`• Forecast freshness is current${evaluatedAt}.`);
  } else if (events.length || resolved.length || goals.length) {
    lines.push('• Forecast freshness is stale or unavailable, so I cannot treat this as an all-clear.');
  }
  return lines.join('\n').slice(0, 5800);
}

/** Evaluate personal schedule slots and project opted-in canonical events without model calls. */
export async function runAssistantScheduleForMember(db: any, context: Context, deps: Row, now = new Date()) {
  const owner = context;
  const settings = await notificationContext(db, owner);
  const preferences = settings.preferences || {};
  const slots = assistantScheduleSlots(now, context.userId, preferences);
  // In-app off is the hard delivery stop. Leave due claims unclaimed so a later
  // re-enable can catch up within the same local period.
  const claimed: AssistantSlot[] = [];
  if (preferences.in_app_enabled !== false) {
    for (const slot of slots) {
      if (checked(await db.rpc('claim_finance_agent_run', { p_household_id: context.householdId, p_key: slot.key, p_trigger: slot.trigger }))) claimed.push(slot);
    }
  }
  try {
    if (claimed.length && typeof deps.refreshAgentState === 'function') await deps.refreshAgentState(context);
    const eventResult = typeof deps.listAgentEvents === 'function' ? await deps.listAgentEvents(context) : { events: [] };
    const events = Array.isArray(eventResult?.events) ? eventResult.events : [];
    const projection = await projectAssistantEvents(db, context, events, preferences, now, { dailyCheckDue: claimed.some(slot => slot.trigger === 'assistant_daily') });
    for (const slot of claimed.filter(item => item.trigger === 'assistant_weekly')) {
      if (preferences.in_app_enabled === false || preferences.assistant_weekly_review_enabled !== true) continue;
      if (typeof deps.getAgentState !== 'function') throw new Error('Weekly review state is unavailable.');
      const result = await deps.getAgentState(context), state: Row = result?.agent_state || result || {};
      const feedback = checked(await db.from('finance_agent_event_feedback').select('event_type,feedback').eq('household_id', context.householdId).eq('actor_user_id', context.userId).gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString()).limit(100));
      const makeSummary = typeof deps.weeklyReviewSummary === 'function' ? deps.weeklyReviewSummary : fallbackWeeklyReviewSummary;
      const summary = makeSummary(events, feedback || [], state.active_goals || [], { current: state.forecast_current === true, evaluated_at: state.evaluated_at || null, forecast: state.current_forecast_summary || null });
      const content = digestText(summary, state);
      if (content) {
        const sourceKey = `weekly:${slot.local_week_start}`;
        const existing = await listAssistantMessages(db, owner, { source: 'weekly_review', source_key: sourceKey, limit: 1 });
        if (!existing.length) await insertTrustedAssistantMessage(db, owner, { source: 'weekly_review', source_key: sourceKey, content });
      }
    }
    for (const slot of claimed) checked(await db.from('finance_agent_schedule_runs').update({ status: 'succeeded', finished_at: now.toISOString(), metrics: { llm_calls: 0, assistant_messages: projection.created || 0 } }).eq('household_id', context.householdId).eq('run_key', slot.key));
    return { slots_due: slots.length, slots_claimed: claimed.length, projected: projection.created || 0, failed: 0, llm_calls: 0 };
  } catch {
    for (const slot of claimed) await db.from('finance_agent_schedule_runs').update({ status: 'failed', finished_at: now.toISOString(), metrics: { error: 'assistant_schedule_failed', llm_calls: 0 } }).eq('household_id', context.householdId).eq('run_key', slot.key);
    throw new Error('Assistant scheduled check could not be completed.');
  }
}
