(() => {
  const startedAt = performance.now();
  const maxEvents = 200;
  const events = [];
  const operationNames = new Set([
    'list_accounts', 'get_account_detail', 'search_transactions', 'spending_summary',
    'monthly_transaction_summaries', 'sync_prepared_transactions', 'get_budget_progress',
    'list_budget_targets', 'list_recurring', 'list_investments', 'list_investment_history',
    'list_investment_activity', 'list_investment_evidence', 'get_planning', 'get_planning_history', 'list_agent_events',
    'get_agent_state', 'list_categorization_rules', 'get_rental_accounts', 'get_rental_report',
    'search_rental_transactions', 'preview_rental_classifications',
  ]);
  const eventNames = new Set([
    'request_started', 'request_finished', 'cache_lookup', 'transaction_view_started', 'data_ready', 'render_checkpoint', 'sync_finished',
  ]);
  const outcomes = new Set(['success', 'error', 'cancelled', 'timeout', 'stale', 'miss', 'hit']);
  const sources = new Set(['local', 'server', 'none']);
  const freshness = new Set(['fresh', 'stale', 'unknown']);
  const counters = new Map();

  const boundedNumber = (value, max = 86400000) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(max, Math.round(number * 100) / 100) : undefined;
  };
  const safeId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
  const record = input => {
    if (!input || typeof input !== 'object' || !eventNames.has(input.event)) return;
    const operation = operationNames.has(input.operation) ? input.operation : 'other';
    const event = {
      event: input.event,
      operation,
      atMs: boundedNumber(performance.now() - startedAt),
      ...(boundedNumber(input.durationMs) !== undefined ? { durationMs: boundedNumber(input.durationMs) } : {}),
      ...(boundedNumber(input.upstreamMs) !== undefined ? { upstreamMs: boundedNumber(input.upstreamMs) } : {}),
      ...(boundedNumber(input.routeMs) !== undefined ? { routeMs: boundedNumber(input.routeMs) } : {}),
      ...(outcomes.has(input.outcome) ? { outcome: input.outcome } : {}),
      ...(sources.has(input.source) ? { source: input.source } : {}),
      ...(freshness.has(input.freshness) ? { freshness: input.freshness } : {}),
      ...(Number.isInteger(input.rowCount) && input.rowCount >= 0 && input.rowCount <= 100000 ? { rowCount: input.rowCount } : {}),
      ...(Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? { status: input.status } : {}),
      ...(Number.isInteger(input.attempts) && input.attempts >= 0 && input.attempts <= 20 ? { attempts: input.attempts } : {}),
      ...(Number.isSafeInteger(input.generation) && input.generation >= 0 ? { generation: input.generation } : {}),
      ...(Number.isSafeInteger(input.revision) && input.revision >= 0 ? { revision: input.revision } : {}),
      ...(boundedNumber(input.refreshLagMs) !== undefined ? { refreshLagMs: boundedNumber(input.refreshLagMs) } : {}),
      ...(safeId(input.requestId) ? { requestId: input.requestId } : {}),
    };
    events.push(event);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    if (input.event === 'request_finished' || input.event === 'data_ready' || input.event === 'render_checkpoint' || input.event === 'sync_finished') {
      const counterKey = `${event.event}:${operation}:${event.source || 'none'}`;
      const current = counters.get(counterKey) || { event: event.event, operation, ...(event.source ? { source: event.source } : {}), count: 0, failures: 0, cancellations: 0, totalDurationMs: 0 };
      current.count += 1;
      if (event.outcome === 'error' || event.outcome === 'timeout') current.failures += 1;
      if (event.outcome === 'cancelled') current.cancellations += 1;
      current.totalDurationMs += event.durationMs || 0;
      counters.set(counterKey, current);
    }
  };
  const snapshot = () => Object.freeze({
    events: Object.freeze(events.map(event => Object.freeze({ ...event }))),
    counters: Object.freeze(Object.fromEntries([...counters].map(([name, value]) => [name, Object.freeze({ ...value })]))),
  });
  Object.defineProperty(globalThis, 'FolioPerformanceDiagnostics', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ record, snapshot }),
  });
})();
