type Row = Record<string, any>;

// Single risk authority. Manual actions retain their existing explicit tiers;
// maintenance is low only when the structured evidence independently qualifies.
export const MANUAL_ACTION_POLICY: Record<string, { risk: 'low' | 'medium' | 'high'; confirmation: boolean }> = {
  reallocate_budget: { risk: 'high', confirmation: true },
  refresh_accounts: { risk: 'low', confirmation: false },
  acknowledge_recurring_change: { risk: 'low', confirmation: false },
  acknowledge_change: { risk: 'low', confirmation: false },
  dismiss_event: { risk: 'low', confirmation: false },
  snooze_event: { risk: 'low', confirmation: false },
};

export function classifyActionRisk(actionType: string, candidate: Row = {}): 'low' | 'medium' | 'high' {
  if (actionType === 'reallocate_budget') {
    const ids = Array.isArray(candidate.category_ids) ? candidate.category_ids : [];
    const valid = candidate.bounded_source_evidence === true && typeof candidate.amount === 'number' && Number.isFinite(candidate.amount) && candidate.amount > 0 &&
      typeof candidate.from_category_id === 'string' && typeof candidate.to_category_id === 'string' && candidate.from_category_id !== candidate.to_category_id && ids.length === 2 && ids.includes(candidate.from_category_id) && ids.includes(candidate.to_category_id);
    return valid && candidate.amount <= 250 && candidate.affects_core_goal !== true && candidate.protected_category_involved !== true ? 'medium' : 'high';
  }
  if (actionType === 'archive_expired') return candidate.event_status === 'expired' && candidate.event_expired === true ? 'low' : 'high';
  if (actionType === 'normalize_merchant') {
    return candidate.known_evidence === true && candidate.mapping_source === 'confirmed_household_examples' && Number.isInteger(candidate.confirmed_examples) && candidate.confirmed_examples >= 3 && Number.isFinite(candidate.confidence) && candidate.confidence >= .98 && candidate.confidence <= 1 && candidate.user_override !== true && candidate.manual_review !== true ? 'low' : 'high';
  }
  if (actionType === 'correct_category') {
    return candidate.known_evidence === true && candidate.rule_created_by_user === true && candidate.rule_match_type === 'exact' && Number.isFinite(candidate.confidence) && candidate.confidence >= .98 && candidate.confidence <= 1 && candidate.user_override !== true && candidate.manual_review !== true ? 'low' : 'high';
  }
  return MANUAL_ACTION_POLICY[actionType]?.risk ?? 'high';
}
