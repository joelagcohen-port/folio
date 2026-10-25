import { listAssistantMessages, listAssistantWatches, insertTrustedAssistantMessage, updateAssistantMessageLifecycle, type AssistantOwner } from './assistant-storage.ts';
import { matchAssistantWatch } from './assistant-watch-policy.ts';
import { NOTIFICATION_DEFAULTS, routeEvent } from './delivery-policy.ts';

type Row = Record<string, any>;
type Context = AssistantOwner;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_DISPOSITIONS = new Set(['acted', 'acknowledged', 'dismissed', 'expected', 'wrong']);
function checked(result: any) { if (result?.error) throw new Error('Assistant projection could not be reconciled.'); return result?.data; }
function eventSourceKey(event: Row) { return `event:${event.event_id}:${Number(event.event_version)}`; }
function staleEvidence(event: Row, now: Date) {
  const lastSeen = typeof event.last_seen_at === 'string' ? Date.parse(event.last_seen_at) : NaN;
  return !Number.isFinite(lastSeen) || lastSeen > now.getTime() + 5 * 60_000 || now.getTime() - lastSeen > 48 * 60 * 60_000;
}
function terminalEvent(event: Row, state: Row | undefined, now: Date) {
  const disposition = String(state?.disposition || event.user_disposition || '');
  if (TERMINAL_DISPOSITIONS.has(disposition)) return true;
  const snoozedUntil = state?.snoozed_until || event.user_snoozed_until || null;
  if (disposition === 'snoozed') {
    const until = typeof snoozedUntil === 'string' ? Date.parse(snoozedUntil) : NaN;
    if (!Number.isFinite(until) || until > now.getTime()) return true;
  }
  return !['new', 'surfaced'].includes(String(event.status || '')) || !!event.expires_at && Date.parse(event.expires_at) <= now.getTime();
}
function localDate(now:Date,timezone:string){try{return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}catch{return now.toISOString().slice(0,10);}}
function validMemoryDate(value:unknown):value is string{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const parsed=new Date(`${value}T00:00:00.000Z`);return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;}
function activePersonalMemories(rows:Row[],now:Date,timezone:string){const today=localDate(now,timezone);return rows.filter(m=>{const from=m.effectiveFrom??m.effective_from,until=m.effectiveUntil??m.effective_until;return (!from||validMemoryDate(from)&&from<=today)&&(!until||validMemoryDate(until)&&until>=today);}).slice(-24);}
function relevantMemory(event: Row, memories: Row[]): Row | null {
  const facts = event.facts && typeof event.facts === 'object' ? event.facts : {};
  const category = String(facts.category || facts.category_name || '').toLocaleLowerCase();
  const eventWords = event.event_type === 'cash_floor_risk' || event.event_type === 'forecast_change'
    ? ['cash', 'buffer', 'reserve', 'floor', 'forecast']
    : event.event_type === 'budget_pace_risk' || event.event_type === 'budget_projection_improved'
    ? ['budget', 'category', 'spend', 'spending', category].filter(Boolean)
    : [];
  if (!eventWords.length) return null;
  return memories.find(memory => {
    if (!memory || !['goal', 'decision'].includes(String(memory.kind)) || typeof memory.summary !== 'string') return false;
    const summary = memory.summary.toLocaleLowerCase();
    return eventWords.some(word => word && summary.includes(word));
  }) ?? null;
}

function messageText(event: Row, memories: Row[] = []): string {
  const title = typeof event.title === 'string' ? event.title.trim().slice(0, 240) : 'A financial item needs review';
  const summary = typeof event.summary === 'string' ? event.summary.trim().slice(0, 4800) : '';
  const memory = relevantMemory(event, memories);
  const action = Array.isArray(event.recommended_actions)
    ? event.recommended_actions.find((item: Row) => item && typeof item.label === 'string' && item.label.trim())?.label.trim().slice(0, 120)
    : '';
  const lines = [title, summary || 'Folio has a verified update to review.'];
  if (memory) lines.push(`This may matter for your stated goal or decision: “${memory.summary.trim().slice(0, 240)}”.`);
  if (action) lines.push(`A useful next step: ${action}. Would you like to review it now?`);
  else lines.push('Would you like to review this in Folio?');
  return lines.join('\n\n').slice(0, 5600);
}
function shouldKeepExistingLifecycle(message: Row): boolean {
  return message.lifecycle === 'resolved' || message.lifecycle === 'superseded';
}
function lifecycleFor(message: Row, event: Row | undefined, state: Row | undefined, now: Date) {
  if (shouldKeepExistingLifecycle(message)) return { lifecycle: message.lifecycle, snoozed_until: message.snoozed_until || null };
  if (!event) return { lifecycle: 'resolved', snoozed_until: null };
  const currentVersion = Number(event.event_version), messageVersion = Number(message.event_version);
  if (Number.isInteger(currentVersion) && Number.isInteger(messageVersion) && currentVersion > messageVersion) return { lifecycle: 'superseded', snoozed_until: null };
  if (terminalEvent(event, state, now)) {
    const disposition = String(state?.disposition || event.user_disposition || '');
    const snoozedUntil = state?.snoozed_until || event.user_snoozed_until || null;
    if (disposition === 'snoozed' && typeof snoozedUntil === 'string' && Date.parse(snoozedUntil) > now.getTime()) return { lifecycle: 'snoozed', snoozed_until: snoozedUntil };
    return { lifecycle: 'resolved', snoozed_until: null };
  }
  return { lifecycle: 'active', snoozed_until: null };
}

/** Persist one message per current canonical event/version and reconcile prior lifecycle state. */
export async function projectAssistantEvents(db: any, context: Context, events: Row[], preferences: Row = {}, now = new Date(), options: Row = {}) {
  const owner = context, p = { ...NOTIFICATION_DEFAULTS, ...preferences };
  if (p.in_app_enabled === false) return { created: 0, reconciled: 0, skipped: true };
  const [watches, priorMessages, preferenceResult] = await Promise.all([
    listAssistantWatches(db, owner),
    listAssistantMessages(db, owner, { source: 'event', limit: 500 }),
    db.from('finance_user_preferences').select('ask_folio_memories').eq('user_id', context.userId).maybeSingle(),
  ]);
  if (preferenceResult?.error) throw new Error('Assistant personal context could not be loaded.');
  const timezone=typeof p.timezone==='string'?p.timezone:'UTC';
  const memories = Array.isArray(preferenceResult?.data?.ask_folio_memories)
    ? activePersonalMemories(preferenceResult.data.ask_folio_memories.filter((item: Row) => item && typeof item.summary === 'string' && typeof item.kind === 'string'),now,timezone)
    : [];
  const activeWatches = watches.filter((watch: Row) => ['active', 'snoozed'].includes(String(watch.status)));
  // A reviewed issue commitment owns quieting for that canonical issue ID, not
  // just the original message version. Later event versions stay quiet until the
  // commitment itself reaches its reviewed end condition.
  const committedIssueIds = new Set(activeWatches.filter((watch: Row) => watch.template === 'issue_follow_through')
    .map((watch: Row) => String(watch.origin_event_id || watch.commitment?.origin?.event_id || watch.commitment?.origin_event_id || ''))
    .filter((id: string) => UUID.test(id)));
  const incoming = Array.isArray(events) ? events.filter((event: Row) => event && typeof event === 'object' && UUID.test(String(event.event_id || '')) && Number.isSafeInteger(Number(event.event_version)) && Number(event.event_version) > 0) : [];
  const eventIds = [...new Set([...incoming.map((event: Row) => String(event.event_id)), ...priorMessages.filter((message: Row) => message.lifecycle === 'active' || message.lifecycle === 'snoozed').map((message: Row) => String(message.event_id || '')).filter((id: string) => UUID.test(id))])];
  if (!eventIds.length) return { created: 0, reconciled: 0, skipped: false };
  const [canonicalRows, stateRows] = await Promise.all([
    checked(await db.from('finance_agent_events').select('event_id,event_type,event_version,status,title,summary,facts,recommended_actions,last_seen_at,expires_at').eq('household_id', context.householdId).in('event_id', eventIds)),
    checked(await db.from('finance_agent_event_user_state').select('event_id,disposition,snoozed_until,updated_at').eq('household_id', context.householdId).eq('user_id', context.userId).in('event_id', eventIds)),
  ]);
  const canonicalById = new Map((Array.isArray(canonicalRows) ? canonicalRows : []).map((event: Row) => [String(event.event_id), event]));
  const stateById = new Map((Array.isArray(stateRows) ? stateRows : []).map((state: Row) => [String(state.event_id), state]));
  const messageBySource = new Map(priorMessages.map((message: Row) => [String(message.source_key), message]));
  const messagesByEvent = new Map<string, Row[]>();
  for (const message of priorMessages) {
    const id = String(message.event_id || '');
    if (!UUID.test(id)) continue;
    const rows = messagesByEvent.get(id) || []; rows.push(message); messagesByEvent.set(id, rows);
  }
  const eligible = new Map<string, { event: Row; watch_ids: string[] }>();
  for (const event of incoming) {
    const canonical = canonicalById.get(String(event.event_id));
    if (!canonical || Number(canonical.event_version) !== Number(event.event_version) || staleEvidence(event, now)) continue;
    if (committedIssueIds.has(String(event.event_id))) continue;
    const state = stateById.get(String(event.event_id));
    const scopedEvent = { ...canonical, ...event, user_disposition: state?.disposition ?? event.user_disposition ?? null, user_snoozed_until: state?.snoozed_until ?? null };
    if (terminalEvent(scopedEvent, state, now)) continue;
    const delivery = routeEvent(scopedEvent, p, Array.isArray(event.recent_delivery) ? event.recent_delivery : [], now);
    const dailyCheckScoped = options.dailyCheckDue === true && p.assistant_daily_check_enabled === true &&
      ['cash_floor_risk', 'budget_pace_risk'].includes(String(scopedEvent.event_type));
    if (!delivery.channels.includes('assistant_inbox') && !(event.restored_in_app && p.in_app_enabled) && !dailyCheckScoped) continue;
    const matched = activeWatches.filter((watch: Row) => matchAssistantWatch(watch, scopedEvent, now)).map((watch: Row) => String(watch.watch_id)).filter((id: string) => UUID.test(id));
    if (p.assistant_proactive_enabled !== true && !matched.length && !dailyCheckScoped) continue;
    eligible.set(eventSourceKey(scopedEvent), { event: scopedEvent, watch_ids: matched.slice(0, 20) });
  }
  let created = 0, reconciled = 0;
  const projectedIds = new Map<string, string>();
  for (const [sourceKey, value] of eligible) {
    const event = value.event;
    const existing = messageBySource.get(sourceKey) || (messagesByEvent.get(String(event.event_id)) || []).find((message: Row) => Number(message.event_version) === Number(event.event_version));
    if (existing && shouldKeepExistingLifecycle(existing)) continue;
    const state = stateById.get(String(event.event_id));
    const before = existing ? lifecycleFor(existing, event, state, now) : null;
    let saved: Row;
    if (!existing) {
      saved = await insertTrustedAssistantMessage(db, owner, { source: 'event', source_key: sourceKey, content: messageText(event, memories), event_id: event.event_id, event_version: Number(event.event_version), watch_ids: value.watch_ids });
      if (!messageBySource.has(sourceKey)) created++;
    } else {
      saved = existing;
    }
    if (!shouldKeepExistingLifecycle(saved)) {
      const mergedWatchIds = [...new Set([...value.watch_ids, ...(Array.isArray(saved.watch_ids) ? saved.watch_ids : [])])].filter((id: string) => UUID.test(String(id))).slice(0, 20);
      const desired = before || { lifecycle: saved.lifecycle, snoozed_until: saved.snoozed_until || null };
      const lifecycleChanged = saved.lifecycle !== desired.lifecycle || (desired.lifecycle === 'snoozed' && saved.snoozed_until !== desired.snoozed_until);
      const watchesChanged = JSON.stringify(Array.isArray(saved.watch_ids) ? saved.watch_ids : []) !== JSON.stringify(mergedWatchIds);
      if (lifecycleChanged || watchesChanged) {
        saved = await updateAssistantMessageLifecycle(db, owner, { message_id: saved.message_id, ...desired, ...(watchesChanged ? { watch_ids: mergedWatchIds } : {}) });
        reconciled++;
      }
    }
    projectedIds.set(String(event.event_id), String(saved.message_id));
  }
  // Reconcile previously projected messages against canonical event versions and per-member disposition.
  for (const message of priorMessages) {
    if (!['active', 'snoozed'].includes(String(message.lifecycle)) || !UUID.test(String(message.event_id || ''))) continue;
    const eventId = String(message.event_id), canonical = canonicalById.get(eventId), state = stateById.get(eventId);
    let next = lifecycleFor(message, canonical, state, now);
    if (next.lifecycle === 'superseded') next = { ...next, superseded_by: projectedIds.get(eventId) || null } as any;
    if (message.lifecycle !== next.lifecycle || (next.lifecycle === 'snoozed' && message.snoozed_until !== next.snoozed_until) || (next.lifecycle === 'superseded' && message.superseded_by !== next.superseded_by)) {
      await updateAssistantMessageLifecycle(db, owner, { message_id: message.message_id, ...next });
      reconciled++;
    }
  }
  return { created, reconciled, skipped: false };
}
