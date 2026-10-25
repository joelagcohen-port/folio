import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { resolvePlaidAccessToken } from "../_shared/plaid-access-token.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2"
import { categorizationRuleMatches } from "../_shared/categorization-rules.ts"
import { merchantMetadataFromTransaction } from "../_shared/merchant-recognition.ts"

type HouseholdScope = {
  userId: string
  householdIds: string[]
}

type SyncCounts = {
  added: number
  modified: number
  removed: number
  permanentlyDeletedSuppressed: number
  categorizedByRules: number
}

type CategorizationRule = {
  match_text: string
  match_field: "any" | "name" | "merchant_name" | "original_description"
  match_type: "contains" | "exact" | "prefix"
  category: string
  subcategory: string | null
  transfer_network: string | null
  transfer_direction: string | null
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

class PlaidFailure extends Error {
  constructor(message: string, readonly code: string | null) { super(message) }
}

async function assertItemLease(supabase: any, itemId: string, leaseToken: string): Promise<void> {
  const { data, error } = await supabase.rpc("finance_renew_plaid_item_sync_lease", {
    p_item_id: itemId, p_lease_token: leaseToken, p_lease_seconds: 180,
  })
  if (error || data !== true) throw new Error("Plaid sync lease expired; this worker was fenced before saving more data.")
}

async function finishRefreshItem(supabase: any, row: any, status: string, options: {
  code?: string | null; message?: string | null; counts?: Partial<SyncCounts>; retryAfter?: number;
} = {}) {
  const { data, error } = await supabase.rpc("finance_finish_plaid_refresh_item", {
    p_job_id: row.job_id, p_item_id: row.item_id, p_lease_token: row.lease_token,
    p_status: status, p_provider_code: options.code ?? null, p_message: options.message ?? null,
    p_counts: { added: options.counts?.added ?? 0, modified: options.counts?.modified ?? 0, removed: options.counts?.removed ?? 0 },
    p_retry_after_seconds: options.retryAfter ?? 0,
  })
  if (error) throw error
  if (data !== true) throw new Error("Plaid refresh lease expired; the result was not committed.")
}

async function runDurableRefreshWorker(supabase: any) {
  const workerId = crypto.randomUUID()
  let claimed: any[] = []
  try {
    // Provider refresh requests are short-lived work. Claim up to five per pass
    // so items waiting on Plaid release capacity instead of serializing the queue.
    const result = await supabase.rpc("finance_claim_plaid_refresh_items", { p_worker_id: workerId, p_limit: 5 })
    if (result.error) throw result.error
    claimed = Array.isArray(result.data) ? result.data : []
    const results = await mapLimit(claimed, 5, async row => {
      const counts = { added: 0, modified: 0, removed: 0, permanentlyDeletedSuppressed: 0, categorizedByRules: 0 }
      const item = { item_id: row.item_id, household_id: row.household_id, access_token: await resolvePlaidAccessToken(supabase, row.item_id, row.access_token), plaid_environment: row.plaid_environment, transactions_cursor: row.transactions_cursor, institution_name: row.institution_name }
      try {
        await assertItemLease(supabase, row.item_id, row.lease_token)
        if (row.status === "requesting") {
          const refresh = await requestTransactionRefresh(item)
          if (!refresh.ok) {
            const code = optionalString(refresh.data?.error_code) ?? "REFRESH_FAILED"
            const message = optionalString(refresh.data?.display_message) ?? optionalString(refresh.data?.error_message) ?? "Plaid could not refresh this institution."
            if (code === "ITEM_LOGIN_REQUIRED") {
              await assertItemLease(supabase, row.item_id, row.lease_token)
              const { error } = await supabase.from("plaid_items").update({ connection_status: "needs_attention", connection_error_code: code, connection_error_message: message }).eq("item_id", row.item_id)
              if (error) throw error
              await finishRefreshItem(supabase, row, "needs_attention", { code, message })
            } else if (code === "TRANSACTIONS_LIMIT" || code === "RATE_LIMIT_EXCEEDED") {
              const cooldown = code === "TRANSACTIONS_LIMIT" ? 86400 : 3600
              await finishRefreshItem(supabase, row, "cooldown", { code, message, retryAfter: cooldown })
            } else if (code === "PRODUCTS_NOT_SUPPORTED" || code === "PRODUCT_NOT_READY") {
              await finishRefreshItem(supabase, row, "failed", { code, message })
            } else if (row.attempt_count < 3) {
              await finishRefreshItem(supabase, row, "queued", { code, message, retryAfter: Math.min(900, 30 * 2 ** row.attempt_count) })
            } else {
              await finishRefreshItem(supabase, row, "failed", { code, message })
            }
            return { item_id: row.item_id, status: "failed", code }
          }
          await finishRefreshItem(supabase, row, "waiting_for_plaid", { retryAfter: 15 })
          return { item_id: row.item_id, status: "waiting_for_plaid" }
        }

        // A request can outlive its Edge worker. If reclaimed, keep waiting
        // for Plaid's signed webhook instead of issuing another provider call.
        if (row.status === "waiting_for_plaid") {
          await finishRefreshItem(supabase, row, "waiting_for_plaid", { retryAfter: 120 })
          return { item_id: row.item_id, status: "waiting_for_plaid" }
        }

        await refreshItemHealth(supabase, item, row.lease_token)
        const syncCounts = await syncItemTransactions(supabase, item, row.lease_token)
        Object.assign(counts, syncCounts)
        await assertItemLease(supabase, row.item_id, row.lease_token)
        await updateItemBalances(supabase, item)
        await assertItemLease(supabase, row.item_id, row.lease_token)
        const { error: healthError } = await supabase.from("plaid_items").update({ connection_status: "connected", connection_error_code: null, connection_error_message: null, last_successful_sync_at: new Date().toISOString() }).eq("item_id", row.item_id)
        if (healthError) throw healthError
        const { error: queueError } = await supabase.rpc("finance_queue_refund_matching", { p_household_id: row.household_id })
        if (queueError) console.warn("Post-sync reconciliation could not be queued", { household_id: row.household_id })
        const { error: canonicalError } = await supabase.rpc("finance_reconcile_canonical_household_accounts", { p_household_id: row.household_id })
        if (canonicalError) console.warn("Canonical account reconciliation deferred after successful bank sync", { item_id: row.item_id })
        await queueRecurringRefresh(supabase, row.household_id, row.item_id)
        await finishRefreshItem(supabase, row, "succeeded", { counts })
        return { item_id: row.item_id, status: "succeeded", counts }
      } catch (error) {
        const code = error instanceof PlaidFailure ? error.code : null
        if (row.status === "requesting" && !(error instanceof PlaidFailure)) {
          // The request may have reached Plaid even if the HTTP response was
          // lost. Do not submit it again and risk a provider cooldown. Await a
          // signed webhook, then reconcile or expire with an explicit status.
          try { await finishRefreshItem(supabase, row, "waiting_for_plaid", { message: "Plaid may still be processing this request. Waiting for its update before retrying.", retryAfter: 120 }) } catch {}
          return { item_id: row.item_id, status: "waiting_for_plaid", uncertain_request: true }
        }
        const message = code === "ITEM_LOGIN_REQUIRED" ? "Reconnect this institution, then refresh again." : "Folio could not sync this institution. Saved data remains available."
        if (code === "ITEM_LOGIN_REQUIRED") {
          try { await assertItemLease(supabase, row.item_id, row.lease_token) } catch { return { item_id: row.item_id, status: "fenced", code } }
          await supabase.from("plaid_items").update({ connection_status: "needs_attention", connection_error_code: code, connection_error_message: message }).eq("item_id", row.item_id)
          await finishRefreshItem(supabase, row, "needs_attention", { code, message })
          return { item_id: row.item_id, status: "needs_attention", code }
        }
        if (row.attempt_count < 3) {
          await finishRefreshItem(supabase, row, "queued", { code, message, retryAfter: Math.min(900, 30 * 2 ** row.attempt_count) })
          return { item_id: row.item_id, status: "retrying", code }
        }
        await finishRefreshItem(supabase, row, "failed", { code, message })
        console.error("Durable Plaid refresh item failed", { item_id: row.item_id, code, error: error instanceof Error ? error.message : error })
        return { item_id: row.item_id, status: "failed", code }
      }
    })
    const webhookClaim = await supabase.rpc("finance_claim_plaid_webhook_syncs", { p_worker_id: workerId, p_limit: 3 })
    if (webhookClaim.error) throw webhookClaim.error
    const webhookRows = Array.isArray(webhookClaim.data) ? webhookClaim.data : []
    const webhookResults = await mapLimit(webhookRows, 3, async row => {
      const item = { item_id: row.item_id, household_id: row.household_id, access_token: await resolvePlaidAccessToken(supabase, row.item_id, row.access_token), plaid_environment: row.plaid_environment, transactions_cursor: row.transactions_cursor, institution_name: row.institution_name }
      try {
        await assertItemLease(supabase, row.item_id, row.lease_token)
        await refreshItemHealth(supabase, item, row.lease_token)
        const counts = await syncItemTransactions(supabase, item, row.lease_token)
        await assertItemLease(supabase, row.item_id, row.lease_token)
        await updateItemBalances(supabase, item)
        await assertItemLease(supabase, row.item_id, row.lease_token)
        const { error } = await supabase.from("plaid_items").update({ connection_status: "connected", connection_error_code: null, connection_error_message: null, last_successful_sync_at: new Date().toISOString() }).eq("item_id", row.item_id)
        if (error) throw error
        await supabase.rpc("finance_queue_refund_matching", { p_household_id: row.household_id })
        await supabase.rpc("finance_reconcile_canonical_household_accounts", { p_household_id: row.household_id })
        await queueRecurringRefresh(supabase, row.household_id, row.item_id)
        try { await supabase.rpc("finance_reconcile_outstanding_plaid_refresh", { p_item_id: row.item_id }) } catch { console.warn("Outstanding Refresh All state could not be reconciled", { item_id: row.item_id }) }
        const { data: completed, error: completionError } = await supabase.rpc("finance_finish_plaid_webhook_sync", { p_item_id: row.item_id, p_lease_token: row.lease_token, p_success: true })
        if (completionError || completed !== true) throw completionError ?? new Error("Webhook sync lease expired before completion")
        return { item_id: row.item_id, status: "succeeded", counts }
      } catch (error) {
        const code = error instanceof PlaidFailure ? error.code : null
        if (code === "ITEM_LOGIN_REQUIRED") {
          // Renew before changing health so an expired owner cannot overwrite
          // the status set by a newer sync worker.
          try { await assertItemLease(supabase, row.item_id, row.lease_token); await supabase.from("plaid_items").update({ connection_status: "needs_attention", connection_error_code: code, connection_error_message: "Reconnect this institution, then sync again." }).eq("item_id", row.item_id) } catch {}
        }
        await supabase.rpc("finance_finish_plaid_webhook_sync", { p_item_id: row.item_id, p_lease_token: row.lease_token, p_success: false, p_error: code ?? "sync_failed", p_retry_after_seconds: Math.min(900, 30 * 2 ** Math.min(Number(row.attempt_count) || 0, 5)) })
        return { item_id: row.item_id, status: "retrying", code }
      }
    })
    const refundClaim = await supabase.rpc("finance_claim_refund_matching", { p_worker_id: workerId, p_limit: 1 })
    if (refundClaim.error) throw refundClaim.error
    const refundRows = Array.isArray(refundClaim.data) ? refundClaim.data : []
    const refundResults = await mapLimit(refundRows, 1, async row => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000)
      try {
        const { error: canonicalError } = await supabase.rpc("finance_reconcile_canonical_household_accounts", { p_household_id: row.household_id })
        if (canonicalError) throw canonicalError
        const { error } = await supabase.rpc("finance_match_refunds", { p_household_id: row.household_id }).abortSignal(controller.signal)
        if (error) throw error
        const { data, error: finishError } = await supabase.rpc("finance_finish_refund_matching", { p_household_id: row.household_id, p_lease_token: row.lease_token, p_success: true })
        if (finishError || data !== true) throw finishError ?? new Error("Refund processing lease expired")
        return { household_id: row.household_id, status: "succeeded" }
      } catch (error) {
        await supabase.rpc("finance_finish_refund_matching", { p_household_id: row.household_id, p_lease_token: row.lease_token, p_success: false })
        console.warn("Refund matching failed independently of bank sync", { household_id: row.household_id })
        return { household_id: row.household_id, status: "retrying" }
      } finally { clearTimeout(timer) }
    })
    return { worker: true, claimed: claimed.length, results, webhook_claimed: webhookRows.length, webhook_results: webhookResults, refund_jobs_claimed: refundRows.length, refund_results: refundResults }
  } finally {
    try { await supabase.rpc("finance_release_plaid_refresh_worker", { p_worker_id: workerId }) } catch {}
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405)
  }

  try {
    const scope = await authorizeRequest(request)
    const internal = request.headers.get("x-plaid-app-secret") === Deno.env.get("PLAID_MCP_SHARED_SECRET")

    const body = await request.json().catch(() => ({}))
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).some((key) =>
        key !== "account_id" && key !== "refresh" && key !== "item_id" &&
        key !== "worker" && key !== "refresh_status" && key !== "job_id" && key !== "household_id"
      )
    ) throw new Error("Invalid sync request")
    if ((body as any).worker === true && !internal) throw new Error("Unauthorized")
    const requestedHouseholdId = optionalString((body as any).household_id)
    if (requestedHouseholdId && (!scope || !scope.householdIds.includes(requestedHouseholdId))) throw new Error("Unauthorized")
    const householdIds = requestedHouseholdId ? [requestedHouseholdId] : scope?.householdIds ?? []
    const accountId = typeof (body as any).account_id === "string" &&
        (body as any).account_id.trim()
      ? (body as any).account_id.trim()
      : undefined
    const refreshRequested = (body as any).refresh === true
    const itemId = typeof (body as any).item_id === "string" &&
        (body as any).item_id.trim()
      ? (body as any).item_id.trim()
      : undefined
    if (itemId && scope) {
      throw new Error("Item-scoped sync requires internal authentication")
    }

    const supabase = createClient(
      required("SUPABASE_URL"),
      required("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    )

    if ((body as any).worker === true) {
      return json(await runDurableRefreshWorker(supabase))
    }

    if ((body as any).refresh_status === true) {
      if (!scope) throw new Error("Unauthorized")
      const jobs = await Promise.all(householdIds.map(async householdId => {
        const { data, error } = await supabase.rpc("finance_get_plaid_refresh_status", {
          p_household_id: householdId,
          p_job_id: optionalString((body as any).job_id),
        })
        if (error) throw error
        return data
      }))
      return json({ jobs: jobs.filter(Boolean) })
    }

    if (refreshRequested && scope && !accountId && !itemId) {
      // Refresh All is sync-first: queue durable provider refreshes for deeper
      // freshness, but do not block the immediate sync on Plaid's callback.
      const jobs = await Promise.all(householdIds.map(async householdId => {
        const { data, error } = await supabase.rpc("finance_start_plaid_refresh", {
          p_household_id: householdId,
          p_requested_by: scope.userId,
        })
        if (error) throw error
        return data
      }))
      // Continue below and immediately sync only enabled canonical sources.
      ;(body as any)._refresh_jobs = jobs
    }

    let itemQuery = supabase
      .from("plaid_items")
      .select(
        "item_id, household_id, access_token, plaid_environment, transactions_cursor, institution_name, connection_status, connection_error_code",
      )

    if (scope) {
      itemQuery = itemQuery.in("household_id", householdIds)
    }
    if (refreshRequested && scope && !accountId && !itemId) {
      const { data: activeSources, error: sourceError } = await supabase
        .from("finance_canonical_account_sources").select("source_account_id")
        .in("household_id", householdIds).eq("transaction_source_enabled", true)
      if (sourceError) throw sourceError
      const sourceIds = [...new Set((activeSources ?? []).map((row:any) => row.source_account_id).filter(Boolean))]
      const { data: activeAccounts, error: accountSourceError } = sourceIds.length
        ? await supabase.from("plaid_accounts").select("item_id").in("account_id", sourceIds).neq("lifecycle_status", "closed")
        : { data: [], error: null }
      if (accountSourceError) throw accountSourceError
      const activeItemIds = [...new Set((activeAccounts ?? []).map((row:any) => row.item_id).filter(Boolean))]
      if (!activeItemIds.length) return json({ synced:true, refresh_requested:true, accounts_updated:0, sync_pending:false, jobs:(body as any)._refresh_jobs ?? [] })
      itemQuery = itemQuery.in("item_id", activeItemIds)
    }

    if (itemId) {
      itemQuery = itemQuery.eq("item_id", itemId)
    }

    if (accountId) {
      if (!scope) throw new Error("Account-scoped sync requires a signed-in user")
      const { data: account, error } = await supabase
        .from("plaid_accounts")
        .select("item_id,plaid_items!inner(household_id)")
        .eq("account_id", accountId)
        .in("plaid_items.household_id", householdIds)
        .maybeSingle()
      if (error || !account) throw new Error("Account not available")
      itemQuery = itemQuery.eq("item_id", account.item_id)
    }

    const { data: items, error: itemError } =
      await itemQuery

    if (itemError) throw itemError

    let addedCount = 0
    let modifiedCount = 0
    let removedCount = 0
    let permanentlyDeletedSuppressed = 0
    let categorizedByRules = 0
    let accountsUpdated = 0
    let refreshAttempted = 0
    let refreshSucceeded = 0
    let refreshUnsupported = 0
    let refreshFailed = 0
    let syncFailed = 0
    let skippedItems = 0
    const refreshWarnings: string[] = []
    const syncWarnings: string[] = []

    for (const item of items ?? []) {
      const syncWorkerId = crypto.randomUUID()
      const lease = await supabase.rpc("finance_claim_plaid_item_sync", {
        p_item_id: item.item_id,
        p_worker_id: syncWorkerId,
        p_lease_seconds: 180,
      })
      if (lease.error) throw lease.error
      const leaseToken = typeof lease.data === "string" ? lease.data : null
      if (!leaseToken) {
        console.info("Plaid item sync skipped because another worker holds its lease", { item_id: item.item_id })
        skippedItems++
        continue
      }
      const attemptedAt = new Date().toISOString()
      try {
      item.access_token = await resolvePlaidAccessToken(supabase, item.item_id, item.access_token)
      await assertItemLease(supabase, item.item_id, leaseToken)
      await supabase.from("plaid_items").update({ connection_status: "syncing", last_sync_attempt_at: attemptedAt }).eq("item_id", item.item_id)

        await refreshItemHealth(supabase, item, leaseToken)
        const webhookUpdate = await updateItemWebhook(item)
        if (!webhookUpdate.ok) {
          console.warn("Could not configure Plaid webhook", {
            error_code: webhookUpdate.data?.error_code,
            request_id: webhookUpdate.data?.request_id,
            item_id: item.item_id,
          })
        }
        if (refreshRequested) {
          refreshAttempted++
          const refresh = await requestTransactionRefresh(item)
          if (refresh.ok) {
            refreshSucceeded++
          } else {
            const code = optionalString(refresh.data?.error_code) ??
              "REFRESH_FAILED"
            const message = optionalString(refresh.data?.display_message) ??
              optionalString(refresh.data?.error_message) ??
              "Plaid could not refresh this institution."
            if (
              code === "PRODUCTS_NOT_SUPPORTED" ||
              code === "PRODUCT_NOT_READY"
            ) {
              refreshUnsupported++
            } else {
              refreshFailed++
            }
            refreshWarnings.push(message)
            console.warn("Plaid transaction refresh unavailable", {
              error_code: code,
              request_id: refresh.data?.request_id,
              item_id: item.item_id,
            })
          }
        }
        const counts = await syncItemTransactions(
          supabase,
          item,
          leaseToken,
        )

      addedCount += counts.added
      modifiedCount += counts.modified
      removedCount += counts.removed
      permanentlyDeletedSuppressed +=
        counts.permanentlyDeletedSuppressed
      categorizedByRules += counts.categorizedByRules

        await assertItemLease(supabase, item.item_id, leaseToken)
        accountsUpdated += await updateItemBalances(
          supabase,
          item,
        )

        await assertItemLease(supabase, item.item_id, leaseToken)
        await supabase.from("plaid_items").update({
          connection_status: "connected",
          connection_error_code: null,
          connection_error_message: null,
          last_successful_sync_at: new Date().toISOString(),
        }).eq("item_id", item.item_id)
        // Refund reconciliation is secondary processing. Its failures must
        // never change the bank connection's health after successful sync.
        try {
          const { error } = await supabase.rpc("finance_queue_refund_matching", { p_household_id: item.household_id })
          if (error) console.warn("Could not queue refund reconciliation", { household_id: item.household_id })
        } catch { console.warn("Could not queue refund reconciliation", { household_id: item.household_id }) }
        const { error: canonicalError } = await supabase.rpc(
          "finance_reconcile_canonical_household_accounts",
          { p_household_id: item.household_id },
        )
        if (canonicalError) console.warn("Canonical account reconciliation deferred after successful bank sync", { item_id: item.item_id })
        await queueRecurringRefresh(supabase, item.household_id, item.item_id)
        try { await supabase.rpc("finance_reconcile_outstanding_plaid_refresh", { p_item_id: item.item_id }) } catch { console.warn("Outstanding Refresh All state could not be reconciled", { item_id: item.item_id }) }
      } catch (error) {
        const providerCode = error instanceof PlaidFailure ? error.code : null
        try {
          await assertItemLease(supabase, item.item_id, leaseToken)
          if (providerCode === "ITEM_LOGIN_REQUIRED") {
            await supabase.from("plaid_items").update({ connection_status: "needs_attention", connection_error_code: providerCode, connection_error_message: "Reconnect this institution, then sync again." }).eq("item_id", item.item_id)
          } else {
            const priorLoginError = item.connection_error_code === "ITEM_LOGIN_REQUIRED"
            await supabase.from("plaid_items").update(priorLoginError
              ? { connection_status: "needs_attention", connection_error_code: "ITEM_LOGIN_REQUIRED", connection_error_message: "Reconnect this institution, then sync again." }
              : { connection_status: "needs_attention", connection_error_code: "SYNC_FAILED", connection_error_message: "Could not refresh. Try again." }).eq("item_id", item.item_id)
          }
        } catch { /* An expired worker cannot overwrite connection state. */ }
        syncFailed++
        const institution = optionalString(item.institution_name) ?? "One institution"
        syncWarnings.push(`${institution}: sync failed; retry this connection from Accounts.`)
        console.error("Plaid item sync failed; continuing with remaining institutions", {
          item_id: item.item_id,
          institution,
          error: error instanceof Error ? error.message : error,
        })
      } finally {
        try { await supabase.rpc("finance_release_plaid_item_sync_lease", { p_item_id: item.item_id, p_lease_token: leaseToken }) } catch {}
      }
    }

    return json({
      synced: true,
      added: addedCount,
      modified: modifiedCount,
      removed: removedCount,
      permanently_deleted_suppressed:
        permanentlyDeletedSuppressed,
      categorized_by_rules: categorizedByRules,
      accounts_updated: accountsUpdated,
      refresh_requested: refreshRequested,
      refresh_attempted: refreshAttempted,
      refresh_succeeded: refreshSucceeded,
      refresh_unsupported: refreshUnsupported,
      refresh_failed: refreshFailed,
      refresh_warnings: refreshWarnings,
      sync_failed: syncFailed,
      sync_warnings: syncWarnings,
      sync_pending: skippedItems > 0,
      skipped_items: skippedItems,
    })
  } catch (error) {
    console.error(
      "Transaction sync failed",
      error instanceof Error
        ? error.message
        : error,
    )

    return json(
      {
        error: error instanceof Error &&
            error.message === "Unauthorized"
          ? "Unauthorized"
          : "Could not sync transactions",
      },
      error instanceof Error &&
          error.message === "Unauthorized"
        ? 401
        : 500,
    )
  }
})

async function authorizeRequest(
  request: Request,
): Promise<HouseholdScope | null> {
  const expectedSecret =
    Deno.env.get("PLAID_MCP_SHARED_SECRET")

  const suppliedSecret =
    request.headers.get("x-plaid-app-secret")

  if (
    expectedSecret &&
    suppliedSecret === expectedSecret
  ) {
    // Shared-secret calls are used by the daily cron.
    return null
  }

  const authorization =
    request.headers.get("authorization")

  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Unauthorized")
  }

  const authClient = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_ANON_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  )

  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser(
    authorization.slice(7),
  )

  if (userError || !user) {
    throw new Error("Unauthorized")
  }
  if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new Error("Unauthorized")

  const serviceClient = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  )

  const { data: memberships, error } =
    await serviceClient
      .from("finance_household_members")
      .select("household_id")
      .eq("user_id", user.id)

  if (error) throw error

  const householdIds = (memberships ?? [])
    .map((membership) => membership.household_id)
    .filter(
      (householdId): householdId is string =>
        typeof householdId === "string",
    )

  if (!householdIds.length) {
    throw new Error("Unauthorized")
  }

  return {
    userId: user.id,
    householdIds,
  }
}

async function queueRecurringRefresh(supabase: any, householdId: string, itemId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([Promise.resolve(supabase.rpc("finance_enqueue_recurring_refresh", {
      p_household_id: householdId,
      p_input_revision: `bank-sync-${crypto.randomUUID()}`,
      p_item_ids: [itemId],
    })).catch(() => ({ error: true })),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),500)})])
    if (!result || result.error) console.warn("Recurring forecast refresh could not be queued after bank sync", { item_id: itemId })
  } catch { console.warn("Recurring forecast refresh could not be queued after bank sync", { item_id: itemId }) }
  finally { if(timer)clearTimeout(timer) }
}

async function syncItemTransactions(
  supabase: any,
  item: {
    item_id: string
    household_id: string | null
    access_token: string
    plaid_environment: string
    transactions_cursor: string | null
  },
  leaseToken: string,
): Promise<SyncCounts> {
  const startingCursor =
    item.transactions_cursor || undefined

  if (!item.household_id) {
    throw new Error(
      "Plaid item is not assigned to a household",
    )
  }

  const activeRules = await loadCategorizationRules(
    supabase,
    item.household_id,
  )

  // Plaid may require a pagination restart if transactions
  // change while pages are being downloaded.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let cursor = startingCursor
    let addedCount = 0
    let modifiedCount = 0
    let removedCount = 0
    let permanentlyDeletedSuppressed = 0
    let categorizedByRules = 0
    let restartRequired = false

    while (true) {
      const response = await plaidRequest(
        item,
        "/transactions/sync",
        {
          access_token: item.access_token,
          ...(cursor ? { cursor } : {}),
          count: 500,
          options: {
            include_original_description: true,
          },
        },
      )

      if (
        !response.ok &&
        response.data?.error_code ===
          "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
      ) {
        restartRequired = true
        break
      }

      if (!response.ok) {
        console.error("Plaid sync failed", {
          error_code: response.data?.error_code,
          request_id: response.data?.request_id,
          item_id: item.item_id,
        })

        throw new PlaidFailure("Plaid could not sync transactions", optionalString(response.data?.error_code))
      }

      const data = response.data

      const deletedAccountIds = await loadDeletedAccountIds(
        supabase,
        item.household_id,
      )
      const accounts = (data.accounts ?? []).filter(
        (account: any) => !deletedAccountIds.has(account.account_id),
      ).map(
        (account: any) => ({
          account_id: account.account_id,
          item_id: item.item_id,
          name: account.name,
          official_name: account.official_name,
          mask: account.mask,
          type: account.type,
          subtype: account.subtype,
          persistent_account_id:
            optionalString(account.persistent_account_id),
          updated_at: new Date().toISOString(),
        }),
      )

      if (accounts.length) {
        await assertItemLease(supabase, item.item_id, leaseToken)
        const { error } = await supabase
          .from("plaid_accounts")
          .upsert(accounts, {
            onConflict: "account_id",
          })

        if (error) throw error
      }

      const mapTransaction = (
        transaction: any,
      ) => ({
        // Only update metadata when Plaid supplied a useful value; an omitted
        // nullable field on a later sync must not erase a previously saved one.
        ...Object.fromEntries(Object.entries(merchantMetadataFromTransaction(transaction)).filter(([, value]) => value !== null)),
        transaction_id:
          transaction.transaction_id,
        item_id: item.item_id,
        account_id: transaction.account_id,
        transaction_date: transaction.date,
        authorized_date:
          transaction.authorized_date,
        name: transaction.name,
        original_description:
          transaction.original_description,
        merchant_name: transaction.merchant_name,
        amount: transaction.amount,
        iso_currency_code:
          transaction.iso_currency_code,
        pending: transaction.pending,
        // Plaid supplies this exact link when a posted transaction replaces a
        // pending authorization. Persist it so every financial surface can
        // suppress only the precise predecessor, never a lookalike purchase.
        pending_transaction_id: transaction.pending_transaction_id,
        payment_channel:
          transaction.payment_channel,
        personal_finance_category:
          transaction.personal_finance_category,
        counterparties:
          transaction.counterparties,
        updated_at: new Date().toISOString(),
      })

      const addedCandidates = applyCategorizationRules(
        (data.added ?? []).filter((transaction: any) =>
          !deletedAccountIds.has(transaction.account_id)
        ).map(mapTransaction),
        activeRules,
      )

      const modifiedCandidates = applyCategorizationRules(
        (data.modified ?? []).filter((transaction: any) =>
          !deletedAccountIds.has(transaction.account_id)
        ).map(mapTransaction),
        activeRules,
      )

      categorizedByRules +=
        addedCandidates.matched +
        modifiedCandidates.matched

      // Apply the permanent-deletion tombstones before every upsert. This
      // prevents Plaid from restoring a transaction that the user deleted.
      const addedGuard =
        await excludePermanentDeletions(
          supabase,
          item.household_id,
          addedCandidates.rows,
        )

      const modifiedGuard =
        await excludePermanentDeletions(
          supabase,
          item.household_id,
          modifiedCandidates.rows,
        )

      const added = addedGuard.visible
      const modified = modifiedGuard.visible

      permanentlyDeletedSuppressed +=
        addedGuard.suppressed +
        modifiedGuard.suppressed

      if (added.length) {
        await assertItemLease(supabase, item.item_id, leaseToken)
        const { error } = await supabase
          .from("plaid_transactions")
          .upsert(added, {
            onConflict: "transaction_id",
          })

        if (error) throw error
      }

      if (modified.length) {
        await assertItemLease(supabase, item.item_id, leaseToken)
        const { error } = await supabase
          .from("plaid_transactions")
          .upsert(modified, {
            onConflict: "transaction_id",
          })

        if (error) throw error
      }

      const removedIds =
        (data.removed ?? []).map(
          (entry: any) => entry.transaction_id,
        )

      if (removedIds.length) {
        await assertItemLease(supabase, item.item_id, leaseToken)
        const { error } = await supabase
          .from("plaid_transactions")
          .delete()
          .eq("item_id", item.item_id)
          .in("transaction_id", removedIds)

        if (error) throw error
      }

      addedCount += added.length
      modifiedCount += modified.length
      removedCount += removedIds.length
      cursor = data.next_cursor

      if (!data.has_more) {
        await assertItemLease(supabase, item.item_id, leaseToken)
        const { error } = await supabase
          .from("plaid_items")
          .update({
            transactions_cursor: cursor,
            updated_at: new Date().toISOString(),
          })
          .eq("item_id", item.item_id)

        if (error) throw error

        return {
          added: addedCount,
          modified: modifiedCount,
          removed: removedCount,
          permanentlyDeletedSuppressed,
          categorizedByRules,
        }
      }
    }

    if (!restartRequired) {
      break
    }

    console.log(
      `Restarting Plaid pagination for item after mutation; attempt ${attempt}.`,
    )
  }

  throw new Error(
    "Plaid transaction pagination could not stabilize",
  )
}

async function loadCategorizationRules(
  supabase: any,
  householdId: string,
): Promise<CategorizationRule[]> {
  const { data, error } = await supabase
    .from("transaction_categorization_rules")
    .select(
      "match_text,match_field,match_type,category,subcategory,transfer_network,transfer_direction",
    )
    .eq("household_id", householdId)
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(
      "Could not load categorization rules",
    )
  }

  return data ?? []
}

function applyCategorizationRules<
  T extends Record<string, any>,
>(
  rows: T[],
  rules: CategorizationRule[],
): { rows: T[]; matched: number } {
  let matched = 0

  return {
    rows: rows.map((row) => {
      const rule = rules.find((candidate) => categorizationRuleMatches(row, candidate))

      if (!rule) return row
      matched++

      return {
        ...row,
        user_category: rule.category,
        user_subcategory: rule.subcategory,
        ...(rule.transfer_network
          ? { transfer_network: rule.transfer_network }
          : {}),
        ...(rule.transfer_direction
          ? { transfer_direction: rule.transfer_direction }
          : {}),
      }
    }),
    matched,
  }
}

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase()
    : ""
}

type SyncTransaction = {
  transaction_id: string
}

async function excludePermanentDeletions<
  T extends SyncTransaction,
>(
  supabase: any,
  householdId: string,
  candidates: T[],
): Promise<{
  visible: T[]
  suppressed: number
}> {
  if (!candidates.length) {
    return {
      visible: [],
      suppressed: 0,
    }
  }

  const transactionIds = [
    ...new Set(
      candidates.map(
        (transaction) =>
          transaction.transaction_id,
      ),
    ),
  ]

  const tombstonedIds = new Set<string>()

  // Keep each PostgREST filter bounded. Plaid currently returns no more than
  // 500 rows per sync page, so this requires at most three small queries.
  for (
    let offset = 0;
    offset < transactionIds.length;
    offset += 200
  ) {
    const chunk = transactionIds.slice(
      offset,
      offset + 200,
    )

    const { data, error } = await supabase
      .from("finance_transaction_overrides")
      .select("transaction_id")
      .eq("household_id", householdId)
      .not("deleted_at", "is", null)
      .in("transaction_id", chunk)

    if (error) {
      throw new Error(
        "Could not enforce permanent transaction deletions",
      )
    }

    for (const row of data ?? []) {
      if (typeof row.transaction_id === "string") {
        tombstonedIds.add(row.transaction_id)
      }
    }
  }

  const visible = candidates.filter(
    (transaction) =>
      !tombstonedIds.has(
        transaction.transaction_id,
      ),
  )

  return {
    visible,
    suppressed:
      candidates.length - visible.length,
  }
}

async function updateItemBalances(
  supabase: any,
  item: {
    item_id: string
    access_token: string
    plaid_environment: string
  },
): Promise<number> {
  const response = await plaidRequest(
    item,
    "/accounts/balance/get",
    {
      access_token: item.access_token,
    },
  )

  if (!response.ok) {
    console.error("Plaid balance request failed", {
      error_code: response.data?.error_code,
      request_id: response.data?.request_id,
      item_id: item.item_id,
    })

    throw new Error(
      "Plaid could not retrieve account balances",
    )
  }

  const updatedAt = new Date().toISOString()

  const { data: itemRecord, error: itemRecordError } = await supabase
    .from("plaid_items").select("household_id").eq("item_id", item.item_id).single()
  if (itemRecordError || !itemRecord?.household_id) throw new Error("Plaid item has no household")
  const deletedAccountIds = await loadDeletedAccountIds(supabase, itemRecord.household_id)
  const { data: closedAccounts, error: closedError } = await supabase
    .from("plaid_accounts").select("account_id").eq("item_id", item.item_id).eq("lifecycle_status", "closed")
  if (closedError) throw closedError
  const closedAccountIds = new Set((closedAccounts ?? []).map((row: any) => row.account_id))
  const accounts = (response.data.accounts ?? []).filter(
    (account: any) => !deletedAccountIds.has(account.account_id) && !closedAccountIds.has(account.account_id),
  ).map(
    (account: any) => ({
      account_id: account.account_id,
      item_id: item.item_id,
      name: account.name,
      official_name: account.official_name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      persistent_account_id:
        optionalString(account.persistent_account_id),
      current_balance:
        finiteNumberOrNull(account.balances?.current),
      available_balance:
        finiteNumberOrNull(account.balances?.available),
      credit_limit:
        finiteNumberOrNull(account.balances?.limit),
      balance_currency_code:
        optionalString(
          account.balances?.iso_currency_code,
        ),
      balance_updated_at: updatedAt,
      updated_at: updatedAt,
    }),
  )

  if (!accounts.length) {
    return 0
  }

  const { error } = await supabase
    .from("plaid_accounts")
    .upsert(accounts, {
      onConflict: "account_id",
    })

  if (error) throw error

  const snapshots = accounts.map((account: any) => ({
    household_id: itemRecord.household_id,
    account_id: account.account_id,
    snapshot_date: updatedAt.slice(0, 10),
    recorded_at: updatedAt,
    current_balance: account.current_balance,
    available_balance: account.available_balance,
    credit_limit: account.credit_limit,
    currency_code: account.balance_currency_code,
    source: "plaid_sync",
  }))
  const { error: snapshotError } = await supabase
    .from("finance_account_balance_snapshots")
    .upsert(snapshots, { onConflict: "household_id,account_id,snapshot_date" })
  if (snapshotError) throw snapshotError

  return accounts.length
}

async function loadDeletedAccountIds(
  supabase: any,
  householdId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("finance_account_deletions")
    .select("account_id")
    .eq("household_id", householdId)
  if (error) throw error
  return new Set((data ?? []).map((row: any) => row.account_id))
}

async function refreshItemHealth(supabase: any, item: any, leaseToken?: string) {
  const response = await plaidRequest(item, "/item/get", { access_token: item.access_token })
  if (!response.ok) throw new PlaidFailure("Plaid could not read item status", optionalString(response.data?.error_code))
  const plaidItem = response.data.item ?? {}
  const plaidError = plaidItem.error ?? null
  const patch: Record<string, unknown> = {
    institution_id: plaidItem.institution_id ?? null,
    connection_status: plaidError ? "needs_attention" : "syncing",
    connection_error_code: plaidError?.error_code ?? null,
    connection_error_message: plaidError?.display_message ??
      (plaidError ? "This institution needs attention." : null),
  }
  if (plaidItem.institution_id) {
    const institution = await plaidRequest(item, "/institutions/get_by_id", {
      institution_id: plaidItem.institution_id,
      country_codes: ["US"],
      options: { include_optional_metadata: true },
    })
    if (institution.ok) {
      patch.institution_name = institution.data.institution?.name ?? null
      patch.institution_logo = institution.data.institution?.logo ?? null
      patch.institution_primary_color = institution.data.institution?.primary_color ?? null
      patch.institution_url = institution.data.institution?.url ?? null
    }
  }
  if (leaseToken) await assertItemLease(supabase, item.item_id, leaseToken)
  const { error } = await supabase.from("plaid_items").update(patch).eq("item_id", item.item_id)
  if (error) throw error
}

async function updateItemWebhook(
  item: {
    item_id: string
    access_token: string
    plaid_environment: string
  },
): Promise<{ ok: boolean; data: any }> {
  return plaidRequest(
    item,
    "/item/webhook/update",
    {
      access_token: item.access_token,
      webhook: `${required("SUPABASE_URL")}/functions/v1/plaid-webhook`,
    },
  )
}

async function requestTransactionRefresh(
  item: {
    item_id: string
    access_token: string
    plaid_environment: string
  },
): Promise<{ ok: boolean; data: any }> {
  return plaidRequest(
    item,
    "/transactions/refresh",
    { access_token: item.access_token },
  )
}

async function plaidRequest(
  item: {
    plaid_environment: string
  },
  path: string,
  body: Record<string, unknown>,
): Promise<{
  ok: boolean
  data: any
}> {
  const response = await fetch(
    `https://${item.plaid_environment}.plaid.com${path}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(35000),
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id:
          required("PLAID_CLIENT_ID").trim(),
        secret:
          required("PLAID_SECRET").trim(),
        ...body,
      }),
    },
  )

  const data = await response
    .json()
    .catch(() => ({}))

  return {
    ok: response.ok,
    data,
  }
}

function required(name: string): string {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(
      `Missing server secret: ${name}`,
    )
  }

  return value
}

function finiteNumberOrNull(
  value: unknown,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  return null
}

function optionalString(
  value: unknown,
): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null
}

function json(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })
}
