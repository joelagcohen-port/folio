import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { completedSpendingMonths, readSpendingAverage } from "../_shared/completed-year-spending.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { merchantMetadataFromTransaction } from "../_shared/merchant-recognition.ts";

type Row = Record<string, any>;
class HttpError extends Error {
  constructor(public status: number, message: string, public code = "query_failed") { super(message); }
}
const accountFields = "canonical_account_id,account_id,item_id,name,official_name,mask,type,subtype,current_balance,available_balance,credit_limit,balance_currency_code,balance_updated_at,updated_at,source_count";
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const MAX_ROWS = 20000;

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let requestedAction: unknown;
  const requestStartedAt = performance.now();
  try {
    // Authenticate the actual user, not the shared MCP secret or a supplied user ID.
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Sign in required.");
    const auth = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), options);
    const { data: identity, error: authError } = await auth.auth.getUser(authorization.slice(7));
    if (authError || !identity.user) throw new HttpError(401, "Sign in required.");
    if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new HttpError(401, "Sign in required.");

    let body: Row;
    try { body = await request.json(); } catch { throw new HttpError(400, "Invalid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected an object.");
    requestedAction = body.action;
    const allowed = new Set(["action", "household_id", "account_id", "canonical_account_ids", "transaction_ids", "start_date", "end_date", "query", "category", "include_pending", "pending_only", "mode", "generation", "revision", "target_revision", "change_revision", "cursor", "limit", "offset", "timezone"]);
    if (Object.keys(body).some(k => !allowed.has(k))) throw new HttpError(400, "Unknown input field.");
    if (!["list_accounts", "search_transactions", "spending_summary", "monthly_transaction_summaries", "sync_prepared_transactions", "completed_year_spending"].includes(body.action)) throw new HttpError(400, "Invalid action.");
    const householdInput = optionalText(body.household_id, 36);
    if (householdInput && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(householdInput)) throw new HttpError(400, "Invalid household_id.");
    const accountId = optionalText(body.account_id, 200);
    const canonicalAccountIds = canonicalAccountIdsInput(body.canonical_account_ids);
    if (canonicalAccountIds !== undefined && body.action !== "search_transactions") throw new HttpError(400, "canonical_account_ids is only available for transaction search.");
    const transactionIds = transactionIdsInput(body.transaction_ids);
    if (transactionIds && body.action !== "search_transactions") throw new HttpError(400, "transaction_ids is only available for transaction search.");
    const queryText = optionalText(body.query, 120)?.toLocaleLowerCase();
    const category = optionalText(body.category, 120);
    const syncMode = body.mode === undefined ? "page" : body.mode;
    if (body.action === "sync_prepared_transactions" && !["page", "delta"].includes(syncMode)) throw new HttpError(400, "Invalid transaction sync mode.");
    if (body.action !== "sync_prepared_transactions" && ["mode", "revision", "target_revision", "change_revision", "cursor"].some(key => body[key] !== undefined)) throw new HttpError(400, "Transaction sync fields are only available for replica sync.");
    const generation = optionalInteger(body.generation, 1, Number.MAX_SAFE_INTEGER);
    if (generation !== undefined && body.action !== "sync_prepared_transactions" && body.action !== "search_transactions") throw new HttpError(400, "generation is only available for transaction reads.");
    const revision = optionalInteger(body.revision, 0, Number.MAX_SAFE_INTEGER);
    const targetRevision = optionalInteger(body.target_revision, 0, Number.MAX_SAFE_INTEGER);
    const changeRevision = optionalInteger(body.change_revision, 0, Number.MAX_SAFE_INTEGER);
    const cursor = optionalText(body.cursor, 500);
    const start = dateInput(body.start_date);
    const end = dateInput(body.end_date);
    if (start && end && start > end) throw new HttpError(400, "start_date must precede end_date.");
    if (body.action === "sync_prepared_transactions" && (accountId || canonicalAccountIds !== undefined || transactionIds || start || end || queryText || category || body.pending_only !== undefined || body.include_pending !== undefined || body.offset !== undefined)) throw new HttpError(400, "Transaction filters are not available for replica sync.");
    if (body.include_pending !== undefined && typeof body.include_pending !== "boolean") throw new HttpError(400, "include_pending must be boolean.");
    if (body.pending_only !== undefined && typeof body.pending_only !== "boolean") throw new HttpError(400, "pending_only must be boolean.");
    if (body.pending_only === true && body.include_pending === false) throw new HttpError(400, "pending_only cannot be used when pending transactions are excluded.");
    if (body.pending_only === true && body.action !== "search_transactions") throw new HttpError(400, "pending_only is only available for transaction search.");
    if (body.action === "monthly_transaction_summaries" && (!start || !end || accountId || canonicalAccountIds !== undefined || transactionIds || queryText || category || body.pending_only !== undefined || generation !== undefined)) throw new HttpError(400, "Monthly history requires a date range and does not accept transaction filters.");
    const includePending = body.include_pending === true;
    const limit = integer(body.limit, body.action === "sync_prepared_transactions" ? 500 : 50, 1, body.action === "sync_prepared_transactions" ? 1000 : 200);
    const offset = integer(body.offset, 0, 0, MAX_ROWS);

    // This service client bypasses RLS: every data query below is explicitly scoped.
    const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), options);
    let membershipQuery = db.from("finance_household_members").select("household_id,role").eq("user_id", identity.user.id);
    if (householdInput) membershipQuery = membershipQuery.eq("household_id", householdInput);
    const { data: members, error: membershipError } = await membershipQuery.limit(2);
    check(membershipError);
    if (!members?.length) throw new HttpError(403, "No access to this household.");
    if (members.length !== 1) throw new HttpError(400, "Select a household using household_id.");
    const householdId = members[0].household_id;
    const common = { household_id: householdId, generated_at: new Date().toISOString() };
    if (body.action === "completed_year_spending") {
      const cacheStartedAt = performance.now();
      if (Object.keys(body).some(key => !["action", "household_id", "timezone"].includes(key))) throw new HttpError(400, "Invalid completed-year spending request.");
      const requestedTimezone = body.timezone === undefined ? undefined : optionalText(body.timezone, 100);
      const now = new Date();
      let window: ReturnType<typeof completedSpendingMonths>;
      try { window = completedSpendingMonths(requestedTimezone, now); }
      catch { throw new HttpError(400, "Invalid calendar time zone.", "invalid_timezone"); }
      const forMonth = `${window.forMonth}-01`, algorithmVersion = 1;
      const { data: cacheState, error: cacheError } = await db.rpc("finance_read_completed_year_spending_cache", {
        p_household_id: householdId, p_for_month: forMonth, p_timezone: window.timezone, p_algorithm_version: algorithmVersion,
      }).abortSignal(request.signal);
      check(cacheError);
      if (!cacheState || cacheState.ready !== true || !Number.isSafeInteger(cacheState.generation) || !Number.isSafeInteger(cacheState.revision) || !/^[0-9a-f]{32}$/.test(String(cacheState.source_fingerprint || ""))) {
        throw new HttpError(503, "Completed-year spending could not be verified.", "prepared_unavailable");
      }
      if (cacheState.cache_hit === true && cacheState.cacheable === true && validCompletedYearResult(cacheState.result, window)) {
        console.info("Completed-year spending cache", { outcome: "hit", status: 200, durationMs: Math.max(0, Math.round(performance.now() - cacheStartedAt)) });
        return json({ ...common, ...cacheState.result, cache_status: "hit", source_checked_at: new Date().toISOString() });
      }
      let cursor: string | null = null, generation: number | null = null, revision: number | null = null, totalRows: number | null = null;
      const rows: Row[] = [], seenCursors = new Set<string>(), seenTransactions = new Set<string>(); let downloadedRows = 0;
      for (let page = 0; page < 100; page++) {
        const { data, error } = await db.rpc("finance_sync_prepared_transactions", {
          p_household_id: householdId, p_mode: "page", p_generation: generation, p_revision: 0,
          p_after_transaction_id: cursor, p_limit: 1000, p_target_revision: null, p_change_revision: null,
        }).abortSignal(request.signal);
        check(error);
        if (!data || data.restart_required === true) throw new HttpError(503, "Prepared household history changed while it was loading.", "snapshot_changed");
        if (data.restart_required !== false || !Array.isArray(data.rows) || data.fresh !== true || data.stale !== false ||
            !Number.isSafeInteger(data.generation) || !Number.isSafeInteger(data.revision) || !Number.isSafeInteger(data.total_rows) || data.total_rows > 100000 ||
            data.complete !== (data.has_more === false) || data.has_more !== (typeof data.next_cursor === "string")) throw new HttpError(503, "Prepared household history could not be verified.", "incomplete");
        if (generation === null) { generation = data.generation; revision = data.revision; totalRows = data.total_rows; }
        else if (data.generation !== generation || data.revision !== revision || data.total_rows !== totalRows) throw new HttpError(503, "Prepared household history changed while it was loading.", "snapshot_changed");
        if (data.generation !== cacheState.generation || data.revision !== cacheState.revision) throw new HttpError(503, "Prepared household history changed while it was loading.", "snapshot_changed");
        for (const item of data.rows) {
          if (!item || typeof item.transaction_id !== "string" || seenTransactions.has(item.transaction_id) || item.deleted !== false || !item.row || typeof item.row !== "object" || String(item.row.transaction_id || "") !== item.transaction_id) throw new HttpError(503, "Prepared household history could not be verified.", "incomplete");
          seenTransactions.add(item.transaction_id); downloadedRows++; rows.push(item.row);
        }
        if (downloadedRows > 100000 || downloadedRows > (totalRows ?? 0)) throw new HttpError(503, "Prepared household history could not be verified.", "incomplete");
        if (data.has_more === false) { if (downloadedRows !== totalRows) throw new HttpError(503, "Prepared household history is incomplete.", "incomplete"); break; }
        if (typeof data.next_cursor !== "string" || seenCursors.has(data.next_cursor)) throw new HttpError(503, "Prepared household history is incomplete.", "incomplete");
        seenCursors.add(data.next_cursor); cursor = data.next_cursor;
        if (page === 99) throw new HttpError(503, "Prepared household history is incomplete.", "incomplete");
        if (request.signal.aborted) throw new HttpError(499, "This request is no longer needed.");
      }
      let result: Row;
      try { result = await readSpendingAverage(window.timezone, async () => { throw new Error("Prepared household history is incomplete."); }, now, request.signal, async () => rows); }
      catch (error) {
        if (request.signal.aborted) throw new HttpError(499, "This request is no longer needed.", "cancelled");
        const candidate = (error as any)?.code, code = ["allocation_invalid", "snapshot_changed", "incomplete", "upstream"].includes(String(candidate)) ? String(candidate) : "read_failed";
        throw new HttpError(503, "Completed-year spending could not be generated.", code);
      }
      let cacheStatus = "uncacheable_split";
      if (cacheState.cacheable === true) {
        const { data: stored, error: storeError } = await db.rpc("finance_store_completed_year_spending_cache", {
          p_household_id: householdId, p_for_month: forMonth, p_timezone: window.timezone, p_algorithm_version: algorithmVersion,
          p_source_fingerprint: cacheState.source_fingerprint, p_expected_generation: cacheState.generation,
          p_expected_revision: cacheState.revision, p_result: result,
        }).abortSignal(request.signal);
        check(storeError);
        if (stored?.current !== true) throw new HttpError(503, "Prepared household history changed while it was loading.", "snapshot_changed");
        cacheStatus = stored.stored === true ? "generated" : "uncacheable_split";
      }
      if (request.signal.aborted) throw new HttpError(499, "This request is no longer needed.");
      console.info("Completed-year spending cache", { outcome: cacheStatus, status: 200, durationMs: Math.max(0, Math.round(performance.now() - cacheStartedAt)) });
      return json({ ...common, ...result, cache_status: cacheStatus, source_checked_at: new Date().toISOString() });
    }
    if (body.action === "sync_prepared_transactions") {
      const { data, error } = await db.rpc("finance_sync_prepared_transactions", {
        p_household_id: householdId,
        p_mode: syncMode,
        p_generation: generation ?? null,
        p_revision: revision ?? 0,
        p_after_transaction_id: cursor ?? null,
        p_limit: limit,
        p_target_revision: targetRevision ?? null,
        p_change_revision: changeRevision ?? null,
      });
      check(error);
      const cursorIsValid = data?.restart_required === true || (syncMode === "page"
        ? (data?.next_cursor === null || typeof data?.next_cursor === "string")
        : ((data?.next_cursor_transaction_id === null || typeof data?.next_cursor_transaction_id === "string") &&
          (data?.next_cursor_revision === null || Number.isSafeInteger(data?.next_cursor_revision)) &&
          Number.isSafeInteger(data?.target_revision)));
      const hasContinuation = data?.restart_required === true || (data?.has_more === false || (syncMode === "page"
        ? typeof data?.next_cursor === "string"
        : Number.isSafeInteger(data?.next_cursor_revision) && typeof data?.next_cursor_transaction_id === "string"));
      if (!data || typeof data !== "object" ||
        !Number.isSafeInteger(data.generation) || !Number.isSafeInteger(data.revision) ||
        !Number.isSafeInteger(data.total_rows) || typeof data.complete !== "boolean" ||
        typeof data.fresh !== "boolean" || typeof data.stale !== "boolean" ||
        typeof data.restart_required !== "boolean" ||
        !cursorIsValid ||
        (data.restart_required !== true && typeof data.has_more !== "boolean") || !hasContinuation || data.fresh === data.stale ||
        (data.restart_required !== true && !Array.isArray(data.rows)) ||
        (Array.isArray(data.rows) && data.rows.some((item: Row) => typeof item?.transaction_id !== "string" || typeof item?.deleted !== "boolean" || (!item.deleted && (!item.row || typeof item.row !== "object"))))) {
        throw new HttpError(500, "The local transaction copy could not be verified.");
      }
      return json({ ...common, ...data, rows: Array.isArray(data.rows) ? data.rows : [], has_more: data.restart_required ? false : data.has_more, next_cursor: data.restart_required ? null : data.next_cursor ?? null, next_cursor_revision: data.restart_required ? null : data.next_cursor_revision ?? null, next_cursor_transaction_id: data.restart_required ? null : data.next_cursor_transaction_id ?? null });
    }
    let accounts: Row[] = [];
    if (body.action === "list_accounts") {
      const { data: items, error: itemsError } = await db.from("plaid_items").select("item_id,institution_id").eq("household_id", householdId).limit(101);
      check(itemsError);
      if ((items?.length ?? 0) > 100) throw new HttpError(422, "Household connection limit exceeded.");
      const itemIds = (items ?? []).map(i => i.item_id);
      if (itemIds.length) {
      const { data, error } = await db.from("finance_household_accounts").select(accountFields).eq("household_id", householdId).order("account_id").limit(501);
      check(error);
      if ((data?.length ?? 0) > 500) throw new HttpError(422, "Household account limit exceeded.");
      accounts = data ?? [];
      }
    } else {
      if (accountId) {
        const { data, error } = await db.from("finance_household_accounts").select("account_id").eq("household_id", householdId).eq("account_id", accountId).limit(1);
        check(error);
        if (!data?.length) throw new HttpError(403, "Account is not available in this household.");
      }
      if (canonicalAccountIds !== undefined && canonicalAccountIds.length) {
        const { data, error } = await db.from("finance_canonical_household_accounts").select("canonical_account_id").eq("household_id", householdId).in("canonical_account_id", canonicalAccountIds).limit(501);
        check(error);
        const available = new Set((data ?? []).map((row: Row) => String(row.canonical_account_id)));
        if (available.size !== canonicalAccountIds.length || canonicalAccountIds.some(id => !available.has(id))) throw new HttpError(403, "An account is not available in this household.");
      }
    }
    if (body.action === "list_accounts") {
      return json({
        ...common,
        accounts: accounts
          .filter(a => !accountId || a.account_id === accountId)
          .map(a => ({
            ...a,
            current_balance: nullableNumber(a.current_balance),
            available_balance: nullableNumber(a.available_balance),
            credit_limit: nullableNumber(a.credit_limit),
            asset_group: assetGroup(a.type),
            balance_status: a.balance_updated_at ? "current" : "unavailable",
          })),
      });
    }

    if (body.action === "monthly_transaction_summaries") {
      const { data, error } = await db.rpc("finance_prepared_transaction_monthly_summaries", {
        p_household_id: householdId, p_start_date: start, p_end_date: end, p_include_pending: includePending,
      });
      check(error);
      if (!data || typeof data !== "object" || !Array.isArray(data.months) || !Number.isSafeInteger(data.generation) || !Number.isSafeInteger(data.revision) || typeof data.fresh !== "boolean" || typeof data.stale !== "boolean" || data.fresh === data.stale || data.months.some((month: Row) => {
        const coverage = month?.allocation_coverage;
        if (typeof month?.key !== "string" || typeof month.start !== "string" || typeof month.end !== "string" ||
          !coverage || typeof coverage !== "object" || !["complete", "unavailable"].includes(coverage.status) ||
          !Number.isSafeInteger(coverage.parent_count) || coverage.parent_count < 0 ||
          !Number.isSafeInteger(coverage.unavailable_parent_count) || coverage.unavailable_parent_count < 0 ||
          coverage.unavailable_parent_count > coverage.parent_count ||
          !(coverage.non_usd_split_parent_count === undefined || Number.isSafeInteger(coverage.non_usd_split_parent_count) && coverage.non_usd_split_parent_count >= 0)) return true;
        if (coverage.status === "complete") {
          return coverage.unavailable_parent_count !== 0 ||
            (coverage.non_usd_split_parent_count !== undefined && coverage.non_usd_split_parent_count !== 0) ||
            data.stale !== false || !Array.isArray(month.categories) ||
            !Array.isArray(month.daily_budget_spending) ||
            ![month.money_in, month.money_out, month.net_cash_flow].every(value => typeof value === "number" && Number.isFinite(value));
        }
        // An unavailable month must remain explicitly null in every aggregate;
        // do not let absent or malformed fields be interpreted as empty/zero history.
        return (coverage.unavailable_parent_count === 0 && data.stale !== true) ||
          month.money_in !== null || month.money_out !== null || month.net_cash_flow !== null ||
          month.categories !== null || month.daily_budget_spending !== null;
      })) throw new HttpError(503, "Prepared household history could not be verified.");
      const allMonthsComplete = data.fresh === true && data.stale === false && data.months.length > 0 &&
        data.months.every((month: Row) => month.allocation_coverage.status === "complete");
      const parentCount = data.months.reduce((sum: number, month: Row) => sum + month.allocation_coverage.parent_count, 0);
      const unavailableParentCount = data.months.reduce((sum: number, month: Row) => sum + month.allocation_coverage.unavailable_parent_count, 0);
      return json({
        ...common,
        ...data,
        allocation_coverage: {
          status: allMonthsComplete ? "complete" : "unavailable",
          month_count: data.months.length,
          parent_count: parentCount,
          unavailable_parent_count: unavailableParentCount,
        },
      });
    }

    if (body.action === "search_transactions") {
      const rpcName = canonicalAccountIds === undefined ? "finance_search_prepared_transactions_page" : "finance_search_prepared_transactions_page_by_canonical_accounts";
      const { data, error } = await db.rpc(rpcName, {
        p_household_id: householdId,
        p_account_id: accountId ?? null,
        ...(canonicalAccountIds === undefined ? {} : { p_canonical_account_ids: canonicalAccountIds }),
        p_transaction_ids: transactionIds ?? null,
        p_start_date: start ?? null,
        p_end_date: end ?? null,
        p_query: queryText ?? null,
        p_category: category ?? null,
        p_include_pending: includePending,
        p_pending_only: body.pending_only === true,
        p_limit: limit,
        p_offset: offset,
        p_expected_generation: generation ?? null,
      });
      check(error);
      if (!data || typeof data !== "object" || !Array.isArray(data.transactions) ||
        (canonicalAccountIds !== undefined && typeof data.bounded_incomplete !== "boolean") ||
        !Number.isInteger(data.matched_transactions) || data.matched_transactions < 0 ||
        !(data.next_offset === null || Number.isInteger(data.next_offset)) ||
        typeof data.restart_required !== "boolean" || !Number.isSafeInteger(data.generation) || !Number.isSafeInteger(data.revision) ||
        typeof data.fresh !== "boolean" || typeof data.stale !== "boolean" || data.fresh === data.stale) {
        throw new HttpError(500, "The transaction page could not be verified.");
      }
      const filters = { account_id: accountId ?? null, canonical_account_ids: canonicalAccountIds ?? null, transaction_ids: transactionIds ?? null, start_date: start ?? null, end_date: end ?? null, include_pending: includePending, pending_only: body.pending_only === true, query: queryText ?? null, category: category ?? null };
      const transactionRows = data.transactions.map((transaction: Row) => {
        const amount = Number(transaction.amount);
        if (!Number.isFinite(amount)) throw new HttpError(500, "Invalid stored amount.");
        return {
          ...transaction,
          amount,
          transaction_date: transaction.effective_transaction_date,
          merchant_name: transaction.effective_merchant_name,
          updated_at: transaction.override_updated_at || transaction.plaid_updated_at,
          logo_url: plaidLogoUrl(transaction.counterparties),
          ...merchantMetadataFromTransaction(transaction),
        };
      });
      return json({
        ...common,
        filters,
        amount_convention: "Plaid: positive is money out; negative is money in.",
        consistency: "Transaction pages use one consistent snapshot. If new activity arrives, reload before reconciling totals.",
        matched_transactions: data.matched_transactions,
        generation: data.generation,
        revision: data.revision,
        fresh: data.fresh,
        stale: data.stale,
        restart_required: data.restart_required,
        refreshed_at: data.refreshed_at ?? null,
        transactions: transactionRows,
        next_offset: data.restart_required ? null : data.next_offset,
        ...(canonicalAccountIds === undefined ? {} : { bounded_incomplete: data.bounded_incomplete }),
      });
    }

    const summaryFilters = { account_id: accountId ?? null, transaction_ids: null, start_date: start ?? null, end_date: end ?? null, include_pending: includePending, query: queryText ?? null, category: category ?? null };
    const { data: summary, error: summaryError } = await db.rpc("finance_prepared_transaction_summaries", {
      p_household_id: householdId,
      p_start_date: start ?? null,
      p_end_date: end ?? null,
      p_include_pending: includePending,
      p_account_id: accountId ?? null,
      p_query: queryText ?? null,
      p_category: category ?? null,
    });
    check(summaryError);
    if (!summary || typeof summary !== "object" || !Array.isArray(summary.currencies) ||
      !Number.isInteger(summary.matched_transactions) || summary.matched_transactions < 0 ||
      summary.fresh !== true || summary.stale !== false ||
      !Number.isSafeInteger(summary.generation) || !Number.isSafeInteger(summary.revision)) {
      throw new HttpError(503, "A current household spending summary is not available. Please retry.");
    }
    return json({
      ...common,
      filters: summaryFilters,
      matched_transactions: summary.matched_transactions,
      amount_convention: "Plaid: positive is money out; negative is money in.",
      consistency: "Prepared from one current canonical transaction generation.",
      summary_basis: "canonical_budget_spending_and_classified_cash_flow",
      includes_transfers_and_card_payments: false,
      excludes_manual_transaction_exclusions: true,
      permanently_deleted_transactions_visible: false,
      generation: summary.generation,
      revision: summary.revision,
      fresh: true,
      stale: false,
      refreshed_at: summary.refreshed_at ?? null,
      notes: [
        "Income and expenses use the household's effective Monarch-style category mapping.",
        "Household spending uses the same budget exclusions as the Budget screen.",
        "cash_flow_money_out and net_cash_flow use cash-flow exclusions.",
        "Matched refunds are cash inflows and negative budget spending in the linked category; they are excluded from earned income.",
        "Currencies are separate; UNKNOWN is not assumed to be USD.",
        "Totals are rounded to two decimal places.",
      ],
      currencies: summary.currencies,
    });
  } catch (error) {
    // Never echo database errors, auth responses, request bodies, or credentials.
    const status = requestedAction === "completed_year_spending" && request.signal.aborted ? 499 : error instanceof HttpError ? error.status : 500;
    if (requestedAction === "completed_year_spending") console.warn("Completed-year spending read failed", { code: error instanceof HttpError ? error.code : "query_failed", status, durationMs: Math.max(0, Math.round(performance.now() - requestStartedAt)) });
    return json({ error: status === 499 ? "This request is no longer needed." : error instanceof HttpError ? error.message : "Could not query household finances." }, status);
  }
});

function check(error: unknown) { if (error) throw new HttpError(500, "Could not read household data."); }
function required(name: string) { const v = Deno.env.get(name); if (!v) throw new HttpError(500, "Server configuration is incomplete."); return v; }
function optionalText(v: unknown, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, "Invalid text filter.");
  return v.trim();
}
function transactionIdsInput(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new HttpError(400, "transaction_ids must contain 1 to 500 IDs.");
  const ids = value.map(id => {
    if (typeof id !== "string" || !id.trim() || id.length > 200) throw new HttpError(400, "Invalid transaction ID.");
    return id.trim();
  });
  return [...new Set(ids)];
}
function dateInput(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, "Dates must use YYYY-MM-DD.");
  const date = new Date(v + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== v) throw new HttpError(400, "Invalid calendar date.");
  return v;
}
function integer(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, "Invalid pagination value.");
  return v;
}
function optionalInteger(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new HttpError(400, "Invalid transaction sync cursor.");
  return v;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function plaidLogoUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter((entry): entry is Row => entry !== null && typeof entry === "object" && !Array.isArray(entry));
  rows.sort((a, b) => (a.type === "merchant" ? -1 : 0) - (b.type === "merchant" ? -1 : 0));
  for (const row of rows) {
    const logo = typeof row.logo_url === "string" ? row.logo_url : "";
    if (/^https:\/\/(?:plaid-merchant-logos|plaid-counterparty-logos)\.plaid\.com\//i.test(logo)) return logo;
  }
  return null;
}
function assetGroup(type: string) { return type === "depository" ? "Cash" : type === "investment" ? "Investments" : ["credit", "loan"].includes(type) ? "Liabilities" : "Other"; }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }

function validCompletedYearResult(value: unknown, window: ReturnType<typeof completedSpendingMonths>): value is Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Row, coverage = result.allocation_coverage;
  return result.schemaVersion === 2 && result.forMonth === window.forMonth && result.timezone === window.timezone && result.monthCount === 12 &&
    coverage?.status === "complete" && coverage.month_count === 12 && coverage.currency === "USD" && coverage.unavailable_parent_count === 0 &&
    result.start === window.months[0].start && result.endExclusive === window.months[11].endExclusive &&
    Array.isArray(result.months) && result.months.length === 12 && result.months.every((month: Row, index: number) => month && month.key === window.months[index].key && month.start === window.months[index].start && month.endExclusive === window.months[index].endExclusive && Number.isFinite(month.spending) && Array.isArray(month.cumulative) && month.cumulative.length === 31 && month.cumulative.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) &&
    Array.isArray(result.actualMonths) && result.actualMonths.length === 12 && result.actualMonths.every((month: Row, index: number) => month && month.key === window.months[index].key && Number.isFinite(month.total) && Array.isArray(month.cumulative) && month.cumulative.length === 31 && month.cumulative.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) &&
    Array.isArray(result.cumulativeAverage) && result.cumulativeAverage.length === 31 && result.cumulativeAverage.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) && Number.isFinite(result.average) && Number.isFinite(result.total) && Number.isSafeInteger(result.excludedCount) && Number.isFinite(result.excludedTotal);
}

function canonicalAccountIdsInput(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new HttpError(400, "Invalid canonical_account_ids.");
  return [...new Set(value.map(id => String(id).toLowerCase()))].sort();
}

