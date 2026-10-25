// Shared candidate policy applied after canonical stream reconciliation and
// before forecast/event projections in all three deployed schedule bundles.
export function resolveLifecycleStates(streams, states) {
  const assignments = new Map();
  const used = new Set();
  const unresolved = [];
  const ambiguousStreamKeys = new Set();
  for (const state of states || []) {
    const exact = streams.filter(stream => stream.stream_key === state.stream_key);
    if (exact.length === 1) {
      const stream = exact[0];
      const sameIdentity = String(stream.canonical_account_id ?? stream.account_id) === state.canonical_account_id &&
        stream.flow_type === state.flow_type && String(stream.currency_code ?? "USD") === state.currency_code;
      if (!sameIdentity || used.has(stream.stream_key)) {
        unresolved.push(state.stream_key);
        ambiguousStreamKeys.add(stream.stream_key);
        continue;
      }
      assignments.set(stream.stream_key, state);
      used.add(stream.stream_key);
      continue;
    }
    const matches = exact.length ? exact : streams.filter(stream =>
      stream.manual_stream_id && state.stream_key === `manual:${stream.manual_stream_id}` ||
      String(stream.canonical_account_id ?? stream.account_id) === state.canonical_account_id &&
      stream.flow_type === state.flow_type && String(stream.currency_code ?? "USD") === state.currency_code &&
      Array.isArray(state.transaction_ids) && state.transaction_ids.length > 0 &&
      state.transaction_ids.some(id => (stream.transaction_ids || []).includes(id)));
    if (matches.length !== 1 || used.has(matches[0]?.stream_key)) {
      unresolved.push(state.stream_key);
      for (const stream of matches) ambiguousStreamKeys.add(stream.stream_key);
      continue;
    }
    assignments.set(matches[0].stream_key, state);
    used.add(matches[0].stream_key);
  }
  return { assignments, unresolved, ambiguousStreamKeys };
}

export function applyLifecycleProjection(streams, states) {
  const { assignments, unresolved, ambiguousStreamKeys } = resolveLifecycleStates(streams, states);
  const projected = streams.map(stream => {
    const state = assignments.get(stream.stream_key);
    if (!state && !unresolved.length && !ambiguousStreamKeys.has(stream.stream_key)) return stream;
    if (!state) return {
      ...stream,
      lifecycle_unavailable: true,
      primary_eligible: false,
      include_in_forecast: false,
      display_status: "needs_review",
      review_reasons: [...new Set([...(stream.review_reasons || []), "lifecycle_identity_unresolved"])],
    };
    const skipped = Array.isArray(state.skipped_dates) ? state.skipped_dates.map(String) : [];
    return {
      ...stream,
      lifecycle_stream_key: state.stream_key,
      lifecycle_revision: Number(state.revision),
      lifecycle_paused: state.paused === true,
      lifecycle_skipped_dates: skipped,
      ...(state.paused === true ? {
        primary_eligible: false,
        include_in_forecast: false,
        display_status: "paused",
      } : {}),
    };
  });
  return { streams: projected, unresolved };
}

export async function loadLifecycleState(db, householdId) {
  const result = await db.rpc("finance_recurring_lifecycle_state", { p_household_id: householdId });
  if (result.error) throw new Error("Recurring lifecycle state is unavailable.");
  return result.data || [];
}

export function filterLifecycleOccurrences(occurrences, stream) {
  if (stream.lifecycle_paused === true) return [];
  const skipped = new Set(stream.lifecycle_skipped_dates || []);
  return occurrences.filter(occurrence => !skipped.has(occurrence.date));
}
