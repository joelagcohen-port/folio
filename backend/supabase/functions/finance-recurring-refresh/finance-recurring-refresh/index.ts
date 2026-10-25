import {runRolloverBoundary} from '../finance-live-data/rollover-boundary.ts';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { resolvePlaidAccessToken } from "../_shared/plaid-access-token.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { planningResponse, recurringResponse } from "../finance-live-data/index.ts";
import { buildProjectedVariableSpend } from "../finance-live-data/financial-state.ts";

type ClaimedItem = { job_id: string; household_id: string; item_id: string; lease_token: string; attempt_count: number; access_token: string; plaid_environment: string; institution_name: string | null };
type ClaimedRecalculation = { job_id: string; household_id: string; lease_token: string; requested_generation: number };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const required = (name: string) => { const value = Deno.env.get(name); if (!value) throw new Error(`Missing ${name}`); return value; };

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("PLAID_MCP_SHARED_SECRET");
  if (!secret || request.headers.get("x-plaid-app-secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return json({ error: "Invalid request" }, 400);

  const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const workerId = crypto.randomUUID();
  try {
    const recovery = await supabase.rpc("finance_recover_stale_plaid_sync_status");
    if (recovery.error) throw new Error(recovery.error.message);
    const due = await supabase.rpc("finance_enqueue_due_recurring_refreshes");
    if (due.error) throw new Error(due.error.message);
    const claimed = await supabase.rpc("finance_claim_recurring_refresh_items", { p_worker_id: workerId, p_limit: 3 });
    if (claimed.error) throw new Error(claimed.error.message);
    const items = (claimed.data ?? []) as ClaimedItem[];
    const itemResults = await mapLimit(items, 3, async item => { try { return await refreshItem(supabase, item); } catch (error) { return { item_id: item.item_id, status: "error", message: error instanceof Error ? error.message : "Recurring refresh failed" }; } });

    const recalculations = await supabase.rpc("finance_claim_recurring_recalculations", { p_worker_id: workerId, p_limit: 3 });
    if (recalculations.error) throw new Error(recalculations.error.message);
    const claimedRecalculations = (recalculations.data ?? []) as ClaimedRecalculation[];
    const recalculationResults = await mapLimit(claimedRecalculations, 3, async job => { try { return await recalculate(supabase, job); } catch (error) { return { household_id: job.household_id, status: "error", message: error instanceof Error ? error.message : "Forecast recalculation failed" }; } });
    return json({ ok: true, recovered_sync_statuses: recovery.data ?? 0, due_households: due.data ?? 0, claimed_items: items.length, item_results: itemResults, claimed_recalculations: claimedRecalculations.length, recalculation_results: recalculationResults });
  } catch (error) {
    console.error("Recurring refresh worker failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Recurring refresh worker failed" }, 500);
  } finally {
    try { await supabase.rpc("finance_release_recurring_refresh_worker", { p_worker_id: workerId }); } catch { /* PostgREST builders are thenable; await handles rejection. */ }
  }
});

async function refreshItem(supabase: any, item: ClaimedItem) {
  let succeeded = false, payload: any = null, errorMessage: string | null = null;
  try {
    const accountResult = await supabase.from("finance_household_accounts").select("account_id,type,lifecycle_status").eq("household_id", item.household_id).eq("item_id", item.item_id);
    if (accountResult.error) throw new Error("Could not verify the bank account scope.");
    const sourceAccountIds = (accountResult.data ?? []).filter((account: any) => account.lifecycle_status !== "closed" && ["depository", "credit"].includes(String(account.type).toLowerCase())).map((account: any) => account.account_id).sort();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    let response: Response, data: any;
    try {
      response = await fetch(`https://${item.plaid_environment}.plaid.com/transactions/recurring/get`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: required("PLAID_CLIENT_ID").trim(), secret: required("PLAID_SECRET").trim(), access_token: await resolvePlaidAccessToken(supabase, item.item_id, item.access_token) }), signal: controller.signal,
      });
      data = await response.json().catch(() => ({}));
    } finally { clearTimeout(timer); }
    if (!response!.ok || data?.error_code) throw new Error(providerFailure(data, response!.status));
    if (!Array.isArray(data.inflow_streams) || !Array.isArray(data.outflow_streams)) throw new Error("Plaid returned incomplete recurring data.");
    payload = { streams: { inflow_streams: data.inflow_streams, outflow_streams: data.outflow_streams }, sourceAccountIds, coverage: { fetched_at: new Date().toISOString(), provider: "plaid-transactions-recurring" } };
    succeeded = true;
  } catch (error) { errorMessage = error instanceof Error ? error.message : "Plaid recurring request failed."; }

  const finished = await supabase.rpc("finance_finish_recurring_refresh_item", {
    p_household_id: item.household_id, p_item_id: item.item_id, p_lease_token: item.lease_token, p_success: succeeded,
    p_streams: payload?.streams ?? null, p_coverage: payload?.coverage ?? {}, p_source_account_ids: payload?.sourceAccountIds ?? [],
    p_error: errorMessage, p_retry_after_seconds: Math.min(3600, Math.max(60, 30 * 2 ** Math.min(item.attempt_count - 1, 6))),
  });
  if (finished.error) throw new Error(finished.error.message);
  return { item_id: item.item_id, status: finished.data ? (succeeded ? "cached" : "retrying") : "lease_lost" };
}

async function recalculate(supabase: any, job: ClaimedRecalculation) {
  let ok = false, completionKind="incomplete";
  const started=performance.now();
  try {
    await runRolloverBoundary(supabase,job.household_id);
    const scopeStarted=performance.now();
    const [scopeResult,scopesResult]=await Promise.all([
      supabase.from("finance_recurring_refresh_jobs").select("requested_timezone,requested_generation").eq("job_id",job.job_id).eq("household_id",job.household_id).maybeSingle(),
      supabase.from("finance_recurring_refresh_job_scopes").select("timezone,start_date").eq("job_id",job.job_id).eq("household_id",job.household_id).order("requested_at",{ascending:false}).limit(12),
    ]);
    if(scopeResult.error)throw new Error("Could not load forecast refresh scope.");
    if(scopesResult.error)throw new Error("Could not load requested forecast time zones.");
    if(Number(scopeResult.data?.requested_generation)!==Number(job.requested_generation))throw new Error("Forecast refresh generation changed before processing.");
    const defaultTimeZone=scopeResult.data?.requested_timezone||"UTC";
    const timeZones=[...new Set(((scopesResult.data??[]) as any[]).map((scope:any)=>scope.timezone).filter((value:any)=>typeof value==="string"))];
    if(!timeZones.length)timeZones.push(defaultTimeZone);
    const accountsResult=await supabase.from("finance_household_accounts").select("canonical_account_id,account_id,item_id,name,official_name,mask,type,subtype,current_balance,balance_updated_at,balance_currency_code,lifecycle_status,source_count").eq("household_id",job.household_id);
    if(accountsResult.error)throw new Error("Could not load forecast accounts.");
    const context={userId:"recurring-refresh-worker",householdId:job.household_id};
    const timing:any[]=[];const allResults:any[]=[];let recurringMs=0,historyMs=0,planningMs=0;
    for(const timeZone of timeZones){
      const recurringStarted=performance.now();
      const recurring=await recurringResponse(context,undefined,accountsResult.data??[],{cacheOnly:true,timeZone,allowPreparedRefresh:true});
      recurringMs+=Math.round(performance.now()-recurringStarted);
      await runRolloverBoundary(supabase,job.household_id);
      const historyStarted=performance.now();
      const variableSpend=await buildProjectedVariableSpend(supabase,context,recurring,timeZone);
      historyMs+=Math.round(performance.now()-historyStarted);
      if(recurring.history_generation!==variableSpend.generation)throw new Error("Prepared forecast inputs changed between history reads.");
      const planningStarted=performance.now();
      const results=await Promise.all([30,60,90].map(horizon=>planningResponse(
        context,{horizon_days:horizon,timezone:timeZone},recurring,accountsResult.data??[],
        {cacheOnly:true,queueRefresh:false,precomputedVariableSpend:variableSpend,forceRecompute:true,expectedRefreshJobId:job.job_id,expectedRefreshGeneration:job.requested_generation},
      )));
      planningMs+=Math.round(performance.now()-planningStarted);
      const durabilityStarted=performance.now();
      const durable=await Promise.all(results.map(async(result:any)=>{
        const startDate=result.points?.[0]?.date;
        if(typeof startDate!=="string")return false;
        const saved=await supabase.rpc("finance_get_cached_planning_snapshot",{p_household_id:job.household_id,p_horizon_days:result.horizon_days,p_timezone:timeZone,p_start_date:startDate});
        if(saved.error)throw new Error("Could not verify saved forecast durability.");
        return saved.data?.current_for_forecast===true&&saved.data?.snapshot?.input_quality==="complete";
      }));
      planningMs+=Math.round(performance.now()-durabilityStarted);
      results.forEach((result:any,index:number)=>{result.durable_current=durable[index]===true;});
      allResults.push(...results);
      timing.push({timezone:timeZone,horizons:results.map((result:any)=>({horizon_days:result.horizon_days,ready:result.ready===true,complete:result.complete===true,reliable:result.reliable===true,current:result.current_for_forecast===true,durable:result.durable_current===true}))});
    }
    const complete=timeZones.length>0&&allResults.length===timeZones.length*3&&allResults.every(result=>result.ready===true&&result.complete===true&&result.reliable===true&&result.current_for_forecast===true&&result.durable_current===true);
    const itemsResult=await supabase.from("finance_recurring_refresh_job_items").select("status").eq("job_id",job.job_id);
    if(itemsResult.error)throw new Error("Could not verify forecast source outcomes.");
    const hasTerminalRequiredFailure=(itemsResult.data??[]).some((item:any)=>item.status==="failed");
    const handledPartial=timeZones.length>0&&allResults.length===timeZones.length*3&&allResults.every(result=>typeof result.complete==="boolean"&&typeof result.current_for_forecast==="boolean")&&hasTerminalRequiredFailure;
    ok=complete||handledPartial;completionKind=complete?"complete":handledPartial?"partial":"incomplete";
    console.info("Cash forecast recalculation timing",{household_id:job.household_id,job_id:job.job_id,scope_load_ms:Math.round(performance.now()-scopeStarted),timezones:timeZones.length,recurring_ms:recurringMs,prepared_history_ms:historyMs,planning_horizons_ms:planningMs,total_ms:Math.round(performance.now()-started),result:completionKind,horizons:timing});
  } catch (error) { console.warn("Forecast recalculation deferred", { household_id: job.household_id, phase:"recalculate",ms:Math.round(performance.now()-started), message: error instanceof Error ? error.message : "unknown" }); }
  const result = await supabase.rpc("finance_finish_recurring_recalculation", { p_job_id: job.job_id, p_lease_token: job.lease_token, p_success: ok, p_retry_after_seconds: 90 });
  if (result.error) throw new Error(result.error.message);
  let assistantProjection="not_triggered";
  if(result.data===true&&ok&&completionKind==="complete"){
    try{assistantProjection=await triggerAssistantProjection(job.household_id,job.job_id,job.requested_generation)?"completed":"deferred";}
    catch{assistantProjection="deferred";}
  }
  return { household_id: job.household_id, status: result.data ? (ok ? (completionKind==="complete"?"recomputed":"partial") : "retrying") : "lease_lost", assistant_projection:assistantProjection };
}

/** Trigger one coalesced in-app projection; the existing scheduler tick retries if this handoff is unavailable. */
async function triggerAssistantProjection(householdId:string,jobId:string,generation:number){
 const base=Deno.env.get("SUPABASE_URL")?.replace(/\/$/,""),secret=Deno.env.get("PLAID_MCP_SHARED_SECRET");
 if(!base||!secret||!/^[0-9a-f-]{36}$/i.test(householdId)||!/^[0-9a-f-]{36}$/i.test(jobId)||!Number.isSafeInteger(generation)||generation<1)return false;
 const response=await fetch(`${base}/functions/v1/finance-agent-schedule`,{
  method:"POST",cache:"no-store",signal:AbortSignal.timeout(20_000),
  headers:{"content-type":"application/json","x-plaid-app-secret":secret},
  body:JSON.stringify({operation:"assistant_projection_update",household_id:householdId,source_key:`assistant-refresh:${jobId}:g${generation}`}),
 });
 return response.ok;
}

function providerFailure(data: any, status: number) {
  const code = typeof data?.error_code === "string" ? data.error_code : null;
  return code ? `Plaid ${code}` : `Plaid recurring request returned ${status}`;
}
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array<R>(items.length); let cursor = 0;
  async function run() { while (cursor < items.length) { const index = cursor++; results[index] = await worker(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run)); return results;
}
