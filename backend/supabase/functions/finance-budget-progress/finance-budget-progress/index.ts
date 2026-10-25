import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { calendarDate, resolveCalendarTimeZone } from "../finance-live-data/date-context.ts";
import { countsTowardBudget } from "../_shared/accounting.ts";

type Row = Record<string, unknown>;

type HouseholdContext = {
  userId: string;
  householdId: string;
  role: string;
};

type BudgetTarget = {
  budget_target_id: string;
  category: string;
  subcategory: string | null;
  monthly_target_amount: number | string;
  currency_code: string;
};

type EffectiveTransaction = {
  transaction_id: string;
  effective_transaction_date: string;
  effective_category: string;
  effective_subcategory: string | null;
  amount: number | string;
  iso_currency_code: string | null;
  pending: boolean;
  effective_type: string;
  excluded_from_totals: boolean;
  category_excluded_from_budget: boolean;
  transaction_excluded_from_budget: boolean;
  split_status?: "passthrough" | "available" | "unavailable";
  split_allocations?: Row[];
};

const responseHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
  "cache-control": "no-store",
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: responseHeaders,
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const context = await authenticate(request);
    const body = await readBody(request);

    rejectUnknownProperties(body, [
      "month",
      "as_of_date",
      "include_pending",
      "timezone",
    ]);

    let timezone: string;
    try {
      timezone = resolveCalendarTimeZone(body.timezone);
    } catch {
      throw new RequestError("timezone must be a valid IANA time zone.", 400);
    }
    const today = calendarDate(new Date(), timezone);
    const requestedMonth = optionalMonth(body.month);
    const requestedAsOfDate = optionalDate(
      body.as_of_date,
      "as_of_date",
    );
    const includePending = optionalBoolean(
      body.include_pending,
      false,
    );

    const month = requestedMonth ??
      requestedAsOfDate?.slice(0, 7) ??
      today.slice(0, 7);

    if (
      requestedAsOfDate &&
      requestedAsOfDate.slice(0, 7) !== month
    ) {
      return json(
        {
          error:
            "as_of_date must fall within the selected month.",
        },
        400,
      );
    }

    const monthStart = `${month}-01`;
    const monthEnd = lastDayOfMonth(month);
    const asOfDate = chooseAsOfDate(
      month,
      today,
      requestedAsOfDate,
      monthStart,
      monthEnd,
    );

    const weekStart = maxDate(
      mondayOfWeek(asOfDate),
      monthStart,
    );
    const weekEnd = minDate(
      sundayOfWeek(asOfDate),
      monthEnd,
    );

    const database = serviceClient();

    const { data: targetRows, error: targetError } =
      await database
        .from("finance_budget_targets")
        .select(
          "budget_target_id,category,subcategory,monthly_target_amount,currency_code",
        )
        .eq("household_id", context.householdId)
        .eq("active", true)
        .order("category", { ascending: true });

    if (targetError) {
      throw new SafeError("Could not load budget targets.");
    }

    const targets = (targetRows ?? []) as BudgetTarget[];
    let transactionEvidence: Awaited<ReturnType<typeof loadMonthTransactions>>;
    let pendingSplitAvailable = true;
    let pendingSplitUnavailableReason: string | null = null;
    try {
      transactionEvidence = await loadMonthTransactions(
        database, context.householdId, monthStart, asOfDate, true,
      );
    } catch (error) {
      if (includePending || !(error instanceof SafeError)) throw error;
      // Keep the legacy posted-only result if the extra all-status scan cannot
      // finish; explicitly mark its new split unavailable.
      transactionEvidence = await loadMonthTransactions(
        database, context.householdId, monthStart, asOfDate, false,
      );
      pendingSplitAvailable = false;
      pendingSplitUnavailableReason = "pending_coverage_incomplete";
    }
    const transactions = transactionEvidence.rows;
    const currencyCoverageVerified = transactions.every((transaction) =>
      isCurrencyCode(transaction.iso_currency_code)
    ) && targets.every((target) => isCurrencyCode(target.currency_code));
    if (!currencyCoverageVerified) {
      pendingSplitAvailable = false;
      pendingSplitUnavailableReason = "currency_coverage_unverified";
    }
    const includedTransactions = includePending
      ? transactions
      : transactions.filter((transaction) => transaction.pending !== true);

    const targetProgress = targets.map((target) =>
      calculateTargetProgress(
        target,
        transactions,
        includePending,
        pendingSplitAvailable,
        monthStart,
        monthEnd,
        asOfDate,
        weekStart,
        weekEnd,
      )
    );

    // Additive F2 capacity fields. Legacy targets/totals remain base-target values.
    let rolloverStates: any = null;
    try { const result=await database.rpc("finance_get_budget_rollover_states", {h:context.householdId,a:context.userId,m:monthStart}); if(!result.error)rolloverStates=result.data; } catch {}
    const stateScope=rolloverStates?.household_id===context.householdId&&rolloverStates?.actor_user_id===context.userId&&rolloverStates?.month===monthStart&&Array.isArray(rolloverStates?.states);
    for(const row of targetProgress){
      const state=stateScope?rolloverStates.states.find((entry:any)=>entry.budget_target_id===row.budget_target_id):null;
      let rollover:any={status:"unavailable",reason:"rollover_state_unavailable"};
      if(state?.setting_available===true&&typeof state.current_enabled==="boolean"&&typeof state.setting?.enabled==="boolean"){
        if(!state.current_enabled)rollover={status:"available",current_enabled:false,setting:state.setting,opening_carry_cents:0,available_monthly_target:row.monthly.target,available_weekly_target:row.weekly.adjusted_target};
        else {
          const capacity=state.capacity?.status==="closed"?state.capacity.evidence:state.capacity;
          if(["available","closed"].includes(state.capacity?.status)&&state.setting.timezone===timezone&&String(rolloverStates.generation)===String(transactionEvidence.generation)&&Number.isSafeInteger(capacity?.opening_carry_cents)&&capacity.opening_carry_cents>=0&&capacity.base_target_cents===Math.round(row.monthly.target*100)){
            const totalCents=Math.round(row.monthly.target*100)+capacity.opening_carry_cents;
            if(Number.isSafeInteger(totalCents))rollover={status:"available",current_enabled:true,setting:state.setting,opening_carry_cents:capacity.opening_carry_cents,available_monthly_target:totalCents/100,available_weekly_target:roundMoney(Math.max(totalCents/100-row.weekly.spent_before_week,0)*inclusiveDays(weekStart,weekEnd)/inclusiveDays(weekStart,monthEnd)),generation:rolloverStates.generation};
          } else rollover={status:"unavailable",current_enabled:true,setting:state.setting,reason:"carry_lineage_or_scope_unavailable"};
        }
      }
      Object.assign(row,{rollover});
    }

    const activeTargetKeys = new Set(
      targets.map((target) => targetKey(
        target.category,
        target.subcategory,
        target.currency_code,
      )),
    );

    const unbudgetedByCurrency = new Map<string, number>();

    for (const transaction of includedTransactions) {
      const currency = normalizedCurrency(
        transaction.iso_currency_code,
      );
      const key = targetKey(
        transaction.effective_category,
        transaction.effective_subcategory,
        currency,
      );

      const categoryOnlyKey = targetKey(
        transaction.effective_category,
        null,
        currency,
      );

      if (
        !activeTargetKeys.has(key) &&
        !activeTargetKeys.has(categoryOnlyKey)
      ) {
        unbudgetedByCurrency.set(
          currency,
          roundMoney(
            (unbudgetedByCurrency.get(currency) ?? 0) +
              numberValue(transaction.amount),
          ),
        );
      }
    }

    const totalsByCurrency = buildTotals(targetProgress);

    return json({
      household_id: context.householdId,
      generated_at: new Date().toISOString(),
      timezone,
      period: {
        month,
        month_start: monthStart,
        month_end: monthEnd,
        as_of_date: asOfDate,
        current_week_start: weekStart,
        current_week_end: weekEnd,
        week_starts_on: "monday",
      },
      include_pending: includePending,
      scope: {
        household_id: context.householdId,
        month,
        start_date: monthStart,
        end_date: asOfDate,
        timezone,
      },
      coverage: {
        status: "complete",
        status_scope: "caller_requested_legacy_progress",
        source: "finance_query_prepared_transactions",
        transaction_generation: transactionEvidence.generation,
        start_date: monthStart,
        end_date: asOfDate,
        eligible_transaction_count: transactionEvidence.parentCount,
        eligible_budget_row_count: transactions.length,
        eligible_parent_count: transactionEvidence.parentCount,
        split_allocation_count: transactionEvidence.allocationCount,
        split_parent_count: transactionEvidence.splitParentCount,
        split_allocation_status: "complete",
        posted_pending_split_available: pendingSplitAvailable,
        posted_pending_split_unavailable_reason: pendingSplitUnavailableReason,
        currency_status: currencyCoverageVerified ? "verified" : "unverified",
        unverified_currency_transaction_count: transactions.filter((transaction) =>
          !isCurrencyCode(transaction.iso_currency_code)
        ).length,
        currencies: [...new Set([
          ...targets.filter((target) => isCurrencyCode(target.currency_code)).map((target) =>
            normalizedCurrency(target.currency_code)
          ),
          ...transactions.map((transaction) =>
            isCurrencyCode(transaction.iso_currency_code)
              ? normalizedCurrency(transaction.iso_currency_code)
              : null
          ).filter((currency): currency is string => currency !== null),
        ])].sort(),
      },
      calculation_notes: {
        monthly_target_is_fixed: true,
        weekly_target_method:
          "Remaining monthly target after spending before the current week, allocated proportionally across the remaining calendar days in the month.",
        refunds_reduce_spending: true,
        transfers_and_card_payments_excluded: true,
        manually_excluded_transactions_excluded: true,
        permanently_deleted_transactions_visible: false,
      },
      totals_by_currency: totalsByCurrency,
      unbudgeted_spending_by_currency:
        mapToCurrencyRows(unbudgetedByCurrency),
      targets: targetProgress,
    });
  } catch (error) {
    console.error(
      "Budget progress request failed",
      error instanceof Error ? error.message : error,
    );

    if (error instanceof RequestError) {
      return json({ error: error.message }, error.status);
    }

    if (error instanceof SafeError) {
      return json({ error: error.message }, 400);
    }

    return json(
      { error: "Could not calculate budget progress." },
      500,
    );
  }
});

function calculateTargetProgress(
  target: BudgetTarget,
  transactions: EffectiveTransaction[],
  includePending: boolean,
  pendingSplitAvailable: boolean,
  monthStart: string,
  monthEnd: string,
  asOfDate: string,
  weekStart: string,
  weekEnd: string,
) {
  const monthlyTarget = numberValue(
    target.monthly_target_amount,
  );
  const currency = normalizedCurrency(target.currency_code);

  const allMatching = transactions.filter((transaction) => {
    if (
      normalizedCurrency(transaction.iso_currency_code) !==
        currency
    ) {
      return false;
    }

    if (
      normalizeText(transaction.effective_category) !==
        normalizeText(target.category)
    ) {
      return false;
    }

    if (target.subcategory) {
      return normalizeText(
        transaction.effective_subcategory ?? "",
      ) === normalizeText(target.subcategory);
    }

    return true;
  });
  const matching = includePending
    ? allMatching
    : allMatching.filter((transaction) => transaction.pending !== true);

  const monthlySpent = roundMoney(sumAmounts(matching));
  const postedSpent = pendingSplitAvailable
    ? roundMoney(sumAmounts(
      allMatching.filter((transaction) => transaction.pending !== true),
    ))
    : null;
  const pendingSpent = pendingSplitAvailable
    ? roundMoney(sumAmounts(
      allMatching.filter((transaction) => transaction.pending === true),
    ))
    : null;

  const spentBeforeWeek = roundMoney(sumAmounts(
    matching.filter(
      (transaction) =>
        transaction.effective_transaction_date >= monthStart &&
        transaction.effective_transaction_date < weekStart,
    ),
  ));

  const currentWeekSpent = roundMoney(sumAmounts(
    matching.filter(
      (transaction) =>
        transaction.effective_transaction_date >= weekStart &&
        transaction.effective_transaction_date <= asOfDate,
    ),
  ));

  const remainingAtWeekStart = roundMoney(
    Math.max(monthlyTarget - spentBeforeWeek, 0),
  );

  const remainingDaysAtWeekStart = inclusiveDays(
    weekStart,
    monthEnd,
  );

  const currentWeekCalendarDays = inclusiveDays(
    weekStart,
    weekEnd,
  );

  const adjustedWeeklyTarget = roundMoney(
    remainingDaysAtWeekStart > 0
      ? remainingAtWeekStart *
        currentWeekCalendarDays /
        remainingDaysAtWeekStart
      : 0,
  );

  const baseWeeklyTarget = roundMoney(
    monthlyTarget *
      currentWeekCalendarDays /
      inclusiveDays(monthStart, monthEnd),
  );

  const elapsedWeekDays = inclusiveDays(weekStart, asOfDate);
  const expectedByToday = roundMoney(
    adjustedWeeklyTarget *
      elapsedWeekDays /
      currentWeekCalendarDays,
  );

  return {
    budget_target_id: target.budget_target_id,
    category: target.category,
    subcategory: target.subcategory,
    currency_code: currency,
    monthly: {
      target: roundMoney(monthlyTarget),
      spent: monthlySpent,
      posted_spent: postedSpent,
      pending_spent: pendingSpent,
      posted_pending_split_available: pendingSplitAvailable,
      pending_included_in_spent: includePending,
      remaining: roundMoney(monthlyTarget - monthlySpent),
      progress_percent: progressPercent(
        monthlySpent,
        monthlyTarget,
      ),
      transaction_count: new Set(matching.map((transaction) => transaction.transaction_id)).size,
    },
    weekly: {
      week_start: weekStart,
      week_end: weekEnd,
      base_target: baseWeeklyTarget,
      adjusted_target: adjustedWeeklyTarget,
      spent_before_week: spentBeforeWeek,
      spent: currentWeekSpent,
      remaining: roundMoney(
        adjustedWeeklyTarget - currentWeekSpent,
      ),
      expected_spend_by_today: expectedByToday,
      progress_percent: progressPercent(
        currentWeekSpent,
        adjustedWeeklyTarget,
      ),
      adjustment_from_base: roundMoney(
        adjustedWeeklyTarget - baseWeeklyTarget,
      ),
      status: currentWeekSpent > adjustedWeeklyTarget
        ? "over_adjusted_target"
        : currentWeekSpent > expectedByToday
        ? "ahead_of_pace"
        : "on_track",
    },
  };
}

function buildTotals(
  progress: ReturnType<typeof calculateTargetProgress>[],
) {
  const totals = new Map<
    string,
    {
      monthly_target: number;
      monthly_spent: number;
      monthly_posted_spent: number;
      monthly_pending_spent: number;
      monthly_split_available: boolean;
      monthly_remaining: number;
      adjusted_weekly_target: number;
      weekly_spent: number;
      weekly_remaining: number;
    }
  >();

  for (const target of progress) {
    const current = totals.get(target.currency_code) ?? {
      monthly_target: 0,
      monthly_spent: 0,
      monthly_posted_spent: 0,
      monthly_pending_spent: 0,
      monthly_split_available: true,
      monthly_remaining: 0,
      adjusted_weekly_target: 0,
      weekly_spent: 0,
      weekly_remaining: 0,
    };

    current.monthly_target = roundMoney(
      current.monthly_target + target.monthly.target,
    );
    current.monthly_spent = roundMoney(
      current.monthly_spent + target.monthly.spent,
    );
    current.monthly_posted_spent = roundMoney(
      current.monthly_posted_spent + (target.monthly.posted_spent ?? 0),
    );
    current.monthly_pending_spent = roundMoney(
      current.monthly_pending_spent + (target.monthly.pending_spent ?? 0),
    );
    current.monthly_split_available = current.monthly_split_available &&
      target.monthly.posted_pending_split_available;
    current.monthly_remaining = roundMoney(
      current.monthly_remaining + target.monthly.remaining,
    );
    current.adjusted_weekly_target = roundMoney(
      current.adjusted_weekly_target +
        target.weekly.adjusted_target,
    );
    current.weekly_spent = roundMoney(
      current.weekly_spent + target.weekly.spent,
    );
    current.weekly_remaining = roundMoney(
      current.weekly_remaining + target.weekly.remaining,
    );

    totals.set(target.currency_code, current);
  }

  return Array.from(totals.entries()).map(
    ([currency_code, values]) => ({
      currency_code,
      ...values,
      monthly_posted_spent: values.monthly_split_available
        ? values.monthly_posted_spent
        : null,
      monthly_pending_spent: values.monthly_split_available
        ? values.monthly_pending_spent
        : null,
      monthly_progress_percent: progressPercent(
        values.monthly_spent,
        values.monthly_target,
      ),
      weekly_progress_percent: progressPercent(
        values.weekly_spent,
        values.adjusted_weekly_target,
      ),
    }),
  );
}

async function loadMonthTransactions(
  database: ReturnType<typeof serviceClient>,
  householdId: string,
  startDate: string,
  endDate: string,
  includePending: boolean,
): Promise<{ rows: EffectiveTransaction[]; generation: number | string | null; parentCount: number; allocationCount: number; splitParentCount: number }> {
  const pageSize = 1000;
  const maximumRows = 20000;
  const maximumAttempts = 2;

  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    const rows: EffectiveTransaction[] = [];
    let parentCount = 0;
    let allocationCount = 0;
    let splitParentCount = 0;
    const eligibleParentIds = new Set<string>();
    let afterDate: string | null = null;
    let afterId: string | null = null;
    let generation: number | string | null = null;

    try {
      for (let offset = 0; offset < maximumRows; offset += pageSize) {
        const { data, error } = await database.rpc("finance_query_prepared_transactions", {
          p_household_id: householdId,
          p_start_date: startDate,
          p_end_date: endDate,
          // Load one complete effective view so the response can report both
          // posted and pending values. Legacy totals still honor include_pending.
          p_include_pending: includePending,
          p_after_date: afterDate,
          p_after_transaction_id: afterId,
          p_limit: pageSize,
          p_expected_generation: generation,
        });
        if (error) {
          throw new SafeError("Could not load complete prepared transactions for budget progress.");
        }
        if (data?.restart_required === true) {
          throw new PreparedSnapshotChanged("generation_changed");
        }
        if (data?.stale === true || data?.fresh === false) {
          throw new PreparedSnapshotChanged("snapshot_stale");
        }
        if (!data || data.fresh !== true || !Array.isArray(data.transactions) || data.has_more === undefined) {
          throw new SafeError("Could not load complete prepared transactions for budget progress.");
        }
        if (!validPreparedGeneration(data.generation)) {
          throw new SafeError("Could not load a stable prepared transaction generation.");
        }
        if (generation !== null && generationKey(generation) !== generationKey(data.generation)) {
          throw new PreparedSnapshotChanged("generation_changed");
        }
        generation = data.generation;
        const page = data.transactions as EffectiveTransaction[];
        const expanded = expandPreparedBudgetRows(page);
        if (!expanded.available) {
          throw new RequestError("Split transaction allocation coverage is unavailable. Retry after household history refreshes.", 503);
        }
        allocationCount += expanded.allocationCount;
        splitParentCount += expanded.splitParentCount;
        const budgetRows = expanded.rows.filter(countsTowardBudget);
        for (const row of budgetRows) eligibleParentIds.add(row.transaction_id);
        rows.push(...budgetRows);
        parentCount = eligibleParentIds.size;
        if (data.has_more !== true) return { rows, generation, parentCount, allocationCount, splitParentCount };
        afterDate = data.next_date;
        afterId = data.next_transaction_id;
        if (typeof afterDate !== "string" || typeof afterId !== "string") {
          throw new SafeError("Could not continue prepared transaction pagination.");
        }
      }
      throw new SafeError(
        "The selected month exceeds the 20,000 transaction safety limit.",
      );
    } catch (error) {
      if (!(error instanceof PreparedSnapshotChanged)) throw error;
      if (attempt + 1 >= maximumAttempts) {
        console.warn("Budget progress snapshot remained unavailable after bounded retry", {
          reason: error.reason,
          attempts: maximumAttempts,
        });
        throw new RequestError("Budget data is temporarily unavailable while transaction history refreshes. Please retry.", 503);
      }
      // A restart discards every accumulated page and starts a complete read
      // against the new generation. Keep diagnostics bounded and free of row
      // content or household identifiers.
      console.warn("Retrying budget progress after prepared snapshot changed", {
        reason: error.reason,
        retry: attempt + 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new SafeError("Could not load complete prepared transactions for budget progress.");
}

function expandPreparedBudgetRows(
  parents: EffectiveTransaction[],
): { available: boolean; rows: EffectiveTransaction[]; parentCount: number; allocationCount: number; splitParentCount: number } {
  const rows: EffectiveTransaction[] = [];
  let allocationCount = 0;
  let splitParentCount = 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const parent of parents) {
    const allocations = parent.split_allocations;
    if (parent.split_status === "passthrough") {
      if (!Array.isArray(allocations) || allocations.length !== 0) return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount: 0 };
      rows.push(parent);
      continue;
    }
    splitParentCount += 1;
    if (parent.split_status !== "available" || !Array.isArray(allocations) || allocations.length < 2 || allocations.length > 40 ||
      typeof parent.transaction_id !== "string" || !parent.transaction_id || !isCurrencyCode(parent.iso_currency_code) || !Number.isFinite(Number(parent.amount)) ||
      !Number.isFinite(Number(parent.amount) * 100) || !Number.isSafeInteger(Math.round(Number(parent.amount) * 100)) ||
      Math.abs(Number(parent.amount) * 100 - Math.round(Number(parent.amount) * 100)) > 1e-6 ||
      typeof parent.pending !== "boolean" || typeof parent.excluded_from_totals !== "boolean" ||
      typeof parent.transaction_excluded_from_budget !== "boolean" || typeof parent.account_id !== "string" || !parent.account_id) {
      return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount };
    }
    const parentCents = Math.round(Number(parent.amount) * 100);
    const ids = new Set<string>(), indexes = new Set<number>();
    let sumCents = 0;
    const children: EffectiveTransaction[] = [];
    for (const allocation of allocations) {
      const id = String(allocation?.allocation_id ?? "");
      const index = allocation?.allocation_index;
      const cents = allocation?.amount_cents;
      const category = String(allocation?.category_name ?? "").trim();
      const type = String(allocation?.effective_type ?? "");
      if (!uuid.test(id) || ids.has(id) || !Number.isSafeInteger(index) || index < 0 || index >= 40 || indexes.has(index) ||
        allocation?.allocation_status !== "split" || allocation.parent_transaction_id !== parent.transaction_id ||
        !uuid.test(String(allocation.category_id ?? "")) || !category || !["expense", "income"].includes(type) || type !== parent.effective_type ||
        allocation.currency_code !== parent.iso_currency_code ||
        !(allocation.subcategory === null || typeof allocation.subcategory === "string") || !Number.isSafeInteger(cents) ||
        typeof allocation.pending !== "boolean" || allocation.pending !== parent.pending ||
        allocation.effective_transaction_date !== parent.effective_transaction_date ||
        allocation.account_id !== parent.account_id ||
        typeof allocation.excluded_from_totals !== "boolean" || allocation.excluded_from_totals !== parent.excluded_from_totals ||
        typeof allocation.transaction_excluded_from_budget !== "boolean" || allocation.transaction_excluded_from_budget !== parent.transaction_excluded_from_budget ||
        typeof allocation.category_excluded_from_budget !== "boolean" ||
        (parentCents > 0 && cents < 0) || (parentCents < 0 && cents > 0) ||
        (parentCents === 0 && cents !== 0)) {
        return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount };
      }
      ids.add(id); indexes.add(index); sumCents += cents;
      children.push({
        ...parent,
        transaction_id: parent.transaction_id,
        effective_category: category,
        effective_subcategory: allocation.subcategory === null ? null : String(allocation.subcategory),
        effective_type: type,
        amount: cents / 100,
        iso_currency_code: String(allocation.currency_code),
        category_excluded_from_budget: allocation.category_excluded_from_budget,
      });
    }
    if (parentCents === 0 || sumCents !== parentCents) return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount };
    allocationCount += children.length;
    rows.push(...children);
  }
  return { available: true, rows, parentCount: parents.length, allocationCount, splitParentCount };
}

async function authenticate(
  request: Request,
): Promise<HouseholdContext> {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    throw new RequestError("Unauthorized", 401);
  }

  const userResponse = await fetch(
    `${required("SUPABASE_URL")}/auth/v1/user`,
    {
      headers: {
        authorization,
        apikey: required("SUPABASE_ANON_KEY"),
      },
    },
  );

  if (!userResponse.ok) {
    throw new RequestError("Unauthorized", 401);
  }

  const user = await userResponse.json();

  if (typeof user?.id !== "string") {
    throw new RequestError("Unauthorized", 401);
  }
  if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new RequestError("Unauthorized", 401);

  const { data, error } = await serviceClient()
    .from("finance_household_members")
    .select("household_id,role")
    .eq("user_id", user.id)
    .limit(2);

  if (error) {
    throw new SafeError(
      "Could not verify household membership.",
    );
  }

  if (!data?.length) {
    throw new RequestError(
      "Your signed-in account is not a household member.",
      403,
    );
  }

  if (data.length !== 1) {
    throw new RequestError(
      "Multiple households require household selection support.",
      409,
    );
  }

  return {
    userId: user.id,
    householdId: data[0].household_id,
    role: data[0].role,
  };
}

function serviceClient() {
  return createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

async function readBody(request: Request): Promise<Row> {
  let value: unknown;

  try {
    value = await request.json();
  } catch {
    throw new RequestError("Request body must be valid JSON.", 400);
  }

  if (!isRecord(value)) {
    throw new RequestError(
      "Request body must be a JSON object.",
      400,
    );
  }

  return value;
}

function rejectUnknownProperties(
  body: Row,
  allowed: string[],
) {
  const unknown = Object.keys(body).find(
    (key) => !allowed.includes(key),
  );

  if (unknown) {
    throw new RequestError(
      `Unknown request property: ${unknown}.`,
      400,
    );
  }
}

function chooseAsOfDate(
  month: string,
  today: string,
  requested: string | undefined,
  monthStart: string,
  monthEnd: string,
): string {
  if (requested) return requested;

  const currentMonth = today.slice(0, 7);

  if (month < currentMonth) return monthEnd;
  if (month > currentMonth) return monthStart;
  return today;
}

function optionalMonth(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)
  ) {
    throw new RequestError(
      "month must use YYYY-MM format.",
      400,
    );
  }

  return value;
}

function optionalDate(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    utcDateString(parseDate(value)) !== value
  ) {
    throw new RequestError(
      `${name} must be a valid YYYY-MM-DD date.`,
      400,
    );
  }

  return value;
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;

  if (typeof value !== "boolean") {
    throw new RequestError(
      "include_pending must be boolean.",
      400,
    );
  }

  return value;
}

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return utcDateString(
    new Date(Date.UTC(year, monthNumber, 0)),
  );
}

function mondayOfWeek(value: string): string {
  const date = parseDate(value);
  const day = date.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return utcDateString(date);
}

function sundayOfWeek(value: string): string {
  const monday = parseDate(mondayOfWeek(value));
  monday.setUTCDate(monday.getUTCDate() + 6);
  return utcDateString(monday);
}

function inclusiveDays(start: string, end: string): number {
  return Math.floor(
    (parseDate(end).getTime() - parseDate(start).getTime()) /
      86400000,
  ) + 1;
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function utcDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right;
}

function sumAmounts(rows: EffectiveTransaction[]): number {
  return rows.reduce(
    (total, row) => total + numberValue(row.amount),
    0,
  );
}

function targetKey(
  category: string,
  subcategory: string | null,
  currency: string,
): string {
  return [
    normalizeText(category),
    normalizeText(subcategory ?? ""),
    normalizedCurrency(currency),
  ].join("|");
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizedCurrency(
  value: string | null | undefined,
): string {
  const candidate = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(candidate) ? candidate : "USD";
}

function isCurrencyCode(value: unknown): boolean {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value.trim().toUpperCase());
}

function validPreparedGeneration(value: unknown): value is number | string {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  const maxInt8 = "9223372036854775807";
  return value.length < maxInt8.length ||
    value.length === maxInt8.length && value <= maxInt8;
}

function generationKey(value: number | string): string {
  return String(value);
}

function numberValue(value: unknown): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : Number.NaN;

  if (!Number.isFinite(number)) {
    throw new SafeError("Stored financial amount is invalid.");
  }

  return number;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function progressPercent(spent: number, target: number): number {
  if (target <= 0) return spent > 0 ? 100 : 0;
  return Math.round(Math.max(spent, 0) / target * 10000) / 100;
}

function mapToCurrencyRows(values: Map<string, number>) {
  return Array.from(values.entries()).map(
    ([currency_code, amount]) => ({
      currency_code,
      amount: roundMoney(amount),
    }),
  );
}

function required(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error("Server configuration is incomplete.");
  }

  return value;
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

class SafeError extends Error {}

class PreparedSnapshotChanged extends Error {
  reason: "generation_changed" | "snapshot_stale";

  constructor(reason: "generation_changed" | "snapshot_stale") {
    super(reason);
    this.reason = reason;
  }
}

class RequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

