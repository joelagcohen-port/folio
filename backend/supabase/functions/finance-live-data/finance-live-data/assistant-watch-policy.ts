export type AssistantWatchTemplate = 'cash_flow' | 'budget' | 'recurring' | 'account_health' | 'one_time_follow_up' | 'expected_refund';
export type AssistantFollowUpCheck = 'reminder' | 'cash_flow' | 'budget' | 'recurring' | 'account_health';
export type AssistantWatchSchedule = { due_at: string; local_date: string; local_time: string; timezone: string; utc_offset_minutes: number };
export type AssistantWatchInput = {
  template: AssistantWatchTemplate;
  category_name?: string;
  expires_at?: string | null;
  watch_id?: string;
  expected_version?: number;
  schedule?: AssistantWatchSchedule;
  follow_up?: { check: AssistantFollowUpCheck; reminder_text?: string; category_name?: string };
  refund?: AssistantExpectedRefundInput;
  delivery?: 'chat' | 'chat_and_push';
};
export type AssistantWatchMatch = {
  template: AssistantWatchTemplate;
  category_name?: string | null;
  status?: string;
  snoozed_until?: string | null;
  expires_at?: string | null;
};
type Row = Record<string, unknown>;
const WATCH_EVENTS: Record<AssistantWatchTemplate, readonly string[]> = {
  cash_flow: ['cash_floor_risk', 'forecast_change'],
  budget: ['budget_pace_risk'],
  recurring: ['recurring_amount_change', 'recurring_payment_missing'],
  account_health: ['account_sync_issue'],
  // These templates are private timed watches, not event filters. Their due
  // dispatch uses the watch-run ledger and never projects generic events.
  one_time_follow_up: [],
  expected_refund: [],
};
const TEMPLATES = new Set(Object.keys(WATCH_EVENTS));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/;

function catalogCategoryNames(catalog: unknown): string[] {
  const rows = Array.isArray(catalog) ? catalog : catalog && typeof catalog === 'object' && Array.isArray((catalog as Row).categories) ? (catalog as Row).categories as unknown[] : [];
  const names: string[] = [];
  for (const item of rows) {
    if (typeof item === 'string') { if (item.trim()) names.push(item.trim()); continue; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Row;
    const name = typeof row.name === 'string' ? row.name.trim() : typeof row.label === 'string' ? row.label.trim() : '';
    if (name && row.active !== false) names.push(name);
  }
  return [...new Set(names)];
}

type AssistantExpectedRefundInput = { original_transaction_id: string; expected_amount_minor: number; currency: string; expected_by_date: string };
type AssistantRefundEvidence = {
  available: boolean; complete: boolean; checked_at: string | null; source?: string;
  original: Row | null; posted_refunds: Row[]; candidates: Row[];
};
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function utcDateIsReal(value: string) {
  if (!LOCAL_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number), check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}
function zonedParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (key: string) => parts.find(part => part.type === key)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
function validZonedSchedule(value: unknown, now: Date) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a valid local date, time, and time zone.');
  const row = value as Row;
  if (Object.keys(row).some(key => !['due_at', 'local_date', 'local_time', 'timezone', 'utc_offset_minutes'].includes(key)) ||
      typeof row.due_at !== 'string' || !ISO_UTC.test(row.due_at) || typeof row.local_date !== 'string' || !utcDateIsReal(row.local_date) ||
      typeof row.local_time !== 'string' || !LOCAL_TIME.test(row.local_time) || typeof row.timezone !== 'string' || row.timezone.length > 100 ||
      !Number.isSafeInteger(row.utc_offset_minutes) || Number(row.utc_offset_minutes) < -840 || Number(row.utc_offset_minutes) > 840) {
    throw new Error('Choose a valid local date, time, and time zone.');
  }
  let timezone: string;
  try { timezone = new Intl.DateTimeFormat('en-US', { timeZone: row.timezone }).resolvedOptions().timeZone; }
  catch { throw new Error('Choose a valid local date, time, and time zone.'); }
  const due = new Date(row.due_at);
  if (!Number.isFinite(due.getTime())) throw new Error('Choose a valid UTC time for this follow-up.');
  const actual = zonedParts(due, timezone);
  const offset = Math.round((Date.UTC(Number(actual.date.slice(0, 4)), Number(actual.date.slice(5, 7)) - 1, Number(actual.date.slice(8, 10)), Number(actual.time.slice(0, 2)), Number(actual.time.slice(3, 5))) - due.getTime()) / 60000);
  if (actual.date !== row.local_date || actual.time !== row.local_time || offset !== Number(row.utc_offset_minutes)) {
    throw new Error('That local time does not match the selected time zone and UTC offset.');
  }
  const delta = due.getTime() - now.getTime();
  if (delta <= 0 || delta > 366 * 86400000) throw new Error('Choose a future time within the next year.');
  return { due_at: due.toISOString(), local_date: row.local_date as string, local_time: row.local_time as string, timezone, utc_offset_minutes: offset };
}
function validateFollowUp(value: unknown, catalog: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose what the follow-up should check.');
  const row = value as Row, allowed = new Set(['check', 'reminder_text', 'category_name']);
  if (Object.keys(row).some(key => !allowed.has(key)) || !['reminder', 'cash_flow', 'budget', 'recurring', 'account_health'].includes(String(row.check))) throw new Error('Choose a supported follow-up check.');
  const check = row.check as AssistantFollowUpCheck;
  let reminder_text: string | undefined, category_name: string | undefined;
  if (check === 'reminder') {
    if (typeof row.reminder_text !== 'string' || !row.reminder_text.trim() || row.reminder_text.trim().length > 280) throw new Error('Add a reminder of 280 characters or less.');
    reminder_text = row.reminder_text.trim();
    if (row.category_name !== undefined) throw new Error('A category applies only to a budget check.');
  } else if (check === 'budget') {
    if (typeof row.category_name !== 'string' || !row.category_name.trim()) throw new Error('Choose a category from your active budget categories.');
    const exact = catalogCategoryNames(catalog).find(name => name === row.category_name);
    if (!exact) throw new Error('Choose a category from your active budget categories.');
    category_name = exact;
    if (row.reminder_text !== undefined) throw new Error('Reminder text applies only to a reminder follow-up.');
  } else if (row.category_name !== undefined || row.reminder_text !== undefined) {
    throw new Error('Only a reminder or budget follow-up can include extra details.');
  }
  return { check, ...(reminder_text ? { reminder_text } : {}), ...(category_name ? { category_name } : {}) };
}

/** Validates only caller-authored refund expectation fields. Source purchase facts are never accepted from a caller. */
export function validateAssistantExpectedRefundInput(value: unknown): AssistantExpectedRefundInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Select an existing purchase and refund expectation.');
  const row = value as Row;
  if (Object.keys(row).some(key => !['original_transaction_id', 'expected_amount_minor', 'currency', 'expected_by_date'].includes(key)) ||
      typeof row.original_transaction_id !== 'string' || row.original_transaction_id.trim().length < 1 || row.original_transaction_id.length > 240 ||
      !Number.isSafeInteger(row.expected_amount_minor) || Number(row.expected_amount_minor) <= 0 || row.currency !== 'USD' ||
      typeof row.expected_by_date !== 'string' || !utcDateIsReal(row.expected_by_date)) throw new Error('Choose a supported USD refund expectation for a valid date.');
  return { original_transaction_id: row.original_transaction_id, expected_amount_minor: Number(row.expected_amount_minor), currency: 'USD', expected_by_date: row.expected_by_date };
}

/** Bind a reviewed expectation to exact current source evidence, never merchant/amount similarity. */
export function normalizeAssistantExpectedRefund(input: unknown, evidence: AssistantRefundEvidence, now = new Date()) {
  const proposal = validateAssistantExpectedRefundInput(input);
  const checkedAt = typeof evidence?.checked_at === 'string' ? Date.parse(evidence.checked_at) : NaN;
  if (!evidence?.available || !evidence.complete || evidence.source !== 'current_bank_parent_and_composed_split_proof' || !Number.isFinite(checkedAt) || checkedAt > now.getTime() + 5 * 60_000 || now.getTime() - checkedAt > 15 * 60_000 || !evidence.original) throw new Error('Current purchase evidence is unavailable or incomplete.');
  const original = evidence.original;
  if (original.transaction_id !== proposal.original_transaction_id || original.pending !== false || original.effective_type !== 'expense' || original.currency !== 'USD' || original.evidence_source !== evidence.source || original.canonical_current !== true ||
      !Number.isSafeInteger(original.amount_minor) || Number(original.amount_minor) <= 0 || original.signed_amount_minor !== Number(original.amount_minor) ||
      typeof original.merchant !== 'string' || !original.merchant.trim() || typeof original.date !== 'string' || !LOCAL_DATE.test(original.date) || !utcDateIsReal(original.date)) {
    throw new Error('That purchase could not be verified as a current posted expense.');
  }
  if (proposal.expected_amount_minor > Number(original.amount_minor)) throw new Error('The expected refund cannot exceed the verified purchase amount.');
  const ids = new Set<string>();
  let baseline = 0;
  for (const refund of evidence.posted_refunds) {
    if (!refund || typeof refund !== 'object' || typeof refund.transaction_id !== 'string' || ids.has(refund.transaction_id) || refund.original_transaction_id !== proposal.original_transaction_id || refund.pending !== false || refund.refund_status !== 'matched' || refund.relationship_type !== 'refund' || refund.effective_type !== 'expense' || refund.currency !== 'USD' || refund.evidence_source !== evidence.source || refund.canonical_current !== true || !Number.isSafeInteger(refund.amount_minor) || Number(refund.amount_minor) <= 0 || refund.signed_amount_minor !== -Number(refund.amount_minor) || typeof refund.date !== 'string' || !LOCAL_DATE.test(refund.date) || !utcDateIsReal(refund.date)) {
      throw new Error('Current refund evidence is invalid or ambiguous.');
    }
    ids.add(refund.transaction_id); baseline += Number(refund.amount_minor);
    if (!Number.isSafeInteger(baseline)) throw new Error('Current refund evidence is too large to verify.');
  }
  if (baseline > Number(original.amount_minor)) throw new Error('Verified refunds exceed the selected purchase amount and need review.');
  if (baseline >= proposal.expected_amount_minor) throw new Error('Current verified refunds already meet this expectation.');
  return { ...proposal, original_merchant: original.merchant.trim().slice(0, 100), original_date: original.date, original_amount_minor: Number(original.amount_minor), baseline_received_minor: baseline };
}

export type { AssistantRefundEvidence };

/** Validate a fixed watch template and return only normalized, non-executable fields. */
export function validateAssistantWatch(input: unknown, catalog: unknown, now = new Date()): AssistantWatchInput & { label: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose a supported Folio watch.');
  const row = input as Row;
  const allowed = new Set(['template', 'category_name', 'expires_at', 'watch_id', 'expected_version', 'schedule', 'follow_up', 'refund', 'delivery']);
  if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('A watch can use only a supported template.');
  if (typeof row.template !== 'string' || !TEMPLATES.has(row.template)) throw new Error('Choose a supported Folio watch.');
  const template = row.template as AssistantWatchTemplate;
  let category_name: string | undefined;
  if (template === 'budget') {
    if (typeof row.category_name !== 'string' || !row.category_name.trim()) throw new Error('Choose a category from your active budget categories.');
    const exact = catalogCategoryNames(catalog).find(name => name === row.category_name);
    if (!exact) throw new Error('Choose a category from your active budget categories.');
    category_name = exact;
  } else if (row.category_name !== undefined) {
    throw new Error('A category applies only to a budget watch.');
  }
  const timed = template === 'one_time_follow_up' || template === 'expected_refund';
  let schedule: AssistantWatchSchedule | undefined, follow_up: AssistantWatchInput['follow_up'], refund: AssistantWatchInput['refund'];
  let delivery: 'chat' | 'chat_and_push' | undefined;
  if (timed) {
    schedule = validZonedSchedule(row.schedule, now);
    if (template === 'one_time_follow_up') {
      follow_up = validateFollowUp(row.follow_up, catalog);
      if (row.refund !== undefined) throw new Error('Refund details apply only to an expected-refund watch.');
    } else {
      if (row.follow_up !== undefined) throw new Error('A scheduled check applies only to a one-time follow-up.');
      refund = validateAssistantExpectedRefundInput(row.refund);
      if (schedule.local_date !== refund.expected_by_date) throw new Error('The expected-by date must match the reviewed local date.');
    }
    if (row.delivery === undefined) delivery = 'chat';
    else if (row.delivery === 'chat' || row.delivery === 'chat_and_push') delivery = row.delivery;
    else throw new Error('Choose chat or chat and push delivery.');
  } else if (row.schedule !== undefined || row.follow_up !== undefined || row.refund !== undefined || row.delivery !== undefined) {
    throw new Error('Timed follow-up settings apply only to one-time or expected-refund watches.');
  }
  let expires_at: string | null | undefined;
  if (row.expires_at !== undefined) {
    if (row.expires_at === null) expires_at = null;
    else if (typeof row.expires_at === 'string' && DATE.test(row.expires_at) && Number.isFinite(Date.parse(row.expires_at))) expires_at = new Date(row.expires_at).toISOString();
    else throw new Error('Choose a valid watch end time.');
  }
  if (timed && schedule) {
    const due = Date.parse(schedule.due_at), expiry = expires_at === undefined
      ? due + (template === 'one_time_follow_up' ? 24 * 60 * 60_000 : 30 * 24 * 60 * 60_000)
      : expires_at === null ? NaN : Date.parse(expires_at);
    const maxExpiry = template === 'one_time_follow_up' ? due + 24 * 60 * 60_000 : now.getTime() + 366 * 24 * 60 * 60_000;
    if (!Number.isFinite(expiry) || expiry <= due || expiry > maxExpiry) throw new Error('Choose an explicit catch-up end after the due time and within the supported window.');
    expires_at = new Date(expiry).toISOString();
  }
  if (row.watch_id !== undefined && (typeof row.watch_id !== 'string' || !UUID.test(row.watch_id))) throw new Error('This watch is no longer available.');
  if (row.expected_version !== undefined && (!Number.isSafeInteger(row.expected_version) || Number(row.expected_version) < 1)) throw new Error('This watch changed. Review it again.');
  const label = template === 'budget' ? `Watch ${category_name} budget` : template === 'cash_flow' ? 'Watch cash flow' : template === 'recurring' ? 'Watch recurring charges' : template === 'account_health' ? 'Watch account connections' : template === 'expected_refund' ? 'Watch for an expected refund' : 'One-time follow-up';
  return { template, ...(category_name ? { category_name } : {}), ...(schedule ? { schedule } : {}), ...(follow_up ? { follow_up } : {}), ...(refund ? { refund } : {}), ...(delivery ? { delivery } : {}), ...(expires_at !== undefined ? { expires_at } : {}), ...(row.watch_id ? { watch_id: row.watch_id as string } : {}), ...(row.expected_version !== undefined ? { expected_version: Number(row.expected_version) } : {}), label };
}

/** Match only canonical event types; watches never add thresholds or synthesize evidence. */
export function matchAssistantWatch(watch: AssistantWatchMatch, event: Row, now: Date = new Date()): boolean {
  if (!watch || !event || typeof event !== 'object') return false;
  const active = watch.status === 'active';
  const resumedSnooze = watch.status === 'snoozed' && typeof watch.snoozed_until === 'string' && Number.isFinite(Date.parse(watch.snoozed_until)) && Date.parse(watch.snoozed_until) <= now.getTime();
  if (!active && !resumedSnooze) return false;
  const template = watch.template;
  if (!TEMPLATES.has(template) || !WATCH_EVENTS[template].includes(String(event.event_type || ''))) return false;
  const eventStatus = String(event.status || '');
  if (!['new', 'surfaced'].includes(eventStatus)) return false;
  if (event.expires_at && Date.parse(String(event.expires_at)) <= now.getTime()) return false;
  if (watch.expires_at && Date.parse(watch.expires_at) <= now.getTime()) return false;
  if (watch.snoozed_until && Date.parse(watch.snoozed_until) > now.getTime()) return false;
  const disposition = String(event.user_disposition || '');
  if (['acted', 'acknowledged', 'dismissed', 'expected', 'wrong'].includes(disposition)) return false;
  if (disposition === 'snoozed') {
    const until = typeof event.user_snoozed_until === 'string' ? Date.parse(event.user_snoozed_until) : NaN;
    if (!Number.isFinite(until) || until > now.getTime()) return false;
  }
  if (template === 'budget') {
    const expected = typeof watch.category_name === 'string' ? watch.category_name : '';
    const facts = event.facts && typeof event.facts === 'object' && !Array.isArray(event.facts) ? event.facts as Row : {};
    return !!expected && (facts.category === expected || facts.category_name === expected);
  }
  return true;
}
