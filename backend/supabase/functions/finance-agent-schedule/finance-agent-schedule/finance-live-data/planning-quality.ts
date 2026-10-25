export function isTrustedForecast(snapshot: any) { return snapshot?.input_quality === "complete"; }
export function canonicalForecastScope(accountStates: any[], mappings: any[] = []) {
  const canonicalBySource = new Map<string, string>();
  for (const mapping of mappings) {
    if (typeof mapping?.source_account_id !== "string" || typeof mapping?.canonical_account_id !== "string") continue;
    const existing = canonicalBySource.get(mapping.source_account_id);
    if (existing && existing !== mapping.canonical_account_id) return null;
    canonicalBySource.set(mapping.source_account_id, mapping.canonical_account_id);
  }
  const result: string[] = [];
  for (const row of accountStates) {
    const canonicalId = typeof row?.canonical_account_id === "string" ? row.canonical_account_id : canonicalBySource.get(row?.account_id);
    if (typeof canonicalId !== "string" || !canonicalId || typeof row?.type !== "string") return null;
    const lifecycle = row.lifecycle_status ?? "active";
    result.push(`${canonicalId}:${row.type}:${lifecycle}`);
  }
  if (new Set(result).size !== result.length) return null;
  return result.sort();
}
export function forecastScopeMatches(snapshot: any, expectedScope: string[], mappings: any[] = []) {
  if (!Array.isArray(snapshot?.account_states)) return false;
  const stored = canonicalForecastScope(snapshot.account_states, mappings);
  return !!stored && JSON.stringify(stored) === JSON.stringify([...expectedScope].sort());
}
export function forecastFingerprint(streamStates: any[], events: any[], startingBalance = 0, accountScope: string[] = [], horizon = 30, points: any[] = []) {
  const text = JSON.stringify({ startingBalance, accountScope: [...accountScope].sort(), horizon, points, streams: streamStates.map(stream => [stream.key, stream.active, stream.flow, stream.amount, stream.frequency, stream.next_date]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), events: events.map(event => [event.stream_key, event.date, event.amount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) + String(a[1]).localeCompare(String(b[1]))) });
  let hash = 2166136261; for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619); return (hash >>> 0).toString(16);
}
