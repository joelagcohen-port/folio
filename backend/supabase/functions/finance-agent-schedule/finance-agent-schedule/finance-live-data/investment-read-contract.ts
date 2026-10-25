export type InvestmentAccount = {
  account_id: string;
  canonical_account_id: string;
  item_id: string | null;
  type: string;
  lifecycle_status?: string | null;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  current_balance?: unknown;
  balance_updated_at?: string | null;
};

export type InvestmentPage<T> = { rows: T[]; complete: boolean; pages: number; row_count: number; upstream_total: number | null; reason: string | null };

export function selectInvestmentAccounts(accounts: InvestmentAccount[], requested: unknown) {
  const eligible = accounts.filter(row => row.type === "investment" && row.lifecycle_status !== "closed" && row.canonical_account_id && row.account_id);
  const byCanonical = new Map<string, InvestmentAccount[]>();
  for (const row of eligible) {
    const group = byCanonical.get(row.canonical_account_id) ?? [];
    group.push(row);
    byCanonical.set(row.canonical_account_id, group);
  }
  let ids: string[];
  if (requested === undefined) ids = [...byCanonical.keys()].sort();
  else {
    if (!Array.isArray(requested) || requested.length > 100 || requested.some(id => typeof id !== "string" || id.trim() === "")) {
      throw new Error("canonical_account_ids must be an array of up to 100 account IDs.");
    }
    ids = requested as string[];
    if (new Set(ids).size !== ids.length) throw new Error("canonical_account_ids must not contain duplicates.");
    const foreign = ids.filter(id => !byCanonical.has(id));
    if (foreign.length) throw new Error("One or more selected investment accounts are unavailable.");
  }
  const selected = ids.flatMap(id => byCanonical.get(id) ?? []);
  return {
    canonicalAccountIds: ids,
    accounts: selected,
    sourceAccountIds: [...new Set(selected.map(row => row.account_id))].sort(),
    accountsBySourceId: new Map(selected.map(row => [row.account_id, row])),
  };
}

export function nullableFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function strictCurrency(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) return null;
    return value;
  }
  return null;
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function collectOffsetPages<T>(
  fetchPage: (offset: number, count: number) => Promise<{ rows: T[]; total: number }>,
  options: { pageSize: number; maxPages: number },
): Promise<InvestmentPage<T>> {
  const { pageSize, maxPages } = options;
  const rows: T[] = [];
  let total: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    let result: { rows: T[]; total: number };
    try { result = await fetchPage(offset, pageSize); }
    catch { return { rows, complete: false, pages: page, row_count: rows.length, upstream_total: total, reason: "source_error" }; }
    if (!Array.isArray(result.rows) || !Number.isSafeInteger(result.total) || result.total < 0) {
      return { rows, complete: false, pages: page + 1, row_count: rows.length, upstream_total: total, reason: "invalid_page" };
    }
    if (total === null) total = result.total;
    else if (total !== result.total) return { rows, complete: false, pages: page + 1, row_count: rows.length, upstream_total: total, reason: "source_changed" };
    if (result.rows.length > pageSize || offset + result.rows.length > result.total) {
      return { rows, complete: false, pages: page + 1, row_count: rows.length, upstream_total: total, reason: "invalid_page" };
    }
    rows.push(...result.rows);
    if (rows.length === total) return { rows, complete: true, pages: page + 1, row_count: rows.length, upstream_total: total, reason: null };
    if (result.rows.length < pageSize) return { rows, complete: false, pages: page + 1, row_count: rows.length, upstream_total: total, reason: "short_page" };
  }
  return { rows, complete: false, pages: maxPages, row_count: rows.length, upstream_total: total, reason: "page_limit" };
}

export function normalizeActivityRows(rows: any[], selectedSourceAccounts: Map<string, InvestmentAccount>) {
  const byId = new Map<string, any>();
  let invalid = 0, foreign = 0, conflicts = 0, duplicates = 0;
  for (const row of rows) {
    if (!row || typeof row.investment_transaction_id !== "string" || !row.investment_transaction_id || typeof row.account_id !== "string") { invalid++; continue; }
    const account = selectedSourceAccounts.get(row.account_id);
    if (!account) { foreign++; continue; }
    const normalized = {
      investment_transaction_id: row.investment_transaction_id,
      canonical_account_id: account.canonical_account_id,
      source_account_id: row.account_id,
      date: validDateOnly(row.date) ? row.date : null,
      cancel_transaction_id: typeof row.cancel_transaction_id === "string" ? row.cancel_transaction_id : null,
      transaction_datetime: typeof row.transaction_datetime === "string" ? row.transaction_datetime : null,
      unofficial_currency_code: typeof row.unofficial_currency_code === "string" ? row.unofficial_currency_code : null,
      name: typeof row.name === "string" ? row.name : null,
      security_id: typeof row.security_id === "string" ? row.security_id : null,
      amount: nullableFinite(row.amount),
      price: nullableFinite(row.price),
      quantity: nullableFinite(row.quantity),
      fees: nullableFinite(row.fees),
      type: typeof row.type === "string" ? row.type : null,
      subtype: typeof row.subtype === "string" ? row.subtype : null,
      currency_code: strictCurrency(row.iso_currency_code, row.unofficial_currency_code),
      flow_classification: "unknown",
    };
    if (normalized.date === null) invalid++;
    const prior = byId.get(row.investment_transaction_id);
    if (prior) { duplicates++; if (JSON.stringify(prior) !== JSON.stringify(normalized)) conflicts++; }
    else if (!prior) byId.set(row.investment_transaction_id, normalized);
  }
  return { rows: [...byId.values()], invalid, foreign, conflicts, duplicates };
}

export function normalizeHistoryRows(rows: any[]) {
  const latest = new Map<string, any>();
  const sourceRows: any[] = [];
  const conflictingKeys = new Set<string>();
  let invalid = 0;
  for (const row of rows) {
    if (!row || typeof row.canonical_account_id !== "string" || !validDateOnly(row.snapshot_date)) { invalid++; continue; }
    const key = `${row.canonical_account_id}|${row.snapshot_date}`;
    const prior = latest.get(key);
    sourceRows.push({source_account_id: row.account_id ?? null, canonical_account_id: row.canonical_account_id, snapshot_date: row.snapshot_date, recorded_at: row.recorded_at ?? null, current_balance: nullableFinite(row.current_balance), currency_code: strictCurrency(row.currency_code), source: typeof row.source === "string" ? row.source : null});
    if (prior && (nullableFinite(prior.current_balance) !== nullableFinite(row.current_balance) || strictCurrency(prior.currency_code) !== strictCurrency(row.currency_code) || prior.source !== row.source)) conflictingKeys.add(key);
    if (!prior || String(row.recorded_at ?? "") >= String(prior.recorded_at ?? "")) latest.set(key, row);
  }
  return {
    rows: [...latest.values()].map(row => ({
      canonical_account_id: row.canonical_account_id,
      snapshot_date: row.snapshot_date,
      recorded_at: row.recorded_at ?? null,
      current_balance: nullableFinite(row.current_balance),
      currency_code: strictCurrency(row.currency_code),
      source: typeof row.source === "string" ? row.source : null,
    })).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date) || a.canonical_account_id.localeCompare(b.canonical_account_id)),
    source_rows: sourceRows,
    conflicting_snapshot_keys: [...conflictingKeys].sort(),
    invalid,
  };
}
