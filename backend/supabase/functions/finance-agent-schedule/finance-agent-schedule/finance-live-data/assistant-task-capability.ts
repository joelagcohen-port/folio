import { getAgentStateForAssistant, planningResponse, recurringResponse, refreshAssistantEvidenceOnly, serviceClient } from "./index.ts";
import { compactAgentState, compactPlanning, compactPreparedTransactions, compactRecurring, compactSpendingSummary } from "./assistant-task-projections.ts";

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function checked(result: any) { if (result?.error) throw new Error("scheduled_task_unavailable"); return result?.data; }
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
export async function assistantTaskCapabilityOperation(request: Request, body: Row) {
  const runId = body.run_id;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!UUID.test(String(runId)) || token.length < 32 || token.length > 512) return json({ error: "Invalid run capability." }, 401);
  const capabilityHash = await hash(token);
  const db = serviceClient();
  if (body.operation === "assistant_task_claim") {
    if (Object.keys(body).sort().join(",") !== "operation,run_id") return json({ error: "Invalid request." }, 400);
    try {
      const result = await db.rpc("finance_claim_assistant_task_capability", { p_run_id: runId, p_capability_hash: capabilityHash });
      if (result?.error?.code === "40001") return json({ error: "Run already active." }, 409);
      const value = checked(result);
      if (value?.status === "already_completed") return json({ status: "already_completed" });
      return json(value);
    } catch (error) {
      const status = /already active/i.test(String((error as Error)?.message)) ? 409 : 401;
      return json({ error: status === 409 ? "Run already active." : "Invalid or expired run capability." }, status);
    }
  }
  if (body.operation === "assistant_task_context") {
    if (Object.keys(body).sort().join(",") !== "operation,run_id") return json({ error: "Invalid task context request." }, 400);
    try {
      const value = checked(await db.rpc("finance_claim_assistant_task_context", { p_run_id: runId, p_capability_hash: capabilityHash }));
      if (!record(value) || !Array.isArray(value.explicit_memories) || value.explicit_memories.length > 24 || !Array.isArray(value.open_issues) || value.open_issues.length > 8) return json({ error: "Task context is unavailable." }, 503);
      return json(value);
    } catch { return json({ error: "Invalid, expired, or exhausted run capability." }, 401); }
  }
  if (body.operation === "assistant_task_fail") {
    if (Object.keys(body).sort().join(",") !== "failure,operation,run_id" || body.failure !== "Scheduled check could not be completed.") return json({ error: "Invalid scheduled failure." }, 400);
    try {
      const value = checked(await db.rpc("finance_fail_assistant_task_run", { p_run_id: runId, p_capability_hash: capabilityHash, p_failure: body.failure }));
      return json(value);
    } catch { return json({ error: "Scheduled failure could not be saved." }, 409); }
  }
  if (body.operation === "assistant_task_read") {
    if (Object.keys(body).sort().join(",") !== "args,operation,run_id,tool" || typeof body.tool !== "string" || !record(body.args)) return json({ error: "Invalid read request." }, 400);
    let scope: Row;
    try { scope = checked(await db.rpc("finance_claim_assistant_task_read", { p_run_id: runId, p_capability_hash: capabilityHash })); }
    catch { return json({ error: "Invalid, expired, or exhausted run capability." }, 401); }
    if (!record(scope) || !UUID.test(String(scope.household_id)) || !UUID.test(String(scope.user_id))) return json({ error: "Run scope is unavailable." }, 401);
    const context = { householdId: scope.household_id, userId: scope.user_id };
    const taskTimezone = typeof scope.timezone === "string" ? scope.timezone : "Etc/UTC";
    const args = body.args;
    try {
      if (scope.should_refresh_state === true) await refreshAssistantEvidenceOnly(context);
      if (body.tool === "get_agent_state" && Object.keys(args).length === 0) return json(compactAgentState(await getAgentStateForAssistant(context)));
      if (body.tool === "get_planning" && Object.keys(args).every(key => ["horizon_days", "timezone"].includes(key)) && [30, 60, 90].includes(Number(args.horizon_days || 30))) {
        const timezone = typeof args.timezone === "string" ? args.timezone : taskTimezone;
        new Intl.DateTimeFormat("en", { timeZone: timezone });
        return json(compactPlanning(await planningResponse(context, { horizon_days: Number(args.horizon_days || 30), timezone })));
      }
      if (body.tool === "list_recurring" && Object.keys(args).length === 0) return json(compactRecurring(await recurringResponse(context, undefined, undefined, { timeZone: taskTimezone, horizonDays: 30 })));
      if (body.tool === "get_budget_progress" && Object.keys(args).every(key => key === "month")) {
        const state = await getAgentStateForAssistant(context);
        const progress = state?.agent_state?.budget_progress;
        const monthParts = new Intl.DateTimeFormat("en-US", { timeZone: taskTimezone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
        const currentMonth = `${monthParts.find(part => part.type === "year")?.value}-${monthParts.find(part => part.type === "month")?.value}`;
        if (args.month !== undefined && args.month !== currentMonth) return json({ error: "Only current-month canonical budget progress is available to this scheduled read." }, 422);
        const rows = Array.isArray(progress?.categories) ? progress.categories : [];
        const categories = rows.slice(0, 30).map((item: any) => record(item) ? { name: item.name ?? item.category, spent: item.spent, target: item.target, capacity: item.available_capacity, remaining: item.remaining_capacity, currency: item.currency } : null).filter(Boolean);
        const month = typeof progress?.month === "string" ? progress.month : null;
        if (args.month !== undefined && args.month !== month || month !== currentMonth) return json({ error: "Only current-month canonical budget progress is available to this scheduled read." }, 422);
        return json({ month, progress: progress ? { spent: progress.spent ?? null, target: progress.target ?? null, available_capacity: progress.available_capacity ?? null, remaining_capacity: progress.remaining_capacity ?? null, categories, omitted_category_count: Math.max(0, rows.length - categories.length), available: true } : null, freshness: progress?.evaluated_at || state?.agent_state?.evaluated_at || null });
      }
      if (body.tool === "search_transactions" && Object.keys(args).every(key => ["start_date", "end_date", "query", "category", "limit", "offset", "include_pending", "generation"].includes(key))) {
        const start = args.start_date ?? null, end = args.end_date ?? null;
        if ((start === null) !== (end === null) || start !== null && (typeof start !== "string" || typeof end !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(start) || !/^20\d{2}-\d{2}-\d{2}$/.test(end) || start > end) || args.query !== undefined && (typeof args.query !== "string" || args.query.length > 120) || args.category !== undefined && (typeof args.category !== "string" || args.category.length > 120) || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) || args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 20_000) || args.include_pending !== undefined && typeof args.include_pending !== "boolean" || args.generation !== undefined && (!Number.isSafeInteger(args.generation) || args.generation < 1)) return json({ error: "Choose valid bounded transaction search criteria." }, 422);
        const result = checked(await db.rpc("finance_search_prepared_transactions_page", { p_household_id: context.householdId, p_account_id: null, p_transaction_ids: null, p_start_date: start, p_end_date: end, p_query: typeof args.query === "string" ? args.query.trim().toLowerCase() || null : null, p_category: typeof args.category === "string" ? args.category.trim() || null : null, p_include_pending: args.include_pending === true, p_pending_only: false, p_limit: args.limit ?? 25, p_offset: args.offset ?? 0, p_expected_generation: args.generation ?? null }));
        const projection = compactPreparedTransactions(result, args.limit ?? 25);
        if (!projection) return json({ error: "Canonical transaction evidence is stale or incomplete." }, 503);
        return json(projection);
      }
      if (body.tool === "spending_summary" && Object.keys(args).every(key => ["start_date", "end_date", "include_pending"].includes(key))) {
        const start = args.start_date ?? null, end = args.end_date ?? null;
        if ((start === null) !== (end === null) || start !== null && (typeof start !== "string" || typeof end !== "string" || start > end)) return json({ error: "Choose a valid bounded date range." }, 422);
        const value = checked(await db.rpc("finance_prepared_transaction_summaries", { p_household_id: context.householdId, p_start_date: start, p_end_date: end, p_include_pending: args.include_pending === true, p_account_id: null, p_query: null, p_category: null }));
        const projection = compactSpendingSummary(value);
        if (!projection) return json({ error: "Canonical spending evidence is stale or unavailable." }, 503);
        return json(projection);
      }
      return json({ error: "That read is not available to scheduled Folio tasks." }, 403);
    } catch { return json({ error: "Fresh canonical Folio data is temporarily unavailable." }, 503); }
  }
  if (body.operation === "assistant_task_complete") {
    if (Object.keys(body).sort().join(",") !== "answer,operation,run_id" || typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > 8000) return json({ error: "Invalid scheduled response." }, 400);
    try {
      const value = checked(await db.rpc("finance_complete_assistant_task_run", { p_run_id: runId, p_capability_hash: capabilityHash, p_answer: body.answer, p_answer_hash: await hash(body.answer) }));
      return json(value);
    } catch { return json({ error: "Scheduled response could not be saved." }, 409); }
  }
  return json({ error: "Unsupported task operation." }, 400);
}
