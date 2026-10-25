export type SavingsTransaction = {
  transaction_id: string;
  account_id: string;
  amount: number;
  transaction_date: string;
  currency?: string | null;
  pending?: boolean;
  pending_transaction_id?: string | null;
  transfer_direction?: string | null;
  transfer_network?: string | null;
  user_category?: string | null;
  user_subcategory?: string | null;
  name?: string | null;
  original_description?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
  canonical_account_id?: string | null;
};

export type SavingsCandidate = {
  transfer_key: string;
  transaction_id: string;
  paired_transaction_id: string | null;
  canonical_account_id: string;
  amount: number;
  transaction_date: string;
  description: string;
  signed_contribution: number;
  status: "review" | "confirmed" | "excluded";
  reason: string;
  evidence: Record<string, unknown>;
};

const transferText = /\b(transfer|xfer|sweep|savings deposit|withdrawal from savings)\b/i;
const refundText = /\b(refund|reversal|chargeback|return of purchase)\b/i;
const securityText = /\b(buy|purchase|bought|sold|sell|dividend|interest|capital gain|stock|bond|etf|crypto|security)\b/i;
const safeDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

function isTransfer(tx: SavingsTransaction): boolean {
  const primary = String(tx.personal_finance_category?.primary || "").toUpperCase();
  const detailed = String(tx.personal_finance_category?.detailed || "").toUpperCase();
  const category = `${tx.user_category || ""} ${tx.user_subcategory || ""}`;
  if (String(tx.user_category||"").trim()) return /\btransfer\b/i.test(category);
  return primary.startsWith("TRANSFER") || detailed.startsWith("TRANSFER") || !!tx.transfer_direction || /\btransfer\b/i.test(category) || transferText.test(`${tx.name || ""} ${tx.original_description || ""}`);
}

function excludedReason(tx: SavingsTransaction): string | null {
  const pfc = `${tx.personal_finance_category?.primary || ""} ${tx.personal_finance_category?.detailed || ""}`.toUpperCase();
  const description = `${tx.name || ""} ${tx.original_description || ""}`;
  if (refundText.test(description) || /REFUND|REVERSAL|CHARGEBACK/.test(pfc)) return "refund_or_reversal";
  // A brokerage contribution or investment transfer is eligible evidence.
  // Exclude purchase/security activity and investment income specifically;
  // the broad word "investment" alone would reject genuine cash transfers.
  if (securityText.test(description) || /DIVIDEND|INTEREST|CAPITAL_GAIN|SECURITIES/.test(pfc) || /\b(interest|dividend|capital gain)\b/i.test(`${tx.user_category||""} ${tx.user_subcategory||""}`)) return "investment_or_gain";
  return null;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}

/**
 * Deterministic evidence triage for one canonical savings account. Positive
 * Plaid amounts are money out, so the contribution effect is their negation.
 * Only a posted transfer with an equal, opposite transfer on another canonical
 * account is verified. A missing counterpart stays review-only.
 */
export function detectSavingsCandidates(input: {
  goalId: string;
  canonicalAccountId: string;
  goalAccountIds: Set<string>;
  transactions: SavingsTransaction[];
}): SavingsCandidate[] {
  const { goalId, canonicalAccountId, goalAccountIds, transactions } = input;
  const candidates: SavingsCandidate[] = [];
  const postedPendingIds = new Set(transactions.filter(tx => !tx.pending && tx.pending_transaction_id).map(tx => String(tx.pending_transaction_id)));
  const usedCounterparts = new Set<string>();
  const ordered = [...transactions].sort((a,b) => a.transaction_date.localeCompare(b.transaction_date) || a.transaction_id.localeCompare(b.transaction_id));
  for (const tx of ordered) {
    if (tx.pending && postedPendingIds.has(tx.transaction_id)) continue;
    if (tx.canonical_account_id !== canonicalAccountId || !Number.isFinite(tx.amount) || tx.amount === 0 || !safeDate(tx.transaction_date)) continue;
    const excluded = excludedReason(tx);
    if (excluded || !isTransfer(tx)) continue;
    const pendingKey = tx.pending ? tx.transaction_id : tx.pending_transaction_id?.trim();
    const transferKey = pendingKey ? `pending:${pendingKey}` : `posted:${tx.transaction_id}`;
    const duplicate = candidates.some(row => row.transfer_key === transferKey);
    if (duplicate) continue;
    const currency=String(tx.currency||"").trim().toUpperCase();
    const matches = ordered.filter(other => other.transaction_id !== tx.transaction_id && other.canonical_account_id !== canonicalAccountId && currency==="USD" && String(other.currency||"").trim().toUpperCase()===currency &&
      !other.pending && Number.isFinite(other.amount) && Math.round(Math.abs(other.amount) * 100) === Math.round(Math.abs(tx.amount) * 100) &&
      Math.sign(other.amount) !== Math.sign(tx.amount) && safeDate(other.transaction_date) && daysBetween(tx.transaction_date, other.transaction_date) <= 4 && isTransfer(other) && !excludedReason(other));
    const reverseMatches = matches.length===1 ? ordered.filter(other => other.transaction_id !== matches[0].transaction_id && other.canonical_account_id === canonicalAccountId && String(other.currency||"").trim().toUpperCase()===currency && !other.pending && Number.isFinite(other.amount) && Math.round(Math.abs(other.amount) * 100) === Math.round(Math.abs(matches[0].amount) * 100) && Math.sign(other.amount) !== Math.sign(matches[0].amount) && safeDate(other.transaction_date) && daysBetween(other.transaction_date, matches[0].transaction_date) <= 4 && isTransfer(other) && !excludedReason(other)) : [];
    const ambiguousPair = matches.length>1 || (matches.length===1 && reverseMatches.length!==1) || (matches.length===1 && usedCounterparts.has(matches[0].transaction_id));
    const paired = matches.length===1&&reverseMatches.length===1&&!usedCounterparts.has(matches[0].transaction_id)?matches[0]:null;
    if (paired) usedCounterparts.add(paired.transaction_id);
    const sameGoalTransfer = !!paired?.canonical_account_id && goalAccountIds.has(paired.canonical_account_id);
    const sameGoalRows = !!paired && goalAccountIds.has(canonicalAccountId) && goalAccountIds.has(paired.canonical_account_id || "");
    const internal = sameGoalTransfer || sameGoalRows;
    const verified = !!paired && matches.length===1 && !tx.pending;
    const signedContribution = -tx.amount;
    const status = verified ? "confirmed" : "review";
    candidates.push({
      transfer_key: transferKey,
      transaction_id: tx.transaction_id,
      paired_transaction_id: paired?.transaction_id || null,
      canonical_account_id: canonicalAccountId,
      amount: Math.abs(tx.amount),
      transaction_date: tx.transaction_date,
      description: String(tx.name || tx.original_description || "Savings transfer").slice(0, 180),
      signed_contribution: signedContribution,
      status,
      reason: internal ? "within_goal_transfer" : verified ? (signedContribution >= 0 ? "verified_external_deposit" : "verified_external_withdrawal") : tx.pending ? "pending_transfer" : ambiguousPair ? "ambiguous_transfer_pair" : "counterpart_unverified",
      evidence: { detector: "posted_transfer_pair_v1", matched: verified, internal_goal_transfer:internal, pending: tx.pending === true, pending_key:pendingKey||null, currency_code:currency||null, candidate_count: Math.max(matches.length,reverseMatches.length), ambiguous:ambiguousPair, account_id: tx.account_id, paired_account_id: paired?.account_id || null, sign_convention: "positive_out_negative_in" },
    });
  }
  return candidates;
}

export function contributionForMode(mode: string, allocatedBalance: number, netContribution: number): number {
  if (mode === "balance") return Math.max(0, allocatedBalance);
  if (mode === "net_contributions") return Math.max(0, netContribution);
  return 0;
}

export function forecastSavings(current: number, monthlyNet: number, target: number, forecastReady: boolean) {
  const values = [current, monthlyNet, target];
  if (!forecastReady || values.some(value => !Number.isFinite(value) || value < 0) || target <= 0) return { ready: false, months_to_goal: null, completion_date: null };
  const remaining = Math.max(0, target - current);
  const months = remaining === 0 ? 0 : monthlyNet > 0 ? Math.ceil(remaining / monthlyNet) : null;
  return { ready: true, months_to_goal: months, completion_date: months === null ? null : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + months, 1)).toISOString().slice(0, 10) };
}
