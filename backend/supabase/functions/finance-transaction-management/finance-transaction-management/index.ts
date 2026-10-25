import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, unknown>;
type Context = { userId: string; householdId: string; role: string };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
  "cache-control": "no-store",
};

const options = { auth: { persistSession: false, autoRefreshToken: false } };

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestStarted = performance.now();
  let timingAction = "unknown";
  try {
    const authorization = request.headers.get("authorization");
    const body = await readBody(request);
    const action = requiredText(body.action, "action", 40);
    timingAction = action;
    const transactionId = optionalText(body.transaction_id, "transaction_id", 200);
    const householdInput = optionalUuid(body.household_id, "household_id");
    const context = await authenticate(authorization, householdInput, action);
    const db = serviceClient();

    if (action === "review_split_refund") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "purchase_transaction_id", "operation", "choice"]);
      if (!transactionId || !isRecord(body.choice) || !["match", "unmatch"].includes(String(body.operation))) throw new HttpError(400, "Choose the refund allocation action explicitly.");
      const purchase = requiredText(body.purchase_transaction_id, "purchase_transaction_id", 200);
      const { data, error } = await db.rpc("finance_review_split_refund", { p_household: context.householdId, p_actor: context.userId, p_refund: transactionId, p_purchase: purchase, p_operation: body.operation, p_choice: body.choice });
      if (error) throw splitRpcError(error, false);
      if (!isRecord(data) || !isUuid(data.review_id) || data.household_id !== context.householdId || data.actor_user_id !== context.userId || data.refund_transaction_id !== transactionId || data.purchase_transaction_id !== purchase || data.operation !== body.operation || !isRecord(data.proposal) || !validSplitRefundLinks(data.proposal.links, body.operation === "unmatch") || !isRecord(data.evidence) || !isUuid(data.evidence.split_id) || typeof data.evidence.allocation_revision !== "string" || !/^[a-f0-9]{32}$/.test(data.evidence.allocation_revision) || !isRecord(data.evidence.refund_state) || !isRecord(data.evidence.refund_state.refund) || !isRecord(data.evidence.refund_state.refund.bank) || data.evidence.refund_state.refund.bank.transaction_id !== transactionId || body.operation === "match" && (data.proposal.links as Row[]).reduce((n, l) => n + Number(l.amount_cents), 0) !== -Number(data.evidence.refund_state.refund.bank.amount) * 100) throw new HttpError(503, "Could not verify the reviewed refund allocation.");
      return json(data);
    }
    if (action === "confirm_split_refund") {
      rejectUnknown(body, ["action", "household_id", "review_id", "request_id", "confirm"]);
      if (!isUuid(body.review_id) || !isUuid(body.request_id) || body.confirm !== true) throw new HttpError(400, "Confirm the exact reviewed allocation.");
      let result;
      try { result = await db.rpc("finance_confirm_split_refund", { p_household: context.householdId, p_actor: context.userId, p_review: body.review_id, p_request: body.request_id, p_confirm: true }); }
      catch { throw new HttpError(503, "Refund outcome unknown. Retry the exact request ID."); }
      const { data, error } = result;
      if (error) throw splitRpcError(error, true);
      if (!isRecord(data) || data.saved !== true || data.household_id !== context.householdId || data.actor_user_id !== context.userId || !isRecord(data.receipt) || data.receipt.review_id !== body.review_id || data.receipt.request_id !== body.request_id || !["match", "unmatch"].includes(String(data.receipt.operation)) || !isRecord(data.receipt.attribution) || data.receipt.attribution.household_id !== context.householdId || data.receipt.attribution.actor_user_id !== context.userId || !isUuid(data.receipt.attribution.split_id) || !validSplitRefundLinks(data.receipt.attribution.links, data.receipt.operation === "unmatch") || typeof data.receipt.attribution.refund_transaction_id !== "string" || typeof data.receipt.attribution.purchase_transaction_id !== "string" || !isRecord(data.receipt.refund_receipt) || !isRecord(data.receipt.refund_receipt.receipt) || data.receipt.refund_receipt.receipt.transaction_id !== data.receipt.attribution.refund_transaction_id || data.receipt.attribution.state !== (data.receipt.operation === "match" ? "active" : "reversed")) throw new HttpError(503, "Refund outcome unknown. Retry the exact request ID.");
      return json(data);
    }
    if (action === "review_split_successor" || action === "confirm_split_successor") {
      if (Deno.env.get("FOLIO2_SPLIT_SUCCESSOR_ENABLED") !== "true") throw new HttpError(422, "Split successor reconciliation is not enabled.");
      const validAllocations = (value: Row) => {
        const cents = value.parent_amount_cents, rows = value.allocations;
        return Number.isSafeInteger(cents) && cents !== 0 && typeof value.currency_code === "string" && /^[A-Z]{3}$/.test(value.currency_code)
          && Array.isArray(rows) && rows.length >= 2 && rows.length <= 40 && new Set(rows.map((row: Row) => row.allocation_id)).size === rows.length
          && rows.every((row: unknown, index: number) => isRecord(row) && isUuid(row.allocation_id) && isUuid(row.category_id) && row.allocation_index === index && Number.isSafeInteger(row.amount_cents) && (row.amount_cents === 0 || Math.sign(Number(row.amount_cents)) === Math.sign(Number(cents))))
          && rows.reduce((sum: number, row: Row) => sum + Number(row.amount_cents), 0) === cents;
      };
      if (action === "review_split_successor") {
        rejectUnknown(body, ["action", "household_id", "split_id", "expected_split_version"]);
        if (!isUuid(body.split_id) || typeof body.expected_split_version !== "string" || !/^[1-9][0-9]*$/.test(body.expected_split_version)) throw new HttpError(400, "Refresh the exact split version before review.");
        try {
          const { data, error } = await db.rpc("finance_review_split_successor", { p_household_id: context.householdId, p_actor_user_id: context.userId, p_split_id: body.split_id, p_expected_split_version: body.expected_split_version });
          if (error) throw splitRpcError(error, false);
          if (!isRecord(data) || !isUuid(data.review_id) || data.actor_user_id !== context.userId || data.household_id !== context.householdId || data.split_id !== body.split_id || data.expected_split_version !== body.expected_split_version || typeof data.predecessor_id !== "string" || typeof data.successor_id !== "string" || data.predecessor_id === data.successor_id || !validAllocations(data) || !Number.isSafeInteger(data.expires_at)) throw new HttpError(503, "Successor review could not be verified.");
          return json({ household_id: context.householdId, review: data });
        } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, "Successor review is unavailable."); }
      }
      rejectUnknown(body, ["action", "household_id", "review_id", "idempotency_key", "confirm"]);
      if (!isUuid(body.review_id) || typeof body.idempotency_key !== "string" || body.idempotency_key.length < 8 || body.idempotency_key.length > 200 || body.confirm !== true) throw new HttpError(400, "Confirm the reviewed successor with its exact retry key.");
      try {
        const { data, error } = await db.rpc("finance_confirm_split_successor", { p_household_id: context.householdId, p_actor_user_id: context.userId, p_review_id: body.review_id, p_idempotency_key: body.idempotency_key, p_confirm: true });
        if (error) throw splitRpcError(error, true);
        if (!isRecord(data) || data.saved !== true || data.household_id !== context.householdId || data.actor_user_id !== context.userId || data.review_id !== body.review_id || data.idempotency_key !== body.idempotency_key || !isRecord(data.receipt) || data.receipt.household_id !== context.householdId || !isUuid(data.receipt.split_id) || typeof data.receipt.split_version !== "string" || !/^[1-9][0-9]*$/.test(data.receipt.split_version) || !validAllocations(data.receipt) || typeof data.receipt.transaction_id !== "string" || typeof data.receipt.predecessor_id !== "string" || data.receipt.transaction_id === data.receipt.predecessor_id) throw new HttpError(503, "The successor may have saved. Retry the exact request key to verify its receipt.");
        return json(data);
      } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, "The successor save outcome is unknown. Retry the exact request key."); }
    }
    if (action === "transaction_split_state") {
      rejectUnknown(body, ["action", "household_id", "transaction_id"]);
      if (!transactionId) throw new HttpError(400, "transaction_id is required.");
      const { data, error } = await db.rpc("finance_get_transaction_split_state", {
        p_household_id: context.householdId, p_actor_user_id: context.userId, p_transaction_id: transactionId,
      });
      if (error) throw splitRpcError(error, false);
      return json({ household_id: context.householdId, ...data });
    }
    if (action === "review_transaction_split") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "expected_parent_state", "expected_split_version", "allocations"]);
      if (!transactionId || !isRecord(body.expected_parent_state) || !Array.isArray(body.allocations)
        || !(body.expected_split_version === null || typeof body.expected_split_version === "string" && /^[1-9][0-9]*$/.test(body.expected_split_version))) {
        throw new HttpError(400, "Refresh the transaction and review its exact split before continuing.");
      }
      const { data, error } = await db.rpc("finance_review_transaction_split", {
        p_household_id: context.householdId, p_actor_user_id: context.userId, p_transaction_id: transactionId,
        p_expected_parent_state: body.expected_parent_state, p_expected_split_version: body.expected_split_version,
        p_allocations: body.allocations,
      });
      if (error) throw splitRpcError(error, false);
      if (!isRecord(data) || !isUuid(data.review_id) || data.actor_user_id !== context.userId || data.household_id !== context.householdId) {
        throw new HttpError(502, "Folio could not verify the split review.");
      }
      const review = { ...data };
      if (isRecord(data.after) && Array.isArray(data.after.allocations)) {
        review.after = { ...data.after, allocations: data.after.allocations.map((row: unknown) => {
          if (!isRecord(row)) return row;
          const { category_fingerprint: _internalFingerprint, ...publicRow } = row;
          return publicRow;
        }) };
      }
      return json({ household_id: context.householdId, review });
    }
    if (action === "confirm_transaction_split") {
      rejectUnknown(body, ["action", "household_id", "review_id", "idempotency_key", "confirm"]);
      if (!isUuid(body.review_id) || typeof body.idempotency_key !== "string" || body.idempotency_key.length < 8 || body.idempotency_key.length > 200 || body.confirm !== true) {
        throw new HttpError(400, "Confirm the reviewed split with its exact retry key.");
      }
      const { data, error } = await db.rpc("finance_confirm_transaction_split", {
        p_household_id: context.householdId, p_actor_user_id: context.userId, p_review_id: body.review_id,
        p_idempotency_key: body.idempotency_key, p_confirm: true,
      });
      if (error) throw splitRpcError(error, true);
      if (!isRecord(data) || data.saved !== true || data.actor_user_id !== context.userId || !isRecord(data.receipt) || data.receipt.household_id !== context.householdId) {
        throw new HttpError(503, "The split may have saved, but Folio could not verify its receipt. Retry the exact request key.");
      }
      return json(data);
    }
    if (action === "review_transaction_split_undo") {
      rejectUnknown(body, ["action", "household_id", "transaction_id"]);
      if (!transactionId) throw new HttpError(400, "transaction_id is required.");
      const { data, error } = await db.rpc("finance_review_transaction_split_undo", {
        p_household_id: context.householdId, p_actor_user_id: context.userId, p_transaction_id: transactionId,
      });
      if (error) throw splitRpcError(error, false);
      if (!isRecord(data) || !isUuid(data.review_id) || data.operation !== "undo" || data.actor_user_id !== context.userId) throw new HttpError(502, "Folio could not verify the remove-split review.");
      return json({ household_id: context.householdId, review: data });
    }
    if (action === "confirm_transaction_split_undo") {
      rejectUnknown(body, ["action", "household_id", "review_id", "idempotency_key", "confirm"]);
      if (!isUuid(body.review_id) || typeof body.idempotency_key !== "string" || body.idempotency_key.length < 8 || body.idempotency_key.length > 200 || body.confirm !== true) {
        throw new HttpError(400, "Confirm reviewed split removal with its exact retry key.");
      }
      const { data, error } = await db.rpc("finance_confirm_transaction_split_undo", {
        p_household_id: context.householdId, p_actor_user_id: context.userId, p_review_id: body.review_id,
        p_idempotency_key: body.idempotency_key, p_confirm: true,
      });
      if (error) throw splitRpcError(error, true);
      if (!isRecord(data) || data.undone !== true || data.saved !== true || data.actor_user_id !== context.userId || !isRecord(data.receipt) || data.receipt.household_id !== context.householdId) throw new HttpError(503, "Split removal may have saved, but Folio could not verify its receipt. Retry the exact request key.");
      return json(data);
    }

    if (action === "get_refund_preferences") {
      rejectUnknown(body, ["action", "household_id"]);
      const [{ data, error }, { data: member, error: memberError }] = await Promise.all([
        db.from("finance_refund_preferences").select("auto_apply_high_confidence,unmatched_behavior,version,updated_by,updated_at,auto_paused_at,auto_pause_reason").eq("household_id", context.householdId).maybeSingle(),
        db.from("finance_household_members").select("role").eq("household_id", context.householdId).eq("user_id", context.userId).maybeSingle(),
      ]);
      if (error) throw new HttpError(500, "Could not load refund handling preferences.");
      if (memberError || !member) throw new HttpError(403, "Household access denied.");
      const { data: householdConfig, error: configError } = await db.from("finance_autonomy_household_config").select("mode,rollout_enabled,kill_switch").eq("household_id", context.householdId).maybeSingle();
      if (configError) throw new HttpError(500, "Could not load automatic-action status.");
      const prefs = data ?? { auto_apply_high_confidence: false, unmatched_behavior: "review", version: 0, updated_by: null, updated_at: null };
      const householdPaused = !householdConfig || householdConfig.mode !== "auto" || householdConfig.rollout_enabled !== true || householdConfig.kill_switch !== false;
      return json({ preferences: { ...prefs, can_manage: member.role === "owner", automatic_paused: householdPaused || !!prefs.auto_paused_at } });
    }
    if (action === "save_refund_preferences") {
      rejectUnknown(body, ["action", "household_id", "expected_version", "auto_apply_high_confidence", "unmatched_behavior"]);
      if (!Number.isInteger(body.expected_version) || Number(body.expected_version) < 0 || typeof body.auto_apply_high_confidence !== "boolean" || !new Set(["review", "uncategorized"]).has(String(body.unmatched_behavior))) throw new HttpError(400, "Refresh and review the refund handling settings.");
      const { data, error } = await db.rpc("save_finance_refund_preferences", { p_household_id: context.householdId, p_user_id: context.userId, p_expected_version: body.expected_version, p_auto_apply_high_confidence: body.auto_apply_high_confidence, p_unmatched_behavior: body.unmatched_behavior });
      if (error) throw new HttpError(error.message.includes("Only a household owner") ? 403 : error.message.includes("changed") ? 409 : 422, error.message || "Could not save refund handling preferences.");
      return json({ preferences: { ...data, can_manage: true } });
    }
    if (action === "refund_candidates") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "query", "offset"]);
      const refund = await findTransaction(db, context.householdId, transactionId ?? "");
      const refundBank = refund ? await readBankEvidence(db, context.householdId, refund) : null;
      if (!refund || refund.pending || !refund.plaid_transaction_date || !refundBank || refundBank.amount >= 0 || !bankEvidenceMatches(refund, refundBank) || !refundBankEligible(refund, refundBank)) throw new HttpError(422, "Choose a posted bank credit to review.");
      const offset = body.offset === undefined ? 0 : Number(body.offset);
      const maxOffset = 1_000_000;
      if (!Number.isInteger(offset) || offset < 0 || offset > maxOffset) throw new HttpError(400, "Invalid purchase search position.");
      const query = optionalText(body.query, "query", 120)?.trim();
      const pageSize = 100;
      const resultLimit = 50;
      const scanLimit = Math.min(500, maxOffset - offset);
      const candidates: Row[] = [];
      let scanOffset = offset;
      let nextOffset: number | null = null;
      let finished = false;
      let scanned = 0;
      while (candidates.length < resultLimit && scanned < scanLimit && !finished) {
        let request = db.from("finance_effective_transactions")
          .select("transaction_id,item_id,account_id,effective_transaction_date,plaid_transaction_date,effective_merchant_name,effective_category,effective_group,amount,iso_currency_code,pending,pending_transaction_id,canonical_account_id,transfer_network,plaid_detailed_category,effective_type")
          .eq("household_id", context.householdId).eq("canonical_account_id", refund.canonical_account_id)
          .eq("effective_type", "expense").eq("pending", false).gt("amount", 0)
          .lte("plaid_transaction_date", String(refund.plaid_transaction_date))
          .order("plaid_transaction_date", { ascending: false }).order("transaction_id", { ascending: true });
        request = refund.iso_currency_code == null
          ? request.is("iso_currency_code", null)
          : request.eq("iso_currency_code", refund.iso_currency_code);
        if (query) request = request.ilike("effective_merchant_name", `%${query.replace(/[%,_]/g, "\\$&")}%`);
        request = request.range(scanOffset, scanOffset + pageSize - 1);
        const { data, error } = await request;
        if (error) throw new HttpError(500, "Could not search prior purchases.");
        const rows = data ?? [];
        if (!rows.length) { finished = true; break; }
        const bankRows = await readBankEvidenceBatch(db, context.householdId, rows);
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index] as Row;
          const bank = bankRows.get(String(row.transaction_id));
          scanned++;
          if (bank && bank.amount > 0 && bankEvidenceMatches(row, bank) && purchaseBankEligible(row, bank)) {
            candidates.push({ ...row, amount: Math.abs(bank.amount) });
            if (candidates.length === resultLimit) {
              nextOffset = scanOffset + index + 1;
              finished = true;
              break;
            }
          }
        }
        scanOffset += rows.length;
        if (rows.length < pageSize) finished = true;
      }
      if (!finished && scanned >= scanLimit && scanOffset < maxOffset) nextOffset = scanOffset;
      const data = candidates;
      const ids = data.map((row: Row) => String(row.transaction_id));
      const splitIds = new Set<string>();
      if (ids.length) {
        const { data: splits, error: splitError } = await db.from("finance_rental_transaction_classifications")
          .select("transaction_id").eq("household_id", context.householdId).not("mortgage_split", "is", null).in("transaction_id", ids);
        if (splitError) throw new HttpError(500, "Could not load purchase review details.");
        for (const split of splits ?? []) splitIds.add(String(split.transaction_id));
      }
      return json({ refund_amount: Math.abs(refundBank.amount), candidates: data.map((row: Row) => ({ ...row, date: row.effective_transaction_date, requires_review: splitIds.has(String(row.transaction_id)), review_reason: splitIds.has(String(row.transaction_id)) ? "This rental purchase has a split classification." : null })), next_offset: nextOffset, search_incomplete: nextOffset !== null || scanOffset >= maxOffset && scanned >= scanLimit });
    }
    if (action === "reviewed_state") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "changes"]);
      if (!transactionId) throw new HttpError(400, "transaction_id is required for review.");
      if (body.changes !== undefined && !isRecord(body.changes)) throw new HttpError(400, "Invalid proposed transaction changes.");
      const proposedChanges = body.changes === undefined ? {} : reviewedChanges(body.changes);
      const rpcStarted = performance.now();
      const reviewPromise = Promise.resolve(db.rpc("get_folio2_transaction_review_state", {
        p_household_id: context.householdId,
        p_user_id: context.userId,
        p_transaction_id: transactionId,
      })).finally(() => logReviewStage(action, "review_rpc", rpcStarted));
      const categoryPromise = proposedChanges.category_override !== undefined && proposedChanges.category_override !== null
        ? (async () => {
          const categoryStarted = performance.now();
          try {
            return await db.from("finance_categories").select("category_id")
              .eq("household_id", context.householdId)
              .eq("category_name", proposedChanges.category_override).eq("active", true).maybeSingle();
          } finally { logReviewStage(action, "category_validation", categoryStarted); }
        })()
        : Promise.resolve(null);
      const [reviewResult, categoryResult] = await Promise.allSettled([reviewPromise, categoryPromise]);
      if (reviewResult.status === "rejected") throw reviewResult.reason;
      const { data, error } = reviewResult.value;
      if (error) {
        const message = String(error.message || "");
        throw new HttpError(message.includes("access denied") ? 403 : message.includes("not found") ? 404 : 409,
          message.includes("access denied") ? "Household access denied." : message.includes("not found") ? "Transaction not found." : "Refresh the transaction before reviewing changes.");
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || data.contract_version !== 1 || !data.bank || !data.effective) {
        throw new HttpError(502, "Folio could not verify the transaction details.");
      }
      if (categoryResult.status === "rejected") throw categoryResult.reason;
      if (categoryResult.value) {
        const { data: category, error: categoryError } = categoryResult.value;
        if (categoryError) throw new HttpError(500, "Could not validate the proposed household category.");
        if (!category?.category_id) throw new HttpError(422, "Choose a current household category.");
      }
      if (data.effective.refund_relationship_type === "refund" && data.effective.refund_status === "matched"
        && (proposedChanges.category_override !== undefined || proposedChanges.excluded_from_budget !== undefined || proposedChanges.excluded_from_totals !== undefined)) {
        throw new HttpError(422, "Change this setting in Refund details so the linked purchase and refund stay reconciled.");
      }
      logReviewStage(action, "request_total", requestStarted);
      return json({ household_id: context.householdId, reviewed_state: data });
    }
    if (action === "reviewed_refund_state") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "related_transaction_id"]);
      if (!transactionId) throw new HttpError(400, "Choose a refund to review.");
      const relatedId = optionalText(body.related_transaction_id, "related_transaction_id", 200) ?? null;
      if (relatedId === transactionId) throw new HttpError(422, "Choose a different earlier purchase.");
      const { data, error } = await db.rpc("get_folio2_refund_review_state", {
        p_household_id: context.householdId,
        p_user_id: context.userId,
        p_transaction_id: transactionId,
        p_related_transaction_id: relatedId,
      });
      if (error) {
        const message = String(error.message || "");
        throw new HttpError(message.includes("access denied") ? 403 : message.includes("not found") ? 404 : 409,
          message.includes("access denied") ? "Household access denied." : "Refund evidence changed. Refresh and review again.");
      }
      if (!isRecord(data) || data.contract_version !== 1 || !isRecord(data.refund)
        || !isRecord(data.refund.bank) || !isRecord(data.refund.effective)
        || data.refund.bank.transaction_id !== transactionId) {
        throw new HttpError(502, "Folio could not verify the refund details.");
      }
      if (data.refund.bank.pending !== false || typeof data.refund.bank.amount !== "number"
        || !Number.isFinite(data.refund.bank.amount) || !String(data.refund.bank.iso_currency_code ?? "").trim()
        || !isDateOnly(data.refund.bank.transaction_date)
        || !String(data.refund.effective.canonical_account_id ?? "").trim()
        || Number(data.refund.bank.amount) >= 0
        || data.refund.pending_successor_id != null) {
        throw new HttpError(422, "A current posted bank credit is required for Refund Review.");
      }
      if (relatedId) {
        const purchase = data.purchase;
        if (!isRecord(purchase) || !isRecord(purchase.bank) || !isRecord(purchase.effective)
          || purchase.bank.transaction_id !== relatedId || purchase.bank.pending !== false
          || typeof purchase.bank.amount !== "number" || !Number.isFinite(purchase.bank.amount)
          || Number(purchase.bank.amount) <= 0 || purchase.pending_successor_id != null
          || purchase.effective.effective_type !== "expense"
          || !String(purchase.effective.canonical_account_id ?? "").trim()
          || purchase.effective.canonical_account_id !== data.refund.effective.canonical_account_id
          || !String(purchase.bank.iso_currency_code ?? "").trim()
          || purchase.bank.iso_currency_code !== data.refund.bank.iso_currency_code
          || !isDateOnly(purchase.bank.transaction_date)
          || String(purchase.bank.transaction_date) > String(data.refund.bank.transaction_date)) {
          throw new HttpError(422, "Choose a verified earlier purchase on the same account and in the same currency.");
        }
        const purchaseCategory = String(purchase.effective.effective_category ?? "").trim();
        if (!purchaseCategory) throw new HttpError(422, "The purchase category needs review before matching.");
        const { data: activeCategory, error: activeCategoryError } = await db.from("finance_categories")
          .select("category_id").eq("household_id", context.householdId)
          .eq("category_name", purchaseCategory).eq("active", true).maybeSingle();
        if (activeCategoryError) throw new HttpError(500, "Could not verify the purchase category.");
        if (!activeCategory?.category_id) throw new HttpError(422, "The purchase category is no longer active.");
      }
      return json({ household_id: context.householdId, reviewed_state: data });
    }
    if (action === "reviewed_refund_preview") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "decision", "related_transaction_id", "category", "expected_state"]);
      if (!transactionId || !isRecord(body.expected_state)
        || !new Set(["match", "unmatched", "not_refund", "review"]).has(String(body.decision))) {
        throw new HttpError(400, "Refresh and review the refund before previewing its impact.");
      }
      const decision = String(body.decision);
      const relatedId = decision === "match" ? requiredText(body.related_transaction_id, "related_transaction_id", 200) : null;
      if (decision !== "match" && body.related_transaction_id != null) {
        throw new HttpError(400, "Only a matched refund can include a purchase.");
      }
      const category = optionalText(body.category, "category", 80) ?? null;
      const expected = body.expected_state;
      const refund = expected.refund;
      if (expected.contract_version !== 1 || !isRecord(refund) || !isRecord(refund.bank)
        || !isRecord(refund.effective) || refund.bank.transaction_id !== transactionId
        || refund.bank.pending !== false || typeof refund.bank.amount !== "number"
        || !Number.isFinite(refund.bank.amount) || refund.bank.amount >= 0
        || !String(refund.bank.iso_currency_code ?? "").trim() || !isDateOnly(refund.bank.transaction_date)
        || !String(refund.effective.canonical_account_id ?? "").trim() || refund.pending_successor_id != null) {
        throw new HttpError(409, "Refresh the verified refund evidence before previewing its impact.");
      }
      if (decision === "match") {
        const purchase = expected.purchase;
        if (!isRecord(purchase) || !isRecord(purchase.bank) || !isRecord(purchase.effective)
          || purchase.bank.transaction_id !== relatedId || purchase.bank.pending !== false
          || typeof purchase.bank.amount !== "number" || !Number.isFinite(purchase.bank.amount)
          || purchase.bank.amount <= 0 || purchase.pending_successor_id != null
          || purchase.effective.effective_type !== "expense"
          || !String(purchase.effective.canonical_account_id ?? "").trim()
          || purchase.effective.canonical_account_id !== refund.effective.canonical_account_id
          || !String(purchase.bank.iso_currency_code ?? "").trim()
          || purchase.bank.iso_currency_code !== refund.bank.iso_currency_code
          || !isDateOnly(purchase.bank.transaction_date)
          || String(purchase.bank.transaction_date) > String(refund.bank.transaction_date)) {
          throw new HttpError(409, "Refresh the verified purchase evidence before previewing its impact.");
        }
      }
      const { data, error } = await db.rpc("preview_folio2_reviewed_refund", {
        p_household_id: context.householdId, p_user_id: context.userId,
        p_transaction_id: transactionId, p_decision: decision,
        p_related_transaction_id: relatedId, p_category: category,
        p_expected_state: expected,
      });
      if (error) {
        const message = String(error.message || "");
        throw new HttpError(message.includes("access denied") ? 403
          : message.includes("category") ? 422
            : message.includes("changed") || message.includes("review") || message.includes("refresh") ? 409 : 422,
          message.includes("access denied") ? "Household access denied." : "Refund impact could not be verified. Refresh and review again.");
      }
      const metricNames = ["money_in", "income", "cash_flow_money_out", "net_cash_flow", "budget_spending"];
      const validMetrics = (row: unknown) => isRecord(row) && metricNames.every(key => typeof row[key] === "number" && Number.isFinite(row[key]));
      if (!isRecord(data) || data.contract_version !== 1 || data.preview_only !== true
        || data.transaction_id !== transactionId || typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)
        || !isDateOnly(data.transaction_date)
        || !isRecord(data.before) || !isRecord(data.after)
        || !validMetrics(data.before.daily) || !validMetrics(data.after.daily)
        || !validMetrics(data.before.month) || !validMetrics(data.after.month)
        || !isRecord(data.before.review_state) || !isRecord(data.after.review_state)) {
        throw new HttpError(502, "Folio could not verify the refund impact preview.");
      }
      return json({ household_id: context.householdId, preview: data });
    }
    if (action === "reviewed_refund_update") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "request_id", "decision", "related_transaction_id", "category", "expected_state"]);
      if (!transactionId || !isUuid(body.request_id) || !isRecord(body.expected_state)
        || !new Set(["match", "unmatched", "not_refund", "review"]).has(String(body.decision))) {
        throw new HttpError(400, "Refresh and review the refund before confirming.");
      }
      const decision = String(body.decision);
      if (decision !== "match" && body.related_transaction_id != null) {
        throw new HttpError(400, "Only a matched refund can include a purchase.");
      }
      if (decision === "unmatched" && body.category != null) {
        throw new HttpError(400, "An unmatched refund is not assigned to a purchase category.");
      }
      const relatedId = decision === "match" ? requiredText(body.related_transaction_id, "related_transaction_id", 200) : null;
      const category = optionalText(body.category, "category", 80) ?? null;
      if (body.expected_state.contract_version !== 1 || body.expected_state.refund?.bank?.transaction_id !== transactionId) {
        throw new HttpError(409, "Refund evidence changed. Refresh and review again.");
      }
      if (decision === "match" && (!isRecord(body.expected_state.purchase)
        || body.expected_state.purchase.bank?.transaction_id !== relatedId)) {
        throw new HttpError(409, "The selected purchase was not part of this review. Refresh and review again.");
      }
      const verifiedRefund = body.expected_state.refund;
      if (!isRecord(verifiedRefund) || !isRecord(verifiedRefund.bank) || !isRecord(verifiedRefund.effective)
        || typeof verifiedRefund.bank.amount !== "number" || !Number.isFinite(verifiedRefund.bank.amount)
        || verifiedRefund.bank.amount >= 0 || !String(verifiedRefund.bank.iso_currency_code ?? "").trim()
        || !isDateOnly(verifiedRefund.bank.transaction_date)
        || !String(verifiedRefund.effective.canonical_account_id ?? "").trim()) {
        throw new HttpError(409, "Refresh the verified refund evidence before confirming.");
      }
      if (decision === "match") {
        const purchase = body.expected_state.purchase;
        if (!isRecord(purchase) || !isRecord(purchase.bank) || !isRecord(purchase.effective)
          || typeof purchase.bank.amount !== "number" || !Number.isFinite(purchase.bank.amount)
          || purchase.bank.amount <= 0 || !String(purchase.bank.iso_currency_code ?? "").trim()
          || !isDateOnly(purchase.bank.transaction_date)
          || !String(purchase.effective.canonical_account_id ?? "").trim()) {
          throw new HttpError(409, "Refresh the verified purchase evidence before confirming.");
        }
        const inheritedCategory = String(purchase.effective.effective_category ?? "").trim();
        if (!inheritedCategory) throw new HttpError(422, "The purchase category needs review before matching.");
        // Commit-time category validation belongs inside the receipt-backed SQL RPC.
        // It must replay an existing durable receipt before checking current catalog state.
      }
      const { data, error } = await db.rpc("apply_folio2_reviewed_refund", {
        p_household_id: context.householdId, p_user_id: context.userId,
        p_transaction_id: transactionId, p_request_id: body.request_id,
        p_decision: decision, p_related_transaction_id: relatedId,
        p_category: category, p_expected_state: body.expected_state,
      });
      if (error) {
        const message = String(error.message || "");
        const status = message.includes("access denied") ? 403
          : message.includes("changed") || message.includes("already used") ? 409
          : message.includes("Invalid") || message.includes("Choose") || message.includes("posted") ? 422 : 500;
        throw new HttpError(status, status === 500 ? "Could not save this reviewed refund decision." : message);
      }
      if (!isRecord(data) || data.saved !== true || !isRecord(data.receipt)
        || data.receipt.transaction_id !== transactionId || data.receipt.request_id !== body.request_id
        || data.receipt.decision !== decision || data.receipt.related_transaction_id !== relatedId
        || !String(data.receipt.status ?? "").trim()
        || !isRecord(data.receipt.transaction)) {
        throw new HttpError(502, "The decision may have saved, but Folio could not verify its receipt. Retry the same review before starting another one.");
      }
      return json({ household_id: context.householdId, saved: true, replayed: data.replayed === true, receipt: data.receipt });
    }
    if (action === "reviewed_refund_undo") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "target_request_id", "undo_request_id"]);
      if (!transactionId || !isUuid(body.target_request_id) || !isUuid(body.undo_request_id)) {
        throw new HttpError(400, "Refresh the refund before undoing this change.");
      }
      const { data, error } = await db.rpc("undo_folio2_reviewed_refund", {
        p_household_id: context.householdId, p_user_id: context.userId,
        p_transaction_id: transactionId, p_target_request_id: body.target_request_id,
        p_undo_request_id: body.undo_request_id,
      });
      if (error) {
        const message = String(error.message || "");
        const status = message.includes("access denied") ? 403 : message.includes("changed") || message.includes("no longer") ? 409 : 422;
        throw new HttpError(status, message);
      }
      if (!isRecord(data) || data.saved !== true || !isRecord(data.receipt)
        || data.receipt.transaction_id !== transactionId || data.receipt.request_id !== body.undo_request_id
        || data.receipt.decision !== "undo" || data.receipt.target_request_id !== body.target_request_id
        || !String(data.receipt.status ?? "").trim() || !isRecord(data.receipt.transaction)) {
        throw new HttpError(502, "The undo may have saved, but Folio could not verify its receipt.");
      }
      return json({ household_id: context.householdId, saved: true, replayed: data.replayed === true, receipt: data.receipt });
    }
    if (action === "reviewed_update") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "request_id", "changes", "expected_state"]);
      if (!transactionId || !isUuid(body.request_id) || !isRecord(body.changes) || !isRecord(body.expected_state)) {
        throw new HttpError(400, "Refresh and review the transaction before saving.");
      }
      const changes = reviewedChanges(body.changes);
      if (!Object.keys(changes).length) throw new HttpError(400, "Provide at least one reviewed transaction change.");
      if (body.expected_state.contract_version !== 1 || body.expected_state.bank?.transaction_id !== transactionId) {
        throw new HttpError(409, "Transaction evidence changed. Refresh and review it again.");
      }
      const applyStarted = performance.now();
      const { data, error } = await Promise.resolve(db.rpc("apply_folio2_reviewed_transaction_override", {
        p_household_id: context.householdId,
        p_user_id: context.userId,
        p_transaction_id: transactionId,
        p_request_id: body.request_id,
        p_changes: changes,
        p_expected_state: body.expected_state,
      })).finally(() => logReviewStage(action, "apply_rpc", applyStarted));
      if (error) {
        const message = String(error.message || "");
        const status = message.includes("access denied") ? 403
          : message.includes("not found") ? 404
          : message.includes("changed") || message.includes("already used") || message.includes("reconciling") ? 409
          : message.includes("Invalid") || message.includes("Choose") || message.includes("Change this") ? 422
          : 500;
        throw new HttpError(status, status === 409 ? message : status === 422 ? message : "Could not save this reviewed transaction change.");
      }
      if (!isRecord(data) || data.saved !== true || !isRecord(data.receipt)
        || data.receipt.transaction_id !== transactionId || typeof data.receipt.override_updated_at !== "string") {
        throw new HttpError(502, "The change may have saved, but Folio could not confirm the receipt. Refresh transaction details before retrying.");
      }
      logReviewStage(action, "request_total", requestStarted);
      return json({
        household_id: context.householdId,
        saved: true,
        replayed: data.replayed === true,
        receipt: data.receipt,
      });
    }
    if (!transactionId) throw new HttpError(400, "transaction_id is required for this action.");

    const transaction = await findTransaction(db, context.householdId, transactionId);
    if (!transaction) throw new HttpError(404, "Transaction not found.");

    if (action === "refund_relationship") {
      rejectUnknown(body, ["action", "household_id", "transaction_id", "decision", "related_transaction_id", "category"]);
      const decision = requiredText(body.decision, "decision", 30);
      if (!new Set(["apply", "not_refund", "review"]).has(decision)) throw new HttpError(400, "Choose whether to apply the refund or mark it as not a refund.");
      const relatedId = decision === "apply" ? requiredText(body.related_transaction_id, "related_transaction_id", 200) : optionalText(body.related_transaction_id, "related_transaction_id", 200) ?? null;
      const category = optionalText(body.category, "category", 80) ?? null;
      const bank = await readBankEvidence(db, context.householdId, transaction);
      if (!bank || bank.amount >= 0 || transaction.pending || !bankEvidenceMatches(transaction, bank)) throw new HttpError(422, "A refund decision requires a posted bank credit.");
      if (decision === "apply" && !refundBankEligible(transaction, bank)) throw new HttpError(422, "This credit is not eligible for refund matching.");
      const { data, error } = await db.rpc("set_finance_refund_relationship", {
        p_household_id: context.householdId,
        p_transaction_id: transactionId,
        p_related_transaction_id: relatedId,
        p_status: decision === "apply" ? "matched" : decision === "not_refund" ? "not_refund" : "review",
        p_confidence: decision === "apply" ? "high" : "low",
        p_match_source: "user",
        p_user_id: context.userId,
        p_category: category,
      });
      if (error) throw new HttpError(422, error.message || "Could not update the refund relationship.");
      const refreshed = await findTransaction(db, context.householdId, transactionId);
      return json({ household_id: context.householdId, result: data, transaction: refreshed });
    }

    if (action === "update") {
      rejectUnknown(body, [
        "action", "household_id", "transaction_id", "merchant_name",
        "category", "subcategory", "transaction_date", "notes",
      ]);
      const changes = compact({
        merchant_name_override: optionalText(body.merchant_name, "merchant_name", 200),
        category_override: optionalText(body.category, "category", 80),
        subcategory_override: optionalText(body.subcategory, "subcategory", 80),
        transaction_date_override: optionalDate(body.transaction_date, "transaction_date"),
        notes: optionalText(body.notes, "notes", 4000),
      });
      if (!Object.keys(changes).length) {
        throw new HttpError(400, "Provide at least one transaction field to update.");
      }
      if (transaction.refund_relationship_type === "refund" && transaction.refund_status === "matched" && Object.hasOwn(changes, "category_override")) {
        throw new HttpError(422, "Change this category in Refund details so the linked purchase and refund stay reconciled.");
      }
      return await applyTransactionOverride(db, context, transaction, changes);
    }

    if (action === "set_exclusions") {
      rejectUnknown(body, [
        "action", "household_id", "transaction_id", "excluded_from_budget",
        "excluded_from_cash_flow", "excluded_from_totals",
      ]);
      const changes = compact({
        excluded_from_budget: optionalBoolean(body.excluded_from_budget, "excluded_from_budget"),
        excluded_from_cash_flow: optionalBoolean(body.excluded_from_cash_flow, "excluded_from_cash_flow"),
        excluded_from_totals: optionalBoolean(body.excluded_from_totals, "excluded_from_totals"),
      });
      if (!Object.keys(changes).length) {
        throw new HttpError(400, "Provide at least one exclusion value.");
      }
      return await applyTransactionOverride(db, context, transaction, changes, "transaction.exclusions_changed");
    }

    if (action === "delete") {
      rejectUnknown(body, [
        "action", "household_id", "transaction_id", "confirm_permanent",
      ]);
      if (body.confirm_permanent !== true) {
        throw new HttpError(400, "Permanent deletion requires confirm_permanent=true.");
      }

      // The database function writes the tombstone, removes the raw Plaid row,
      // and records the audit event in one transaction.
      const { data, error } = await db.rpc("finance_permanently_delete_transaction", {
        p_household_id: context.householdId,
        p_transaction_id: transactionId,
        p_actor_user_id: context.userId,
      });
      if (error) throw new HttpError(500, "Could not permanently delete the transaction.");
      return json(data);
    }

    throw new HttpError(400, "Invalid action.");
  } catch (error) {
    logReviewStage(timingAction, "request_total", requestStarted);
    return json(
      { error: error instanceof HttpError ? error.message : "Could not manage the transaction." },
      error instanceof HttpError ? error.status : 500,
    );
  }
});

async function authenticate(
  authorization: string | null,
  householdInput?: string,
  action = "unknown",
): Promise<Context> {
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Sign in required.");
  const auth = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), options);
  const userStarted = performance.now();
  const sessionStarted = performance.now();
  const [identityResult, sessionResult] = await Promise.allSettled([
    auth.auth.getUser(authorization.slice(7)).finally(() => logReviewStage(action, "auth_user", userStarted)),
    currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization).finally(() => logReviewStage(action, "current_session", sessionStarted)),
  ]);
  if (identityResult.status === "rejected") throw identityResult.reason;
  const { data: identity, error } = identityResult.value;
  if (error || !identity.user) throw new HttpError(401, "Sign in required.");
  if (sessionResult.status === "rejected") throw sessionResult.reason;
  if (!sessionResult.value) throw new HttpError(401, "Sign in required.");

  const db = serviceClient();
  const membershipStarted = performance.now();
  let query = db
    .from("finance_household_members")
    .select("household_id,role")
    .eq("user_id", identity.user.id);
  if (householdInput) query = query.eq("household_id", householdInput);
  const { data: memberships, error: membershipError } = await Promise.resolve(query.limit(2))
    .finally(() => logReviewStage(action, "membership", membershipStarted));
  if (membershipError) throw new HttpError(500, "Could not verify household access.");
  if (!memberships?.length) throw new HttpError(403, "No access to this household.");
  if (memberships.length !== 1) {
    throw new HttpError(400, "Select a household using household_id.");
  }
  return {
    userId: identity.user.id,
    householdId: memberships[0].household_id,
    role: memberships[0].role,
  };
}

function logReviewStage(action: string, stage: string, started: number): void {
  if (action !== "reviewed_state" && action !== "reviewed_update") return;
  console.info("folio_transaction_review_timing", JSON.stringify({ action, stage, duration_ms: Math.round(performance.now() - started) }));
}

async function findTransaction(
  db: ReturnType<typeof serviceClient>,
  householdId: string,
  transactionId: string,
): Promise<Row | null> {
  const { data, error } = await db
    .from("finance_effective_transactions")
    .select("transaction_id,item_id,account_id,name,original_description,transfer_network,plaid_detailed_category,effective_merchant_name,effective_category,effective_subcategory,effective_transaction_date,plaid_transaction_date,override_updated_at,notes,transaction_excluded_from_budget,transaction_excluded_from_cash_flow,excluded_from_totals,amount,iso_currency_code,pending,pending_transaction_id,effective_type,canonical_account_id,refund_relationship_type,refund_original_transaction_id,refund_matched_amount,refund_status,refund_confidence,refund_match_source,refund_user_confirmed")
    .eq("household_id", householdId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not verify the transaction.");
  return data;
}

type BankEvidence = {
  transaction_id: string;
  item_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  transaction_date: string | null;
  name: string | null;
  original_description: string | null;
  transfer_network: string | null;
  personal_finance_category: Row | null;
};

async function readBankEvidence(db: ReturnType<typeof serviceClient>, householdId: string, row: Row): Promise<BankEvidence | null> {
  if (typeof row.transaction_id !== "string" || typeof row.item_id !== "string" || typeof row.account_id !== "string") return null;
  const { data, error } = await db.from("plaid_transactions")
    .select("transaction_id,item_id,account_id,amount,iso_currency_code,pending,pending_transaction_id,transaction_date,name,original_description,transfer_network,personal_finance_category")
    .eq("transaction_id", row.transaction_id).eq("item_id", row.item_id).eq("account_id", row.account_id).maybeSingle();
  if (error) throw new HttpError(500, "Could not verify the bank transaction evidence.");
  if (!data || !Number.isFinite(Number(data.amount))) return null;
  const { data: item, error: itemError } = await db.from("plaid_items").select("item_id")
    .eq("item_id", row.item_id).eq("household_id", householdId).maybeSingle();
  if (itemError) throw new HttpError(500, "Could not verify the bank account household.");
  if (!item) return null;
  return { ...data, amount: Number(data.amount), iso_currency_code: data.iso_currency_code ?? null,
    pending: data.pending === true, pending_transaction_id: data.pending_transaction_id ?? null,
    transaction_date: data.transaction_date ?? null, name: data.name ?? null,
    original_description: data.original_description ?? null, transfer_network: data.transfer_network ?? null,
    personal_finance_category: isRecord(data.personal_finance_category) ? data.personal_finance_category : null } as BankEvidence;
}

async function readBankEvidenceBatch(db: ReturnType<typeof serviceClient>, householdId: string, rows: Row[]): Promise<Map<string, BankEvidence>> {
  const result = new Map<string, BankEvidence>();
  const ids = [...new Set(rows.map(row => String(row.transaction_id ?? "")).filter(Boolean))];
  const { data: bankRows, error } = await db.from("plaid_transactions")
    .select("transaction_id,item_id,account_id,amount,iso_currency_code,pending,pending_transaction_id,transaction_date,name,original_description,transfer_network,personal_finance_category")
    .in("transaction_id", ids);
  if (error) throw new HttpError(500, "Could not verify bank purchase evidence.");
  const itemIds = [...new Set((bankRows ?? []).map((bank: Row) => String(bank.item_id ?? "")).filter(Boolean))];
  const { data: items, error: itemError } = await db.from("plaid_items").select("item_id")
    .eq("household_id", householdId).in("item_id", itemIds);
  if (itemError) throw new HttpError(500, "Could not verify bank account household.");
  const allowedItems = new Set((items ?? []).map((item: Row) => String(item.item_id)));
  const byId = new Map<string, Row[]>();
  for (const bank of bankRows ?? []) {
    const id = String(bank.transaction_id ?? "");
    const list = byId.get(id) ?? [];
    list.push(bank);
    byId.set(id, list);
  }
  for (const row of rows) {
    const matches = (byId.get(String(row.transaction_id)) ?? []).filter(bank =>
      String(bank.item_id) === String(row.item_id) && String(bank.account_id) === String(row.account_id)
      && allowedItems.has(String(bank.item_id)));
    if (matches.length !== 1 || !Number.isFinite(Number(matches[0].amount))) continue;
    const bank = matches[0];
    const evidence: BankEvidence = { ...bank, amount: Number(bank.amount), iso_currency_code: bank.iso_currency_code ?? null,
      pending: bank.pending === true, pending_transaction_id: bank.pending_transaction_id ?? null,
      transaction_date: bank.transaction_date ?? null, name: bank.name ?? null,
      original_description: bank.original_description ?? null, transfer_network: bank.transfer_network ?? null,
      personal_finance_category: isRecord(bank.personal_finance_category) ? bank.personal_finance_category : null } as BankEvidence;
    if (bankEvidenceMatches(row, evidence)) result.set(evidence.transaction_id, evidence);
  }
  return result;
}

function bankEvidenceMatches(row: Row, bank: BankEvidence): boolean {
  const sameNullable = (a: unknown, b: unknown) => (a == null ? null : String(a)) === (b == null ? null : String(b));
  return bank.transaction_id === String(row.transaction_id) && bank.item_id === String(row.item_id)
    && bank.account_id === String(row.account_id) && bank.pending === (row.pending === true)
    && sameNullable(bank.pending_transaction_id, row.pending_transaction_id)
    && sameNullable(bank.iso_currency_code, row.iso_currency_code)
    && sameNullable(bank.transaction_date, row.plaid_transaction_date);
}

function bankEligibleForManualReview(row: Row, bank: BankEvidence): boolean {
  return !bank.pending && !row.pending && String(row.effective_type ?? "") !== "transfer" && !bank.transfer_network;
}
function refundBankEligible(row: Row, bank: BankEvidence): boolean { return bank.amount < 0 && bankEligibleForManualReview(row, bank); }
function purchaseBankEligible(row: Row, bank: BankEvidence): boolean { return bank.amount > 0 && String(row.effective_type ?? "") === "expense" && bankEligibleForManualReview(row, bank); }

async function applyTransactionOverride(db: ReturnType<typeof serviceClient>, context: Context, transaction: Row, changes: Row, action = "transaction.updated") {
  if (changes.category_override) {
    const { data: category, error } = await db.from("finance_categories").select("category_id")
      .eq("household_id", context.householdId).eq("category_name", changes.category_override).eq("active", true).maybeSingle();
    if (error) throw new HttpError(500, "Could not verify the household category.");
    if (!category) throw new HttpError(422, "Choose an active category from this household.");
  }
  const expected = {
    effective_merchant_name: transaction.effective_merchant_name,
    effective_category: transaction.effective_category,
    effective_subcategory: transaction.effective_subcategory,
    effective_transaction_date: transaction.effective_transaction_date,
    notes: transaction.notes,
    transaction_excluded_from_budget: transaction.transaction_excluded_from_budget,
    transaction_excluded_from_cash_flow: transaction.transaction_excluded_from_cash_flow,
    excluded_from_totals: transaction.excluded_from_totals,
    override_updated_at: transaction.override_updated_at,
  };
  const { data, error } = await db.rpc("apply_finance_transaction_override", {
    p_household_id: context.householdId, p_user_id: context.userId, p_transaction_id: transaction.transaction_id,
    p_changes: changes, p_expected: expected, p_autonomy_ticket: null,
  });
  if (error) throw new HttpError(409, error.message || "Transaction changed. Review the current details.");
  // The atomic RPC already returns its committed values. Avoid querying the
  // expensive effective-transaction view again after the write: that second
  // read can time out after the save has committed and make success ambiguous.
  const result = data && typeof data === "object" && !Array.isArray(data) ? data as Row : null;
  const saved = result?.new_values && typeof result.new_values === "object" && !Array.isArray(result.new_values)
    ? result.new_values as Row
    : null;
  if (result?.saved !== true || !saved || saved.transaction_id !== transaction.transaction_id || typeof saved.override_updated_at !== "string") {
    throw new HttpError(502, "The change may have been saved, but Folio could not confirm it. Refresh transaction details before trying again.");
  }
  // This is a save receipt, not a refreshed canonical transaction. The RPC
  // returns raw override values, which can differ from effective values after
  // category exclusions, mortgage matching, refunds, or other reconciliation.
  return json({
    household_id: context.householdId,
    saved: true,
    transaction_id: transaction.transaction_id,
    changed_fields: Object.keys(changes),
    override_updated_at: saved.override_updated_at,
  });
}

function isRecord(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validSplitRefundLinks(value: unknown, reversed: boolean): value is Row[] {
  if (!Array.isArray(value) || (reversed ? value.length !== 0 : value.length < 1 || value.length > 40)) return false;
  const ids = new Set<string>(); let total = 0;
  for (const row of value) { if (!isRecord(row) || !isUuid(row.allocation_id) || ids.has(row.allocation_id) || !Number.isSafeInteger(row.amount_cents) || Number(row.amount_cents) <= 0) return false; ids.add(row.allocation_id); total += Number(row.amount_cents); }
  return Number.isSafeInteger(total);
}

function splitRpcError(error: { code?: string; message?: string }, write: boolean): HttpError {
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  if (code === "42501") return new HttpError(403, "Household access denied.");
  if (code === "P0002") return new HttpError(404, "Transaction or split review not found.");
  if (code === "40001" || code === "23505") return new HttpError(409, "The transaction or split changed. Refresh and review it again.");
  if (code.startsWith("22") || code === "23514") return new HttpError(code === "23514" ? 422 : 400, "The split request is invalid or no longer eligible.");
  return new HttpError(write ? 503 : 500, write ? "The split outcome is unknown. Retry the exact request key." : "Could not verify the split state.");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function reviewedChanges(value: Row): Row {
  const allowed = new Set([
    "merchant_name", "category", "subcategory", "transaction_date", "notes",
    "excluded_from_budget", "excluded_from_cash_flow", "excluded_from_totals",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new HttpError(400, "Unknown reviewed transaction field.");
  const changes = compact({
    merchant_name_override: value.merchant_name === undefined ? undefined : optionalText(value.merchant_name, "merchant_name", 200),
    category_override: value.category === undefined ? undefined : optionalText(value.category, "category", 80),
    subcategory_override: value.subcategory === undefined ? undefined : optionalText(value.subcategory, "subcategory", 80),
    transaction_date_override: value.transaction_date === undefined ? undefined : optionalDate(value.transaction_date, "transaction_date"),
    notes: value.notes === undefined ? undefined : optionalText(value.notes, "notes", 4000),
    excluded_from_budget: value.excluded_from_budget === undefined ? undefined : optionalBoolean(value.excluded_from_budget, "excluded_from_budget"),
    excluded_from_cash_flow: value.excluded_from_cash_flow === undefined ? undefined : optionalBoolean(value.excluded_from_cash_flow, "excluded_from_cash_flow"),
    excluded_from_totals: value.excluded_from_totals === undefined ? undefined : optionalBoolean(value.excluded_from_totals, "excluded_from_totals"),
  });
  return changes;
}

async function upsertOverride(
  db: ReturnType<typeof serviceClient>,
  context: Context,
  transactionId: string,
  changes: Row,
): Promise<Row> {
  const { data, error } = await db
    .from("finance_transaction_overrides")
    .upsert({
      household_id: context.householdId,
      transaction_id: transactionId,
      updated_by: context.userId,
      created_by: context.userId,
      ...changes,
    }, { onConflict: "household_id,transaction_id" })
    .select("*")
    .single();
  if (error) throw new HttpError(500, "Could not save the transaction change.");
  return data;
}

async function audit(
  db: ReturnType<typeof serviceClient>,
  context: Context,
  action: string,
  entityId: string,
  metadata: Row,
) {
  const { error } = await db.from("finance_audit_events").insert({
    household_id: context.householdId,
    actor_user_id: context.userId,
    action,
    entity_type: "transaction",
    entity_id: entityId,
    metadata,
  });
  if (error) throw new HttpError(500, "Could not record the transaction change.");
}

function serviceClient() {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), options);
}

async function readBody(request: Request): Promise<Row> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Row;
  } catch {
    throw new HttpError(400, "Invalid JSON object.");
  }
}

function rejectUnknown(body: Row, allowed: string[]) {
  const set = new Set(allowed);
  if (Object.keys(body).some((key) => !set.has(key))) {
    throw new HttpError(400, "Unknown input field.");
  }
}

function compact(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${name} must be boolean.`);
  return value;
}

function optionalDate(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${name} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value;
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalUuid(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value;
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, "Server configuration is incomplete.");
  return value;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}


