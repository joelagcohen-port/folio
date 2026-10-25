type Row = Record<string, any>;
export type AssistantRefundWatchEvidence = {
  available: boolean; complete: boolean; source?: string; original: Row | null; posted_refunds: Row[]; candidates: Row[]; checked_at: string | null; coverage_as_of: string | null;
};
const SOURCE = 'current_bank_parent_and_composed_split_proof';
const SOURCE_ID = /^[\x20-\x7E]{1,240}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function realDate(value: unknown) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number), parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
function validMoneyRow(row: Row, isOriginal: boolean, originalId: string) {
  return !!row && typeof row === 'object' && !Array.isArray(row) &&
    typeof row.transaction_id === 'string' && SOURCE_ID.test(row.transaction_id) &&
    row.currency === 'USD' && Number.isSafeInteger(row.amount_minor) && Number(row.amount_minor) > 0 &&
    Number.isSafeInteger(row.signed_amount_minor) && Number(row.signed_amount_minor) === (isOriginal ? Number(row.amount_minor) : -Number(row.amount_minor)) &&
    row.pending === false && row.effective_type === 'expense' && row.evidence_source === SOURCE && row.canonical_current === true && realDate(row.date) &&
    (isOriginal ? row.transaction_id === originalId : row.original_transaction_id === originalId && row.refund_status === 'matched' && row.relationship_type === 'refund');
}

/** Read exact-original current receipt proof. Any failed, stale, malformed or partial result fails closed. */
export async function loadAssistantRefundWatchEvidence(db: any, context: { householdId: string; userId: string }, originalTransactionId: string, now = new Date()): Promise<AssistantRefundWatchEvidence> {
  const unavailable: AssistantRefundWatchEvidence = { available: false, complete: false, original: null, posted_refunds: [], candidates: [], checked_at: null, coverage_as_of: null };
  if (!context || typeof context.householdId !== 'string' || typeof context.userId !== 'string' || typeof originalTransactionId !== 'string' || !SOURCE_ID.test(originalTransactionId)) return unavailable;
  try {
    const response = await db.rpc('finance_assistant_refund_watch_evidence', { p_household_id: context.householdId, p_user_id: context.userId, p_original_transaction_id: originalTransactionId });
    if (response?.error) return unavailable;
    const value = response?.data;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.available !== true || typeof value.complete !== 'boolean' || value.source !== SOURCE ||
        typeof value.checked_at !== 'string' || !Number.isFinite(Date.parse(value.checked_at)) ||
        !Object.prototype.hasOwnProperty.call(value, 'coverage_as_of') || (value.coverage_as_of !== null && (typeof value.coverage_as_of !== 'string' || !Number.isFinite(Date.parse(value.coverage_as_of))))) return unavailable;
    const checkedAt = Date.parse(value.checked_at);
    if (checkedAt > now.getTime() + 5 * 60_000 || now.getTime() - checkedAt > 15 * 60_000) return unavailable;
    if (value.household_id !== undefined && value.household_id !== context.householdId || value.actor_user_id !== undefined && value.actor_user_id !== context.userId) return unavailable;
    const original = value.original;
    const posted = Array.isArray(value.posted_refunds) ? value.posted_refunds : null;
    const candidates = Array.isArray(value.candidates) ? value.candidates : null;
    if (!original || !posted || !candidates || posted.length > 5000 || candidates.length > 5000 || !validMoneyRow(original, true, originalTransactionId)) return unavailable;
    const seen = new Set<string>();
    for (const refund of posted) {
      if (!validMoneyRow(refund, false, originalTransactionId) || refund.transaction_id === originalTransactionId || seen.has(refund.transaction_id)) return unavailable;
      seen.add(refund.transaction_id);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.transaction_id !== 'string' || !SOURCE_ID.test(candidate.transaction_id) ||
          candidate.transaction_id === originalTransactionId || candidate.original_transaction_id !== originalTransactionId || candidate.currency !== 'USD' ||
          !Number.isSafeInteger(candidate.amount_minor) || Number(candidate.amount_minor) <= 0 || !Number.isSafeInteger(candidate.signed_amount_minor) ||
          Math.abs(Number(candidate.signed_amount_minor)) !== Number(candidate.amount_minor) || typeof candidate.pending !== 'boolean' ||
          !['matched', 'review', 'unmatched'].includes(candidate.refund_status) || candidate.relationship_type !== 'refund' || !realDate(candidate.date) || candidate.evidence_source !== SOURCE || candidate.canonical_current !== true) return unavailable;
    }
    const coverage = typeof value.coverage_as_of === 'string' ? new Date(value.coverage_as_of).toISOString() : null;
    if (value.complete === true && coverage === null) return unavailable;
    return { available: true, complete: value.complete === true, source: SOURCE, original, posted_refunds: posted, candidates, checked_at: new Date(checkedAt).toISOString(), coverage_as_of: coverage };
  } catch { return unavailable; }
}

export type AssistantRefundOutcome = {
  outcome: { status: 'received' | 'partial' | 'needs_review' | 'unavailable' | 'not_received' | 'missed' | 'pending'; dedupe_key?: string };
  message_content: string | null;
  next_check_at: string | null;
  terminal: boolean;
};
const usd = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
function nextObservation(now: Date, deadline: number, expiry = NaN): string {
  const next = (Math.floor(now.getTime() / 900_000) + 1) * 900_000;
  const at = [next, deadline, expiry].filter(value => Number.isFinite(value) && value > now.getTime()).reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
  return new Date(at).toISOString();
}
async function candidateSetKey(rows: Row[]) {
  const canonical = JSON.stringify([...rows].map(row => [row.transaction_id, row.refund_status, row.pending, row.amount_minor, row.date]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `candidate_set:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Evaluate one read-only expected-refund observation without changing financial records. */
export async function evaluateAssistantRefundObservation(watch: Row, evidence: AssistantRefundWatchEvidence, now = new Date(), prior: { not_received_seen?: boolean } = {}): Promise<AssistantRefundOutcome> {
  const refund = watch?.refund, dueAt = watch?.schedule?.due_at, expiry = typeof watch?.expires_at === 'string' ? Date.parse(watch.expires_at) : NaN;
  if (!refund || typeof refund.original_transaction_id !== 'string' || !Number.isSafeInteger(refund.expected_amount_minor) || Number(refund.expected_amount_minor) <= 0 ||
      !Number.isSafeInteger(refund.original_amount_minor) || Number(refund.original_amount_minor) <= 0 || Number(refund.expected_amount_minor) > Number(refund.original_amount_minor) ||
      !Number.isSafeInteger(refund.baseline_received_minor) || Number(refund.baseline_received_minor) < 0 || !Number.isFinite(Date.parse(dueAt)) || !Number.isFinite(expiry)) {
    return { outcome: { status: 'unavailable', dedupe_key: 'once:unavailable' }, message_content: 'I couldn’t verify the saved refund expectation, so I left it unchanged and will try again.', next_check_at: nextObservation(now, NaN, expiry), terminal: false };
  }
  if (now.getTime() >= expiry) return { outcome: { status: 'missed', dedupe_key: 'missed' }, message_content: 'I couldn’t verify the expected refund before this watch expired. You can review the purchase in Folio’s refund review screen.', next_check_at: null, terminal: true };
  const deadline = Date.parse(dueAt), expected = Number(refund.expected_amount_minor), originalId = refund.original_transaction_id;
  const pendingCheck = () => ({ outcome: { status: 'unavailable' as const, dedupe_key: 'once:unavailable' }, message_content: 'I can’t verify the current bank evidence for this expected refund yet. I’ll check again; this is not confirmation that a refund is missing.', next_check_at: nextObservation(now, deadline, expiry), terminal: false });
  const checkedAt = typeof evidence?.checked_at === 'string' ? Date.parse(evidence.checked_at) : NaN;
  if (!evidence?.available || evidence.source !== SOURCE || !Number.isFinite(checkedAt) || checkedAt > now.getTime() + 5 * 60_000 || now.getTime() - checkedAt > 15 * 60_000 || evidence.original?.transaction_id !== originalId || !validMoneyRow(evidence.original, true, originalId) || !Array.isArray(evidence.posted_refunds) || !Array.isArray(evidence.candidates)) return pendingCheck();
  if (evidence.candidates.length) {
    const candidatesValid = evidence.candidates.every((row: Row) => row && typeof row === 'object' && typeof row.transaction_id === 'string' && SOURCE_ID.test(row.transaction_id) &&
      row.transaction_id !== originalId && row.original_transaction_id === originalId && row.currency === 'USD' && Number.isSafeInteger(row.amount_minor) && Number(row.amount_minor) > 0 &&
      Number.isSafeInteger(row.signed_amount_minor) && Math.abs(Number(row.signed_amount_minor)) === Number(row.amount_minor) && typeof row.pending === 'boolean' &&
      ['matched', 'review', 'unmatched'].includes(row.refund_status) && row.relationship_type === 'refund' && realDate(row.date) && row.evidence_source === SOURCE && row.canonical_current === true);
    if (candidatesValid) {
      const key = await candidateSetKey(evidence.candidates);
      return { outcome: { status: 'needs_review', dedupe_key: key }, message_content: 'I found a possible refund record that needs your review before I can count it. I did not treat it as received or change its classification.', next_check_at: nextObservation(now, deadline, expiry), terminal: false };
    }
    return pendingCheck();
  }
  if (!evidence.complete) return pendingCheck();
  const seen = new Set<string>(); let received = 0;
  for (const row of evidence.posted_refunds) {
    if (!validMoneyRow(row, false, originalId) || seen.has(row.transaction_id)) return pendingCheck();
    seen.add(row.transaction_id); received += Number(row.amount_minor);
    if (!Number.isSafeInteger(received)) return pendingCheck();
  }
  if (received > Number(refund.original_amount_minor)) return { outcome: { status: 'needs_review', dedupe_key: await candidateSetKey(evidence.posted_refunds) }, message_content: 'The verified refund total exceeds the selected purchase amount, so I left this watch unresolved for review.', next_check_at: nextObservation(now, deadline, expiry), terminal: false };
  if (received >= expected) return { outcome: { status: 'received', dedupe_key: 'received' }, message_content: `The verified posted refunds now total ${usd(received)}, meeting the ${usd(expected)} expectation for the selected purchase.`, next_check_at: null, terminal: true };
  const changedPartial = received > Number(refund.baseline_received_minor);
  if (now.getTime() >= deadline && !prior.not_received_seen) {
    const coverage = typeof evidence.coverage_as_of === 'string' ? Date.parse(evidence.coverage_as_of) : NaN;
    if (!Number.isFinite(coverage) || coverage < deadline) return pendingCheck();
    const detail = received > 0 ? ` Verified posted refunds total ${usd(received)} of ${usd(expected)} so far.` : '';
    const asOf = new Date(coverage).toISOString();
    return { outcome: { status: 'not_received', dedupe_key: 'not_received' }, message_content: `As of ${asOf}, Folio has not seen the expected refund in verified transactions yet.${detail} I’ll keep watching until this watch expires.`, next_check_at: nextObservation(now, deadline, expiry), terminal: false };
  }
  if (changedPartial) return { outcome: { status: 'partial', dedupe_key: `partial:${received}` }, message_content: `${usd(received)} of the expected ${usd(expected)} is verified as posted. I’ll continue checking for the remaining amount.`, next_check_at: nextObservation(now, deadline, expiry), terminal: false };
  return { outcome: { status: 'pending' }, message_content: null, next_check_at: nextObservation(now, deadline, expiry), terminal: false };
}

