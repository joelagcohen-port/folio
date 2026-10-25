import {collectInvestmentHousehold,readInvestmentEstimate} from './investment-collector.ts';
import {folio2ReleaseState,folio2WorkerAllowed} from './release-control.ts';
import {budgetTargetFundingIdentity,projectCashScopeFromFunding,recurringFundingIdentity} from './funding-attribution.ts';
import {recurringSourceTransaction} from './recurring-source.ts';
import {loadRefundActivityEvidence,verifiedRefundActivity} from './refund-activity-evidence.ts';
import { investmentPerformanceReadiness } from "./investment-performance.ts";
import {savingsPlanEditHandlers} from './savings-plan-edit.ts';
import {savingsPlanCreateHandlers} from './savings-plan-create.ts';
import {goalSettingsHandlers} from './goal-reviewed-settings.ts';
import {standaloneGoalPlanHandlers} from './standalone-goals.ts';
import {debtGoalHandlers} from './debt-goals.ts';
import { cachedSavingsForecastResponse as buildCachedSavingsForecastResponse } from './savings-forecast-service.ts';
import { buildSavingsIntelligence } from './savings-intelligence.ts';
import { getSavingsActivityRead } from './savings-read.ts';
import { detectSavingsCandidates, type SavingsTransaction } from './savings-tracking.ts';
import {FORECAST_SERIES_CONTRACT,buildDatedForecast,verifiedDatedSnapshot,compareVerifiedForecasts,addForecastDays} from './forecast-series.ts';
import {cashScopeEvidence} from './cash-scope-evidence.ts';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { resolvePlaidAccessToken } from "../_shared/plaid-access-token.ts";
import { collectOffsetPages, normalizeActivityRows, normalizeHistoryRows, nullableFinite, selectInvestmentAccounts, strictCurrency } from "./investment-read-contract.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { agentEventChangedMaterially, agentEventHiddenForUser, detectFinancialEvents, eventFeedbackFatigueMultiplier, recurringEvidenceIsFresh, recurringExpectedDate, scoreAgentEvent } from "./agent-events.ts";

import { activeAgentMemories, activePermanentCategoryPreferences, compactFinancialState, currentPlanRiskEvents, currentRefundActivity, deliveryChannels, financialDeltas, reconcileEvents, evaluatedPlanIdsForReconciliation, EVENT_TYPES } from "./agent-state.ts";

import { notificationContext, notificationOperation } from "./notification-service.ts";
import { assistantServiceOperation } from "./assistant-service.ts";
import { listAssistantMessages, updateAssistantMessageLifecycle } from "./assistant-storage.ts";
import { routeEvent } from "./delivery-policy.ts";
import { summarizePlanningHistory } from "./planning-history.ts";
import { canonicalForecastScope, forecastFingerprint, forecastScopeMatches, isTrustedForecast } from "./planning-quality.ts";
import { calendarDate, DEFAULT_CALENDAR_TIME_ZONE, resolveCalendarTimeZone } from "./date-context.ts";

import {buildAuthoritativeFinancialState,buildProjectedVariableSpend} from './financial-state.ts';
import {deriveExpectedRecurringAmount,sameCadence} from './recurring-model.ts';
import {loadLifecycleState,applyLifecycleProjection,filterLifecycleOccurrences} from '../lifecycle-projection.ts';
import {reviewRecurringLifecycle,applyRecurringLifecycle} from './recurring-lifecycle-service.ts';
import {excludeNonIncomeInflows} from './state-input.js';
import {evaluateFinancialPlan,planRiskEvent,planInputMaterial,recommendSpendingAdjustments} from './plan-engine.ts';
import {buildPlanScenario} from './plan-scenarios.ts';
import {analyzePlanConflicts,comparePlanSnapshots} from './plan-conflicts.ts';
import {agentActionOperation} from './action-service.ts';
import {getAutonomyState,setAutonomyMode,saveAutonomyPolicy,authorizeAutonomyPolicy,undoAutonomyAction,runAutonomyDryRun} from './autonomy-service.ts';
import {readTransactionCategoryCatalog} from './transaction-category-catalog.ts';
type Row = Record<string, unknown>;
type Context = { userId: string; householdId: string };
type Item = { item_id: string; household_id: string; access_token: string; plaid_environment: string; institution_name: string | null };

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
  "cache-control": "no-store",
};
const planningWorkerKicks=new Map<string,Promise<void>>();

class RequestError extends Error { constructor(message: string, public status = 400) { super(message); } }

export async function handleLiveDataRequest(request: Request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json().catch(() => null);
    if (!record(body)) throw new RequestError("Request body must be a JSON object.");
    const context = await authenticate(request.headers.get("authorization"));
    if (body.household_id !== undefined && body.household_id !== context.householdId) throw new RequestError("Household access denied.", 403);
    const action = string(body.action, "action", 60);

    if (["get_assistant_state","begin_assistant_turn","finish_assistant_turn","mark_assistant_message_read","archive_assistant_history","review_assistant_watch","confirm_assistant_watch","review_assistant_task","confirm_assistant_task","set_assistant_watch_state","review_assistant_watch_state","confirm_assistant_watch_state","review_assistant_commitment","confirm_assistant_commitment","set_assistant_commitment_state","set_assistant_message_lifecycle","save_assistant_memory","list_assistant_memories","record_assistant_decision_receipt","claim_assistant_decision_receipt","list_assistant_tasks","get_assistant_task_status","list_assistant_watches"].includes(action)) {
      try { return json(await assistantServiceOperation(action,body,context,serviceClient(),{loadRecurring:(owner:Context,timeZone:string)=>recurringResponse(owner,undefined,undefined,{cacheOnly:true,timeZone})})); }
      catch(error) { throw new RequestError(error instanceof Error ? error.message : "Assistant request could not be completed.", Number.isInteger((error as any)?.status) ? Number((error as any).status) : 503); }
    }
    if(action==='get_folio2_release_state'){only(body,['action','household_id']);return json(await folio2ReleaseState(serviceClient(),context.householdId,context.userId));}
    if(action==='get_folio2_write_status'){
      only(body,['action','household_id','family','request_key']);
      const result=await serviceClient().rpc('finance_folio2_write_status',{p_household_id:context.householdId,p_actor_user_id:context.userId,p_family:string(body.family,'family',40),p_request_key:string(body.request_key,'request_key',200)});
      if(result.error)throw new RequestError('Saved request status is unavailable.',result.error.code==='42501'?403:400);return json(result.data);
    }

    if (["get_notification_settings","save_notification_settings","save_push_subscription","remove_push_subscription","get_agent_event_detail","claim_agent_notifications","complete_agent_notifications"].includes(action)) return json(await notificationOperation(action,body,context,serviceClient(),()=>listAgentEvents(context)));
    if (["prepare_agent_action","claim_agent_action","finish_agent_action"].includes(action)) {
      try { if(action==="prepare_agent_action"&&body.action_type==="reallocate_budget"&&body.event_id)await refreshAgentState(context);
      return json(await agentActionOperation(serviceClient(),context,action,body)); } catch(error){throw new RequestError(error instanceof Error?error.message:"Action unavailable",409);}
    }
    if(action==="get_autonomy_state"){
      only(body,["action","household_id","period_key"]);
      if(body.period_key!==undefined){const current=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit'}).format(new Date()),valid=typeof body.period_key==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period_key),index=(value:string)=>Number(value.slice(0,4))*12+Number(value.slice(5,7))-1;if(!valid||index(body.period_key)>index(current)||index(current)-index(body.period_key)>35)throw new RequestError('Choose a month from the last 36 months.',400);}
      return json(await getAutonomyState(serviceClient(),context,body.period_key));
    }
    if(action==="transaction_category_catalog"){
      only(body,["action","household_id"]);
      try{return json({household_id:context.householdId,catalog:await readTransactionCategoryCatalog(serviceClient(),context.householdId)});}
      catch(error){throw new RequestError(error instanceof Error?error.message:"The active household transaction categories are unavailable.",503);}
    }
    if(action==="get_budget_category_context"){
      only(body,["action","household_id","month","as_of_date","timezone"]);
      if(typeof body.timezone!=="string"||!body.timezone.trim())throw new RequestError("timezone is required.",400);
      const timezone=resolveRequestTimeZone(body.timezone),today=calendarDate(new Date(),timezone),month=today.slice(0,7);
      if(timezone!=="UTC"||body.month!==month||body.as_of_date!==today)throw new RequestError("Budget context scope is not current. Refresh the category view.",409);
      try{return json(await getBudgetCategoryContext(serviceClient(),context,{month,asOfDate:today,timezone}));}
      catch(error){if(error instanceof RequestError)throw error;throw new RequestError("Current budget context is unavailable.",503);}
    }
    if(action==="review_cash_floor_scope"){
      only(body,["action","household_id","plan_id","expected_version","expected_scope","scope"]);
      const planId=uuid(body.plan_id,"plan_id"),expectedVersion=Number(body.expected_version);
      if(!Number.isInteger(expectedVersion)||expectedVersion<1)throw new RequestError("Refresh the Protect Cash plan before reviewing its account scope.",409);
      if(!Object.prototype.hasOwnProperty.call(body,"expected_scope"))throw new RequestError("Refresh the Protect Cash plan before reviewing its account scope.",409);
      if(!record(body.scope))throw new RequestError("Choose an account scope before reviewing.",400);
      try{const {data,error}=await serviceClient().rpc("finance_review_cash_floor_scope",{p_household_id:context.householdId,p_user_id:context.userId,p_plan_id:planId,p_expected_version:expectedVersion,p_expected_scope:body.expected_scope??null,p_after_scope:body.scope});
        if(error){const code=String(error.code||"");const status=code==="42501"?403:["40001","23505"].includes(code)?409:["22023","22P02"].includes(code)?400:503;throw new RequestError(error.message||"The Protect Cash review could not be loaded.",status);}
        const sameScope=(a:any,b:any)=>{if(a==null||b==null)return a===b;if(a.mode!==b.mode)return false;if(a.mode==="all_cash_accounts")return Object.keys(a).length===1&&Object.keys(b).length===1;if(a.mode!=="selected_accounts"||!Array.isArray(a.canonical_account_ids)||!Array.isArray(b.canonical_account_ids))return false;return [...a.canonical_account_ids].sort().join("|")===[...b.canonical_account_ids].sort().join("|");};
        if(!record(data)||data.household_id!==context.householdId||data.actor_user_id!==context.userId||data.plan_id!==planId||Number(data.expected_version)!==expectedVersion||!sameScope(data.before_scope,body.expected_scope??null)||!sameScope(data.after_scope,body.scope)||typeof data.review_id!=="string"||!Number.isFinite(Number(data.expires_at)))throw new RequestError("The Protect Cash review could not be verified. Refresh Planning and try again.",503);
        return json({review:data});
      }catch(error){if(error instanceof RequestError)throw error;throw new RequestError("The Protect Cash review could not be loaded. Retry the review.",503);}
    }
    if(action==="confirm_cash_floor_scope"){
      only(body,["action","household_id","review_id","idempotency_key","confirm"]);
      if(body.confirm!==true)throw new RequestError("Confirm the Protect Cash account scope before saving.",400);
      const reviewId=uuid(body.review_id,"review_id"),idempotencyKey=uuid(body.idempotency_key,"idempotency_key");
      try{const {data,error}=await serviceClient().rpc("finance_confirm_cash_floor_scope",{p_household_id:context.householdId,p_user_id:context.userId,p_review_id:reviewId,p_idempotency_key:idempotencyKey});
        if(error){const code=String(error.code||"");const status=code==="42501"?403:["40001","23505"].includes(code)?409:["22023","22P02"].includes(code)?400:503;throw new RequestError(error.message||"The Protect Cash save outcome is unknown.",status);}
        const scope=data?.cash_account_scope,scopeValid=record(scope)&&(scope.mode==="all_cash_accounts"?Object.keys(scope).length===1:scope.mode==="selected_accounts"&&Object.keys(scope).length===2&&Array.isArray(scope.canonical_account_ids)&&scope.canonical_account_ids.length>0&&scope.canonical_account_ids.length<=100&&scope.canonical_account_ids.every((id:any)=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))&&new Set(scope.canonical_account_ids).size===scope.canonical_account_ids.length);
        if(data?.saved!==true||data?.household_id!==context.householdId||data?.actor_user_id!==context.userId||typeof data?.plan_id!=="string"||!Number.isSafeInteger(Number(data?.plan_version))||Number(data.plan_version)<2||data?.idempotency_key!==idempotencyKey||!scopeValid)throw new RequestError("The saved account scope could not be verified. Refresh Planning before continuing.",503);
        return json(data);
      }catch(error){if(error instanceof RequestError)throw error;throw new RequestError("The save outcome is unknown. Retry the same confirmation before changing this scope.",503);}
    }
    if(action==="get_cash_forecast_funding"){
      only(body,["action","household_id","plan_id","timezone"]);
      const planId=uuid(body.plan_id,"plan_id"),timezone=resolveRequestTimeZone(body.timezone),today=calendarDate(new Date(),timezone);
      try{return json(await cashForecastFundingRead(context,planId,timezone,today));}
      catch(error){if(error instanceof RequestError)throw error;throw new RequestError("Cash funding choices are unavailable. Refresh and try again.",503);}
    }
    if(action==="review_cash_forecast_funding"){
      only(body,["action","household_id","plan_id","timezone","changes"]);
      const planId=uuid(body.plan_id,"plan_id"),timezone=resolveRequestTimeZone(body.timezone),today=calendarDate(new Date(),timezone);
      if(!Array.isArray(body.changes)||body.changes.length<1||body.changes.length>100)throw new RequestError("Choose at least one funding assignment to review.",400);
      try{
        const current=await cashForecastFundingRead(context,planId,timezone,today),versions=new Map(current.assignments.map((a:any)=>[`${a.assignment_kind}|${a.assignment_key}`,String(a.version)]));
        const identityByKey=new Map<string,string>();for(const s of current.streams)identityByKey.set(`recurring_stream|${s.stream_key}`,recurringFundingIdentity(s));for(const t of current.budget_targets)identityByKey.set(`budget_target|${t.budget_target_id}`,t.identity_fingerprint);
        const changes=body.changes.map((change:any)=>{
          const expected=typeof change?.expected_version==='number'&&Number.isSafeInteger(change.expected_version)&&change.expected_version>=0?String(change.expected_version):typeof change?.expected_version==='string'&&/^(0|[1-9][0-9]*)$/.test(change.expected_version)?change.expected_version:null;
          if(!record(change)||!['recurring_stream','budget_target'].includes(change.assignment_kind)||typeof change.assignment_key!=='string'||expected===null||!record(change.mapping))throw new RequestError("Refresh the funding choices and review again.",409);
          const key=`${change.assignment_kind}|${change.assignment_key}`,identity=identityByKey.get(key),version=versions.get(key)??'0';
          if(!identity||version!==expected)throw new RequestError("The recurring stream or budget target changed. Refresh and review again.",409);
          const target=change.assignment_kind==='budget_target'?current.budget_targets.find((t:any)=>t.budget_target_id===change.assignment_key):null;if(change.assignment_kind==='budget_target'&&(!target?.identity_snapshot||target.identity_fingerprint!==identity))throw new RequestError('The budget target changed. Refresh and review again.',409);
          const stream=change.assignment_kind==='recurring_stream'?current.streams.find((s:any)=>s.stream_key===change.assignment_key):null;
          if(change.assignment_kind==='recurring_stream'&&(!record(stream?.source_guard)||!Array.isArray(stream.source_guard.cache)||!Array.isArray(stream.source_guard.overrides)||!Array.isArray(stream.source_guard.manual)))throw new RequestError('Recurring source evidence is incomplete. Refresh and review again.',409);
          return{assignment_kind:change.assignment_kind,assignment_key:change.assignment_key,expected_version:expected,identity_fingerprint:identity,mapping:change.mapping,plan_id:planId,...(stream?{source_guard:stream.source_guard}:{}),...(target?{identity_snapshot:target.identity_snapshot}:{})};
        });
        const {data,error}=await serviceClient().rpc("finance_review_cash_forecast_funding",{p_household_id:context.householdId,p_user_id:context.userId,p_changes:changes});
        if(error){const code=String(error.code||"");throw new RequestError(error.message||"Funding review unavailable.",code==="42501"?403:["40001","23505"].includes(code)?409:["22023","22P02","23514"].includes(code)?400:503);}
        if(!record(data)||data.household_id!==context.householdId||data.actor_user_id!==context.userId||!Array.isArray(data.changes)||data.changes.length!==changes.length||typeof data.review_id!=="string"||!Number.isFinite(Number(data.expires_at)))throw new RequestError("The funding review could not be verified. Refresh and try again.",503);
        return json({review:data});
      }catch(error){if(error instanceof RequestError)throw error;throw new RequestError("Funding review could not be verified. Retry the review.",503);}
    }
    if(action==="confirm_cash_forecast_funding"){
      only(body,["action","household_id","review_id","idempotency_key","confirm","timezone"]);
      if(body.confirm!==true)throw new RequestError("Confirm the reviewed funding assignments before saving.",400);
      const reviewId=uuid(body.review_id,"review_id"),idempotencyKey=uuid(body.idempotency_key,"idempotency_key"),timezone=resolveRequestTimeZone(body.timezone),today=calendarDate(new Date(),timezone);
      try{
        const db=serviceClient(),stored=await db.rpc('finance_get_cash_forecast_funding_review',{p_household_id:context.householdId,p_user_id:context.userId,p_review_id:reviewId,p_idempotency_key:idempotencyKey});
        if(stored.error){const code=String(stored.error.code||''),status=code==='42501'?403:['22023','22P02'].includes(code)?409:503;throw new RequestError(stored.error.message||'Funding outcome could not be checked. Retry the same confirmation.',status);}if(!record(stored.data))throw new RequestError('Funding outcome could not be verified. Retry the same confirmation.',503);
        if(record(stored.data.receipt)){const receipt=stored.data.receipt;if(receipt.saved===true&&receipt.household_id===context.householdId&&receipt.actor_user_id===context.userId&&receipt.review_id===reviewId&&receipt.idempotency_key===idempotencyKey)return json(receipt);throw new RequestError('Saved funding receipt could not be verified.',503);}
        if(stored.data.household_id!==context.householdId||stored.data.actor_user_id!==context.userId||stored.data.review_id!==reviewId||!Array.isArray(stored.data.changes))throw new RequestError('Funding review expired or unavailable. Refresh and review again.',409);
        const planIds=[...new Set(stored.data.changes.map((x:any)=>x?.after?.plan_id).filter((x:any)=>typeof x==='string'))];if(planIds.length!==1||stored.data.changes.some((x:any)=>x?.after?.plan_id!==planIds[0]))throw new RequestError('Funding review context is invalid. Refresh and review again.',409);
        const current=await cashForecastFundingRead(context,planIds[0],timezone,today),streamByKey=new Map(current.streams.map((s:any)=>[s.stream_key,s])),targetByKey=new Map(current.budget_targets.map((t:any)=>[t.budget_target_id,t]));
        for(const change of stored.data.changes){const after=change?.after;if(!record(after))throw new RequestError('Funding review is invalid. Refresh and review again.',409);if(after.assignment_kind==='recurring_stream'){const stream=streamByKey.get(after.assignment_key);if(!stream||recurringFundingIdentity(stream)!==after.identity_fingerprint)throw new RequestError('A recurring source changed after review. Refresh and review again.',409);}else if(after.assignment_kind==='budget_target'){const target=targetByKey.get(after.assignment_key),snapshotKeys=['budget_target_id','category','subcategory','currency_code','active','category_type','category_active','excluded_from_budget'],sameSnapshot=record(target?.identity_snapshot)&&record(after.identity_snapshot)&&snapshotKeys.every((key:string)=>target.identity_snapshot[key]===after.identity_snapshot[key]);if(!target||target.identity_fingerprint!==after.identity_fingerprint||!sameSnapshot)throw new RequestError('A budget target changed after review. Refresh and review again.',409);}else throw new RequestError('Funding review is invalid. Refresh and review again.',409);}
        const {data,error}=await db.rpc("finance_confirm_cash_forecast_funding",{p_household_id:context.householdId,p_user_id:context.userId,p_review_id:reviewId,p_idempotency_key:idempotencyKey});
        if(error){const code=String(error.code||"");throw new RequestError(error.message||"Funding save outcome is unknown.",code==="42501"?403:["40001","23505"].includes(code)?409:["22023","22P02","23514"].includes(code)?400:503);}
        if(!record(data)||data.saved!==true||data.household_id!==context.householdId||data.actor_user_id!==context.userId||data.review_id!==reviewId||data.idempotency_key!==idempotencyKey||!Array.isArray(data.assignments)||data.assignments.length<1)throw new RequestError("The funding save could not be verified. Retry the same confirmation.",503);
        return json(data);
      }catch(error){if(error instanceof RequestError)throw error;throw new RequestError("Funding save outcome is unknown. Retry the same confirmation.",503);}
    }
    if(action==="snooze_autonomy_suggestion"){only(body,["action","household_id","action_type"]);try{const result=await serviceClient().rpc('snooze_finance_autonomy_suggestion',{p_household_id:context.householdId,p_user_id:context.userId,p_action_type:body.action_type});if(result.error)throw new Error(result.error.message);return json(await getAutonomyState(serviceClient(),context));}catch(error){throw new RequestError(error instanceof Error?error.message:'Suggestion could not be snoozed.',409);}}
    if(action==="set_autonomy_mode"){only(body,["action","household_id","mode","expected_version"]);try{return json(await setAutonomyMode(serviceClient(),context,body.mode,body.expected_version));}catch(error){throw new RequestError(error instanceof Error?error.message:"Could not save how Folio can help",409);}}
    if(action==="save_autonomy_policy"){only(body,["action","household_id","policy","confirm"]);try{return json(await saveAutonomyPolicy(serviceClient(),context,{policy:body.policy,confirm:body.confirm}));}catch(error){throw new RequestError(error instanceof Error?error.message:"Policy save unavailable",409);}}
    if(action==="authorize_autonomy_policy"){only(body,["action","household_id","policy_id","expected_version","confirm"]);try{return json(await authorizeAutonomyPolicy(serviceClient(),context,{policy_id:body.policy_id,expected_version:body.expected_version,confirm:body.confirm}));}catch(error){throw new RequestError(error instanceof Error?error.message:"Automatic action permission unavailable",409);}}
    if(action==="undo_autonomy_action"){only(body,["action","household_id","audit_id"]);try{return json(await undoAutonomyAction(serviceClient(),context,string(body.audit_id,"audit_id",60),{refreshAgentState}));}catch(error){throw new RequestError(error instanceof Error?error.message:"Undo unavailable",409);}}
    if(action==="run_autonomy_dry_run"){only(body,["action","household_id"]);try{return json(await runAutonomyDryRun(serviceClient(),context,{}, {refreshAgentState,loadFinancialState:(c:Context)=>consistentPlanFinancialState(serviceClient(),c),loadMemories:agentMemories}));}catch(error){throw new RequestError(error instanceof Error?error.message:"Dry-run unavailable",409);}}
    if(action==="refresh_agent_state")return json(await refreshAgentState(context));
    if (action === "list_recurring") {
      only(body, ["action", "household_id", "timezone", "horizon_days"]);
      const timezone=resolveRequestTimeZone(body.timezone);
      const horizonDays=body.horizon_days===undefined?30:body.horizon_days;
      if(typeof horizonDays!=="number"||![30,60,90].includes(horizonDays))throw new RequestError("horizon_days must be 30, 60, or 90.");
      const cached=await recurringResponse(context,undefined,undefined,{cacheOnly:true,timeZone:timezone,horizonDays});
      const expectedSources=(cached.coverage?.sources??[]).filter((source:any)=>source.expected===true);
      const hasReusableCache=expectedSources.some((source:any)=>source.cache_reusable===true);
      const source=hasReusableCache||expectedSources.length===0?"cache":"provider";
      const data=source==="cache"?cached:await recurringResponse(context,undefined,undefined,{timeZone:timezone,horizonDays});
      const refreshIds=[...new Set([...(cached.refresh_item_ids??[]),...(data.refresh_item_ids??[])])].filter((id:any)=>typeof id==="string");
      let refreshQueued=false;
      if(refreshIds.length){
        try{const queued=await serviceClient().rpc("finance_enqueue_recurring_refresh",{p_household_id:context.householdId,p_input_revision:"source-cache-v1",p_item_ids:refreshIds});refreshQueued=!queued.error;}
        catch{refreshQueued=false;}
      }
      const freshnessStatus=data.coverage?.complete===true?"fresh":hasReusableCache?"stale":"unavailable";
      return json({...data,timezone,freshness:{status:freshnessStatus,is_fresh:data.coverage?.complete===true,current_for_forecast:data.coverage?.complete===true,source,refresh_queued:refreshQueued}});
    }
    if(action==="review_recurring_lifecycle"){
      only(body,["action","household_id","stream_key","timezone"]);
      if(Deno.env.get("FOLIO2_RECURRING_LIFECYCLE_ENABLED")!=="true")throw new RequestError("Recurring lifecycle actions are unavailable.",404);
      try{return json(await reviewRecurringLifecycle(serviceClient(),context,body,recurringResponse,resolveRequestTimeZone(body.timezone),calendarDate));}
      catch(error){const status=Number((error as any)?.status);throw new RequestError(error instanceof Error?error.message:"Recurring lifecycle review failed.",[400,403,404,409,422,503].includes(status)?status:409);}
    }
    if(action==="apply_recurring_lifecycle"){
      only(body,["action","household_id","stream_key","command","expected_revision","idempotency_key","reviewed_identity_fingerprint","reviewed_schedule_fingerprint","source_token","occurrence_date","undo_event_id","timezone"]);
      if(Deno.env.get("FOLIO2_RECURRING_LIFECYCLE_ENABLED")!=="true")throw new RequestError("Recurring lifecycle actions are unavailable.",404);
      try{return json(await applyRecurringLifecycle(serviceClient(),context,body,recurringResponse,resolveRequestTimeZone(body.timezone),calendarDate));}
      catch(error){const status=Number((error as any)?.status);throw new RequestError(error instanceof Error?error.message:"Recurring lifecycle action failed.",[400,403,404,409,422,503].includes(status)?status:409);}
    }
    if (action === "update_recurring") return json(await updateRecurring(context, body));
    if (action === "save_manual_recurring") return json(await saveManualRecurring(context, body));
    if (action === "deactivate_manual_recurring") return json(await deactivateManualRecurring(context, body));
    if (action === "list_investments") return json(await investmentResponse(context));
    if (action === "list_investment_evidence") {
      // Validate request/source scope before any optional collection side effect.
      const evidence=await investmentEvidenceResponse(context,body);
      const collection=await collectDailyInvestmentEvidence(context);
      const estimated=await readInvestmentEstimate(serviceClient(),context,evidence.account_scope,evidence.activity.requested_start_date,evidence.activity.requested_end_date,new Date(),resolveRequestTimeZone(body.timezone));
      return json({...evidence,performance:investmentPerformanceReadiness(evidence),estimated_performance:estimated,collection});
    }
    if (action === "list_investment_history") return json(await investmentHistoryResponse(context, body));
    if (action === "list_investment_activity") return json(await investmentActivityResponse(context, body));
    if(action === "get_cash_floor_scope_evidence"){
      only(body,["action","household_id","plan_id","timezone"]);
      const planId=uuid(body.plan_id,"plan_id"),timezone=resolveRequestTimeZone(body.timezone),today=calendarDate(new Date(),timezone);
      try{const {data,error}=await serviceClient().rpc("finance_cash_floor_scope_evidence",{p_household_id:context.householdId,p_user_id:context.userId,p_plan_id:planId,p_timezone:timezone,p_start_date:today});
        if(error)throw new RequestError("Cash scope evidence is unavailable.",error.code==="42501"?403:error.code==="22023"?400:503);
        const base=cashScopeEvidence(data,{...context,planId,timezone,today});
        const fullIds=(data.accounts??[]).filter((a:any)=>a.type==='depository'&&a.lifecycle_status==='active').map((a:any)=>a.canonical_account_id).sort();
        if(data.plan?.cash_account_scope?.mode==='selected_accounts'&&base.current.status==='current'&&JSON.stringify([...base.canonical_account_ids].sort())!==JSON.stringify(fullIds)){
          try{const funding=await buildCashScopeFundingProjection(context,data,base,timezone,today);const enriched=cashScopeEvidence(data,{...context,planId,timezone,today},Date.now(),funding.projection);return json({...enriched,funding_attribution:funding.summary});}
          catch(error){return json({...base,funding_attribution:{status:'unavailable',reason:String((error as any)?.message??error??'funding_attribution_unavailable'),unresolved:[],accounts:[],assignments:[]}});}
        }
        return json({...base,funding_attribution:await readCashFundingAssignments(context,data,planId)});
      }catch(error){if(error instanceof RequestError)throw error;throw new RequestError("Cash scope evidence could not be verified.",503);}
    }
    if (action === "get_planning") {
      only(body,["action","household_id","horizon_days","timezone"]);
      const timezone=resolveRequestTimeZone(body.timezone),horizon=[30,60,90].includes(Number(body.horizon_days))?Number(body.horizon_days):30;
      const cached=await cachedPlanningResponse(context,horizon,timezone);
      return json({...cached,household_id:context.householdId,timezone});
    }
    if (action === "get_planning_refresh_status") {
      only(body,["action","household_id","job_id"]);
      const db=serviceClient();let query=db.from("finance_recurring_refresh_jobs").select("job_id,status,needs_recompute,requested_generation,claimed_generation,requested_timezone,updated_at,completed_at").eq("household_id",context.householdId);
      if(body.job_id!==undefined)query=query.eq("job_id",string(body.job_id,"job_id",60));
      const result=await query.order("updated_at",{ascending:false}).limit(1).maybeSingle();if(result.error)throw new Error(result.error.message);
      const job=result.data;
      return json(job?{...job,timezone:job.requested_timezone,current_for_forecast:null}:{job_id:null,status:"missing",needs_recompute:false,requested_generation:0,claimed_generation:0,timezone:null,updated_at:null,completed_at:null,current_for_forecast:null});
    }
    if (action === "get_planning_history") return json(await planningHistoryResponse(context, body));
    if (action === "list_financial_plans") return json(await listFinancialPlans(context));
    if (action === "save_financial_plan") return json(await saveFinancialPlan(context,body));
    if (action === "create_plan_scenario") return json(await createPlanScenario(context,body));
    if (action === "list_plan_scenarios") return json(await listPlanScenarios(context,body));
    if (action === "get_savings_activity") return json(await getSavingsActivity(context,body));
    if (action === "get_savings_overview") return json(await getSavingsOverview(context,body));
    if (action === "save_goal_savings_settings") return json(await saveGoalSavingsSettings(context,body));
    if (action === "review_savings_activity") return json(await reviewSavingsActivity(context,body));
    if (action === "undo_savings_activity_decision") return json(await undoSavingsActivityDecision(context,body));
    if (action === "get_debt_goal_state") return json(await debtGoalHandlers(serviceClient(),RequestError).get(context,body));
    if (action === "review_debt_goal") return json(await debtGoalHandlers(serviceClient(),RequestError).review(context,body));
    if (action === "confirm_debt_goal") return json(await debtGoalHandlers(serviceClient(),RequestError).confirm(context,body));
    if (action === "get_standalone_goal_plan_state") return json(await standaloneGoalPlanHandlers(serviceClient(),RequestError).get_standalone_goal_plan_state(context,body));
    if (action === "review_standalone_goal_plan") return json(await standaloneGoalPlanHandlers(serviceClient(),RequestError).review_standalone_goal_plan(context,body));
    if (action === "confirm_standalone_goal_plan") return json(await standaloneGoalPlanHandlers(serviceClient(),RequestError).confirm_standalone_goal_plan(context,body));
    if (action === "get_savings_goal_plan_state") return json(await savingsPlanEditHandlers(serviceClient(),RequestError).get(context,body));
    if (action === "get_goal_settings_state") return json(await goalSettingsHandlers(serviceClient(),RequestError).get(context,body));
    if (action === "review_goal_savings_settings") return json(await goalSettingsHandlers(serviceClient(),RequestError).review(context,body));
    if (action === "confirm_goal_savings_settings") return json(await goalSettingsHandlers(serviceClient(),RequestError).confirm(context,body));
    if (action === "review_savings_goal_plan_creation") return json(await savingsPlanCreateHandlers(serviceClient(),RequestError).review(context,body));
    if (action === "confirm_savings_goal_plan_creation") return json(await savingsPlanCreateHandlers(serviceClient(),RequestError).confirm(context,body));
    if (action === "review_savings_goal_plan_edit") return json(await savingsPlanEditHandlers(serviceClient(),RequestError).review(context,body));
    if (action === "confirm_savings_goal_plan_edit") return json(await savingsPlanEditHandlers(serviceClient(),RequestError).confirm(context,body));
    if (action === "save_goal") return json(await saveGoal(context, body));
    if (action === "deactivate_goal") return json(await deactivateGoal(context, body));
    if (action === "evaluate_agent_events") { only(body, ["action", "household_id", "state"]); return json(await evaluateAgentEvents(context, body.state)); }
    if (action === "get_agent_state") { only(body, ["action", "household_id", "mark_seen", "state_version"]); return json(await getAgentState(context, body.mark_seen === true, typeof body.state_version==="string"?body.state_version:null)); }
    if (action === "save_agent_memory") return json(await saveAgentMemory(context, body));
    if (action === "list_agent_events") { only(body, ["action", "household_id"]); return json(await listAgentEvents(context)); }
    if (action === "list_agent_event_history") { only(body, ["action", "household_id"]); return json(await listAgentEventHistory(context)); }
    if (action === "restore_agent_event") { only(body, ["action", "household_id", "event_id", "event_version"]); return json(await restoreAgentEvent(context, body)); }
    if (action === "feedback_agent_event") { only(body, ["action", "household_id", "event_id", "feedback", "snooze_days"]); return json(await feedbackAgentEvent(context, body)); }
    if (action === "apply_agent_event_disposition") { only(body, ["action", "household_id", "event_id", "event_version", "expected_disposition", "expected_state_updated_at", "disposition", "snooze_days", "idempotency_key"]); return json(await applyAgentEventDisposition(context, body)); }
    if (action === "restore_agent_event_v2") { only(body, ["action", "household_id", "event_id", "event_version", "expected_disposition", "expected_state_updated_at", "idempotency_key"]); return json(await restoreAgentEventV2(context, body)); }
    throw new RequestError("Unknown action.");
  } catch (error) {
    console.error("Finance live data request failed", error instanceof Error ? error.message : error);
    return json({ error: error instanceof RequestError ? error.message : "The finance data request could not be completed." }, error instanceof RequestError ? error.status : 500);
  }
}

async function cachedPlanningResponse(context:Context,horizon:number,timezone:string){
  const started=performance.now(),today=calendarDate(new Date(),timezone),db=serviceClient();
  let result:any;
  try{result=await db.rpc("finance_get_cached_planning_snapshot",{p_household_id:context.householdId,p_horizon_days:horizon,p_timezone:timezone,p_start_date:today});}
  catch(error){console.warn("Saved forecast lookup failed",{phase:"saved_lookup",ms:Math.round(performance.now()-started),reason:"rpc_unavailable"});return unavailablePlanningResult(horizon,"The saved cash forecast could not be checked. Try again shortly.");}
  if(result.error){console.warn("Saved forecast lookup failed",{phase:"saved_lookup",ms:Math.round(performance.now()-started),reason:"rpc_unavailable"});return unavailablePlanningResult(horizon,"The saved cash forecast could not be checked. Try again shortly.");}
  const payload=result.data&&typeof result.data==="object"?result.data:{};
  let snapshot=payload.snapshot&&typeof payload.snapshot==="object"?payload.snapshot:null;
  const current=payload.current_for_forecast===true&&snapshot?.household_id===context.householdId&&verifiedDatedSnapshot(snapshot)!==null,refresh=normalizePlanningRefresh(payload.refresh);
  console.info("Cash forecast read timing",{phase:"saved_lookup",ms:Math.round(performance.now()-started),saved:!!snapshot,current});
  if(!current){
    const active=(refresh.status==="queued"||refresh.status==="running")&&refresh.timezone===timezone;
    const recentTerminal=!active&&refresh.timezone===timezone&&!!refresh.updated_at&&Date.now()-Date.parse(refresh.updated_at)<5*60*1000&&["partial","failed"].includes(refresh.status);
    if(!active&&!recentTerminal){
      try{
        const queued=await db.rpc("finance_enqueue_planning_refresh",{p_household_id:context.householdId,p_timezone:timezone,p_start_date:today});
        if(!queued.error&&queued.data){
          const q=queued.data,jobId=typeof q.job_id==="string"?q.job_id:null;
          Object.assign(refresh,{job_id:jobId,status:"queued",needs_recompute:true,requested_generation:q.requested_generation??refresh.requested_generation,updated_at:new Date().toISOString()});
          if(jobId)kickPlanningWorker(jobId);
        }
      }catch(error){console.warn("Forecast refresh could not be queued",{phase:"refresh_enqueue",reason:"queue_unavailable"});}
    }else if(refresh.job_id){kickPlanningWorker(refresh.job_id);}
  }
  if(!snapshot)return unavailablePlanningResult(horizon,refresh.status==="queued"||refresh.status==="running"?"A current cash forecast is being prepared from saved household data.":"No verified cash forecast is available yet.",{refresh,goals:payload.goals??[],audit:payload.audit??[],scope_changed:payload.scope_changed===true});
  const inputs=snapshot.source_provenance?.forecast_inputs??{},points=Array.isArray(snapshot.points)?snapshot.points:[],events=Array.isArray(snapshot.events)?snapshot.events:[];
  const savedGenerated=snapshot.generated_at??snapshot.request_started_at??null;
  const sourceProvenance=snapshot.source_provenance?.sources??snapshot.coverage?.sources??[];
  const cashScopeStates=Array.isArray(inputs.cash_scope_source_states)?inputs.cash_scope_source_states:[];
  const cashScopeIds=cashScopeStates.map((item:any)=>String(item?.canonical_account_id||'')).filter((id:string)=>/^[0-9a-f-]{36}$/i.test(id)).sort();
  const accountScopeKey=cashScopeIds.length?await digestAgent(JSON.stringify(cashScopeIds)):null;
  const latestBalanceDate=Array.isArray(snapshot.account_states)?snapshot.account_states.map((a:any)=>a.balance_updated_at).filter(Boolean).sort()[0]??null:null;
  const comparison=await verifiedForecastComparison(db,context,snapshot);
  const forecast={
    series_contract:inputs.series_contract??null,forecast_comparison:comparison,low_date:verifiedDatedSnapshot(snapshot)?.low_date??null,
    ready:points.length>0,state:current?(refresh.needs_recompute?"updating":"current"):(refresh.status==="queued"||refresh.status==="running"?"updating":"last_verified"),verified_at:current?new Date().toISOString():null,
    complete:current,reliable:current,current_for_forecast:current,stale:!current,generated_at:savedGenerated,
    request_started_at:snapshot.request_started_at??null,attempted_at:current?undefined:new Date().toISOString(),horizon_days:snapshot.horizon_days??horizon,
    input_revision:snapshot.input_revision??null,source_revision:snapshot.source_provenance?.source_revision??snapshot.input_revision??null,
    account_scope_key:accountScopeKey,cash_scope_currency:inputs.cash_scope_currency??null,
    cash_scope_currency_verified:inputs.cash_scope_currency_verified===true,source_as_of:latestBalanceDate,source_provenance:sourceProvenance,
    starting_balance:snapshot.starting_balance,projected_low:snapshot.projected_low,
    projected_high:Math.max(...points.map((p:any)=>Number(p.balance)).filter(Number.isFinite),Number(snapshot.starting_balance)||0),
    ending_balance:snapshot.ending_balance,points,events,variable_spend:inputs.variable_spend??null,
    economic_changes:inputs.economic_changes??[],goals:payload.goals??[],audit:payload.audit??[],last_verified:current?null:{generated_at:savedGenerated,horizon_days:snapshot.horizon_days??horizon,start_date:points[0]?.date??null,end_date:points.at(-1)?.date??null,input_revision:snapshot.input_revision??null,source_provenance:sourceProvenance,starting_balance:snapshot.starting_balance,projected_low:snapshot.projected_low,projected_high:Math.max(...points.map((p:any)=>Number(p.balance)).filter(Number.isFinite),Number(snapshot.starting_balance)||0),ending_balance:snapshot.ending_balance,points,events,variable_spend:inputs.variable_spend??null},
    warnings:current?[]:["The saved cash forecast may not reflect the latest household inputs. Folio is refreshing it."],
    forecast_changes:snapshot.change_summary??[],coverage:{...(snapshot.coverage??{}),complete:current,stale:!current},refresh
  };
  return forecast;
}

function unavailablePlanningResult(horizon:number,warning:string,extra:any={}){
  return {ready:false,state:extra.refresh?.status==="queued"||extra.refresh?.status==="running"?"updating":"unavailable",complete:false,reliable:false,current_for_forecast:false,verified_at:null,stale:false,generated_at:new Date().toISOString(),horizon_days:horizon,input_revision:null,source_provenance:[],starting_balance:null,projected_low:null,projected_high:null,ending_balance:null,points:[],events:[],variable_spend:{status:"unavailable",amount:null,categories:[],revision:null},economic_changes:[],goals:extra.goals??[],audit:extra.audit??[],last_verified:null,warnings:[warning],coverage:{complete:false,stale:false,scope_changed:extra.scope_changed===true},refresh:extra.refresh??normalizePlanningRefresh(null)};
}

function normalizePlanningRefresh(value:any){
  const known=["idle","queued","running","retrying","succeeded","partial","failed"];
  const status=known.includes(value?.status)?value.status:"idle";
  return {job_id:typeof value?.job_id==="string"?value.job_id:null,status,needs_recompute:value?.needs_recompute===true,requested_generation:Number(value?.requested_generation)||0,claimed_generation:Number(value?.claimed_generation)||0,updated_at:typeof value?.updated_at==="string"?value.updated_at:null,completed_at:typeof value?.completed_at==="string"?value.completed_at:null,timezone:typeof value?.timezone==="string"?value.timezone:null};
}

function kickPlanningWorker(jobId:string){
  if(planningWorkerKicks.has(jobId))return;
  const task=(async()=>{
    const base=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("PLAID_MCP_SHARED_SECRET");
    if(!base||!secret)return;
    const response=await fetch(`${base.replace(/\/+$/,"")}/functions/v1/finance-recurring-refresh`,{method:"POST",headers:{"content-type":"application/json","x-plaid-app-secret":secret},body:"{}"});
    if(!response.ok)console.warn("Immediate forecast worker kick was rejected",{phase:"worker_kick",status:response.status});
  })().catch(()=>console.warn("Immediate forecast worker kick failed",{phase:"worker_kick",reason:"request_failed"})).finally(()=>planningWorkerKicks.delete(jobId));
  planningWorkerKicks.set(jobId,task);
  const runtime=(globalThis as any).EdgeRuntime;
  if(runtime&&typeof runtime.waitUntil==="function")runtime.waitUntil(task);
}

export async function recurringResponse(context: Context, knownSnapshot?: any, suppliedAccounts?: any[] | Promise<any[]>, options: { cacheOnly?: boolean; timeZone?: string;allowPreparedRefresh?:boolean; horizonDays?: 30|60|90; lifecycleHorizonDays?: number } = {}) {
  const timeZone=options.timeZone??DEFAULT_CALENDAR_TIME_ZONE;
  const db = serviceClient();
  const [connectedItems, allItemsResult, accountRows, overrideRows, manualRows, sourceCacheResult] = await Promise.all([
    options.cacheOnly ? Promise.resolve([] as Item[]) : householdItems(db, context.householdId),
    db.from("plaid_items").select("item_id,institution_name,connection_status,connection_error_code").eq("household_id", context.householdId),
    suppliedAccounts ? Promise.resolve(suppliedAccounts) : householdAccounts(db, context.householdId),
    db.from("finance_recurring_overrides").select("stream_key,plaid_stream_id,canonical_account_id,flow_type,currency_code,transaction_ids,amount_override,frequency_override,next_date_override,category_override,recurring_kind_override,match_text_override,include_in_forecast,active,override_not_recurring,updated_at").eq("household_id", context.householdId),
    db.from("finance_manual_recurring_streams").select("manual_stream_id,name,amount,frequency,next_date,account_id,source_transaction_id,plaid_stream_id,plaid_stream_key,match_text,category_name,flow_type,currency_code,recurring_kind_override,include_in_forecast,active,updated_at").eq("household_id", context.householdId),
    options.cacheOnly ? db.from("finance_recurring_item_cache").select("item_id,schema_version,source_account_ids,streams,coverage,fetched_at").eq("household_id", context.householdId) : Promise.resolve({ data: [], error: null }),
  ]);
  if (allItemsResult.error || overrideRows.error || manualRows.error || sourceCacheResult.error) throw new Error(allItemsResult.error?.message ?? overrideRows.error?.message ?? manualRows.error?.message ?? sourceCacheResult.error?.message);
  const accountMap = new Map(accountRows.map((row: any) => [row.account_id, row]));
  const overrides = new Map((overrideRows.data ?? []).map((row: any) => [row.stream_key, row]));
  const cachedByItem=new Map((sourceCacheResult.data??[]).map((row:any)=>[row.item_id,row]));
  // Recurring data is only one input to a forecast. Keep its provider work
  // inside a strict budget so there is time left for database reads and the
  // forecast response before the Edge caller deadline.
  const items: any[]=options.cacheOnly?(allItemsResult.data??[]):connectedItems;
  const eligibleItems = items.filter(item => accountRows.some((account:any) => account.item_id === item.item_id && account.lifecycle_status !== "closed" && ["depository", "credit"].includes(String(account.type).toLowerCase())) || (knownSnapshot?.stream_states ?? []).some((stream:any) => accountRows.some((account:any) => account.item_id === item.item_id && account.account_id === stream.account_id)));
  const providerDeadline = Date.now() + 3500;
  const calls = options.cacheOnly ? eligibleItems.map((item:any)=>{
    const cached:any=cachedByItem.get(item.item_id),age=cached?.fetched_at?Date.now()-Date.parse(cached.fetched_at):Infinity;
    const expectedIds=accountRows.filter((a:any)=>a.item_id===item.item_id&&a.lifecycle_status!=="closed"&&["depository","credit"].includes(String(a.type).toLowerCase())).map((a:any)=>a.account_id).sort();
    const cachedIds=Array.isArray(cached?.source_account_ids)?[...cached.source_account_ids].sort():[];
    const valid=cached?.schema_version===1&&Number.isFinite(age)&&age>=0&&age<=24*60*60*1000&&JSON.stringify(expectedIds)===JSON.stringify(cachedIds);
    const reusable=cached?.schema_version===1&&Number.isFinite(age)&&age>=0&&age<=48*60*60*1000&&JSON.stringify(expectedIds)===JSON.stringify(cachedIds);
    return reusable?{ok:valid,data:cached.streams,cacheFetchedAt:cached.fetched_at,cacheCoverage:cached.coverage,cacheReusable:true,refreshDue:!Number.isFinite(age)||age>6*60*60*1000}:{ok:false,data:{},cacheFetchedAt:cached?.fetched_at,cacheReusable:false,refreshDue:true};
  }):await mapLimit(eligibleItems, 5, async item => {
    const result=await plaid(item, "/transactions/recurring/get", { access_token: item.access_token }, providerDeadline).catch(() => ({ ok: false, data: {}, timed_out: Date.now() >= providerDeadline }));
    const validated=result?.ok===true&&!result.data?.error_code&&Array.isArray(result.data?.inflow_streams)&&Array.isArray(result.data?.outflow_streams);
    return validated?{...result,cacheFetchedAt:new Date().toISOString()}:result;
  });
  const warnings: string[] = [];
  const sourceCoverage = (allItemsResult.data ?? []).map((item:any) => {
    const linked = accountRows.filter((account: any) => account.item_id === item.item_id && account.lifecycle_status !== "closed");
    const connectedIndex=eligibleItems.findIndex((candidate:any)=>candidate.item_id===item.item_id),result=connectedIndex>=0?calls[connectedIndex]:null;
    const knownStream = (knownSnapshot?.stream_states ?? []).some((stream:any) => linked.some((account:any)=>account.account_id===stream.account_id));
    // Only the currently selected canonical source contributes expected coverage.
    // A retired duplicate source may remain connected in Plaid, but once the
    // household mapping selects its successor it must not block that source's forecast.
    const expected = linked.some((account: any) => ["depository", "credit"].includes(String(account.type).toLowerCase())) || knownStream;
    const code = String(result?.data?.error_code ?? "");
    const ok=result?.ok===true&&!result.data?.error_code&&Array.isArray(result.data?.inflow_streams)&&Array.isArray(result.data?.outflow_streams);
    return { item_id: item.item_id, institution_name:item.institution_name??"Institution", connection_status:item.connection_status, fetched_at:result?.cacheFetchedAt??null, cache_reusable:result?.cacheReusable===true, refresh_due:result?.refreshDue===true&&item.connection_status==="connected"&&expected, account_ids: linked.map((account: any) => account.account_id), status: ok ? "success" : expected ? "failed" : "not_applicable", reason: ok ? null : code === "PRODUCTS_NOT_SUPPORTED" && expected ? "products_not_supported" : item.connection_status !== "connected" ? "connection_unavailable" : options.cacheOnly?"cached_source_unavailable":"provider_unavailable", provider_code:["PRODUCTS_NOT_SUPPORTED","PRODUCT_NOT_READY","ITEM_LOGIN_REQUIRED","RATE_LIMIT_EXCEEDED"].includes(code)?code:null, expected };
  });
  let coverageComplete = sourceCoverage.every((source: any) => source.status !== "failed");
  const deduped = new Map<string, any>();
  calls.forEach((result, index) => {
    const item = eligibleItems[index];
    const source=sourceCoverage.find((entry:any)=>entry.item_id===item.item_id);
    if (!source || source.status !== "success") { if (source?.status === "failed") warnings.push(`${item.institution_name ?? "Institution"}: recurring data unavailable`); if(!options.cacheOnly||!Array.isArray(result?.data?.inflow_streams)||!Array.isArray(result?.data?.outflow_streams))return; }
    for (const [flow, streams] of [["inflow", result.data.inflow_streams ?? []], ["outflow", result.data.outflow_streams ?? []]] as const) {
      for (const stream of streams) {
        const account = accountMap.get(stream.account_id) as any;
        if (!account) continue;
        const rawLastAmount = amountValue(stream.last_amount);
        const rawAverageAmount = amountValue(stream.average_amount);
        const amount = rawLastAmount===null||rawLastAmount===0?null:Math.abs(rawLastAmount);
        const average = rawAverageAmount===null||rawAverageAmount===0?null:Math.abs(rawAverageAmount);
        const streamKey = recurringKey(item, account, flow, stream);
        const sourceCurrency=stream.last_amount?.iso_currency_code??stream.average_amount?.iso_currency_code??null;
        const streamIdentity={canonical_account_id:account.canonical_account_id??stream.account_id,flow_type:flow,currency_code:sourceCurrency??"USD",transaction_ids:Array.isArray(stream.transaction_ids)?stream.transaction_ids:[]};
        const override = findRecurringOverride(overrideRows.data??[],streamKey,stream.stream_id,streamIdentity);
        const row = {
          stream_key: override?.stream_key ?? streamKey,
          stream_id: stream.stream_id ?? null,
          account_id: stream.account_id,
          canonical_account_id: account.canonical_account_id ?? stream.account_id,
          account_name: account.name ?? account.official_name ?? "Account",
          account_mask: account.mask ?? null,
          institution_name: item.institution_name ?? "Institution",
          flow_type: flow,
          description: stream.description ?? stream.merchant_name ?? "Recurring activity",
          merchant_name: stream.merchant_name ?? null,
          match_text: override?.match_text_override ?? stream.merchant_name ?? stream.description ?? "",
          first_date: stream.first_date ?? null,
          last_date: stream.last_date ?? null,
          predicted_next_date: override?.next_date_override ?? stream.predicted_next_date ?? null,
          next_date_override: override?.next_date_override ?? null,
          frequency: override?.frequency_override ?? stream.frequency ?? null,
          frequency_override:override?.frequency_override??null,
          average_amount: average,
          last_amount: amount,
          plaid_average_amount: rawAverageAmount,
          plaid_last_amount: rawLastAmount,
          expected_amount: override?.amount_override!=null?Math.abs(finite(override.amount_override)):amount??average,
          expected_amount_source: override?.amount_override != null ? "user" : amount!==null ? "last" : average!==null?"average":"unknown",
          amount_override: override?.amount_override ?? null,
          category_override: override?.category_override ?? null,
          recurring_kind_override:override?.recurring_kind_override??null,
          override_not_recurring: override?.override_not_recurring === true,
          override_updated_at: override?.updated_at ?? null,
          currency_code: stream.last_amount?.iso_currency_code ?? stream.average_amount?.iso_currency_code ?? "USD",
          source_currency_verified:typeof sourceCurrency==='string'&&/^[A-Z]{3}$/.test(sourceCurrency)&&(!override?.currency_code||override.currency_code===sourceCurrency),
          active_override:override?.active??null,
          is_active: override?.override_not_recurring === true ? false : (override?.active ?? stream.is_active ?? true),
          include_in_forecast: override?.include_in_forecast ?? true,
          include_in_forecast_override:override?.include_in_forecast??null,
          status: stream.status ?? null,
          transaction_ids: Array.isArray(stream.transaction_ids) ? stream.transaction_ids : [],
          personal_finance_category_primary: stream.personal_finance_category?.primary ?? null,
          personal_finance_category_detailed: stream.personal_finance_category?.detailed ?? null,
          confidence: stream.personal_finance_category?.confidence_level ?? null,
          source_type: "plaid",
          source_stream_keys: [`plaid:${item.item_id}:${stream.stream_id??streamKey}`],
          source_guard:{cache:[{item_id:item.item_id,fetched_at:cachedByItem.get(item.item_id)?.fetched_at??null}],overrides:[{stream_key:override?.stream_key??streamKey,updated_at:override?.updated_at??null}],manual:[]},
        };
        const canonical=normalize(account.canonical_account_id ?? account.account_id);
        const priorEntry=[...deduped.entries()].find(([,prior])=>normalize(prior.canonical_account_id??prior.account_id)===canonical&&prior.flow_type===flow&&prior.currency_code===row.currency_code&&(row.stream_id&&prior.stream_id===row.stream_id||row.transaction_ids.some((id:string)=>prior.transaction_ids.includes(id))));
        if (!priorEntry) deduped.set(streamKey,row);
        else {
          const [priorKey,prior]=priorEntry,winner=String(row.last_date??"")>String(prior.last_date??"")?row:prior,priorOverride=Date.parse(prior.override_updated_at??"")||0,rowOverride=Date.parse(row.override_updated_at??"")||0,choice=rowOverride>priorOverride?row:prior;
          deduped.set(priorKey,{...winner,stream_key:prior.stream_key,source_stream_keys:[...new Set([...(prior.source_stream_keys??[`plaid:${item.item_id}:${prior.stream_id??prior.stream_key}`]),...(row.source_stream_keys??[`plaid:${item.item_id}:${row.stream_id??row.stream_key}`])])],source_guard:{cache:[...new Map([...(prior.source_guard?.cache??[]),...(row.source_guard?.cache??[])].map((x:any)=>[x.item_id,x])).values()],overrides:[...new Map([...(prior.source_guard?.overrides??[]),...(row.source_guard?.overrides??[])].map((x:any)=>[x.stream_key,x])).values()],manual:[...new Map([...(prior.source_guard?.manual??[]),...(row.source_guard?.manual??[])].map((x:any)=>[x.manual_stream_id,x])).values()]},transaction_ids:[...new Set([...(prior.transaction_ids??[]),...(row.transaction_ids??[])])],amount_override:choice.amount_override,frequency:choice.frequency_override??winner.frequency,frequency_override:choice.frequency_override??null,predicted_next_date:choice.next_date_override??winner.predicted_next_date,next_date_override:choice.next_date_override,category_override:choice.category_override,recurring_kind_override:choice.recurring_kind_override??null,match_text:choice.match_text_override??winner.match_text,include_in_forecast:choice.include_in_forecast_override??winner.include_in_forecast,include_in_forecast_override:choice.include_in_forecast_override,is_active:choice.override_not_recurring?false:(choice.active_override??winner.is_active),active_override:choice.active_override,override_not_recurring:choice.override_not_recurring,override_updated_at:choice.override_updated_at,expected_amount:choice.amount_override??winner.expected_amount,expected_amount_source:choice.amount_override!=null?"user":winner.expected_amount_source});
        }
      }
    }
  });
  const plaidStreams = [...deduped.values()];
  // Plaid transaction IDs are the strongest available linkage. Use only the
  // latest six linked, canonical transactions and the median to resist stale
  // averages and one-off amount noise.
  const linkedIds = [...new Set(plaidStreams.flatMap(stream => stream.transaction_ids).filter((id: unknown): id is string => typeof id === "string" && id.length > 0))];
  const manualHistoryRows=(manualRows.data??[]).filter((row:any)=>row.account_id&&(row.active===true||row.source_transaction_id||row.plaid_stream_id));
  const manualAccountIds=[...new Set(manualHistoryRows.map((row:any)=>row.account_id))];
  const localToday=calendarDate(new Date(),timeZone),manualStart=new Date(`${localToday}T00:00:00Z`);manualStart.setUTCDate(manualStart.getUTCDate()-400);
  const pendingStart=new Date(`${localToday}T00:00:00Z`);pendingStart.setUTCDate(pendingStart.getUTCDate()-14);
  let sharedHistory:any=null,sharedHistoryError:unknown=null;
  try{
    const result=await db.rpc("finance_get_recurring_history",{p_household_id:context.householdId,p_linked_transaction_ids:linkedIds,p_manual_account_ids:manualAccountIds,p_manual_start_date:manualStart.toISOString().slice(0,10),p_end_date:localToday,p_pending_start_date:pendingStart.toISOString().slice(0,10),p_linked_limit:20000,p_manual_limit:800,p_pending_limit:200,p_refresh_if_needed:options.allowPreparedRefresh===true});
    if(result.error)throw new Error("Prepared recurring transaction history is unavailable.");
    const value=result.data;
    if(!value||typeof value!=="object"||value.stale===true||value.fresh!==true||!Array.isArray(value.linked_transactions)||!Array.isArray(value.manual_transactions)||!Array.isArray(value.pending_transactions))throw new Error("Prepared recurring transaction history is stale or incomplete.");
    if(value.linked_transactions.length!==Number(value.linked_count)||value.linked_transactions.length>20000)throw new Error("Prepared linked recurring history count is invalid.");
    if(value.manual_transactions.length!==Math.min(Number(value.manual_count),800)||value.pending_transactions.length!==Math.min(Number(value.pending_count),200))throw new Error("Prepared recurring history counts are invalid.");
    sharedHistory=value;
  }catch(error){sharedHistoryError=error;console.warn("Prepared recurring history is unavailable.",{reason:preparedHistoryFailureCode(error)});}
  const linkedTransactions = new Map<string, any[]>();
  const linkedCanonicalRows:any[]=sharedHistory?.linked_transactions??[];
  let linkedHistoryComplete=!!sharedHistory,linkedHistoryGeneration:number|null=sharedHistory?Number(sharedHistory.generation):null;
  if(!linkedHistoryComplete&&linkedIds.length)warnings.push("Complete linked recurring transaction history is unavailable; prior amount and date estimates were retained.");
  if (linkedHistoryComplete) {
    for (const tx of linkedCanonicalRows) {
      if (tx.pending || tx.excluded_from_totals) continue;
      const stream = plaidStreams.find(candidate => candidate.transaction_ids.includes(tx.transaction_id));
      if (!stream) continue;
      // Transfer-category occurrences are kept out of obligations. Card
      // repayments remain distinguishable and can still affect cash flow.
      const txCategory=normalize(tx.effective_category),isCardPayment=/credit-card-payment|card-payment|card-repayment/.test(txCategory),txType=String(tx.effective_type??"").toLowerCase();
      if(tx.account_id!==stream.account_id || tx.iso_currency_code && stream.currency_code && tx.iso_currency_code!==stream.currency_code) continue;
      if((stream.flow_type==="outflow"&&Number(tx.amount)<=0)||(stream.flow_type==="inflow"&&Number(tx.amount)>=0))continue;
      if(txType==="transfer"){
        if(isCardPayment)stream._card_payment_evidence=true;
        else stream._transfer_evidence=true;
        if(isCardPayment){const rows=linkedTransactions.get(stream.stream_key)??[];rows.push(tx);linkedTransactions.set(stream.stream_key,rows);}
        continue;
      }
      if(stream.flow_type==="inflow"&&txType==="income")stream._income_evidence=true;
      else if(stream.flow_type==="outflow"&&txType==="expense")stream._expense_evidence=true;
      else continue;
      const rows = linkedTransactions.get(stream.stream_key) ?? [];
      rows.push(tx); linkedTransactions.set(stream.stream_key, rows);
    }
  }
  if(!linkedHistoryComplete){
    const priorByKey=new Map((knownSnapshot?.stream_states??[]).map((s:any)=>[s.key,s]));
    for(const stream of plaidStreams){const prior:any=priorByKey.get(stream.stream_key);if(!prior)continue;stream.expected_amount=prior.amount;stream.predicted_next_date=prior.next_date;if(prior.active===true){stream.is_active=true;stream.include_in_forecast=true;stream.primary_eligible=true;stream.recurring_kind=prior.kind==="internal-transfer"?"internal_transfer":prior.kind==="repayment"?"credit_card_repayment":prior.kind==="needs-review"?"needs_review":prior.kind;}}
  }
  for (const stream of plaidStreams) {
    const recent = (linkedTransactions.get(stream.stream_key) ?? []).slice(0, 3).map(row => Math.abs(Number(row.amount))).filter(Number.isFinite);
    if(linkedHistoryComplete){const derived=deriveExpectedRecurringAmount({override:stream.amount_override,recentAmounts:recent,lastAmount:stream.last_amount,averageAmount:stream.average_amount});stream.expected_amount=derived.amount;stream.expected_amount_source=derived.source;}
    const providerTransferHint=/^transfer/.test(String(stream.personal_finance_category_primary??"").toLowerCase())||/^transfer/.test(String(stream.personal_finance_category_detailed??"").toLowerCase()),reviewReasons:string[]=[];
    let kind:string;
    if(stream._card_payment_evidence)kind="credit_card_repayment";
    else if(stream._transfer_evidence&&!stream._income_evidence&&!stream._expense_evidence)kind="internal_transfer";
    else if(stream.flow_type==="inflow"){if(providerTransferHint&&!stream._income_evidence){kind="needs_review";reviewReasons.push("provider_transfer_label_unconfirmed");}else kind="income";}
    else if(stream._expense_evidence)kind=["services","general_services","entertainment"].includes(normalize(stream.personal_finance_category_primary))?"subscription":"expense";
    else if(stream._transfer_evidence||providerTransferHint)kind="needs_review";
    else kind=["services","general_services","entertainment"].includes(normalize(stream.personal_finance_category_primary))?"subscription":"expense";
    // A confirmed repayment remains a repayment. Otherwise an explicit Folio
    // classification wins over later provider labels without changing flow.
    if(stream.recurring_kind_override&&kind!=="credit_card_repayment"){
      kind=stream.recurring_kind_override;
      if(kind!=="needs_review")reviewReasons.splice(0,reviewReasons.length,...reviewReasons.filter(reason=>reason!=="provider_transfer_label_unconfirmed"));
    }
    if(!isSupportedRecurringFrequency(stream.frequency)){kind="needs_review";reviewReasons.push("cadence_unavailable");}
    if(stream.expected_amount===null){kind="needs_review";reviewReasons.push("amount_unavailable");}
    if(stream.override_not_recurring)reviewReasons.push("user_marked_not_recurring");
    if(kind==="internal_transfer"){stream.transfer_excluded=true;stream.include_in_forecast=false;stream.category_override=null;}
    if(kind==="internal_transfer")stream.include_in_forecast=false;stream.recurring_kind=kind;stream.review_reasons=reviewReasons;stream.primary_eligible=stream.is_active===true&&kind!=="needs_review"&&kind!=="internal_transfer"&&stream.expected_amount!==null&&stream.expected_amount>0;stream.display_status=stream.override_not_recurring?"not_recurring":kind==="internal_transfer"?"transfer":kind==="needs_review"?"needs_review":"active";
    delete stream._card_payment_evidence;delete stream._transfer_evidence;delete stream._income_evidence;delete stream._expense_evidence;
    const observedRows=linkedTransactions.get(stream.stream_key)??[],latestObserved=observedRows[0]?.effective_transaction_date??stream.last_date;
    stream.latest_observed_date=latestObserved;
    if(linkedHistoryComplete&&stream.next_date_override==null&&latestObserved&&isSupportedRecurringFrequency(stream.frequency))stream.predicted_next_date=stream.predicted_next_date?preferObservedNextDate(latestObserved,stream.frequency,stream.predicted_next_date,timeZone):deriveNextDate(latestObserved,stream.frequency,timeZone);
  }
  // A provider's recurring-income stream can contain a refund or generic
  // credit. That makes it historical cash flow, not expected earned income.
  const recurringTransactionIds = [...new Set(plaidStreams.filter(stream => stream.flow_type === "inflow").flatMap(stream => Array.isArray(stream.transaction_ids) ? stream.transaction_ids : []).filter((id: unknown): id is string => typeof id === "string" && id.length > 0))];
  const refundOrOtherInflows: any[] = linkedHistoryComplete ? linkedCanonicalRows.filter((tx:any)=>recurringTransactionIds.includes(tx.transaction_id)).map((tx:any)=>({transaction_id:tx.transaction_id,refund_relationship_type:tx.refund_relationship_type,refund_status:tx.refund_status,effective_type:tx.effective_type})) : [];
  let classificationFailed = recurringTransactionIds.length>0&&!linkedHistoryComplete;
  // Recurring averages cannot be separated into earned income and refund
  // components. If any linked occurrence is a known refund/other credit,
  // exclude the aggregate stream so it cannot inflate expected income.
  if (classificationFailed) {
    coverageComplete = false;
    // An unclassified aggregate must never be treated as verified earned income.
    for (const stream of plaidStreams) if (stream.flow_type === "inflow") stream.include_in_forecast = false;
    warnings.push("Recurring income classification is unavailable; income streams were excluded from this forecast attempt.");
    for (const source of sourceCoverage) if (source.status === "success") source.status = "failed", source.reason = "classification_unavailable";
  } else excludeNonIncomeInflows(plaidStreams, refundOrOtherInflows);
  if(!linkedHistoryComplete){coverageComplete=false;for(const source of sourceCoverage)if(source.status==='success')source.status='failed',source.reason='linked_history_unavailable';}
  if(!linkedHistoryComplete){
    const priorByKey=new Map((knownSnapshot?.stream_states??[]).map((s:any)=>[s.key,s]));
    for(const stream of plaidStreams){const prior:any=priorByKey.get(stream.stream_key);if(!prior)continue;stream.expected_amount=prior.amount;stream.predicted_next_date=prior.next_date;if(prior.active===true){stream.is_active=true;stream.include_in_forecast=true;stream.primary_eligible=true;stream.recurring_kind=prior.kind==="internal-transfer"?"internal_transfer":prior.kind==="repayment"?"credit_card_repayment":prior.kind==="needs-review"?"needs_review":prior.kind;}}
  }
  const manualHistory=new Map<string,any[]>(),manualHistoryStatus=new Map<string,string>(manualHistoryRows.map((row:any)=>[row.manual_stream_id,"complete"]));
  if(manualHistoryRows.length){
    const historyRows:any[]|null=sharedHistory?.manual_transactions??null,attempts=sharedHistory?1:0;let matcherFailure=false,malformedHistoryRow=false;
    if(historyRows===null){for(const id of manualHistoryStatus.keys())manualHistoryStatus.set(id,"unavailable");console.warn("Recurring manual history is incomplete.",{reason:sharedHistoryError?preparedHistoryFailureCode(sharedHistoryError):"prepared_history_unavailable",attempt_count:attempts});coverageComplete=false;}
    else{
      if(sharedHistory.manual_truncated===true){for(const id of manualHistoryStatus.keys())manualHistoryStatus.set(id,"partial");console.warn("Recurring manual history is incomplete.",{reason:"result_truncated",attempt_count:attempts});coverageComplete=false;}
      for(const tx of historyRows){
        if(!tx||typeof tx!=="object"||typeof tx.transaction_id!=="string"||typeof tx.effective_transaction_date!=="string"||!Number.isFinite(Number(tx.amount))){for(const id of manualHistoryStatus.keys())manualHistoryStatus.set(id,"partial");malformedHistoryRow=true;continue;}
        const safeMatch=(manual:any,explicit=false)=>{try{return manualTransactionMatch(manual,tx,accountMap.get(manual.account_id),explicit);}catch{manualHistoryStatus.set(manual.manual_stream_id,"partial");matcherFailure=true;return false;}};
        const exact=manualHistoryRows.filter((manual:any)=>manual.source_transaction_id===tx.transaction_id&&safeMatch(manual,true));
        const candidates=exact.length?exact:manualHistoryRows.filter((manual:any)=>safeMatch(manual,false));
        if(candidates.length>1){for(const manual of candidates)manualHistoryStatus.set(manual.manual_stream_id,"partial");continue;}if(candidates.length!==1)continue;
        const owner=candidates[0],rows=manualHistory.get(owner.manual_stream_id)??[];rows.push(tx);manualHistory.set(owner.manual_stream_id,rows);
      }
      if(matcherFailure)console.warn("Recurring manual history is incomplete.",{reason:"matcher_error",attempt_count:attempts});
      if(malformedHistoryRow)console.warn("Recurring manual history is incomplete.",{reason:"invalid_row",attempt_count:attempts});
    }
  }
  const reconciledManualStreamIds: string[] = [],ambiguousManualIds=new Set<string>(),claimedProviderStreamKeys=new Set<string>();
  const orderedManualRows=[...(manualRows.data??[])].sort((a:any,b:any)=>(Date.parse(b.updated_at??"")||0)-(Date.parse(a.updated_at??"")||0));
  const manualGroupWinner=new Map<string,string>();
  for(const manual of orderedManualRows){if(manualGroupWinner.has(manual.manual_stream_id))continue;manualGroupWinner.set(manual.manual_stream_id,manual.manual_stream_id);for(const candidate of orderedManualRows){if(candidate.manual_stream_id===manual.manual_stream_id||manualGroupWinner.has(candidate.manual_stream_id))continue;if(manualRulesMatch(manual,candidate,accountMap,new Set([...(manualHistory.get(manual.manual_stream_id)??[]).map((tx:any)=>tx.transaction_id)]),new Set([...(manualHistory.get(candidate.manual_stream_id)??[]).map((tx:any)=>tx.transaction_id)])))manualGroupWinner.set(candidate.manual_stream_id,manual.manual_stream_id);}}
  for (const manual of orderedManualRows) {
    if(manualGroupWinner.get(manual.manual_stream_id)!==manual.manual_stream_id)continue;
    const groupRows=orderedManualRows.filter(row=>manualGroupWinner.get(row.manual_stream_id)===manual.manual_stream_id),groupSourceIds=groupRows.map(row=>row.source_transaction_id).filter(Boolean),groupHistoryIds=new Set(groupRows.flatMap(row=>(manualHistory.get(row.manual_stream_id)??[]).map((tx:any)=>tx.transaction_id)));
    const account = accountMap.get(manual.account_id) as any;
    if (!account) continue;
    const candidates=plaidStreams.filter(stream=>manualMatchesPlaid(manual,stream,accountMap,groupHistoryIds));
    const replacement=candidates.length===1?candidates[0]:null;
    if(candidates.length>1)ambiguousManualIds.add(manual.manual_stream_id);
    if(replacement&&claimedProviderStreamKeys.has(replacement.stream_key))continue;
    if(replacement){claimedProviderStreamKeys.add(replacement.stream_key);replacement.history_status=groupRows.map(row=>manualHistoryStatus.get(row.manual_stream_id)??"complete").includes("unavailable")?"unavailable":groupRows.some(row=>manualHistoryStatus.get(row.manual_stream_id)==="partial")?"partial":"complete";replacement.source_transaction_id=manual.source_transaction_id??groupSourceIds[0]??replacement.source_transaction_id;replacement.source_transaction_ids=[...new Set([...(replacement.source_transaction_ids??[]),...groupSourceIds])];replacement.transaction_ids=[...new Set([...(replacement.transaction_ids||[]),...groupSourceIds,...[...groupHistoryIds]])];replacement.source_stream_keys=[...new Set([...(replacement.source_stream_keys??[]),...groupRows.map(row=>`manual:${row.manual_stream_id}`)])];replacement.source_guard={cache:replacement.source_guard?.cache??[],overrides:replacement.source_guard?.overrides??[],manual:[...new Map([...(replacement.source_guard?.manual??[]),...groupRows.map((row:any)=>({manual_stream_id:row.manual_stream_id,updated_at:row.updated_at??null}))].map((x:any)=>[x.manual_stream_id,x])).values()]};const manualNewer=!replacement.override_updated_at||Date.parse(manual.updated_at||0)>=Date.parse(replacement.override_updated_at);if(manualNewer&&manual.active!==true){replacement.is_active=false;replacement.include_in_forecast=false;replacement.override_not_recurring=true;replacement.primary_eligible=false;replacement.display_status="not_recurring";replacement.review_reasons=[...(replacement.review_reasons??[]),"user_marked_not_recurring"];}else if(manualNewer){replacement.manual_fallback_id = manual.manual_stream_id; replacement.manual_fallback_match_text = manual.match_text; replacement.manual_stream_id = manual.manual_stream_id; replacement.user_managed = true;replacement.is_active=true; replacement.override_not_recurring=false; replacement.expected_amount = finite(manual.amount); replacement.expected_amount_source = "user"; replacement.frequency = manual.frequency; replacement.predicted_next_date = currentOrNextDate(String(manual.next_date), String(manual.frequency),timeZone); replacement.description = manual.name; replacement.match_text = manual.match_text;replacement.source_currency_verified=typeof manual.currency_code==='string'&&/^[A-Z]{3}$/.test(manual.currency_code)&&manual.currency_code===replacement.currency_code;replacement.recurring_kind_override=manual.recurring_kind_override??null;replacement.include_in_forecast = replacement.recurring_kind==="internal_transfer"||manual.recurring_kind_override==="internal_transfer"?false:manual.include_in_forecast !== false;if(replacement.recurring_kind!=="credit_card_repayment"){if(manual.recurring_kind_override==="internal_transfer")replacement.recurring_kind="internal_transfer";else if(replacement.recurring_kind!=="internal_transfer")replacement.recurring_kind=manual.flow_type==="inflow"?"income":(replacement.recurring_kind==="subscription"?"subscription":"expense");}if(replacement.recurring_kind==="internal_transfer"){replacement.transfer_excluded=true;replacement.category_override=null;}replacement.review_reasons=(replacement.review_reasons??[]).filter((reason:string)=>!['amount_unavailable','cadence_unavailable','provider_transfer_label_unconfirmed','user_marked_not_recurring'].includes(reason));replacement.primary_eligible=replacement.recurring_kind!=="internal_transfer"&&replacement.recurring_kind!=="needs_review"&&replacement.expected_amount>0&&replacement.review_reasons.length===0;replacement.display_status=replacement.recurring_kind==="internal_transfer"?"transfer":replacement.recurring_kind==="credit_card_repayment"?"repayment":replacement.primary_eligible?"active":"needs_review"; if (replacement.recurring_kind!=="internal_transfer"&&manual.flow_type === "outflow" && manual.category_name) replacement.category_override = manual.category_name; reconciledManualStreamIds.push(manual.manual_stream_id);}continue;}
    if(manual.active!==true)continue;
    const predictedNextDate = currentOrNextDate(String(manual.next_date), String(manual.frequency),timeZone);
    const streamKey = `manual:${manual.manual_stream_id}`;
    deduped.set(streamKey, {
      stream_key: streamKey,
      stream_id: null,
      manual_stream_id: manual.manual_stream_id,
      account_id: manual.account_id,
      canonical_account_id: account.canonical_account_id ?? manual.account_id,
      account_name: account.name ?? account.official_name ?? "Account",
      account_mask: account.mask ?? null,
      institution_name: "Manual fallback",
      flow_type: manual.flow_type === "outflow" ? "outflow" : "inflow",
      description: manual.name,
      merchant_name: manual.match_text,
      first_date: null,
      last_date: null,
      predicted_next_date: predictedNextDate,
      frequency: manual.frequency,
      average_amount: finite(manual.amount),
      last_amount: finite(manual.amount),
      expected_amount: finite(manual.amount),
      expected_amount_source: "user",
      plaid_average_amount:null,
      plaid_last_amount:null,
      amount_override: finite(manual.amount),
      currency_code: manual.currency_code ?? "USD",
      source_currency_verified:typeof manual.currency_code==='string'&&/^[A-Z]{3}$/.test(manual.currency_code),
      is_active: manual.active === true,
      include_in_forecast: manual.recurring_kind_override==="internal_transfer"?false:manual.include_in_forecast !== false,
      status: "MANUAL",
      source_transaction_id: manual.source_transaction_id ?? groupSourceIds[0] ?? null,
      source_transaction_ids:[...new Set(groupSourceIds)],
      history_status: manualHistoryStatus.get(manual.manual_stream_id)??"complete",
      source_stream_keys:[`manual:${manual.manual_stream_id}`],
      recurring_kind:ambiguousManualIds.has(manual.manual_stream_id)?"needs_review":manual.recurring_kind_override??(manual.flow_type==="inflow"?"income":("services"===normalize(manual.category_name)?"subscription":"expense")),
      recurring_kind_override:manual.recurring_kind_override??null,
      primary_eligible:manual.active===true&&finite(manual.amount)>0&&!ambiguousManualIds.has(manual.manual_stream_id)&&manual.recurring_kind_override!=="internal_transfer",
      review_reasons:ambiguousManualIds.has(manual.manual_stream_id)?["ambiguous_provider_match"]:[],
      display_status:ambiguousManualIds.has(manual.manual_stream_id)?"needs_review":manual.recurring_kind_override==="internal_transfer"?"transfer":manual.active===true?"active":"not_recurring",
      transaction_ids: [...new Set([...groupSourceIds,...groupHistoryIds])],
      personal_finance_category_primary: manual.recurring_kind_override==="internal_transfer"?null:manual.flow_type === "outflow" ? (manual.category_name ?? "OTHER") : "INCOME",
      category_override: manual.recurring_kind_override==="internal_transfer"?null:manual.flow_type === "outflow" ? (manual.category_name ?? null) : null,
      personal_finance_category_detailed: manual.recurring_kind_override==="internal_transfer"?null:manual.flow_type === "outflow" ? (manual.category_name ?? "OTHER") : "INCOME_WAGES",
      transfer_excluded:manual.recurring_kind_override==="internal_transfer",
      confidence: "MANUAL",
      source_type: "manual",
      match_text: manual.match_text,
      source_guard:{cache:[],overrides:[],manual:[{manual_stream_id:manual.manual_stream_id,updated_at:manual.updated_at??null}]},
    });
  }
  const streams = [...deduped.values()].sort((a, b) => String(a.predicted_next_date ?? "9999").localeCompare(String(b.predicted_next_date ?? "9999")));
  for(const stream of streams){const reasons=Array.isArray(stream.review_reasons)?stream.review_reasons:[];stream.primary_eligible=stream.is_active===true&&stream.recurring_kind!=="needs_review"&&stream.recurring_kind!=="internal_transfer"&&stream.expected_amount!==null&&stream.expected_amount>0&&reasons.length===0;if(stream.recurring_kind==="internal_transfer"){stream.transfer_excluded=true;stream.include_in_forecast=false;stream.display_status="transfer";}if(stream.override_not_recurring){stream.primary_eligible=false;stream.display_status="not_recurring";}else if(stream.recurring_kind==="needs_review")stream.display_status="needs_review";}
  // Lifecycle is an additive projection after provider/manual reconciliation.
  // Ambiguous or orphaned state fails the forecast closed instead of silently
  // restoring an unpaused default.
  const lifecycleRows=await loadLifecycleState(db,context.householdId);
  const lifecycleProjection=applyLifecycleProjection(streams,lifecycleRows);
  const streamsWithLifecycle=lifecycleProjection.streams;
  if(lifecycleProjection.unresolved.length){coverageComplete=false;warnings.push("Recurring lifecycle identity needs review; affected forecast streams are unavailable.");}
  const projectedStreams=streamsWithLifecycle;
  // Reconcile pending activity against the final Folio-owned amount, cadence,
  // direction, canonical account and merchant. Each pending row can suppress
  // at most one expected occurrence.
  if(!sharedHistory||sharedHistory.pending_truncated===true){warnings.push("Pending recurring payments could not be fully reconciled with the forecast.");coverageComplete=false;}
  else {for(const tx of sharedHistory.pending_transactions){const txCanonicalAccountId=accountMap.get(tx.account_id)?.canonical_account_id;const eligible=projectedStreams.filter((stream:any)=>stream.is_active===true&&stream.include_in_forecast!==false&&stream.primary_eligible!==false&&stream.expected_amount!=null&&stream.predicted_next_date&&tx.account_id===stream.account_id&&(!stream.canonical_account_id||txCanonicalAccountId===stream.canonical_account_id)&&(!stream.currency_code||tx.iso_currency_code===stream.currency_code)&&(stream.flow_type==="outflow"?Number(tx.amount)>0:Number(tx.amount)<0)&&Math.abs(Math.abs(Number(tx.amount))-Math.abs(finite(stream.expected_amount??stream.last_amount??stream.average_amount)))<=Math.max(3,Math.abs(finite(stream.expected_amount??stream.last_amount??stream.average_amount))*.1)&&Math.abs(Date.parse(`${tx.effective_transaction_date}T00:00:00Z`)-Date.parse(`${stream.predicted_next_date}T00:00:00Z`))<=7*86400000&&(()=>{const text=normalize(tx.effective_merchant_name),needle=normalize(stream.match_text||stream.description);return text===needle||needle.length>=4&&text.startsWith(`${needle}-`);})());const exact=eligible.filter((stream:any)=>stream.transaction_ids?.includes(tx.transaction_id)||tx.pending_transaction_id&&stream.transaction_ids?.includes(tx.pending_transaction_id));const candidates=exact.length?exact:eligible;if(candidates.length===1)candidates[0].pending_occurrence_date=tx.effective_transaction_date;}
  }
  const configurationRevision=hashText(JSON.stringify({overrides:[...(overrideRows.data??[])].map((r:any)=>({stream_key:r.stream_key,plaid_stream_id:r.plaid_stream_id,canonical_account_id:r.canonical_account_id,flow_type:r.flow_type,currency_code:r.currency_code,transaction_ids:r.transaction_ids,amount_override:r.amount_override,frequency_override:r.frequency_override,next_date_override:r.next_date_override,category_override:r.category_override,recurring_kind_override:r.recurring_kind_override,match_text_override:r.match_text_override,include_in_forecast:r.include_in_forecast,active:r.active,override_not_recurring:r.override_not_recurring})).sort((a:any,b:any)=>String(a.stream_key).localeCompare(String(b.stream_key))),manual:[...(manualRows.data??[])].map((r:any)=>({manual_stream_id:r.manual_stream_id,name:r.name,amount:r.amount,frequency:r.frequency,next_date:r.next_date,account_id:r.account_id,source_transaction_id:r.source_transaction_id,plaid_stream_id:r.plaid_stream_id,plaid_stream_key:r.plaid_stream_key,match_text:r.match_text,category_name:r.category_name,flow_type:r.flow_type,currency_code:r.currency_code,recurring_kind_override:r.recurring_kind_override,include_in_forecast:r.include_in_forecast,active:r.active})).sort((a:any,b:any)=>String(a.manual_stream_id).localeCompare(String(b.manual_stream_id))),lifecycle:[...(lifecycleRows??[])].map((r:any)=>({stream_key:r.stream_key,canonical_account_id:r.canonical_account_id,flow_type:r.flow_type,currency_code:r.currency_code,transaction_ids:[...(r.transaction_ids??[])].sort(),paused:r.paused===true,skipped_dates:[...(r.skipped_dates??[])].map(String).sort(),revision:Number(r.revision)})).sort((a:any,b:any)=>String(a.stream_key).localeCompare(String(b.stream_key)))}));
  const horizonDays=options.lifecycleHorizonDays===undefined?(options.horizonDays??30):Math.max(30,Math.min(400,Math.floor(Number(options.lifecycleHorizonDays))||30));
  const schedule=buildRecurringSchedule(projectedStreams,calendarDate(new Date(),timeZone),horizonDays,coverageComplete,timeZone);
  return { generated_at: new Date().toISOString(), streams:projectedStreams, schedule, warnings, configuration_revision:configurationRevision,history_generation:sharedHistory?.generation??null, refresh_item_ids:sourceCoverage.filter((source:any)=>source.refresh_due).map((source:any)=>source.item_id), coverage: { complete: coverageComplete, sources: sourceCoverage.filter((source:any) => source.expected === true) }, reconciled_manual_stream_ids: reconciledManualStreamIds };
}

async function updateRecurring(context: Context, body: Row) {
  only(body, ["action", "household_id", "stream_key", "stream_id", "amount", "frequency", "next_date", "category", "recurring_kind", "match_text", "include_in_forecast", "active", "reset_amount"]);
  const db = serviceClient();
  let streamKey = string(body.stream_key, "stream_key", 240);
  let identity:any=null;
  try{const model=await recurringResponse(context,undefined,undefined,{cacheOnly:true});identity=model.streams.find((row:any)=>row.stream_key===streamKey||body.stream_id&&row.stream_id===body.stream_id)??null;if(identity)streamKey=identity.stream_key;}catch{}
  const identityRows=await db.from("finance_recurring_overrides").select("stream_key,plaid_stream_id,canonical_account_id,flow_type,currency_code,transaction_ids,recurring_kind_override,include_in_forecast").eq("household_id",context.householdId);
  if(identityRows.error)throw new Error(identityRows.error.message);
  const priorIdentity=(identityRows.data??[]).find((row:any)=>row.stream_key===streamKey||body.stream_id&&row.plaid_stream_id===body.stream_id||identity&&recurringIdentityMatches(row,identity));
  if(priorIdentity)streamKey=priorIdentity.stream_key;
  if(body.recurring_kind!==undefined){const kind=body.recurring_kind===null?null:string(body.recurring_kind,"recurring_kind",40);if(kind!==null&&kind!=="internal_transfer")throw new RequestError("recurring_kind must be internal_transfer or null.");if(kind==="internal_transfer"&&identity?.recurring_kind==="credit_card_repayment")throw new RequestError("Credit-card repayments remain separate from internal transfers.",409);}
  const values: Row = { household_id: context.householdId, stream_key: streamKey, updated_by: context.userId, updated_at: new Date().toISOString() };
  if(identity){values.canonical_account_id=identity.canonical_account_id??identity.account_id;values.flow_type=identity.flow_type;values.currency_code=identity.currency_code??"USD";values.transaction_ids=identity.transaction_ids.slice(0,500);}
  if (body.stream_id !== undefined) values.plaid_stream_id = nullableString(body.stream_id, "stream_id", 240);
  if (body.reset_amount === true) values.amount_override = null;
  else if (body.amount !== undefined) { values.amount_override = money(body.amount, "amount"); if(values.amount_override<=0) throw new RequestError("amount must be greater than zero."); }
  if (body.frequency !== undefined) {
    const frequency = parseRecurringFrequency(body.frequency);
    values.frequency_override = frequency;
  }
  if (body.include_in_forecast !== undefined) values.include_in_forecast = boolean(body.include_in_forecast, "include_in_forecast");
  if(body.recurring_kind!==undefined){values.recurring_kind_override=body.recurring_kind;if(body.recurring_kind==="internal_transfer"){if(body.category!=null)throw new RequestError("Internal transfers do not use an expense category.");values.category_override=null;values.include_in_forecast=false;}}
  if(body.recurring_kind==="internal_transfer"||body.recurring_kind===undefined&&identity?.recurring_kind==="internal_transfer")values.include_in_forecast=false;
  if (body.active !== undefined) { values.active = boolean(body.active, "active"); values.override_not_recurring = body.active === false; }
  if (body.next_date !== undefined) values.next_date_override = date(body.next_date, "next_date");
  if (body.category !== undefined) values.category_override = nullableString(body.category, "category", 120);
  if (body.category != null) {
    const categoryName = string(body.category, "category", 120);
    const category = await db.from("finance_categories").select("category_name").eq("household_id", context.householdId).eq("category_type", "expense").eq("active", true).eq("excluded_from_cash_flow", false).ilike("category_name", categoryName).maybeSingle();
    if (category.error) throw new Error(category.error.message);
    if (!category.data) throw new RequestError("Select an active expense category from this household.", 404);
    values.category_override = category.data.category_name;
  }
  if (body.match_text !== undefined) values.match_text_override = string(body.match_text, "match_text", 120);
  const { data, error } = await db.from("finance_recurring_overrides").upsert(values, { onConflict: "household_id,stream_key" }).select().single();
  if (error) throw new Error(error.message);
  await audit(db, context, "update", "recurring_stream", streamKey, values);
  return { recurring_override: data };
}

async function saveManualRecurring(context: Context, body: Row) {
  only(body, ["action", "household_id", "manual_stream_id", "source_transaction_id", "name", "amount", "frequency", "next_date", "account_id", "match_text", "category_name", "flow_type", "recurring_kind", "currency_code", "include_in_forecast"]);
  const db = serviceClient();
  const accountId = string(body.account_id, "account_id", 240);
  const accounts = await householdAccounts(db, context.householdId);
  if (!accounts.some((account: any) => account.account_id === accountId && account.lifecycle_status !== "closed")) throw new RequestError("Select an active household account.", 404);
  let existingId=body.manual_stream_id?uuid(body.manual_stream_id,"manual_stream_id"):null,priorManual:any=null;
  const loadPriorManual=async()=>{if(!existingId||priorManual)return;const result=await db.from("finance_manual_recurring_streams").select("manual_stream_id,source_transaction_id,plaid_stream_id,plaid_stream_key,recurring_kind_override,category_name,flow_type").eq("household_id",context.householdId).eq("manual_stream_id",existingId).maybeSingle();if(result.error)throw new Error(result.error.message);priorManual=result.data;};
  await loadPriorManual();
  let sourceTransactionId = body.source_transaction_id===undefined?(priorManual?.source_transaction_id??null):nullableString(body.source_transaction_id, "source_transaction_id", 240);
  if(!existingId&&sourceTransactionId){const found=await db.from("finance_manual_recurring_streams").select("manual_stream_id").eq("household_id",context.householdId).eq("source_transaction_id",sourceTransactionId).eq("active",true).maybeSingle();if(found.error)throw new Error(found.error.message);existingId=found.data?.manual_stream_id??null;await loadPriorManual();}
  let sourceTransaction:any=null;
  if (sourceTransactionId) {
    sourceTransaction=await recurringSourceTransaction(db,context.householdId,context.userId,sourceTransactionId,RequestError,existingId);
  }
  const frequency = parseRecurringFrequency(body.frequency);
  const currencyCode = string(body.currency_code ?? "USD", "currency_code", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new RequestError("currency_code is invalid.");
  const amount = money(body.amount, "amount"); if (amount <= 0) throw new RequestError("amount must be greater than zero.");
  const nextDate = date(body.next_date, "next_date"); if (!nextDate) throw new RequestError("next_date is required.");
  const flowType = body.flow_type === undefined ? (priorManual?.flow_type??"inflow") : string(body.flow_type, "flow_type", 20).toLowerCase();
  if (!["inflow", "outflow"].includes(flowType)) throw new RequestError("flow_type must be inflow or outflow.");
  const recurringKind=body.recurring_kind===undefined?(priorManual?.recurring_kind_override??null):body.recurring_kind===null?null:string(body.recurring_kind,"recurring_kind",40);
  if(recurringKind!==null&&recurringKind!=="internal_transfer")throw new RequestError("recurring_kind must be internal_transfer or null.");
  if(recurringKind==="internal_transfer"&&sourceTransaction&&sourceTransaction.effective_type==="transfer"&&/credit.card.payment|card.repayment/i.test(String(sourceTransaction.effective_category??"")))throw new RequestError("Credit-card repayments remain separate from internal transfers.",409);
  let categoryName: string | null = null;
  if (flowType === "outflow"&&recurringKind!=='internal_transfer') {
    categoryName = string(body.category_name===undefined?priorManual?.category_name:body.category_name, "category_name", 120);
    const categoryResult = await db.from("finance_categories").select("category_name").eq("household_id", context.householdId).eq("category_type", "expense").eq("active", true).eq("excluded_from_cash_flow", false).ilike("category_name", categoryName).maybeSingle();
    if (categoryResult.error) throw new Error(categoryResult.error.message);
    if (!categoryResult.data) throw new RequestError("Select an active expense category from this household.", 404);
    categoryName = categoryResult.data.category_name;
  }
  let matchedProvider:any=null;
  try {
    const current=await recurringResponse(context,undefined,accounts,{cacheOnly:true}),map=new Map(accounts.map((account:any)=>[account.account_id,account]));
    const proposal={account_id:accountId,flow_type:flowType,recurring_kind_override:recurringKind,source_transaction_id:sourceTransactionId,name:String(body.name||""),match_text:String(body.match_text||""),amount,frequency};
    const candidates=current.streams.filter((stream:any)=>stream.source_type==="plaid"&&manualMatchesPlaid(proposal,stream,map));
    if(candidates.length===1)matchedProvider=candidates[0];
  } catch { /* A provider/cache miss must not block an explicitly manual rule. */ }
  if(recurringKind==='internal_transfer'&&matchedProvider?.recurring_kind==='credit_card_repayment')throw new RequestError("Credit-card repayments remain separate from internal transfers.",409);
  if(!existingId&&matchedProvider?.stream_id){const existing=await db.from("finance_manual_recurring_streams").select("manual_stream_id").eq("household_id",context.householdId).eq("plaid_stream_id",matchedProvider.stream_id).eq("active",true).maybeSingle();if(existing.error)throw new Error(existing.error.message);existingId=existing.data?.manual_stream_id??null;await loadPriorManual();}
  const values: Row = {
    household_id: context.householdId,
    flow_type: flowType,
    name: string(body.name, "name", 120),
    amount,
    frequency,
    next_date: nextDate,
    account_id: accountId,
    source_transaction_id: body.source_transaction_id===undefined?(priorManual?.source_transaction_id??sourceTransactionId):sourceTransactionId,
    plaid_stream_id: matchedProvider?.stream_id??priorManual?.plaid_stream_id??null,
    plaid_stream_key: matchedProvider?.stream_key??priorManual?.plaid_stream_key??null,
    match_text: string(body.match_text, "match_text", 120),
    category_name: recurringKind==="internal_transfer"?null:body.category_name===undefined?(priorManual?.category_name??categoryName):categoryName,
    recurring_kind_override:body.recurring_kind===undefined?(priorManual?.recurring_kind_override??null):recurringKind,
    currency_code: currencyCode,
    include_in_forecast: recurringKind==="internal_transfer"||matchedProvider?.recurring_kind==="internal_transfer"?false:body.include_in_forecast === undefined ? true : boolean(body.include_in_forecast, "include_in_forecast"),
    active: true,
    updated_by: context.userId,
    updated_at: new Date().toISOString(),
  };
  let manual;
  if (existingId) {
    const id = existingId;
    const result = await db.from("finance_manual_recurring_streams").update(values).eq("household_id", context.householdId).eq("manual_stream_id", id).eq("active", true).select().maybeSingle();
    if (result.error) throw new Error(result.error.message); if (!result.data) throw new RequestError("Manual recurring item not found.", 404); manual = result.data;
  } else {
    values.created_by = context.userId;
    const result = await db.from("finance_manual_recurring_streams").insert(values).select().single();
    if (result.error) throw new Error(result.error.message); manual = result.data;
  }
  await audit(db, context, existingId ? "update" : "create", "manual_recurring_stream", manual.manual_stream_id, { name: manual.name, amount: manual.amount, frequency: manual.frequency, next_date: manual.next_date, match_text: manual.match_text, source_transaction_id: manual.source_transaction_id ?? null, plaid_stream_id:manual.plaid_stream_id??null });
  return { manual_recurring: manual };
}

async function deactivateManualRecurring(context: Context, body: Row) {
  only(body, ["action", "household_id", "manual_stream_id"]);
  const id = uuid(body.manual_stream_id, "manual_stream_id"), db = serviceClient();
  const { data, error } = await db.from("finance_manual_recurring_streams").update({ active: false, updated_by: context.userId, updated_at: new Date().toISOString() }).eq("household_id", context.householdId).eq("manual_stream_id", id).eq("active", true).select().maybeSingle();
  if (error) throw new Error(error.message); if (!data) throw new RequestError("Manual recurring item not found.", 404);
  await audit(db, context, "deactivate", "manual_recurring_stream", id, { name: data.name });
  return { manual_recurring: data };
}

async function investmentResponse(context: Context) {
  const db = serviceClient();
  const [items, accountRows] = await Promise.all([householdItems(db, context.householdId), householdAccounts(db, context.householdId)]);
  const investmentAccounts = new Set(accountRows.filter((row: any) => row.type === "investment").map((row: any) => row.account_id));
  const accountMap = new Map(accountRows.map((row: any) => [row.account_id, row]));
  const eligible = items.filter(item => accountRows.some((account: any) => account.item_id === item.item_id && investmentAccounts.has(account.account_id)));
  const calls = await mapLimit(eligible, 3, item => plaid(item, "/investments/holdings/get", { access_token: item.access_token }));
  const warnings: string[] = [], holdings: any[] = [];
  calls.forEach((result, index) => {
    if (!result.ok) { warnings.push(`${eligible[index].institution_name ?? "Institution"}: holdings unavailable`); return; }
    const securities = new Map((result.data.securities ?? []).map((security: any) => [security.security_id, security]));
    for (const holding of result.data.holdings ?? []) {
      const account = accountMap.get(holding.account_id) as any, security = securities.get(holding.security_id) as any;
      if (!account || !security) continue;
      holdings.push({
        account_id: holding.account_id, account_name: account.name ?? account.official_name ?? "Investment account", account_mask: account.mask ?? null,
        institution_name: eligible[index].institution_name ?? "Institution", security_id: holding.security_id,
        name: security.name ?? "Holding", ticker_symbol: security.ticker_symbol ?? null, is_cash_equivalent: security.is_cash_equivalent === true,
        type: security.type ?? null, subtype: security.subtype ?? null, quantity: finite(holding.quantity), institution_price: finite(holding.institution_price),
        institution_price_as_of: holding.institution_price_as_of ?? null, institution_value: finite(holding.institution_value), cost_basis: finite(holding.cost_basis),
        currency_code: holding.iso_currency_code ?? security.iso_currency_code ?? "USD", vested_quantity: finite(holding.vested_quantity), vested_value: finite(holding.vested_value),
      });
    }
  });
  holdings.sort((a, b) => b.institution_value - a.institution_value);
  const total_value = round(holdings.reduce((sum, row) => sum + row.institution_value, 0));
  const total_cost_basis = round(holdings.reduce((sum, row) => sum + (row.cost_basis ?? 0), 0));
  return { generated_at: new Date().toISOString(), total_value, total_cost_basis, holdings, warnings };
}

async function investmentHistoryResponse(context: Context, body: Row) {
  only(body, ["action", "household_id", "account_id", "start_date", "end_date"]);
  const db = serviceClient(), accounts = await householdAccounts(db, context.householdId);
  const investmentAccounts = accounts.filter((row: any) => row.type === "investment" && row.lifecycle_status !== "closed");
  const accountId = body.account_id === undefined ? null : string(body.account_id, "account_id", 240);
  if (accountId && !investmentAccounts.some((row: any) => row.account_id === accountId)) throw new RequestError("Investment account not found.", 404);
  const accountIds = accountId ? [accountId] : investmentAccounts.map((row: any) => row.account_id);
  if (!accountIds.length) return { generated_at: new Date().toISOString(), history: [] };
  const startDate = date(body.start_date, "start_date"), endDate = date(body.end_date, "end_date");
  if (startDate && endDate && startDate > endDate) throw new RequestError("start_date must not be after end_date.");

  const rows: any[] = [];
  for (let offset = 0; offset < 100_000; offset += 1000) {
    let query = db.from("finance_canonical_account_balance_snapshots")
      .select("account_id,snapshot_date,recorded_at,current_balance,currency_code,source")
      .eq("household_id", context.householdId)
      .in("account_id", accountIds)
      .order("snapshot_date", { ascending: true })
      .order("recorded_at", { ascending: true })
      .range(offset, offset + 999);
    if (startDate) query = query.gte("snapshot_date", startDate);
    if (endDate) query = query.lte("snapshot_date", endDate);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }

  const latestByAccountDate = new Map<string, any>();
  for (const row of rows) latestByAccountDate.set(`${row.account_id}|${row.snapshot_date}`, row);
  const history = [...latestByAccountDate.values()].map(row => ({
    account_id: row.account_id,
    snapshot_date: row.snapshot_date,
    current_balance: finite(row.current_balance),
    currency_code: row.currency_code ?? "USD",
    source: row.source ?? null,
  })).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date) || a.account_id.localeCompare(b.account_id));
  const firstHistoryDate = history[0]?.snapshot_date ?? startDate ?? new Date().toISOString().slice(0, 10);
  const benchmarkStart = shiftDate(firstHistoryDate, -7);
  const benchmarkEnd = endDate ?? new Date().toISOString().slice(0, 10);
  let benchmark_history: Array<{ snapshot_date: string; close: number }> = [], benchmark_warning: string | null = null;
  try {
    benchmark_history = await sp500History(benchmarkStart, benchmarkEnd);
    console.log("S&P 500 benchmark loaded", { symbol: "I:SPX", points: benchmark_history.length, start: benchmarkStart, end: benchmarkEnd });
  } catch (error) {
    benchmark_warning = "S&P 500 market data is temporarily unavailable.";
    console.error("S&P 500 benchmark request failed", error instanceof Error ? error.message : error);
  }
  return { generated_at: new Date().toISOString(), history, benchmark: { symbol: "I:SPX", name: "S&P 500", source: "Massive", history: benchmark_history }, benchmark_warning };
}

async function investmentActivityResponse(context: Context, body: Row) {
  only(body, ["action", "household_id", "account_id", "start_date", "end_date", "limit"]);
  const db = serviceClient(), items = await householdItems(db, context.householdId), accounts = await householdAccounts(db, context.householdId);
  const accountId = body.account_id === undefined ? null : string(body.account_id, "account_id", 240);
  const endDate = date(body.end_date, "end_date") ?? new Date().toISOString().slice(0, 10);
  const startDefault = new Date(`${endDate}T00:00:00Z`); startDefault.setUTCFullYear(startDefault.getUTCFullYear() - 2);
  const startDate = date(body.start_date, "start_date") ?? startDefault.toISOString().slice(0, 10);
  const limit = Math.min(Math.max(Number(body.limit ?? 200), 1), 500);
  const accountMap = new Map(accounts.map((row: any) => [row.account_id, row]));
  const eligible = items.filter(item => accounts.some((account: any) => account.item_id === item.item_id && account.type === "investment" && (!accountId || account.account_id === accountId)));
  const calls = await mapLimit(eligible, 3, item => plaid(item, "/investments/transactions/get", { access_token: item.access_token, start_date: startDate, end_date: endDate, options: { count: limit, offset: 0, ...(accountId ? { account_ids: [accountId] } : {}) } }));
  const warnings: string[] = [], activity: any[] = [];
  calls.forEach((result, index) => {
    if (!result.ok) { warnings.push(`${eligible[index].institution_name ?? "Institution"}: investment activity unavailable`); return; }
    const securities = new Map((result.data.securities ?? []).map((security: any) => [security.security_id, security]));
    for (const item of result.data.investment_transactions ?? []) {
      const account = accountMap.get(item.account_id) as any, security = securities.get(item.security_id) as any;
      activity.push({ investment_transaction_id: item.investment_transaction_id, account_id: item.account_id, account_name: account?.name ?? "Investment account", institution_name: eligible[index].institution_name ?? "Institution", date: item.date, name: item.name ?? security?.name ?? "Investment activity", ticker_symbol: security?.ticker_symbol ?? null, amount: finite(item.amount), price: finite(item.price), quantity: finite(item.quantity), fees: finite(item.fees), type: item.type ?? null, subtype: item.subtype ?? null, currency_code: item.iso_currency_code ?? "USD" });
    }
  });
  activity.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { generated_at: new Date().toISOString(), activity: activity.slice(0, limit), warnings };
}

async function investmentEvidenceResponse(context: Context, body: Row) {
  only(body, ["action", "household_id", "canonical_account_ids", "start_date", "end_date", "timezone"]);
  resolveRequestTimeZone(body.timezone);
  const startDate = date(body.start_date, "start_date"), endDate = date(body.end_date, "end_date");
  if (startDate && endDate && startDate > endDate) throw new RequestError("start_date must not be after end_date.");
  const activityStart = startDate ?? shiftDate(new Date().toISOString().slice(0, 10), -730);
  const activityEnd = endDate ?? new Date().toISOString().slice(0, 10);
  if (activityStart > activityEnd) throw new RequestError("start_date must not be after end_date.");
  const db = serviceClient();
  const allAccounts = await householdAccounts(db, context.householdId);
  let scope: ReturnType<typeof selectInvestmentAccounts>;
  try { scope = selectInvestmentAccounts(allAccounts, body.canonical_account_ids); }
  catch (error) { const message = error instanceof Error ? error.message : "Investment account selection is invalid."; throw new RequestError(message, message.includes("unavailable") ? 404 : 400); }
  if (!scope.canonicalAccountIds.length) {
    return { contract_version: 1, generated_at: new Date().toISOString(), account_scope: [], account_source_quality: { status: "empty", ambiguous_account_ids: [] }, current_balances: [], history: { rows: [], pagination_complete: true, pages_read: 0, source_rows_read: 0, normalized_rows: 0, period_complete: null, same_date_coverage: null, valuation_consistency: "not_attested", requested_start_date: startDate, requested_end_date: endDate, reason: null }, holdings: { rows: [], complete: true, as_of_consistency: "not_attested" }, activity: { rows: [], pagination_complete: true, per_item: [], provider_rows_read: 0, normalized_rows: 0, requested_start_date: activityStart, requested_end_date: activityEnd, period_complete: null, flow_classification_complete: false, reason: null }, coverage: { pagination_complete: true, historical_period_complete: null, contemporaneous_valuations: null, external_flow_classification: false }, warnings: [] };
  }
  let mappingAvailable = true;
  let mappingRows: any[] = [];
  try {
    const mappingResult = await db.from("finance_canonical_account_sources").select("source_account_id,canonical_account_id,transaction_source_enabled").eq("household_id", context.householdId).in("canonical_account_id", scope.canonicalAccountIds);
    if (mappingResult.error || !Array.isArray(mappingResult.data)) mappingAvailable = false;
    else mappingRows = mappingResult.data;
  } catch { mappingAvailable = false; }
  const primarySourceByCanonical = new Map<string, string>();
  const ambiguousCanonicalIds: string[] = [];
  for (const canonicalId of scope.canonicalAccountIds) {
    const enabled = mappingRows.filter(row => row.canonical_account_id === canonicalId && row.transaction_source_enabled === true);
    if (!mappingAvailable || enabled.length !== 1 || typeof enabled[0]?.source_account_id !== "string") { ambiguousCanonicalIds.push(canonicalId); continue; }
    if (!scope.accounts.some(account => account.account_id === enabled[0].source_account_id)) { ambiguousCanonicalIds.push(canonicalId); continue; }
    primarySourceByCanonical.set(canonicalId, enabled[0].source_account_id);
  }
  const primaryAccounts = scope.accounts.filter(account => primarySourceByCanonical.get(account.canonical_account_id) === account.account_id);
  const sourceAccounts = new Map(primaryAccounts.map(account => [account.account_id, account]));
  const allAccountRowsBySource = new Map(allAccounts.map((account: any) => [account.account_id, account]));
  let balanceCurrencyBySource = new Map<string, string>();
  let balanceCurrencyAvailable = true;
  try {
    const currencyResult = await db.from("finance_household_accounts").select("account_id,balance_currency_code").eq("household_id", context.householdId).in("account_id", primaryAccounts.map(account => account.account_id));
    if (currencyResult.error || !Array.isArray(currencyResult.data)) balanceCurrencyAvailable = false;
    else balanceCurrencyBySource = new Map(currencyResult.data.flatMap((row: any) => typeof row.account_id === "string" && typeof row.balance_currency_code === "string" ? [[row.account_id, row.balance_currency_code]] : []));
  } catch { balanceCurrencyAvailable = false; }
  const balances = scope.canonicalAccountIds.map(canonicalId => {
    const sourceId = primarySourceByCanonical.get(canonicalId);
    const rows = sourceId ? scope.accounts.filter(account => account.account_id === sourceId) : [];
    const values = rows.map(account => nullableFinite(account.current_balance));
    const timestamps = rows.map(account => account.balance_updated_at ?? null);
    const currencies = rows.map(account => strictCurrency(balanceCurrencyBySource.get(account.account_id)));
    const consistent = values.length > 0 && values.every(value => value !== null && value === values[0]) && timestamps.every(value => value !== null && value === timestamps[0]);
    const currency = currencies.length > 0 && currencies[0] !== null && currencies.every(value => value === currencies[0]) ? currencies[0] : null;
    return { canonical_account_id: canonicalId, amount: consistent ? values[0] : null, currency_code: currency, as_of: consistent ? timestamps[0] : null, source: "household account balance", consistency: consistent && balanceCurrencyAvailable && currency ? "source_rows_agree" : "unverified" };
  });

  const historyRows: any[] = [];
  let historyComplete = true, historyPages = 0, historyReason: string | null = null;
  if (scope.canonicalAccountIds.length) {
    const pageSize = 1000, maxPages = 100;
    for (let page = 0; page < maxPages; page++) {
      let query = db.from("finance_canonical_account_balance_snapshots")
        .select("canonical_account_id,account_id,snapshot_date,recorded_at,current_balance,currency_code,source")
        .eq("household_id", context.householdId)
        .in("canonical_account_id", scope.canonicalAccountIds)
        .order("snapshot_date", { ascending: true })
        .order("account_id", { ascending: true })
        .order("recorded_at", { ascending: true })
        .range(page * pageSize, page * pageSize + pageSize - 1);
      if (startDate) query = query.gte("snapshot_date", startDate);
      if (endDate) query = query.lte("snapshot_date", endDate);
      let result: any;
      try { result = await query; } catch { historyComplete = false; historyReason = "source_error"; break; }
      if (result?.error || !Array.isArray(result?.data)) { historyComplete = false; historyReason = "source_error"; break; }
      const rows = result.data as any[];
      if (rows.some(row => !scope.canonicalAccountIds.includes(row.canonical_account_id))) { historyComplete = false; historyReason = "out_of_scope_row"; }
      historyRows.push(...rows.filter(row => scope.canonicalAccountIds.includes(row.canonical_account_id)));
      historyPages++;
      if (rows.length < pageSize) break;
      if (page === maxPages - 1) { historyComplete = false; historyReason = "page_limit"; }
    }
  }
  const normalizedHistory = normalizeHistoryRows(historyRows);
  if (normalizedHistory.invalid) { historyComplete = false; historyReason ??= "invalid_rows"; }
  const history = {
    rows: normalizedHistory.rows,
    source_rows: normalizedHistory.source_rows,
    conflicting_snapshot_keys: normalizedHistory.conflicting_snapshot_keys,
    pagination_complete: historyComplete,
    pages_read: historyPages,
    source_rows_read: historyRows.length,
    normalized_rows: normalizedHistory.rows.length,
    period_complete: null,
    same_date_coverage: null,
    valuation_consistency: "not_attested",
    requested_start_date: startDate,
    requested_end_date: endDate,
    reason: historyReason,
  };

  const warnings: string[] = [];
  const missingItemLink = !mappingAvailable || ambiguousCanonicalIds.length > 0 || primaryAccounts.length !== scope.canonicalAccountIds.length || primaryAccounts.some(account => typeof account.item_id !== "string" || !account.item_id);
  const itemIds = new Set(primaryAccounts.map(account => account.item_id).filter((id): id is string => typeof id === "string"));
  const selectedItems: any[] = [];
  if (itemIds.size) {
    try {
      const itemResult = await db.from("plaid_items").select("item_id,household_id,access_token,plaid_environment,institution_name").eq("household_id", context.householdId).eq("connection_status", "connected").in("item_id", [...itemIds]);
      if (itemResult.error || !Array.isArray(itemResult.data)) throw new Error("item lookup failed");
      for (const item of itemResult.data) {
        try { selectedItems.push({ ...item, access_token: await resolvePlaidAccessToken(db, item.item_id, item.access_token), token_error: false }); }
        catch { selectedItems.push({ ...item, access_token: null, token_error: true }); }
      }
    } catch { warnings.push("Some selected accounts are not connected to an available investment source."); }
  }
  const allActivity: any[] = [];
  let activityComplete = !missingItemLink && selectedItems.length === itemIds.size;
  if (!activityComplete) warnings.push("Some selected accounts are not connected to an available investment source.");
  const activityPages: any[] = [];
  const sourceDeadline = Date.now() + 60_000;
  for (const item of selectedItems) {
    const itemAccountIds = primaryAccounts.filter(account => account.item_id === item.item_id).map(account => account.account_id);
    if (!itemAccountIds.length) continue;
    if (item.token_error) { activityComplete = false; warnings.push("Some investment activity is unavailable."); activityPages.push({ item_id: item.item_id, pages_read: 0, row_count: 0, upstream_total: null, pagination_complete: false, reason: "token_unavailable" }); continue; }
    const collected = await collectOffsetPages(async (offset, count) => {
      const response = await plaid(item, "/investments/transactions/get", {
        access_token: item.access_token,
        start_date: activityStart,
        end_date: activityEnd,
        options: { count, offset, account_ids: itemAccountIds },
      }, sourceDeadline);
      if (!response.ok) throw new Error("Investment activity source unavailable");
      const rows = response.data?.investment_transactions;
      const total = response.data?.total_investment_transactions;
      if (!Array.isArray(rows)) throw new Error("Investment activity page is malformed");
      return { rows, total };
    }, { pageSize: 500, maxPages: 20 });
    activityPages.push({ item_id: item.item_id, pages_read: collected.pages, row_count: collected.row_count, upstream_total: collected.upstream_total, pagination_complete: collected.complete, reason: collected.reason });
    if (!collected.complete) { activityComplete = false; warnings.push("Some investment activity is unavailable or exceeds the page limit."); }
    allActivity.push(...collected.rows);
  }
  const normalizedActivity = normalizeActivityRows(allActivity, sourceAccounts);
  if (normalizedActivity.invalid || normalizedActivity.foreign || normalizedActivity.conflicts || normalizedActivity.duplicates) {
    activityComplete = false;
    warnings.push("Some investment activity could not be matched safely to the selected accounts.");
  }
  const activity = {
    rows: normalizedActivity.rows.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || a.investment_transaction_id.localeCompare(b.investment_transaction_id)),
    pagination_complete: activityComplete,
    per_item: activityPages,
    provider_rows_read: activityPages.reduce((sum, page) => sum + page.row_count, 0),
    normalized_rows: normalizedActivity.rows.length,
    requested_start_date: activityStart,
    requested_end_date: activityEnd,
    period_complete: null,
    flow_classification_complete: false,
    reason: activityComplete ? null : "incomplete_source",
  };

  const holdingsRows: any[] = [];
  let holdingsComplete = !missingItemLink && selectedItems.length === itemIds.size;
  const holdingResults = await mapLimit(selectedItems, 3, async item => {
    if (item.token_error) return { ok: false, data: {} };
    try { return await plaid(item, "/investments/holdings/get", { access_token: item.access_token }, sourceDeadline); }
    catch { return { ok: false, data: {} }; }
  });
  holdingResults.forEach((result, index) => {
    if (!result.ok) { holdingsComplete = false; warnings.push("Some investment holdings are unavailable."); return; }
    if (!Array.isArray(result.data?.holdings) || !Array.isArray(result.data?.securities)) { holdingsComplete = false; warnings.push("Some investment holdings could not be read completely."); return; }
    const item = selectedItems[index];
    const securities = new Map((result.data?.securities ?? []).map((security: any) => [security.security_id, security]));
    for (const row of result.data?.holdings ?? []) {
      const account = sourceAccounts.get(row.account_id);
      if (!account) {
        const knownAccount = allAccountRowsBySource.get(row.account_id) as any;
        if (!knownAccount || knownAccount.item_id !== item.item_id) holdingsComplete = false;
        continue;
      }
      if (account.item_id !== item.item_id) { holdingsComplete = false; continue; }
      const security = securities.get(row.security_id) as any;
      if (!security) holdingsComplete = false;
      holdingsRows.push({
        canonical_account_id: account.canonical_account_id,
        source_account_id: account.account_id,
        security_id: row.security_id ?? null,
        name: security?.name ?? null,
        ticker_symbol: security?.ticker_symbol ?? null,
        quantity: nullableFinite(row.quantity),
        price: nullableFinite(row.institution_price),
        value: nullableFinite(row.institution_value),
        cost_basis: nullableFinite(row.cost_basis),
        currency_code: strictCurrency(row.iso_currency_code, security?.iso_currency_code),
        value_as_of: row.institution_price_as_of ?? null,
      });
    }
  });
  return {
    contract_version: 1,
    generated_at: new Date().toISOString(),
    account_scope: scope.canonicalAccountIds,
    account_source_quality: { status: !mappingAvailable ? "unavailable" : ambiguousCanonicalIds.length ? "ambiguous" : "primary_source_selected", ambiguous_account_ids: ambiguousCanonicalIds },
    current_balances: balances,
    history,
    holdings: { rows: holdingsRows, complete: holdingsComplete, as_of_consistency: "not_attested" },
    activity,
    coverage: { pagination_complete: history.pagination_complete && activity.pagination_complete, historical_period_complete: null, contemporaneous_valuations: null, external_flow_classification: false },
    warnings,
  };
}

export async function planningResponse(context: Context, body: Row, suppliedRecurring?: any, suppliedAccounts?: any[] | Promise<any[]>, options: {cacheOnly?:boolean;precomputedVariableSpend?:any;forceRecompute?:boolean;queueRefresh?:boolean;expectedRefreshJobId?:string;expectedRefreshGeneration?:number} = {}) {
  only(body, ["action", "household_id", "horizon_days", "timezone"]);
  const horizon = [30, 60, 90].includes(Number(body.horizon_days)) ? Number(body.horizon_days) : 30;
  const timezone=resolveRequestTimeZone(body.timezone);
  const db = serviceClient(), requestStartedAt = new Date().toISOString();
  const priorSnapshots = await db.from("finance_planning_forecast_snapshots").select("*").eq("household_id", context.householdId).eq("horizon_days", horizon).eq("input_quality", "complete").order("request_started_at", { ascending: false }).limit(50);
  if (priorSnapshots.error) throw new Error(priorSnapshots.error.message);
  const priorSnapshot={data:(priorSnapshots.data??[]).find((s:any)=>forecastSnapshotTimeZone(s)===timezone)||null,error:null};
  const accountsPromise = suppliedAccounts ? Promise.resolve(suppliedAccounts) : householdAccounts(db, context.householdId);
  const recurringWork = (suppliedRecurring ? Promise.resolve(suppliedRecurring) : recurringResponse(context, priorSnapshot.data, accountsPromise,{cacheOnly:options.cacheOnly===true,timeZone:timezone})).catch(() => ({ generated_at: new Date().toISOString(), streams: [], warnings: ["Saved recurring inputs are unavailable; using the last verified forecast when possible."], coverage: { complete: false, sources: [{ status: "failed", reason: "provider_unavailable", expected: true }] } }));
  const optionalRows=(query:any)=>Promise.race([Promise.resolve(query).catch((error:any)=>({data:null,error:{message:String(error?.message??"query failed")}})),new Promise((resolve)=>setTimeout(()=>resolve({data:null,error:{message:"timed out"}}),350))]);
  const [recurring, accounts, mappingsResult, goalsResult, auditResult,activeJobResult] = await Promise.all([
    recurringWork, accountsPromise,
    db.from("finance_canonical_account_sources").select("source_account_id,canonical_account_id").eq("household_id", context.householdId),
    optionalRows(db.from("finance_planning_goals").select("*").eq("household_id", context.householdId).eq("active", true).order("created_at")),
    optionalRows(db.from("finance_audit_events").select("action,entity_type,entity_id,metadata,created_at").eq("household_id", context.householdId).order("created_at", { ascending: false }).limit(20)),
    optionalRows(db.from("finance_recurring_refresh_jobs").select("job_id,status,needs_recompute,requested_generation,claimed_generation,updated_at,completed_at").eq("household_id",context.householdId).order("updated_at",{ascending:false}).limit(1).maybeSingle()),
  ]);
  let refreshQueuePending=false;
  if(options.cacheOnly&&options.queueRefresh!==false&&Array.isArray(recurring.refresh_item_ids)&&recurring.refresh_item_ids.length){
    const queued=await optionalRows(db.rpc("finance_enqueue_recurring_refresh",{p_household_id:context.householdId,p_input_revision:"source-cache-v1",p_item_ids:recurring.refresh_item_ids}));
    refreshQueuePending=!queued.error;
  }
  if (mappingsResult.error) throw new Error(mappingsResult.error.message);
  const canonicalSources = mappingsResult.data ?? [];
  const cashAccounts = accounts.filter((row: any) => row.type === "depository" && row.lifecycle_status !== "closed");
  const scopeAccounts = accounts.filter((row:any)=>["depository","credit"].includes(String(row.type).toLowerCase())&&row.lifecycle_status!=="closed");
  const nowMs=Date.now(),balanceFresh=(row:any)=>row.current_balance!==null&&row.current_balance!==undefined&&row.current_balance!==""&&Number.isFinite(Number(row.current_balance))&&Number.isFinite(Date.parse(row.balance_updated_at??""))&&nowMs-Date.parse(row.balance_updated_at)<=36*60*60*1000&&nowMs-Date.parse(row.balance_updated_at)>=0;
  const allBalancesKnown=cashAccounts.length>0&&cashAccounts.every(balanceFresh);
  const accountStates = scopeAccounts.map((row: any) => ({ canonical_account_id: row.canonical_account_id, account_id: row.account_id, item_id: row.item_id, type: row.type, balance: row.type === "depository"&&row.current_balance!==null&&row.current_balance!==undefined ? round(Number(row.current_balance)) : null, balance_updated_at:row.balance_updated_at??null, lifecycle_status: row.lifecycle_status ?? "active" })).sort((a: any,b: any)=>String(a.canonical_account_id).localeCompare(String(b.canonical_account_id)));
  const currentScope = canonicalForecastScope(accountStates, canonicalSources);
  if (!currentScope) throw new Error("A connected cash account could not be matched to its verified household account identity.");
  const startingBalance = cashAccounts.every((row:any)=>row.current_balance!==null&&row.current_balance!==undefined&&row.current_balance!==""&&Number.isFinite(Number(row.current_balance)))?round(cashAccounts.reduce((sum: number, row: any) => sum + Number(row.current_balance), 0)):null;
  const balanceForCalculation=startingBalance??0;
  const startDate=calendarDate(new Date(),timezone),start = new Date(startDate+"T00:00:00Z"); const end = new Date(start); end.setUTCDate(end.getUTCDate() + horizon);
  const streamStates = recurring.streams.map((stream: any) => ({ key: stream.stream_key, name: String(stream.description ?? "Recurring activity").slice(0, 120), kind: planningStreamKind(stream), active: stream.is_active === true && stream.include_in_forecast !== false && stream.primary_eligible!==false, flow: stream.flow_type, amount: stream.expected_amount==null?null:round(Math.abs(finite(stream.expected_amount))), frequency: stream.frequency, next_date: stream.predicted_next_date ?? null, account_id: stream.account_id ?? null }));
  const priorStates = new Map((Array.isArray(priorSnapshot.data?.stream_states) ? priorSnapshot.data.stream_states : []).filter(record).map((stream: any) => [stream.key, stream]));
  const incomeReview = streamStates.filter(stream => stream.kind === "income" && !stream.active && priorStates.get(stream.key)?.active === true).map(stream => `Recurring income needs review: ${stream.name} is no longer included in the forecast.`);
  const ignoredTransfers = recurring.streams.filter((stream: any) => stream.is_active && stream.include_in_forecast !== false && planningStreamKind(stream) === "internal-transfer");
  const events=recurring.streams.flatMap((stream:any)=>buildStreamOccurrences(stream,startDate,addForecastDays(dateOnly(end),1))).map((occurrence:any)=>({...occurrence,name:occurrence.description,account_name:occurrence.account_name,amount:occurrence.flow_type==="inflow"?occurrence.amount:-occurrence.amount}));
  // Recurring streams alone assume zero discretionary spending. Reuse the
  // deterministic budget coach and add only projected variable spend that is
  // not already represented by known recurring reserves.
  let variableSpend:any=options.precomputedVariableSpend??{status:"unavailable",amount:null,categories:[],revision:null},projectedVariableSpend=0, variableSpendCategories:any[]=[];
  try {
    if(!options.precomputedVariableSpend)variableSpend=await buildProjectedVariableSpend(db,context,recurring,timezone);
    projectedVariableSpend=round(Number(variableSpend.amount));variableSpendCategories=variableSpend.categories;
    if(projectedVariableSpend>0){
      const monthEnd=new Date(Date.UTC(Number(startDate.slice(0,4)),Number(startDate.slice(5,7)),0,12)).toISOString().slice(0,10);
      const eventDate=monthEnd>=startDate&&monthEnd<=dateOnly(end)?monthEnd:dateOnly(end);
      events.push({stream_key:"forecast:variable-spend:"+startDate.slice(0,7),date:eventDate,description:"Projected variable spending",name:"Projected variable spending",account_name:"Budget forecast",flow_type:"outflow",amount:-projectedVariableSpend,forecast_adjustment:true,categories:variableSpendCategories});
    }
  } catch (error) { variableSpend={status:"unavailable",amount:null,categories:[],revision:null};console.warn("Variable spending forecast inputs are unavailable.",{reason:variableSpendFailureCode(error)}); }
  events.sort((a, b) => a.date.localeCompare(b.date));
  const datedSeries=buildDatedForecast(startDate,horizon,balanceForCalculation,events);
  const {points}=datedSeries,balance=datedSeries.ending_balance,low=datedSeries.projected_low,high=datedSeries.projected_high;
  const goals = (goalsResult.data ?? []).map((goal: any) => ({ ...goal, target_amount: finite(goal.target_amount), current_amount: finite(goal.current_amount), monthly_contribution: finite(goal.monthly_contribution), apr: goal.apr == null ? null : finite(goal.apr) }));
  const informationalWarnings = [...incomeReview];
  if(projectedVariableSpend>0) informationalWarnings.push(`Projected month-end cash includes ${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(projectedVariableSpend)} of expected non-recurring flexible spending.`);
  if (ignoredTransfers.length) informationalWarnings.push(`${ignoredTransfers.length} internal transfer ${ignoredTransfers.length === 1 ? "stream was" : "streams were"} excluded from the household cash forecast.`);
  const latestJob=activeJobResult.data??null;
  const updatePending=(latestJob&&(["queued","running"].includes(latestJob.status)||latestJob.needs_recompute===true))||refreshQueuePending;
  const refreshGeneration=options.expectedRefreshGeneration??latestJob?.requested_generation??0;
  const refreshJobId=options.expectedRefreshJobId??latestJob?.job_id??null;
  const refreshGenerationStable=options.expectedRefreshGeneration===undefined||latestJob?.job_id===options.expectedRefreshJobId&&Number(latestJob?.requested_generation)===options.expectedRefreshGeneration;
  const complete = recurring.coverage?.complete === true && allBalancesKnown && variableSpend.status==="available"&&refreshGenerationStable;
  const fingerprint = forecastFingerprint(streamStates, events, startingBalance, currentScope, horizon, points);
  const cashScopeSourceStates=scopeAccounts.map((a:any)=>({canonical_account_id:a.canonical_account_id,account_id:a.account_id,type:a.type,lifecycle_status:a.lifecycle_status,current_balance:a.current_balance,balance_updated_at:a.balance_updated_at})).sort((a:any,b:any)=>String(a.canonical_account_id).localeCompare(String(b.canonical_account_id)));
  const accountScopeKey=await digestAgent(JSON.stringify(cashScopeSourceStates.map((item:any)=>String(item.canonical_account_id||'')).filter(Boolean).sort()));
  const contextInputs={series_contract:FORECAST_SERIES_CONTRACT,scope:currentScope,accounts:accountStates.map((a:any)=>[a.canonical_account_id,a.type,a.lifecycle_status,a.balance]),configuration:recurring.configuration_revision??"",horizon,timezone,start_date:startDate};
  const contextRevision=hashText(JSON.stringify(contextInputs));
  const revisionInputs={...contextInputs,events:events.map((e:any)=>[e.stream_key,e.date,e.amount,e.flow_type,e.categories??null]).sort((a:any,b:any)=>String(a[0]).localeCompare(String(b[0]))||String(a[1]).localeCompare(String(b[1]))),variable_spend:{revision:variableSpend.revision,amount:variableSpend.amount,categories:variableSpendCategories.map((c:any)=>[c.id,c.remaining])}};
  const inputRevision=hashText(JSON.stringify(revisionInputs));
  const changes = [...incomeReview, ...(ignoredTransfers.length ? ["Internal transfer streams excluded from forecast."] : [])];
  const previous = priorSnapshot.data;
  const provenance=recurring.coverage?.sources??[];
  const sourceRevision=await digestAgent(JSON.stringify(provenance.map((source:any)=>[source.item_id,source.fetched_at??null,source.expected===true]).sort((a:any,b:any)=>String(a[0]).localeCompare(String(b[0])))));
  const sourceTimes=[...provenance.filter((source:any)=>source.expected&&source.fetched_at).map((source:any)=>Date.parse(source.fetched_at)),...cashAccounts.map((account:any)=>Date.parse(account.balance_updated_at??""))].filter(Number.isFinite);
  const sourceAsOf=sourceTimes.length?new Date(Math.min(...sourceTimes)).toISOString():null;
  const lastVerifiedFor=(snapshot:any)=>{
    const generated=Date.parse(snapshot?.generated_at??"");
    const savedForecastInputs=snapshot?.source_provenance?.forecast_inputs;
    const revisionMatches=variableSpend.status==="available"?snapshot?.input_revision===inputRevision:savedForecastInputs?.context_revision===contextRevision;
    if(!verifiedDatedSnapshot(snapshot)||!revisionMatches||!Number.isFinite(generated)||Date.now()-generated>48*60*60*1000||Date.now()<generated)return null;
    if(!sameScope(snapshot))return null;
    const datedPoints=Array.isArray(snapshot.points)?snapshot.points:[];
    if(!datedPoints.length||datedPoints.some((point:any)=>!/^\d{4}-\d{2}-\d{2}$/.test(String(point?.date??""))||point.balance===null||point.balance===""||!Number.isFinite(Number(point.balance))))return null;
    return {generated_at:snapshot.generated_at,horizon_days:snapshot.horizon_days,start_date:datedPoints[0]?.date??null,end_date:datedPoints.at(-1)?.date??null,input_revision:snapshot.input_revision,source_provenance:snapshot.source_provenance?.sources??[],starting_balance:snapshot.starting_balance,projected_low:snapshot.projected_low,projected_high:Math.max(...datedPoints.map((point:any)=>Number(point.balance)).filter(Number.isFinite),Number(snapshot.starting_balance)||0),ending_balance:snapshot.ending_balance,points:datedPoints,events:snapshot.events??[],variable_spend:savedForecastInputs?.variable_spend??null};
  };
  const priorComparable=verifiedDatedSnapshot(previous)&&previous.points?.[0]?.date===startDate&&previous.points?.at(-1)?.date===dateOnly(end)&&forecastScopeMatches(previous,currentScope,canonicalSources);
  const economicChanges=!priorComparable?[]:previous?.input_revision===inputRevision&&Array.isArray(previous?.source_provenance?.forecast_inputs?.economic_changes)?previous.source_provenance.forecast_inputs.economic_changes:forecastEconomicChanges(previous,{accountStates,events,variableSpend});
  const optionalWarnings=[...(goalsResult.error?["Planning goals are temporarily unavailable."]:[]),...(auditResult.error?["Recent planning activity is temporarily unavailable."]:[])];
  const sameScope=(snapshot:any)=>verifiedDatedSnapshot(snapshot)!==null&&isTrustedForecast(snapshot)&&forecastScopeMatches(snapshot,currentScope,canonicalSources);
  const sameRefreshGeneration=(snapshot:any)=>snapshot?.source_provenance?.forecast_inputs?.refresh_job_id===refreshJobId&&Number(snapshot?.source_provenance?.forecast_inputs?.refresh_generation)===Number(refreshGeneration);
  if (complete) {
    const concurrentResult=await db.from("finance_planning_forecast_snapshots").select("*").eq("household_id",context.householdId).eq("horizon_days",horizon).eq("input_quality","complete").order("request_started_at",{ascending:false}).limit(50);
    if(concurrentResult.error)throw new Error(concurrentResult.error.message);
    const concurrent=(concurrentResult.data??[]).find((s:any)=>forecastSnapshotTimeZone(s)===timezone&&Date.parse(s.request_started_at||s.generated_at)>Date.parse(requestStartedAt));
    if(concurrent){
      const latest=concurrent;
      if(sameScope(latest)&&latest.input_revision===inputRevision&&sameRefreshGeneration(latest))return {series_contract:FORECAST_SERIES_CONTRACT,low_date:datedSeries.low_date,ready:true,state:updatePending?"updating":"current",complete:true,reliable:true,current_for_forecast:true,verified_at:new Date().toISOString(),stale:false,generated_at:latest.generated_at,request_started_at:latest.request_started_at,horizon_days:latest.horizon_days,input_revision:latest.input_revision,source_revision:latest.source_provenance?.source_revision??null,account_scope_key:latest.source_provenance?.forecast_inputs?.account_scope_key??accountScopeKey??null,cash_scope_currency:latest.source_provenance?.forecast_inputs?.cash_scope_currency??null,cash_scope_currency_verified:latest.source_provenance?.forecast_inputs?.cash_scope_currency_verified===true,source_as_of:sourceAsOf,source_provenance:latest.source_provenance?.sources??latest.coverage?.sources??[],starting_balance:latest.starting_balance,projected_low:latest.projected_low,projected_high:Math.max(...(latest.points||[]).map((p:any)=>Number(p.balance)||0),Number(latest.starting_balance)||0),ending_balance:latest.ending_balance,points:latest.points||[],events:latest.events||[],variable_spend:latest.source_provenance?.forecast_inputs?.variable_spend??null,economic_changes:latest.source_provenance?.forecast_inputs?.economic_changes??[],goals,audit:auditResult.data||[],last_verified:null,warnings:optionalWarnings,coverage:{complete:true,sources:latest.coverage?.sources||[]}};
      return {ready:false,complete:false,reliable:false,current_for_forecast:false,stale:false,generated_at:new Date().toISOString(),attempted_at:requestStartedAt,horizon_days:horizon,starting_balance:null,projected_low:null,projected_high:null,ending_balance:null,points:[],events:[],variable_spend:{status:"unavailable",amount:null,categories:[],revision:null},economic_changes:[],goals,audit:auditResult.data||[],warnings:["A newer forecast uses a different connected account scope."],coverage:{complete:false,scope_changed:true}};
    }
    if (previous?.event_fingerprint !== fingerprint || previous?.input_revision !== inputRevision || !sameRefreshGeneration(previous) || previous?.source_provenance?.forecast_inputs?.cash_scope_currency_verified === undefined || JSON.stringify(previous?.source_provenance?.forecast_inputs?.cash_scope_source_states)!==JSON.stringify(cashScopeSourceStates)) {
      const { error } = await db.from("finance_planning_forecast_snapshots").insert({ household_id: context.householdId, horizon_days: horizon, request_started_at: requestStartedAt, input_quality: "complete", input_revision:inputRevision,source_provenance:{sources:provenance,source_revision:sourceRevision,balances_checked_at:new Date().toISOString(),forecast_inputs:{series_contract:FORECAST_SERIES_CONTRACT,timezone,context_revision:contextRevision,refresh_job_id:refreshJobId,refresh_generation:refreshGeneration,cash_scope_source_states:cashScopeSourceStates,account_scope_key:accountScopeKey,cash_scope_currency:"USD",cash_scope_currency_verified:cashAccounts.every((a:any)=>a.balance_currency_code==="USD")&&recurring.streams.filter((s:any)=>s.is_active===true&&s.include_in_forecast!==false&&s.primary_eligible!==false).every((s:any)=>s.currency_code==="USD"&&s.source_currency_verified===true),variable_spend:variableSpend,economic_changes:economicChanges}},coverage: { complete: true, sources: recurring.coverage?.sources ?? [], scope_changed: false }, account_states: accountStates, starting_balance: startingBalance, projected_low: round(low), ending_balance: round(balance), event_fingerprint: fingerprint, stream_states: streamStates, events, points, change_summary: changes });
      if (error) console.error("Could not store forecast evidence", error.message);
    }
    return { series_contract:FORECAST_SERIES_CONTRACT,low_date:datedSeries.low_date,ready: true, state:updatePending?"updating":"current", complete: true, reliable: true,current_for_forecast:true,verified_at:new Date().toISOString(),stale: false, generated_at: new Date().toISOString(), request_started_at: requestStartedAt, horizon_days: horizon,input_revision:inputRevision,source_revision:sourceRevision,account_scope_key:accountScopeKey,cash_scope_currency:"USD",cash_scope_currency_verified:cashAccounts.every((a:any)=>a.balance_currency_code==="USD")&&recurring.streams.filter((s:any)=>s.is_active===true&&s.include_in_forecast!==false&&s.primary_eligible!==false).every((s:any)=>s.currency_code==="USD"&&s.source_currency_verified===true),source_as_of:sourceAsOf,source_provenance:provenance,variable_spend:variableSpend,economic_changes:economicChanges,starting_balance: startingBalance, projected_low: round(low), projected_high: round(high), ending_balance: round(balance), points, events, goals, audit: auditResult.data ?? [],last_verified:null, warnings: [...informationalWarnings,...optionalWarnings], forecast_changes: changes, coverage: { complete: true, scope_changed: false, sources: recurring.coverage?.sources ?? [] } };
  }
  const incompleteResult=await db.from("finance_planning_forecast_snapshots").select("event_fingerprint,source_provenance").eq("household_id",context.householdId).eq("horizon_days",horizon).eq("input_quality","incomplete").order("request_started_at",{ascending:false}).limit(50);
  if(incompleteResult.error)throw new Error(incompleteResult.error.message);
  const lastIncomplete=(incompleteResult.data??[]).find((s:any)=>forecastSnapshotTimeZone(s)===timezone);
  if(lastIncomplete?.event_fingerprint!==fingerprint)await db.from("finance_planning_forecast_snapshots").insert({ household_id: context.householdId, horizon_days: horizon, request_started_at: requestStartedAt, input_quality: "incomplete", input_revision:inputRevision,source_provenance:{sources:provenance,source_revision:sourceRevision,forecast_inputs:{series_contract:FORECAST_SERIES_CONTRACT,timezone,context_revision:contextRevision,variable_spend:{status:"unavailable",amount:null,categories:[],revision:null},economic_changes:[]}},coverage: { complete: false, sources: recurring.coverage?.sources ?? [], attempted_scope: currentScope }, account_states: accountStates, starting_balance: startingBalance, projected_low: round(low), ending_balance: round(balance), event_fingerprint: fingerprint, stream_states: streamStates, events, points, change_summary: ["Incomplete source read; excluded from trusted forecasts."] });
  const latestResult=await db.from("finance_planning_forecast_snapshots").select("*").eq("household_id",context.householdId).eq("horizon_days",horizon).eq("input_quality","complete").order("request_started_at",{ascending:false}).limit(50);
  if(latestResult.error)throw new Error(latestResult.error.message);
  const verified=(latestResult.data??[]).find((s:any)=>forecastSnapshotTimeZone(s)===timezone)||null;
  const lastVerified=lastVerifiedFor(verified);
  if (lastVerified) return { ready: true,state:"last_verified",complete:false,reliable:false,current_for_forecast:false,stale:true,generated_at:lastVerified.generated_at,attempted_at:requestStartedAt,horizon_days:lastVerified.horizon_days,input_revision:lastVerified.input_revision,source_revision:sourceRevision,source_as_of:sourceAsOf,source_provenance:lastVerified.source_provenance??[],variable_spend:lastVerified.variable_spend,economic_changes:[],starting_balance:lastVerified.starting_balance,projected_low:lastVerified.projected_low,projected_high:lastVerified.projected_high,ending_balance:lastVerified.ending_balance,points:lastVerified.points,events:lastVerified.events,last_verified:lastVerified,goals,audit:auditResult.data??[],warnings:[variableSpend.status!=="available"?"The current variable-spending estimate is unavailable; showing the last verified forecast.":!allBalancesKnown?"One or more cash balances are missing or older than 36 hours.":"Recurring inputs are missing or older than 24 hours.",...optionalWarnings],coverage:{complete:false,stale:true,scope_changed:false,failed_sources:provenance.filter((source:any)=>source.status==="failed").map((source:any)=>({institution_name:source.institution_name,reason:source.reason}))}};
  return { ready: false,state:"unavailable",complete:false,reliable:false,current_for_forecast:false,stale:false,generated_at:new Date().toISOString(),attempted_at:requestStartedAt,horizon_days:horizon,input_revision:null,source_as_of:sourceAsOf,source_provenance:provenance,variable_spend:{status:"unavailable",amount:null,categories:[],revision:null},starting_balance:null,projected_low:null,projected_high:null,ending_balance:null,points:[],events:[],last_verified:null,goals,audit:auditResult.data??[],warnings:[verified?"Current inputs changed or account scope differs; no matching verified forecast is available.":"Recurring or variable-spending data is incomplete and no verified forecast is available.",...optionalWarnings],coverage:{complete:false,scope_changed:!!verified,failed_sources:provenance.filter((source:any)=>source.status==="failed").map((source:any)=>source.reason)}};
}

async function verifiedForecastComparison(db:any,context:Context,current:any){
 const unavailable={status:'unavailable',projected_low_delta:null,reason:'incomparable_snapshots'};
 if(!verifiedDatedSnapshot(current))return unavailable;
 try{const {data,error}=await db.from('finance_planning_forecast_snapshots').select('*').eq('household_id',context.householdId).eq('horizon_days',current.horizon_days).eq('input_quality','complete').lt('generated_at',current.generated_at).order('generated_at',{ascending:false}).limit(50);if(error)return unavailable;
 for(const prior of data??[]){const comparison=compareVerifiedForecasts(prior,current);if(comparison.status==='available')return comparison;}return unavailable;
 }catch{return unavailable;}
}
async function planningHistoryResponse(context: Context, body: Row) {
  only(body, ["action", "household_id", "horizon_days", "days", "timezone"]);
  const horizon = [30,60,90].includes(Number(body.horizon_days)) ? Number(body.horizon_days) : 30;
  const days = Math.max(1, Math.min(14, Math.floor(Number(body.days) || 2)));
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await serviceClient().from("finance_planning_forecast_snapshots").select("household_id,generated_at,request_started_at,input_quality,input_revision,source_provenance,account_states,coverage,horizon_days,starting_balance,projected_low,ending_balance,stream_states,events,points").eq("household_id", context.householdId).eq("horizon_days", horizon).gte("generated_at", from).order("generated_at", { ascending: false }).limit(41);
  if (error) throw new Error(error.message);
  const raw = (data ?? []).slice(0,40).reverse(), truncated = (data ?? []).length > 40;
  const result=summarizePlanningHistory(raw,horizon,truncated,resolveRequestTimeZone(body.timezone));
  return {...result,range_start:result.range_start??null,range_end:result.range_end??null};
}

async function saveGoal(context: Context, body: Row) {
  only(body, ["action", "household_id", "goal_id", "goal_type", "goal_category", "deadline_date", "request_key", "name", "target_amount", "current_amount", "monthly_contribution", "linked_account_id", "apr", "automatic"]);
  const type = string(body.goal_type, "goal_type", 12); if (!["save", "debt"].includes(type)) throw new RequestError("goal_type must be save or debt.");
  const category=body.goal_category===undefined?"general":string(body.goal_category,"goal_category",32);
  if(!["emergency","vacation","home_down_payment","major_purchase","general","retirement","custom"].includes(category))throw new RequestError("Choose a supported goal category.");
  const requestKey=body.request_key===undefined?null:string(body.request_key,"request_key",100);if(requestKey&&requestKey.length<8)throw new RequestError("request_key must have at least eight characters.");
  const name=string(body.name,"name",80),target=money(body.target_amount,"target_amount");if(target<=0)throw new RequestError("target_amount must be greater than zero.");
  const current=money(body.current_amount??0,"current_amount"),monthly=money(body.monthly_contribution??0,"monthly_contribution"),deadline=date(body.deadline_date,"deadline_date");
  const values: Row = { household_id: context.householdId, goal_type: type, goal_category:category, deadline_date:deadline, name, target_amount:target, current_amount:current, monthly_contribution:monthly, linked_account_id: nullableString(body.linked_account_id, "linked_account_id", 240), apr: body.apr == null ? null : percentage(body.apr, "apr"), automatic: body.automatic === undefined ? false : boolean(body.automatic, "automatic"), updated_by: context.userId, updated_at: new Date().toISOString() };
  const db = serviceClient(); let goal;
  if (body.goal_id) { const goalId = uuid(body.goal_id, "goal_id"); const prior=await db.from("finance_planning_goals").select("tracking_mode,goal_type").eq("household_id",context.householdId).eq("goal_id",goalId).eq("active",true).maybeSingle();if(prior.error)throw new Error(prior.error.message);if(!prior.data)throw new RequestError("Goal not found.",404);if(prior.data.goal_type!==type)throw new RequestError("A goal type cannot be changed after creation.",409);if(prior.data.tracking_mode!=="manual"&&body.current_amount!==undefined)throw new RequestError("This goal’s progress is tracked from verified account balances and reviewed transfers. Update its linked-account allocation or review savings activity instead.",409);const update:Row={updated_by:context.userId,updated_at:new Date().toISOString(),name,target_amount:target};for(const key of ["goal_category","deadline_date","monthly_contribution","linked_account_id","apr","automatic"])if(body[key]!==undefined)update[key]=values[key];if(prior.data.tracking_mode==="manual"&&body.current_amount!==undefined)update.current_amount=current;let query=db.from("finance_planning_goals").update(update).eq("household_id", context.householdId).eq("goal_id", goalId).eq("active", true);if(prior.data.tracking_mode==="manual"&&body.current_amount!==undefined)query=query.eq("tracking_mode","manual");const result = await query.select().maybeSingle(); if (result.error) throw new Error(result.error.message); if (!result.data) throw new RequestError(body.current_amount!==undefined?"Goal tracking changed while saving. Refresh the goal and try again.":"Goal not found.", 409); goal = result.data; }
  else {
    values.created_by = context.userId;
    if(requestKey){values.creation_request_key=requestKey;values.creation_request_payload={goal_type:type,goal_category:category,deadline_date:deadline,name,target_amount:target,current_amount:current,monthly_contribution:monthly};const prior=await db.from("finance_planning_goals").select("*").eq("household_id",context.householdId).eq("creation_request_key",requestKey).maybeSingle();if(prior.error)throw new Error(prior.error.message);if(prior.data){if(!sameGoalCreationPayload(prior.data.creation_request_payload,values.creation_request_payload))throw new RequestError("This goal request key was already used for different values.",409);goal=prior.data;}}
    if(!goal){const result = await db.from("finance_planning_goals").insert(values).select().single();if(result.error){if(requestKey&&/duplicate key|unique constraint/i.test(result.error.message)){const replay=await db.from("finance_planning_goals").select("*").eq("household_id",context.householdId).eq("creation_request_key",requestKey).maybeSingle();if(replay.error)throw new Error(replay.error.message);if(replay.data){if(!sameGoalCreationPayload(replay.data.creation_request_payload,values.creation_request_payload))throw new RequestError("This goal request key was already used for different values.",409);goal=replay.data;}}if(!goal)throw new Error(result.error.message);}else goal=result.data;}
  }
  await audit(db, context, body.goal_id ? "update" : "create", "planning_goal", goal.goal_id, { name: goal.name, goal_type: goal.goal_type });
  return { goal };
}

async function deactivateGoal(context: Context, body: Row) {
  only(body, ["action", "household_id", "goal_id"]); const goalId = uuid(body.goal_id, "goal_id"), db = serviceClient();
  const { data, error } = await db.from("finance_planning_goals").update({ active: false, updated_by: context.userId, updated_at: new Date().toISOString() }).eq("household_id", context.householdId).eq("goal_id", goalId).eq("active", true).select().maybeSingle();
  if (error) throw new Error(error.message); if (!data) throw new RequestError("Goal not found.", 404);
  await audit(db, context, "deactivate", "planning_goal", goalId, { name: data.name }); return { goal: data };
}

async function listFinancialPlans(context:Context){
 const {data:reconciled,error:reconcileError}=await serviceClient().rpc('reconcile_financial_plan_lifecycle',{p_household_id:context.householdId,p_user_id:context.userId});
 if(reconcileError)throw new Error(reconcileError.message);
 if(Number(reconciled)>0)await refreshAgentState(context);
 const db=serviceClient(),[{data,error},committed,revision]=await Promise.all([db.from('finance_household_plans').select('*').eq('household_id',context.householdId).neq('status','archived').order('updated_at',{ascending:false}).limit(30),db.from('finance_agent_state_snapshots').select('state_version').eq('household_id',context.householdId).maybeSingle(),db.rpc('finance_action_revision',{p_household_id:context.householdId})]);
 if(error||revision.error)throw new Error(error?.message||revision.error?.message);
 const plans=await Promise.all((data||[]).map(async(plan:any)=>{if(!committed.data?.state_version)return {...plan,latest:null,recommendation:null};const [result,recommendation]=await Promise.all([db.from('finance_plan_evaluations').select('snapshot,evaluated_at').eq('household_id',context.householdId).eq('plan_id',plan.plan_id).eq('plan_version',plan.version).eq('financial_state_version',committed.data.state_version).maybeSingle(),db.from('finance_plan_recommendations').select('*').eq('household_id',context.householdId).eq('plan_id',plan.plan_id).eq('plan_version',plan.version).eq('financial_state_version',committed.data.state_version).maybeSingle()]);return {...plan,latest:result.error?null:result.data?.snapshot||null,recommendation:recommendation.error?null:recommendation.data||null};}));
 return {plans,financial_state_version:committed.data?.state_version||null,financial_revision:revision.data||null};
}
async function listPlanScenarios(context:Context,body:Row){
 only(body,['action','household_id','plan_id']);const query=serviceClient().from('finance_plan_scenarios').select('scenario_id,plan_id,plan_version,financial_state_version,recommendation_id,selected_category_ids,scenario,status,created_at,expires_at').eq('household_id',context.householdId).gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false}).limit(20);
 const {data,error}=body.plan_id?await query.eq('plan_id',uuid(body.plan_id,'plan_id')):await query;if(error)throw new Error(error.message);return {scenarios:data||[]};
}
async function createPlanScenario(context:Context,body:Row){
 only(body,['action','household_id','plan_id','plan_version','state_version','recommendation_id','selected_category_ids']);
 const planId=uuid(body.plan_id,'plan_id'),planVersion=Number(body.plan_version),stateVersion=string(body.state_version,'state_version',160),recommendationId=string(body.recommendation_id,'recommendation_id',80),ids=body.selected_category_ids;
 if(!Number.isInteger(planVersion)||planVersion<1||!Array.isArray(ids)||ids.length<1||ids.length>12||ids.some((id:any)=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new RequestError('Choose one or more unique current adjustments.',400);
 const refreshed=await refreshAgentState(context),db=serviceClient(),version=String(refreshed.agent_state?.financial_state_version||'');
 if(version!==stateVersion)throw new RequestError('The recommendation changed. Reload before exploring it.',409);
 const [{data:snapshot,error:snapshotError},{data:plans,error:plansError},{data:goals,error:goalsError}]=await Promise.all([
  db.from('finance_agent_state_snapshots').select('state_version,snapshot').eq('household_id',context.householdId).maybeSingle(),
  db.from('finance_household_plans').select('*').eq('household_id',context.householdId).neq('status','draft'),
  db.from('finance_planning_goals').select('goal_id,name,goal_type,current_amount,target_amount,monthly_contribution,updated_at,active').eq('household_id',context.householdId).eq('active',true)
 ]);
 if(snapshotError||plansError||goalsError||snapshot?.state_version!==stateVersion)throw new RequestError('Planning state changed. Reload the current plan.',409);
 const plansNow=plans||[],plan=plansNow.find((item:any)=>item.plan_id===planId);if(!plan||plan.version!==planVersion||plan.status!=='active')throw new RequestError('Plan changed. Reload its current recommendation.',409);
 const {data:recommendation,error:recommendationError}=await db.from('finance_plan_recommendations').select('*').eq('household_id',context.householdId).eq('plan_id',planId).eq('plan_version',planVersion).eq('financial_state_version',stateVersion).maybeSingle();
 if(recommendationError||!recommendation||recommendation.recommendation_id!==recommendationId)throw new RequestError('Recommendation changed. Reload before exploring it.',409);
 const financialState=await consistentPlanFinancialState(db,context);financialState.financialStateVersion=stateVersion;
 const versions=plansNow.map((item:any)=>({plan_id:item.plan_id,version:item.version,status:item.status})).sort((a:any,b:any)=>String(a.plan_id).localeCompare(String(b.plan_id)));
 const snapshotVersions=[...(snapshot.snapshot?.plan_versions||[])].sort((a:any,b:any)=>String(a.plan_id).localeCompare(String(b.plan_id)));
 if(JSON.stringify(versions)!==JSON.stringify(snapshotVersions))throw new RequestError('Another household plan changed. Refresh Planning and compare again.',409);
 const result=buildPlanScenario({householdId:context.householdId,activeHouseholdId:context.householdId,recommendation,plan,financialState,goals:goals||[],allPlans:plansNow,selection:{recommendationId,planVersion,stateVersion,adjustmentIds:ids}});
 if(!result.ok)throw new RequestError(result.message,409);
 const {data:row,error}=await db.rpc('save_finance_plan_scenario',{p_household_id:context.householdId,p_user_id:context.userId,p_values:{plan_id:planId,plan_version:planVersion,financial_state_version:stateVersion,financial_revision:financialState.financialRevision,recommendation_id:recommendationId,selected_category_ids:ids,plan_versions:versions,scenario:result.scenario}});
 if(error)throw new RequestError(error.message,409);return {scenario:row};
}
async function saveFinancialPlan(context:Context,body:Row){
 only(body,['action','household_id','plan_id','expected_version','client_request_id','goal_id','new_goal','goal_update','name','plan_type','status','priority','target_monthly','baseline_monthly','floor_amount','category_ids','constraints','starts_on','ends_on','confirm']);
 const db=serviceClient(),type=string(body.plan_type,'plan_type',30),status=string(body.status,'status',20);
 if(!['savings','spending_reduction','cash_floor'].includes(type)||!['draft','active','paused','completed','ended','archived'].includes(status))throw new RequestError('Invalid plan type or status.');
 if(status==='active'&&body.confirm!==true)throw new RequestError('Review and confirm before activating a household plan.');
 if(status==='completed'&&body.confirm!==true)throw new RequestError('Confirm that this plan is complete.');
 const priority=body.priority==null?(body.plan_id?null:3):body.priority;if(priority!==null&&(!Number.isInteger(priority)||priority<1||priority>5))throw new RequestError('Choose a plan priority from 1 to 5.');
 const planId=body.plan_id?uuid(body.plan_id,'plan_id'):null,expected=body.expected_version,requestId=body.client_request_id?uuid(body.client_request_id,'client_request_id'):null;
 if(!planId&&!['draft','active'].includes(status))throw new RequestError('Create an active plan or a draft.');
 if(status==='ended'&&!planId)throw new RequestError('Only an existing ended plan can be edited.');
 if(planId&&(!Number.isInteger(expected)||Number(expected)<1)||!planId&&expected!=null)throw new RequestError('Refresh this plan before saving.',409);
 const starts=date(body.starts_on,'starts_on'),ends=date(body.ends_on,'ends_on');
 if(!starts||!ends||ends<starts||Date.parse(ends+'T00:00:00Z')-Date.parse(starts+'T00:00:00Z')>5*366*86400000)throw new RequestError('Choose a valid plan period within five years.');
 if(status==='active'&&ends<new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))throw new RequestError('An ended plan cannot be activated.');
 const amount=(raw:unknown,label:string,positive=true)=>{if(raw==null||raw==='')return null;const n=money(raw,label);if(n>1e9||(positive?n<=0:n<0))throw new RequestError(`${label} is invalid.`);return n;};
 const target=amount(body.target_monthly,'target_monthly'),baseline=amount(body.baseline_monthly,'baseline_monthly'),floor=amount(body.floor_amount,'floor_amount',false);
 if(type==='savings'&&!target||type==='spending_reduction'&&(!target||!baseline||target>=baseline)||type==='cash_floor'&&floor===null)throw new RequestError('Enter the required plan amounts.');
 const goalId=body.goal_id?uuid(body.goal_id,'goal_id'):null;
 let newGoal:Row|null=null;
 if(type==='savings'){
  if(goalId&&body.new_goal)throw new RequestError('Choose an existing goal or create a new one.');
  if(!goalId){
   if(planId||!requestId||!record(body.new_goal))throw new RequestError('Enter a new savings goal or choose an existing one.');
   newGoal={name:string(body.new_goal.name,'goal name',80),target_amount:amount(body.new_goal.target_amount,'goal target'),current_amount:amount(body.new_goal.current_amount??0,'tracked amount',false),monthly_contribution:target};
  }else{
   const {data:goal,error}=await db.from('finance_planning_goals').select('goal_id,goal_type,active').eq('household_id',context.householdId).eq('goal_id',goalId).maybeSingle();
   if(error||!goal||goal.goal_type!=='save'||goal.active!==true&&!(planId&&['paused','archived'].includes(status)))throw new RequestError('Choose an active savings goal.',409);
  }
 }else if(goalId){
  // Previously saved plans may retain a Phase 3A link; new plans are standalone.
  if(!planId&&requestId)throw new RequestError('This objective does not need a savings goal.');
 }else if(body.new_goal)throw new RequestError('Only a savings plan can create a goal.');
 if(!planId&&!requestId&&!goalId)throw new RequestError('Refresh Planning before creating a plan.',409);
 let goalUpdate:Row|null=null;
 if(body.goal_update!=null){
  if(type!=='savings'||!goalId||newGoal||!record(body.goal_update))throw new RequestError('A linked savings goal is required for this edit.');
  const update=body.goal_update;
  goalUpdate={target_amount:amount(update.target_amount,'goal target'),expected_target_amount:amount(update.expected_target_amount,'previous goal target',false),expected_monthly_contribution:amount(update.expected_monthly_contribution,'previous contribution',false),expected_current_amount:amount(update.expected_current_amount,'previous tracked amount',false)};
  if(Object.values(goalUpdate).some(value=>value===null))throw new RequestError('Refresh the savings goal before editing.',409);
 }
 const name=body.name?string(body.name,'plan name',80):newGoal?.name||null;
 if(!name&&!goalId)throw new RequestError('Name this plan.');
 const ids=body.category_ids??[];if(!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||id.length>80))throw new RequestError('Invalid plan categories.');
 if(type==='spending_reduction'&&!ids.length)throw new RequestError('Select a budget category.');
 const constraints=body.constraints??[];if(!Array.isArray(constraints)||constraints.length>30)throw new RequestError('Too many constraints.');
 const parsed=constraints.map((item:any)=>{if(!record(item)||!['cash_floor','protected_category','flexible_category','minimum_budget'].includes(item.kind)||!['hard','soft'].includes(item.level))throw new RequestError('Invalid constraint.');const expires=date(item.expires_on,'constraint expiry');if(expires&&expires<starts)throw new RequestError('Constraint expires before the plan begins.');if(item.kind==='cash_floor'){const value=amount(item.amount,'constraint amount',false);if(value===null)throw new RequestError('A cash floor needs an amount.');return {kind:item.kind,level:item.level,amount:value,expires_on:expires};}const id=uuid(item.category_id,'category_id');if(item.kind==='flexible_category'&&item.level!=='soft'||item.kind==='minimum_budget'&&item.level!=='hard')throw new RequestError('Invalid category flexibility rule.');if(item.kind==='minimum_budget'){const value=amount(item.amount,'minimum budget',false);if(value===null)throw new RequestError('A minimum budget needs an amount.');return {kind:item.kind,level:item.level,category_id:id,amount:value,expires_on:expires};}return {kind:item.kind,level:item.level,category_id:id,expires_on:expires};});
 const uniqueConstraints=new Set(parsed.map((item:any)=>`${item.kind}:${item.category_id??item.amount??''}`));if(uniqueConstraints.size!==parsed.length)throw new RequestError('Duplicate plan constraint.');
 const protectedIds=parsed.filter((item:any)=>item.kind==='protected_category').map((item:any)=>item.category_id);
 const flexibleIds=parsed.filter((item:any)=>item.kind==='flexible_category').map((item:any)=>item.category_id),minimumIds=parsed.filter((item:any)=>item.kind==='minimum_budget').map((item:any)=>item.category_id);
 if(type!=='spending_reduction'&&(flexibleIds.length||minimumIds.length))throw new RequestError('Category flexibility only applies to spending-reduction plans.');
 if(flexibleIds.some((id:string)=>!ids.includes(id))||minimumIds.some((id:string)=>!flexibleIds.includes(id)))throw new RequestError('Flexible categories and minimums must be within the spending-reduction categories.');
 const sameList=(left:unknown[],right:unknown[])=>JSON.stringify([...left].map(String).sort())===JSON.stringify([...right].map(String).sort());
 let unchangedLifecycleScope=false;
 if(planId&&['paused','archived','completed','ended'].includes(status)){
  const {data:storedPlan,error:storedError}=await db.from('finance_household_plans').select('version,category_ids,constraints').eq('household_id',context.householdId).eq('plan_id',planId).maybeSingle();
  if(storedError||!storedPlan)throw new RequestError('Refresh this plan before changing its lifecycle.',409);
  if(storedPlan.version!==expected)throw new RequestError('Plan changed. Refresh before saving.',409);
  const categoryRules=(values:any[])=>values.filter((item:any)=>['protected_category','flexible_category','minimum_budget'].includes(item.kind)).map((item:any)=>[item.kind,String(item.category_id||''),String(item.level||''),item.amount??null,item.expires_on??null]).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  unchangedLifecycleScope=sameList(Array.isArray(storedPlan.category_ids)?storedPlan.category_ids:[],ids)&&JSON.stringify(categoryRules(Array.isArray(storedPlan.constraints)?storedPlan.constraints:[]))===JSON.stringify(categoryRules(parsed));
 }
 const checkedIds=[...new Set([...ids,...protectedIds])];if(checkedIds.length&&!unchangedLifecycleScope){const {data,error}=await db.from('finance_budget_targets').select('budget_target_id,category').eq('household_id',context.householdId).eq('active',true).in('budget_target_id',checkedIds);if(error||data?.length!==checkedIds.length)throw new RequestError('Refresh the active budget categories before saving.',409);const names=[...new Set(data.map((target:any)=>target.category))],catalog=await db.from('finance_categories').select('category_name').eq('household_id',context.householdId).eq('active',true).eq('category_type','expense').eq('excluded_from_budget',false).in('category_name',names);if(catalog.error||new Set((catalog.data||[]).map((row:any)=>row.category_name)).size!==names.length)throw new RequestError('Refresh the active household category catalog before saving.',409);}
 // The household-locked RPC compares the stored creation payload on retries.
 const values={goal_id:goalId,new_goal:newGoal,...(goalUpdate?{goal_update:goalUpdate}:{}),name,client_request_id:requestId,plan_type:type,status,...(priority===null?{}:{priority}),completion_source:status==='completed'?'member_confirmed':null,target_monthly:target,baseline_monthly:baseline,floor_amount:floor,category_ids:ids,constraints:parsed,starts_on:starts,ends_on:ends};
 const {data,error}=await db.rpc('save_finance_household_plan',{p_household_id:context.householdId,p_user_id:context.userId,p_plan_id:planId,p_expected_version:planId?expected:null,p_values:values});
 if(error)throw new RequestError(error.message.includes('duplicate key')?'A current plan already uses this savings goal. Refresh Planning.':error.message,409);
 await audit(db,context,planId?'update':'create','financial_plan',data.plan_id,{status,version:data.version,goal_id:data.goal_id});
 return {plan:data};
}

export async function agentMemories(context: Context, today: string) {
 const db=serviceClient();
 const [personal,shared]=await Promise.all([
  db.from("finance_user_preferences").select("ask_folio_memories").eq("user_id",context.userId).maybeSingle(),
  db.from("finance_agent_memories").select("key,kind,summary,value,effectiveFrom:effective_from,effectiveUntil:effective_until,active").eq("household_id",context.householdId).eq("active",true)
 ]);
 if(personal.error||shared.error)throw new Error(personal.error?.message||shared.error?.message);
 const protectedCategories=activePermanentCategoryPreferences(shared.data,today);
 return {personal:activeAgentMemories(personal.data?.ask_folio_memories,today),shared:activeAgentMemories(shared.data,today),protectedCategories};
}
async function saveAgentMemory(context:Context, body:Row) {
 only(body,["action","household_id","key","kind","summary","value","effective_from","effective_until","active","confirm"]);
 if(body.confirm!==true)throw new RequestError("Confirm this household memory before saving.");
 const key=string(body.key,"key",80),kind=string(body.kind,"kind",20),summary=string(body.summary,"summary",280);
 if(!/^[a-z0-9:_-]{3,80}$/.test(key)||!["fact","preference","goal","decision"].includes(kind))throw new RequestError("Invalid memory type or key.");
 if(key.startsWith('budget_category_protection:')){
  const categoryId=uuid(key.slice('budget_category_protection:'.length),'category_id'),value=body.value;
  if(kind!=='preference'||!record(value)||value.category_id!==categoryId||value.scope!=='permanent'||value.source!=='explicit_rejection')throw new RequestError('Permanent category preferences must match the exact active budget category and scope.');
  const {data:target,error:targetError}=await serviceClient().from('finance_budget_targets').select('budget_target_id,category').eq('household_id',context.householdId).eq('budget_target_id',categoryId).eq('active',true).eq('currency_code','USD').maybeSingle();
  if(targetError)throw new Error(targetError.message);if(!target)throw new RequestError('This is not an active household budget category.',409);
  const {data:category,error:categoryError}=await serviceClient().from('finance_categories').select('category_id').eq('household_id',context.householdId).eq('category_name',target.category).eq('category_type','expense').eq('active',true).eq('excluded_from_budget',false).maybeSingle();
  if(categoryError)throw new Error(categoryError.message);if(!category)throw new RequestError('This category is no longer in the active household catalog.',409);
  if(!['Never suggest changing this budget category','Do not suggest changing this budget category'].includes(summary))throw new RequestError('Use the permanent category preference description.');
 }
 const from=date(body.effective_from,"effective_from"),until=date(body.effective_until,"effective_until");
 if(from&&until&&from>until)throw new RequestError("Memory end date precedes its start date.");
 if(key==="preferred_cash_floor"&&(typeof body.value!=="number"||!Number.isFinite(body.value)||body.value<0||body.value>1e9))throw new RequestError("Cash floor must be an explicit nonnegative amount.");
 if(JSON.stringify(body.value??null).length>2000)throw new RequestError("Memory value is too large.");
 const {data,error}=await serviceClient().from("finance_agent_memories").upsert({household_id:context.householdId,key,kind,summary,value:body.value??null,effective_from:from,effective_until:until,active:body.active!==false,source:"user_confirmed",updated_by:context.userId,updated_at:new Date().toISOString()},{onConflict:"household_id,key"}).select("key,kind,summary,effective_from,effective_until").single();
 if(error)throw new Error(error.message);return {saved:true,memory:data};
}
async function markAgentEvaluationVerified(context:Context,version:string){
 const result=await serviceClient().from('finance_agent_state_snapshots').update({evaluated_at:new Date().toISOString()}).eq('household_id',context.householdId).eq('state_version',version).select('state_version').maybeSingle();
 if(result.error||result.data?.state_version!==version)throw new RequestError('A newer financial evaluation completed. Retry with the latest state.',409);
 return listAgentEvents(context);
}
export async function evaluateAgentEvents(context: Context, raw: unknown, authoritative=false, evaluationOnly=false) {
 if (!record(raw)) throw new RequestError("Financial state must be an object.");
 const state={...raw,budget_timezone:DEFAULT_CALENDAR_TIME_ZONE};
 if(state.loading===true||state.error===true||state.budgetsReady!==true||state.recurringReady!==true||state.accountsReady!==true||!Array.isArray(state.budgets)||!Array.isArray(state.recurring)||!Array.isArray(state.accounts))throw new RequestError("Wait for complete household data.",409);
 if(state.budgets.length>300||state.recurring.length>300||state.accounts.length>300||JSON.stringify(state).length>1500000)throw new RequestError("Financial state exceeds limits.",413);
 const today=date(state.today,"today");if(!today||Math.abs(Date.now()-Date.parse(today+"T12:00:00Z"))>36*3600000)throw new RequestError("Current household date required.");
 const db=serviceClient();
 if(!evaluationOnly){const lifecycle=await db.rpc('reconcile_financial_plan_lifecycle',{p_household_id:context.householdId,p_user_id:context.userId});if(lifecycle.error)throw new Error(lifecycle.error.message);}
 // These notification facts are derived from persisted reconciled savings and
 // the saved forecast. Never accept savings notifications from a request body.
 delete state.savingsNotifications;delete state.savings_notifications;
 if(!evaluationOnly)try{const savingsTimezone=resolveRequestTimeZone(state.timezone||DEFAULT_CALENDAR_TIME_ZONE);const savings=await authoritativeSavingsNotifications(context,savingsTimezone);if(savings)state.savingsNotifications=savings;}catch{delete state.savingsNotifications;}
 const [prior,existing,goals,memory,plansResult]=await Promise.all([
  db.from("finance_agent_state_snapshots").select("snapshot,state_version").eq("household_id",context.householdId).maybeSingle(),
  db.from("finance_agent_events").select("*").eq("household_id",context.householdId).in("event_type",[...EVENT_TYPES]),
  db.from("finance_planning_goals").select("goal_id,name,goal_type,current_amount,target_amount,monthly_contribution,updated_at,active").eq("household_id",context.householdId).eq("active",true),
  agentMemories(context,today),
  db.from('finance_household_plans').select('*').eq('household_id',context.householdId).neq('status','draft')
 ]);
 if(prior.error||existing.error||goals.error||plansResult.error)throw new Error(prior.error?.message||existing.error?.message||goals.error?.message||plansResult.error?.message);
 // Browser-submitted event inputs never determine persisted financial-plan assessments.
 // The server builds complete canonical state only when a household has a live plan.
 const plans=plansResult.data||[];
 const planningMemories=[...memory.shared,...(memory.protectedCategories||[])];
 let planState:any=null;
 if(plans.some((p:any)=>p.status==='active')){
  if(authoritative)planState=state;
  else planState=await consistentPlanFinancialState(db,context);
  state.financialRevision=planState.financialRevision;
 }
 const currentRecommendationRows=plans.length?await db.from('finance_plan_recommendations').select('plan_id,plan_version,status,recommendation_id,declined_category_ids,financial_state_version,financial_revision,updated_at').eq('household_id',context.householdId).in('plan_id',plans.map((p:any)=>p.plan_id)).in('status',['active','partial','rejected']).order('updated_at',{ascending:false}).limit(200):{data:[],error:null};
 if(currentRecommendationRows.error)throw new Error(currentRecommendationRows.error.message);
 const currentVersions=new Map(plans.map((p:any)=>[p.plan_id,p.version])),priorRecommendations=new Map<string,any>();
 for(const row of currentRecommendationRows.data||[])if(currentVersions.get(row.plan_id)===row.plan_version&&row.financial_revision===(state.financialRevision||null)&&!priorRecommendations.has(row.plan_id))priorRecommendations.set(row.plan_id,row);
 const recommendationDecisionMaterial=planRecommendationDecisionMaterial([...priorRecommendations.values()],plans,state.financialRevision||null);
 const recommendationDecisionSignature=await digestAgent(JSON.stringify(recommendationDecisionMaterial));
 const planInputSignature=await digestAgent(JSON.stringify({planRiskLifecycleRevision:2,input:planInputMaterial(state,compactFinancialState(state),plans,goals.data||[],planningMemories),recommendationDecisionSignature}));
 if(!authoritative&&plans.some((p:any)=>p.status==='active')&&prior.data?.snapshot?.plan_input_signature===planInputSignature&&prior.data?.snapshot?.recommendation_decision_signature===recommendationDecisionSignature&&prior.data?.snapshot?.forecast_contract_revision===1)return evaluationOnly?markAgentEvaluationVerified(context,prior.data.state_version):getAgentState(context);
 const goalMap=new Map((goals.data||[]).map((g:any)=>[g.goal_id,g]));
 const planEvaluations=plans.map((p:any)=>evaluateFinancialPlan(p,planState||state,goalMap.get(p.goal_id)||null));
 state.goals=goals.data||[];
 state.preferredCashFloor=memory.shared.find(m=>m.key==="preferred_cash_floor")?.value??null;
 state.accountsHealthy=state.accounts.every((a:any)=>a.sourceBalanceUpdatedAt&&Date.now()-Date.parse(a.sourceBalanceUpdatedAt)<36*3600000&&!/error|failed|needs_attention|disconnected/.test(String(a.status)));
 state.recurring=(state.recurring as any[]).map(r=>{const id=r.streamKey||r.streamId||r.id||r.name,old=prior.data?.snapshot?.recurring?.find((v:any)=>v.id===id);return {...r,expectedDate:recurringExpectedDate(r,old)};});
 state.planEvaluatedIds=evaluatedPlanIdsForReconciliation(planEvaluations,prior.data?.snapshot||null,compactFinancialState(state),existing.data||[]);
 const snapshot=compactFinancialState(state);snapshot.financial_revision=state.financialRevision||null;
 snapshot.plan_input_signature=planInputSignature;
 snapshot.recommendation_decision_signature=recommendationDecisionSignature;
 snapshot.plan_versions=plans.map((p:any)=>({plan_id:p.plan_id,version:p.version,status:p.status}));
 // Preserve actual sync revisions for detectors, but never pass these changing timestamps to an LLM.
 const version=await digestAgent(JSON.stringify({snapshot,coaching:state.budgetCoaching,planning:state.planning,accounts:state.accounts,duplicateCandidates:state.duplicateCandidates,memories:planningMemories,today,plans:planEvaluations,recommendationDecisionSignature}));
 state.financialStateVersion=version;
 const existingRecommendations=priorRecommendations;
 for(const evaluation of planEvaluations){const plan=plans.find((p:any)=>p.plan_id===evaluation.plan_id),priorRecommendation:any=existingRecommendations.get(evaluation.plan_id);if(plan?.plan_type==='spending_reduction')evaluation.recommendation=recommendSpendingAdjustments(plan,{...planState,financialStateVersion:version,financialRevision:state.financialRevision,declinedCategoryIds:priorRecommendation?.declined_category_ids||[]},plans,planningMemories);}
 const conflictAnalysis=analyzePlanConflicts({householdId:context.householdId,activeHouseholdId:context.householdId,plans,financialState:{...(planState||state),financialStateVersion:version,financialRevision:state.financialRevision,household_id:context.householdId},goals:goals.data||[],recommendations:planEvaluations.map((evaluation:any)=>evaluation.recommendation).filter(Boolean),memories:planningMemories});
 if(!conflictAnalysis.ok)throw new RequestError(conflictAnalysis.message,409);
 snapshot.plan_conflict_analysis=conflictAnalysis.analysis;
 const conflictByPlan=new Map(conflictAnalysis.analysis.plans.map((item:any)=>[item.plan_id,item]));
 for(const evaluation of planEvaluations){const item:any=conflictByPlan.get(evaluation.plan_id);if(item){evaluation.plan_priority=item.priority;evaluation.plan_conflicts=item.conflicts;evaluation.plan_allocation=item.allocation;if(evaluation.recommendation&&evaluation.plan_type==='spending_reduction')bindRecommendationToPlanAllocation(evaluation.recommendation,item.allocation);}}
 await persistPlanRecommendationRows(db,context,planEvaluations,version,existingRecommendations);
 if(prior.data?.state_version===version&&prior.data?.snapshot?.forecast_contract_revision===1)return evaluationOnly?markAgentEvaluationVerified(context,version):getAgentState(context);
 for(const evaluation of planEvaluations){
  const previousEvaluation=await db.from('finance_plan_evaluations').select('snapshot').eq('household_id',context.householdId).eq('plan_id',evaluation.plan_id).neq('financial_state_version',version).order('evaluated_at',{ascending:false}).limit(1).maybeSingle();
  if(previousEvaluation.error)throw new Error(previousEvaluation.error.message);
  if(previousEvaluation.data?.snapshot){const compared=comparePlanSnapshots(previousEvaluation.data.snapshot,evaluation);if(compared.ok)evaluation.what_changed=compared.comparison;}
  const {error}=await db.from('finance_plan_evaluations').upsert({plan_id:evaluation.plan_id,household_id:context.householdId,plan_version:evaluation.plan_version,financial_state_version:version,period_key:evaluation.period_key,snapshot:evaluation},{onConflict:'plan_id,plan_version,financial_state_version'});
  if(error)throw new Error(error.message);
 }
 state.previous=prior.data?.snapshot||null;
 const detected=[...detectFinancialEvents(state),...planEvaluations.map((e:any)=>planRiskEvent(plans.find((p:any)=>p.plan_id===e.plan_id),e)).filter(Boolean)],now=new Date().toISOString();
 const rows=reconcileEvents(detected,existing.data||[],now,context.householdId).map(event=>{
  const weight=memory.shared.find(m=>m.key===`event_weight:${event.event_type}`)?.value;
  const preference=typeof weight==='number'&&Number.isFinite(weight)?Math.max(0,Math.min(1,weight)):1;
  const attention=event.attention_score*preference;
  return {...event,attention_score:attention,status:event.event_type==='refund_applied'?'acted':attention<.2?'suppressed':event.status};
 });
 // Optional/partial detectors cannot expire valid evidence from the last complete refresh.
 const evaluatedTypes=["account_sync_issue"];
 if(record(state.savingsNotifications))evaluatedTypes.push("savings_review_needed","savings_opportunity");
 if(state.budgetCoachingReady!==false)evaluatedTypes.push("budget_pace_risk");
 if(Array.isArray(state.duplicateCandidates))evaluatedTypes.push("duplicate_account_suspected");
 if(recurringEvidenceIsFresh(state))evaluatedTypes.push("recurring_amount_change","income_materially_different","income_missing","recurring_payment_missing");
 if(record(state.planning)&&state.planning.ready===true&&state.planning.complete===true&&Array.isArray(state.planning.warnings)&&!state.planning.warnings.length)evaluatedTypes.push("cash_floor_risk");
 // An unknown plan cannot withdraw a previously valid risk based on missing evidence.
 evaluatedTypes.push('plan_at_risk');
 const {data:saved,error}=await db.rpc("commit_finance_agent_evaluation",{p_household_id:context.householdId,p_user_id:context.userId,p_expected_version:prior.data?.state_version||null,p_version:version,p_snapshot:snapshot,p_events:rows,p_evaluated_types:evaluatedTypes});
 if(error)throw new Error(error.message);
 if(!saved)throw new RequestError("A newer financial evaluation completed. Retry with the latest state.",409);
 await db.from('finance_plan_recommendations').update({status:'superseded',updated_at:new Date().toISOString()}).eq('household_id',context.householdId).in('status',['active','partial']).neq('financial_state_version',version);
 return evaluationOnly?listAgentEvents(context):getAgentState(context);
}
export function planRecommendationDecisionMaterial(rows:Row[],plans:Row[],financialRevision:string|null){const versions=new Map((plans||[]).map((plan:Row)=>[String(plan.plan_id),Number(plan.version)]));return [...new Map((rows||[]).filter((row:Row)=>row&&versions.get(String(row.plan_id))===Number(row.plan_version)&&(row.financial_revision||null)===financialRevision).map((row:Row)=>[String(row.plan_id),{plan_id:String(row.plan_id),plan_version:Number(row.plan_version),declined_category_ids:[...new Set((Array.isArray(row.declined_category_ids)?row.declined_category_ids:[]).filter((id:unknown)=>typeof id==='string').map(String))].sort()}])).values()].filter((row:any)=>row.declined_category_ids.length>0).sort((a:any,b:any)=>a.plan_id.localeCompare(b.plan_id));}
export function bindRecommendationToPlanAllocation(recommendation:Row,allocation:Row){
 const allocated=new Map((Array.isArray(allocation?.categories)?allocation.categories:[]).map((row:Row)=>[String(row.category_id),Number(row.monthly_potential)]));
 const evidence=new Map((Array.isArray(recommendation.causal_evidence)?recommendation.causal_evidence:[]).filter((row:Row)=>row?.source==='existing_budget_coach').map((row:Row)=>[String(row.category_id),row]));
 const adjustments:Row[]=[];
 for(const item of Array.isArray(recommendation.adjustments)?recommendation.adjustments:[]){const id=String(item?.category_id||''),cap=allocated.get(id)||0,source:any=evidence.get(id),potential=Math.round(Math.min(Number(item.potential_reduction)||0,cap)*100)/100;if(!id||!source||!Number.isFinite(potential)||potential<=0)continue;
  const current=Number(source.current_target),projected=Number(source.projected_spend),floor=Number(source.minimum_budget_floor)||0;
  if(!Number.isFinite(current)||!Number.isFinite(projected)||!Number.isFinite(floor)||floor<0)continue;
  const proposed=Math.round(Math.min(current-potential,projected-potential)*100)/100;
  if(proposed<floor||proposed<0||proposed>=current)continue;
  adjustments.push({...item,current_monthly_target:current,proposed_monthly_target:proposed,target_decrease:Math.round((current-proposed)*100)/100,potential_reduction:potential,status:'pending'});
 }
 recommendation.adjustments=adjustments;
 const unresolved=Number(allocation?.unresolved_shortfall);
 recommendation.potential_total=Math.round(adjustments.reduce((sum:number,item:Row)=>sum+Number(item.potential_reduction||0),0)*100)/100;
 recommendation.unresolved_shortfall=Number.isFinite(unresolved)?Math.max(0,Math.round(unresolved*100)/100):null;
 if(adjustments.length){recommendation.status=Number.isFinite(unresolved)&&unresolved>0?'insufficient_capacity':'ready';recommendation.message=Number.isFinite(unresolved)&&unresolved>0?`Potential changes are limited by shared category capacity; about $${unresolved.toFixed(2)} of the plan gap remains unresolved.`:'Potential changes fit the current shared category allocation; review each target before applying.';}
 else if(allocation?.status==='priority_reconsideration'){recommendation.status='priority_reconsideration';recommendation.message='A higher-priority household plan already uses this category adjustment; this plan needs a different category or priority review.';}
 else if(allocation?.status==='unknown'){recommendation.status='unknown_evidence';recommendation.message='Current category evidence is incomplete, so no budget change is proposed.';}
 else if(recommendation.status==='ready'||recommendation.status==='insufficient_capacity'){recommendation.status='no_verified_capacity';recommendation.message='No eligible category capacity remains after shared household constraints.';}
 return recommendation;
}
async function persistPlanRecommendationRows(db:any,context:Context,evaluations:Row[],stateVersion:string,existing:Map<string,any>){for(const evaluation of evaluations){const r=evaluation.recommendation;if(!r)continue;const previous=existing.get(evaluation.plan_id),status=r.adjustments.length?'active':r.status==='no_flexible_categories'?'no_flexible_categories':r.status==='no_material_gap'?'no_material_gap':['insufficient_capacity','priority_reconsideration'].includes(r.status)?'insufficient_capacity':'unknown_evidence',replace=previous?.status==='rejected'&&previous?.financial_state_version===stateVersion,payload={household_id:context.householdId,plan_id:evaluation.plan_id,recommendation_id:r.recommendation_id,plan_version:r.plan_version,financial_state_version:stateVersion,financial_revision:r.financial_revision,period_key:r.period_key,status,adjustments:r.adjustments.map((item:Row)=>({...item,status:'pending'})),declined_category_ids:previous?.declined_category_ids||[],causal_evidence:r.causal_evidence,message:r.message};if(replace){const {error}=await db.from('finance_plan_recommendations').update(payload).eq('household_id',context.householdId).eq('plan_id',evaluation.plan_id).eq('financial_state_version',stateVersion).eq('plan_version',previous.plan_version).eq('recommendation_id',previous.recommendation_id).eq('status','rejected');if(error)throw new Error(error.message);}else{const {error}=await db.from('finance_plan_recommendations').upsert(payload,{onConflict:'plan_id,financial_state_version',ignoreDuplicates:true});if(error)throw new Error(error.message);}}}
async function digestAgent(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,"0")).join("");}
function householdSummaryFromCompact(current:any) {
 const spent=current?.spent,target=current?.target,capacity=current?.available_capacity;
 if(current?.budgets_ready!==true||typeof spent!=='number'||!Number.isFinite(spent)||typeof target!=='number'||!Number.isFinite(target)||typeof capacity!=='number'||!Number.isFinite(capacity)||typeof current?.month!=='string'||!/^\d{4}-\d{2}$/.test(current.month))return null;
 return {month:current.month,spent,target,available_capacity:capacity,remaining:capacity-spent};
}
export async function getAgentState(context:Context, markSeen=false, seenVersion:string|null=null, readOnly=false) {
 if(!readOnly){const {data:reconciled,error:reconcileError}=await serviceClient().rpc('reconcile_financial_plan_lifecycle',{p_household_id:context.householdId,p_user_id:context.userId});
 if(reconcileError)throw new Error(reconcileError.message);
 if(Number(reconciled)>0)await refreshAgentState(context);}
 const db=serviceClient(),today=new Intl.DateTimeFormat("en-CA",{timeZone:"UTC",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const [snapshot,visit,events,dismissedEvents,memory,goals,decisions,reviews,actions,plans,refundActivity]=await Promise.all([
  db.from("finance_agent_state_snapshots").select("snapshot,state_version,evaluated_at").eq("household_id",context.householdId).maybeSingle(),
  db.from("finance_agent_visits").select("last_seen_state,last_seen_at,last_seen_state_version").eq("household_id",context.householdId).eq("user_id",context.userId).maybeSingle(),
  listAgentEvents(context),listDismissedAgentEvents(context),agentMemories(context,today),
  db.from("finance_planning_goals").select("goal_id,name,goal_type,current_amount,target_amount,monthly_contribution").eq("household_id",context.householdId).eq("active",true),
  db.from("finance_agent_event_feedback").select("event_id,event_type,feedback,created_at").eq("household_id",context.householdId).eq("actor_user_id",context.userId).order("created_at",{ascending:false}).limit(10),
  db.from("finance_agent_weekly_reviews").select("week,summary,created_at").eq("household_id",context.householdId).eq("user_id",context.userId).order("week",{ascending:false}).limit(1).maybeSingle(),
  db.from("finance_agent_actions").select("action_type,label,status,updated_at").eq("household_id",context.householdId).eq("user_id",context.userId).in("status",["succeeded","failed","uncertain"]).order("updated_at",{ascending:false}).limit(8),
  db.from('finance_household_plans').select('plan_id,goal_id,name,plan_type,status,version,priority,lifecycle_reason,completion_source,completed_at,ended_at,lifecycle_history,starts_on,ends_on,target_monthly,baseline_monthly,floor_amount').eq('household_id',context.householdId).eq('status','active').order('priority',{ascending:true}).order('plan_id',{ascending:true}).limit(5),
  db.from('finance_agent_events').select('event_id,title,summary,facts,created_at').eq('household_id',context.householdId).eq('event_type','refund_applied').eq('status','acted').order('created_at',{ascending:false}).limit(20)
 ]);
 if(snapshot.error||visit.error||goals.error||decisions.error)throw new Error("Agent context is temporarily unavailable.");
 const current=snapshot.data?.snapshot||null,memories=[...memory.shared,...(memory.protectedCategories||[]),...memory.personal];
 const evaluatedAt=snapshot.data?.evaluated_at||null,evaluatedMs=typeof evaluatedAt==='string'?Date.parse(evaluatedAt):NaN,snapshotFresh=Number.isFinite(evaluatedMs)&&Date.now()-evaluatedMs>=-5*60*1000&&Date.now()-evaluatedMs<=24*60*60*1000;
 const forecastCurrent=current?.forecast_contract_revision===1&&current?.forecast_current===true&&snapshotFresh;
 const safeForecastEvent=(event:any)=>({date:event.date,amount:Number(event.amount),name:typeof event.name==='string'?event.name.slice(0,120):'Scheduled activity',flow_type:event.flow_type,recurring_kind:event.recurring_kind||null,include_in_forecast:event.include_in_forecast!==false});
 const forecastEvents=Array.isArray(current?.forecast_events)?current.forecast_events.slice(0,80).filter((event:any)=>event&&typeof event.date==='string'&&/^20\d\d-\d\d-\d\d$/.test(event.date)&&Number.isFinite(Number(event.amount))&&['inflow','outflow'].includes(event.flow_type)).map(safeForecastEvent):[];
 const storedIncomeProjection=current?.income_projection&&typeof current.income_projection==='object'?current.income_projection:null;
 const incomeProjection=storedIncomeProjection?{month:storedIncomeProjection.month,as_of:storedIncomeProjection.as_of,observed_income_to_date:storedIncomeProjection.observed_income_to_date,expected_future_income:storedIncomeProjection.expected_future_income,projected_month_income:storedIncomeProjection.projected_month_income,forecast_current:forecastCurrent&&storedIncomeProjection.forecast_current===true,forecast_generated_at:storedIncomeProjection.forecast_generated_at||null,expected_events:Array.isArray(storedIncomeProjection.expected_events)?storedIncomeProjection.expected_events.slice(0,40).filter((event:any)=>event&&typeof event.date==='string'&&/^20\d\d-\d\d-\d\d$/.test(event.date)&&Number.isFinite(Number(event.amount))).map((event:any)=>({date:event.date,amount:Number(event.amount),name:typeof event.name==='string'?event.name.slice(0,120):'Expected income'})):[],observed_income_count:storedIncomeProjection.observed_income_count}:null;
 const changes=current?financialDeltas(visit.data?.last_seen_state||null,current):[];
 const compactConflict=(item:any)=>item?{priority:item.priority,assessment:item.assessment,conflicts:(item.conflicts||[]).slice(0,3).map((row:any)=>({type:row.type,status:row.status,reason:row.reason||null})),allocation:{status:item.allocation?.status||'not_applicable',monthly_potential:item.allocation?.monthly_potential??null,unresolved_shortfall:item.allocation?.unresolved_shortfall??null,categories:(item.allocation?.categories||[]).slice(0,3).map((row:any)=>({category_name:row.category_name,monthly_potential:row.monthly_potential}))}}:null;
 const fullConflict=snapshot.data?.snapshot?.plan_conflict_analysis||null;
 const compactConflictAnalysis=fullConflict?{analysis_version:fullConflict.analysis_version,priority_order:(fullConflict.priority_order||[]).slice(0,5),conflict_count:(fullConflict.conflicts||[]).length,conflicts:(fullConflict.conflicts||[]).slice(0,5).map((row:any)=>({type:row.type,status:row.status,plan_ids:row.plan_ids||[row.plan_id].filter(Boolean),reason:row.reason||null})),capacity:{status:fullConflict.capacity?.status||'unknown',known_allocated_monthly:fullConflict.capacity?.known_allocated_monthly??null,unknown_plan_count:(fullConflict.capacity?.unknown_plan_ids||[]).length},hard_constraint_count:(fullConflict.hard_constraints||[]).length}:null;
 const activePlans=plans.error?[]:await Promise.all((plans.data||[]).map(async(p:any)=>{const conflict=compactConflict(fullConflict?.plans?.find((item:any)=>item.plan_id===p.plan_id)||null);if(!snapshot.data?.state_version)return {...p,latest:null,recommendation:null,conflict};const [evaluation,recommendation]=await Promise.all([db.from('finance_plan_evaluations').select('snapshot,evaluated_at').eq('household_id',context.householdId).eq('plan_id',p.plan_id).eq('plan_version',p.version).eq('financial_state_version',snapshot.data.state_version).maybeSingle(),db.from('finance_plan_recommendations').select('*').eq('household_id',context.householdId).eq('plan_id',p.plan_id).eq('plan_version',p.version).eq('financial_state_version',snapshot.data.state_version).maybeSingle()]),currentRecommendation=recommendation.error?null:recommendation.data||null,latest=evaluation.data?.snapshot?{...evaluation.data.snapshot,recommendation:currentRecommendation}:null;return {...p,latest,recommendation:currentRecommendation,conflict,evaluated_at:evaluation.data?.evaluated_at||null};}));
 let planInAppEnabled=true;if(activePlans.length)try{const delivery=await notificationContext(db,context);planInAppEnabled=delivery.preferences.in_app_enabled!==false&&delivery.preferences.budgets!==false;}catch{}
 let autonomyContext:any=null;if(!readOnly)try{const autonomy=await getAutonomyState(db,context),categoryLabels=Object.fromEntries(autonomy.catalog.categories.map((item:any)=>[item.id,item.label])),planLabels=Object.fromEntries(autonomy.catalog.plans.map((item:any)=>[item.id,item.label]));autonomyContext={mode:autonomy.mode,help_mode:autonomy.help_mode,execution_active:autonomy.execution_active,rollout_enabled:autonomy.rollout_enabled,kill_switch:autonomy.kill_switch,refunds:autonomy.refunds,usage:autonomy.usage,budget_monthly_summary:autonomy.budget_monthly_summary,activity_month_summary:autonomy.activity_month_summary,permission_suggestion:autonomy.permission_suggestion,plan_budget_authority_available:autonomy.plan_budget_authority_available===true,monthly_limit_shared:true,plan_budget_authority:autonomy.plan_budget_authority_available===true?(autonomy.plan_budget_authority||[]).map((item:any)=>({plan:planLabels[item.plan_id]||'Active spending plan',status:item.status,per_action_limit:item.per_action_limit,monthly_limit:item.monthly_limit,monthly_remaining:item.monthly_remaining,exceptions:(item.exceptions||[]).map((exception:any)=>({label:exception.label,reason:exception.reason,amount:exception.amount,next_step:exception.next_step}))})):[],category_labels:categoryLabels,plan_labels:planLabels,policies:autonomy.policies.map((p:any)=>({policy_id:p.policy_id,action_type:p.action_type,enabled:p.enabled,autonomy_level:p.autonomy_level,execution_mode:p.execution_mode,execution_authorized:p.execution_authorized,version:p.version,scope:p.scope,max_amount:p.max_amount,max_monthly_amount:p.max_monthly_amount,min_confidence:p.min_confidence,protected_category_ids:p.protected_category_ids,category_minimums:p.category_minimums,cash_floor:p.cash_floor,start_date:p.start_date,end_date:p.end_date})),recent_actions:autonomy.activity_7d.map((a:any)=>({action_type:a.action_type,label:a.label,status:a.status,reason:a.why,permission_snapshot:a.permission_snapshot,created_at:a.created_at,prior_values:a.prior_values,proposed_values:a.proposed_values})),activity_7d_truncated:autonomy.activity_7d_truncated,monthly_summary:autonomy.monthly_summary,automatic_permissions:autonomy.policies.map((p:any)=>({action_type:p.action_type,enabled:p.enabled&&!p.auto_paused_at&&p.execution_mode==='live'&&p.execution_authorized===true&&autonomy.help_mode==='auto'&&autonomy.rollout_enabled===true&&!autonomy.kill_switch,paused:!!p.auto_paused_at,limits:{max_amount:p.max_amount,max_monthly_amount:p.max_monthly_amount},protected_category_names:p.protected_category_names||[],scope_names:p.scope?.category_names||[]})),permission_history:autonomy.permission_history.map((p:any)=>({change_type:p.change_type,actor_display_name:p.actor_display_name,previous_summary:p.previous_summary,new_summary:p.new_summary,created_at:p.created_at}))};}catch{console.warn('Autonomy context unavailable; continuing regular agent state.');}
 const refundEvidence=await loadRefundActivityEvidence(db,context),currentRefunds=refundEvidence.rows;
 const result={...events,agent_state:{state_read_at:events.generated_at,weekly_review:reviews.error?null:reviews.data,recent_actions:actions.error?[]:actions.data,refunds:currentRefunds,refunds_available:refundEvidence.available,refund_summary:refundEvidence.summary,recent_refund_activity:verifiedRefundActivity(refundActivity.data||[],currentRefunds),financial_state_version:snapshot.data?.state_version||null,evaluated_at:evaluatedAt,forecast_current:forecastCurrent,forecast_contract_revision:current?.forecast_contract_revision||null,forecast_events:forecastEvents,income_projection:incomeProjection,household_summary:householdSummaryFromCompact(current),active_plans:activePlans,active_plan_count:(snapshot.data?.snapshot?.plan_versions||[]).filter((item:any)=>item.status==='active').length,active_plans_omitted:Math.max(0,(snapshot.data?.snapshot?.plan_versions||[]).filter((item:any)=>item.status==='active').length-activePlans.length),plan_conflict_analysis:compactConflictAnalysis,plan_in_app_enabled:planInAppEnabled,autonomy:autonomyContext,active_goals:[...(goals.data||[]),...memories.filter(m=>m.kind==="goal")],active_preferences:memories.filter(m=>m.kind==="preference"),personal_memories:memory.personal,important_memories:memories.filter(m=>!["goal","preference"].includes(m.kind)),current_forecast_summary:forecastCurrent?current?.forecast||null:null,unresolved_events:events.events,dismissed_events:dismissedEvents,recommended_actions:events.events.flatMap((e:any)=>e.recommended_actions||[]).slice(0,8),recent_decisions:decisions.data||[],changed_since_last_visit:changes,last_seen_at:visit.data?.last_seen_at||null}};
 if(markSeen&&current&&seenVersion===snapshot.data?.state_version){const {error}=await db.from("finance_agent_visits").upsert({household_id:context.householdId,user_id:context.userId,last_seen_state:current,last_seen_state_version:snapshot.data!.state_version,last_seen_at:new Date().toISOString()},{onConflict:"household_id,user_id"});if(error)throw new Error(error.message);}
 return result;
}
export async function listAgentEvents(context: Context) {
  const db = serviceClient(), now = new Date();
  const { data, error } = await db.from("finance_agent_events").select("event_id,event_type,fingerprint,severity,urgency,confidence,actionability,novelty,attention_score,facts,title,summary,recommended_actions,status,event_version,first_seen_at,last_seen_at,expires_at").eq("household_id", context.householdId).in("status", ["new", "surfaced", "acknowledged"]).gte("attention_score", 0.2).gt("expires_at", now.toISOString()).order("attention_score", { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  let events = data ?? [];
  if(events.some((event:any)=>event.event_type==='plan_at_risk')){
    const [plansResult,snapshotResult]=await Promise.all([
      db.from('finance_household_plans').select('plan_id,version,status').eq('household_id',context.householdId).eq('status','active'),
      db.from('finance_agent_state_snapshots').select('state_version').eq('household_id',context.householdId).maybeSingle(),
    ]);
    if(plansResult.error||snapshotResult.error)throw new Error(plansResult.error?.message||snapshotResult.error?.message);
    const currentPlans=plansResult.data||[],stateVersion=snapshotResult.data?.state_version;
    const currentEvaluations=currentPlans.length&&stateVersion?await db.from('finance_plan_evaluations').select('plan_id,plan_version,snapshot').eq('household_id',context.householdId).eq('financial_state_version',stateVersion).in('plan_id',currentPlans.map((p:any)=>p.plan_id)): {data:[],error:null};
    if(currentEvaluations.error)throw new Error(currentEvaluations.error.message);
    const byPlan=new Map((currentEvaluations.data||[]).map((row:any)=>[String(row.plan_id),{...row.snapshot,plan_version:row.plan_version}]));
    events=currentPlanRiskEvents(events,currentPlans.map((plan:any)=>({...plan,latest:byPlan.get(String(plan.plan_id))||null})));
  }
  const ids = events.map((event: any) => event.event_id);
  if (!ids.length) return { events: [], generated_at: now.toISOString(), source: "deterministic_household_events" };
  const [states, feedback] = await Promise.all([
    db.from("finance_agent_event_user_state").select("event_id,disposition,snoozed_until,updated_at").eq("household_id", context.householdId).eq("user_id", context.userId).in("event_id", ids),
    db.from("finance_agent_event_feedback").select("feedback,event_id,event_type,created_at").eq("household_id", context.householdId).eq("actor_user_id", context.userId).gte("created_at", new Date(now.getTime() - 90 * 86400000).toISOString()).order("created_at", { ascending: false }).limit(500),
  ]);
  if (states.error || feedback.error) throw new Error(states.error?.message ?? feedback.error?.message);
  const stateById = new Map((states.data ?? []).map((state: any) => [String(state.event_id), state]));
  const hiddenIds = new Set((states.data ?? []).filter((state: any) => agentEventHiddenForUser(state.disposition, state.snoozed_until, now.getTime())).map((state: any) => state.event_id));
  const restoredIds = new Set((states.data ?? []).filter((state: any) => state.disposition === "restored").map((state: any) => state.event_id));
  const recent = feedback.data ?? [], counts = new Map<string, number>();
  for (const row of recent) if (["dismissed", "expected", "wrong"].includes(row.feedback) && row.event_type) counts.set(row.event_type, (counts.get(row.event_type) ?? 0) + 1);
  // Notification failure cannot take down the existing agent surfaces.
  let delivery:any=null;try{delivery=await notificationContext(db,context);}catch{console.warn("Notification routing unavailable; using in-app fallback");}
  const visible = events.filter((event: any) => !hiddenIds.has(event.event_id)).map((event: any) => {
    const count = counts.get(event.event_type) ?? 0, fatigue = eventFeedbackFatigueMultiplier(count);
    const scored={...event,attention_score:Math.round(Number(event.attention_score)*fatigue*10000)/10000,feedback_fatigue:fatigue};
    const decision=delivery?routeEvent(scored,delivery.preferences,delivery.history,now):null;
    const restored=restoredIds.has(event.event_id);
    // Explicit restore pins the in-app copy only. Fatigue and push history remain intact.
    const userState:any=stateById.get(String(event.event_id));
    return {...scored,household_id:context.householdId,actor_user_id:context.userId,user_disposition:userState?.disposition||null,user_state_updated_at:userState?.updated_at||null,restored_in_app:restored,delivery_channels:restored?["in_app","assistant_inbox"]:decision?.channels||deliveryChannels(scored.attention_score),delivery_reason_codes:restored?["explicit_restore"]:decision?.reason_codes||[],recent_delivery:delivery?.history.filter((d:any)=>d.event_id===event.event_id).slice(0,3)||[]};
  }).filter((event: any) => event.restored_in_app || event.attention_score >= 0.2).sort((a: any, b: any) => Number(b.restored_in_app)-Number(a.restored_in_app)||b.attention_score-a.attention_score).slice(0, 20);
  return { events: visible, generated_at: now.toISOString(), source: "deterministic_household_events" };
}
async function feedbackAgentEvent(context: Context, body: Row) {
  const eventId = string(body.event_id, "event_id", 80), feedback = string(body.feedback, "feedback", 24);
  if (!["approved", "dismissed", "expected", "wrong", "snoozed", "acknowledged"].includes(feedback)) throw new RequestError("Unsupported event response.");
  const db = serviceClient();
  const { data: event, error: eventError } = await db.from("finance_agent_events").select("event_id,event_type,event_version,fingerprint").eq("household_id", context.householdId).eq("event_id", eventId).maybeSingle();
  if (eventError || !event) throw new RequestError("This household insight is no longer available.", 404);
  const days = feedback === "snoozed" ? Number(body.snooze_days ?? 7) : null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 30)) throw new RequestError("Snooze must be between 1 and 30 days.");
  const snoozedUntil = days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
  const { error } = await db.rpc("record_finance_agent_event_feedback", { p_household_id: context.householdId, p_user_id: context.userId, p_event_id: event.event_id, p_feedback: feedback, p_snoozed_until: snoozedUntil });
  if (error) throw new Error(error.message);
  if (feedback === "snoozed" || ["approved", "dismissed", "expected", "wrong", "acknowledged"].includes(feedback)) {
    await syncAssistantEventMessageLifecycle(db, context, event.event_id, Number(event.event_version), feedback, snoozedUntil);
  }
  return { saved: true, event_id: event.event_id, feedback, snoozed_until: snoozedUntil };
}

async function syncAssistantEventMessageLifecycle(db:any, context:Context, eventId:string, eventVersion:number, disposition:string, snoozedUntil:string|null) {
  const lifecycle = disposition === "snoozed" ? "snoozed" : disposition === "restored" ? "active" :
    ["approved", "acknowledged", "dismissed", "expected", "wrong", "acted"].includes(disposition) ? "resolved" : null;
  if (!lifecycle || !Number.isSafeInteger(eventVersion) || eventVersion < 1) return;
  const rows = await listAssistantMessages(db, { householdId: context.householdId, userId: context.userId }, { source: "event", event_id: eventId, limit: 500 });
  for (const message of rows) {
    if (Number(message.event_version) !== eventVersion || message.lifecycle === "superseded" || message.lifecycle === lifecycle &&
        (lifecycle !== "snoozed" || message.snoozed_until === snoozedUntil)) continue;
    await updateAssistantMessageLifecycle(db, { householdId: context.householdId, userId: context.userId }, {
      message_id: String(message.message_id), lifecycle, ...(lifecycle === "snoozed" ? { snoozed_until: snoozedUntil } : {}),
    });
  }
}

async function listAgentEventHistory(context:Context) {
  let result:any;try{result=await serviceClient().rpc("list_finance_agent_event_history",{p_household_id:context.householdId,p_user_id:context.userId,p_limit:100});}catch{throw new RequestError("Alert history is temporarily unavailable.",503);}
  if(result.error){if(result.error.code==="42501")throw new RequestError("Household access denied.",403);throw new RequestError("Alert history is temporarily unavailable.",503);}
  if(!Array.isArray(result.data)||result.data.some((row:any)=>!record(row)||row.household_id!==context.householdId||row.actor_user_id!==context.userId||!eventUuid.test(String(row.event_id||""))||!Number.isSafeInteger(Number(row.event_version))||Number(row.event_version)<1||typeof row.disposition!=="string"||typeof row.can_restore!=="boolean"||typeof row.updated_at!=="string"||!Number.isFinite(Date.parse(row.updated_at))))throw new RequestError("Alert history is temporarily unavailable.",503);
  return {events:result.data,household_id:context.householdId,actor_user_id:context.userId};
}

const eventUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function alertEventRequest(body:Row,feedback:"acknowledged"|"dismissed"|"snoozed"|"restored") {
  const eventId=string(body.event_id,"event_id",80),version=Number(body.event_version),key=string(body.idempotency_key,"idempotency_key",80);
  if(!eventUuid.test(eventId)||!eventUuid.test(key)||!Number.isSafeInteger(version)||version<1)throw new RequestError("Refresh this alert before responding.",400);
  const expected=body.expected_disposition===undefined?null:body.expected_disposition;
  const allowed=new Set(["dismissed","expected","wrong","acknowledged","snoozed","acted","restored"]);
  if(expected!==null&&(typeof expected!=="string"||!allowed.has(expected)))throw new RequestError("Alert state changed. Refresh before responding.",400);
  const updated=body.expected_state_updated_at===undefined?null:body.expected_state_updated_at;
  if(updated!==null&&(typeof updated!=="string"||!Number.isFinite(Date.parse(updated))))throw new RequestError("Alert state changed. Refresh before responding.",400);
  if((expected===null)!==(updated===null))throw new RequestError("Refresh this alert before responding.",400);
  if(feedback==="snoozed" ? body.snooze_days!==7 : body.snooze_days!==undefined)throw new RequestError("Snooze is available for one week.",400);
  if(feedback==="restored"&&expected!=="dismissed")throw new RequestError("Only your current dismissal can be restored.",409);
  return {eventId,version,key,expected:expected as string|null,updated:updated as string|null};
}
async function applyVersionedAgentEventDisposition(context:Context,body:Row,feedback:"acknowledged"|"dismissed"|"snoozed"|"restored") {
  const request=alertEventRequest(body,feedback),db=serviceClient();
  let result:any;try{result=await db.rpc("apply_finance_agent_event_disposition",{p_household_id:context.householdId,p_user_id:context.userId,p_event_id:request.eventId,p_event_version:request.version,p_expected_disposition:request.expected,p_expected_state_updated_at:request.updated,p_feedback:feedback,p_snooze_days:feedback==="snoozed"?7:null,p_idempotency_key:request.key});}catch{throw new RequestError("Folio could not confirm this alert response. Retry the same response.",503);}
  if(result.error){
    if(result.error.code==="P0001")throw new RequestError(result.error.message.includes("STALE")?"This alert changed. Refresh before responding.":"Your alert response conflicts with a newer response. Refresh history.",409);
    if(String(result.error.code||"").startsWith("22")||result.error.code==="22023")throw new RequestError("Choose a valid alert response.",400);
    if(result.error.code==="42501")throw new RequestError("Household access denied.",403);
    throw new RequestError("Folio could not confirm this alert response. Retry the same response.",503);
  }
  const receipt=result.data,expectedDisposition=feedback==="restored"?"restored":feedback;
  if(!record(receipt)||receipt.saved!==true||receipt.restored!==(feedback==="restored")||receipt.household_id!==context.householdId||receipt.actor_user_id!==context.userId||receipt.event_id!==request.eventId||Number(receipt.event_version)!==request.version||receipt.feedback!==feedback||receipt.disposition!==expectedDisposition||typeof receipt.user_state_updated_at!=="string"||!Number.isFinite(Date.parse(receipt.user_state_updated_at))||(feedback==="snoozed"?typeof receipt.snoozed_until!=="string"||!Number.isFinite(Date.parse(receipt.snoozed_until)):receipt.snoozed_until!==null))throw new RequestError("Folio could not verify this alert response. Retry the same response.",503);
  await syncAssistantEventMessageLifecycle(db, context, request.eventId, request.version, feedback, receipt.snoozed_until);
  return receipt;
}
async function applyAgentEventDisposition(context:Context,body:Row) {
  const disposition=body.disposition;
  if(!["acknowledged","dismissed","snoozed"].includes(String(disposition)))throw new RequestError("Choose a valid alert response.",400);
  return await applyVersionedAgentEventDisposition(context,body,disposition as "acknowledged"|"dismissed"|"snoozed");
}
async function restoreAgentEventV2(context:Context,body:Row) {
  return await applyVersionedAgentEventDisposition(context,body,"restored");
}

async function listDismissedAgentEvents(context: Context) {
  const db=serviceClient(),now=Date.now();
  const [states,feedback]=await Promise.all([
    db.from("finance_agent_event_user_state").select("event_id,updated_at").eq("household_id",context.householdId).eq("user_id",context.userId).eq("disposition","dismissed").order("updated_at",{ascending:false}).limit(50),
    db.from("finance_agent_event_feedback").select("event_id,feedback,created_at").eq("household_id",context.householdId).eq("actor_user_id",context.userId).order("created_at",{ascending:false}).limit(200),
  ]);
  if(states.error||feedback.error)throw new Error(states.error?.message??feedback.error?.message);
  const own=new Map<string,string>();
  for(const row of feedback.data??[])if(!own.has(row.event_id))own.set(row.event_id,row.feedback);
  const ids=[...new Set([...(states.data??[]).map((row:any)=>row.event_id),...own.keys()])];
  if(!ids.length)return [];
  const {data,error}=await db.from("finance_agent_events").select("event_id,event_version,title,summary,status,expires_at,attention_score,last_seen_at").eq("household_id",context.householdId).in("event_id",ids);
  if(error)throw new Error(error.message);
  const stateIds=new Set((states.data??[]).map((row:any)=>row.event_id));
  return (data??[]).filter((event:any)=>stateIds.has(event.event_id)||event.status==="dismissed"&&own.get(event.event_id)==="dismissed")
    .map((event:any)=>({...event,can_restore:["new","surfaced","dismissed"].includes(event.status)&&Date.parse(event.expires_at)>now&&Number(event.attention_score)>=0.2,
      unavailable_reason:!event.expires_at||Date.parse(event.expires_at)<=now||event.status==="expired"?"Expired; current evidence is no longer available.":!["new","surfaced","dismissed"].includes(event.status)?"No longer an active insight.":Number(event.attention_score)<0.2?"No longer meets the current insight threshold.":null}))
    .sort((a:any,b:any)=>Date.parse(b.last_seen_at)-Date.parse(a.last_seen_at)).slice(0,50);
}

async function restoreAgentEvent(context:Context,body:Row) {
  const eventId=string(body.event_id,"event_id",80),version=Number(body.event_version);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)||!Number.isInteger(version)||version<1)throw new RequestError("Choose a dismissed insight with a current version.");
  const {data,error}=await serviceClient().rpc("restore_finance_agent_event",{p_household_id:context.householdId,p_user_id:context.userId,p_event_id:eventId,p_expected_version:version});
  if(error)throw new RequestError(error.message,409);
  if(data!==true)throw new RequestError("Restore could not be verified. Refresh dismissed insights.",409);
  return {restored:true,event_id:eventId,event_version:version};
}

async function authenticate(authorization: string | null): Promise<Context> {
  if (!authorization?.startsWith("Bearer ")) throw new RequestError("Unauthorized", 401);
  const userResponse = await fetch(`${required("SUPABASE_URL")}/auth/v1/user`, { headers: { authorization, apikey: required("SUPABASE_ANON_KEY") } });
  if (!userResponse.ok) throw new RequestError("Unauthorized", 401); const user = await userResponse.json();
  if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new RequestError("Unauthorized", 401);
  const db = serviceClient(), { data, error } = await db.from("finance_household_members").select("household_id").eq("user_id", user.id).limit(2);
  if (error) throw new Error(error.message); if (!data?.length) throw new RequestError("Your signed-in account is not a household member.", 403); if (data.length !== 1) throw new RequestError("Multiple households require household selection support.", 409);
  return { userId: user.id, householdId: data[0].household_id };
}

async function householdItems(db: any, householdId: string): Promise<Item[]> { const { data, error } = await db.from("plaid_items").select("item_id,household_id,access_token,plaid_environment,institution_name").eq("household_id", householdId).eq("connection_status", "connected"); if (error) throw new Error(error.message); return await Promise.all((data ?? []).map(async (item: Item) => ({ ...item, access_token: await resolvePlaidAccessToken(db, item.item_id, item.access_token) }))); }
async function householdAccounts(db: any, householdId: string) { const { data, error } = await db.from("finance_household_accounts").select("canonical_account_id,account_id,item_id,name,official_name,mask,type,subtype,current_balance,balance_updated_at,balance_currency_code,lifecycle_status,source_count").eq("household_id", householdId); if (error) throw new Error(error.message); return data ?? []; }
async function readCashFundingAssignments(context:Context,envelope:any,planId:string){
 const db=serviceClient(),result=await db.rpc('finance_get_cash_forecast_funding',{p_household_id:context.householdId,p_user_id:context.userId});
 if(result.error||!record(result.data)||result.data.household_id!==context.householdId||result.data.actor_user_id!==context.userId||!Array.isArray(result.data.assignments))throw new Error('Cash funding assignments are unavailable.');
 const accounts=(envelope.accounts??[]).filter((a:any)=>a.type==='depository'&&a.lifecycle_status==='active'&&a.connection_status==='connected'&&a.match_status!=='review_required').map((a:any)=>({canonical_account_id:a.canonical_account_id,name:a.name??'Cash account',mask:a.mask??null,currency_code:a.balance_currency_code??null,balance_status:a.current_balance!=null&&a.balance_currency_code==='USD'?'verified':'unavailable'}));
 const creditAccounts=(envelope.accounts??[]).filter((a:any)=>a.type==='credit'&&a.lifecycle_status==='active'&&a.connection_status==='connected'&&a.match_status!=='review_required').map((a:any)=>({canonical_account_id:a.canonical_account_id,name:a.name??'Credit card',mask:a.mask??null}));
 return{status:'ready',household_id:context.householdId,actor_user_id:context.userId,plan_id:planId,plan_version:envelope.plan.version,accounts,credit_accounts:creditAccounts,assignments:result.data.assignments};
}
async function cashForecastFundingRead(context:Context,planId:string,timezone:string,today:string){
 const {data,error}=await serviceClient().rpc('finance_cash_floor_scope_evidence',{p_household_id:context.householdId,p_user_id:context.userId,p_plan_id:planId,p_timezone:timezone,p_start_date:today});
 if(error||!record(data)||data.household_id!==context.householdId||data.actor_user_id!==context.userId||data.plan?.plan_id!==planId)throw new Error('Cash scope is unavailable.');
 const assignments=await readCashFundingAssignments(context,data,planId),accounts=await householdAccounts(serviceClient(),context.householdId);
 const recurring=await recurringResponse(context,undefined,accounts,{cacheOnly:true,timeZone:timezone});
 const variable=await buildProjectedVariableSpend(serviceClient(),context,recurring,timezone);
 const streams=Array.isArray(recurring.streams)?recurring.streams:[];
 const budgetTargets=Array.isArray(variable.budget_funding_targets)?variable.budget_funding_targets:[];
 const freshSources=(recurring.coverage?.sources??[]).filter((s:any)=>s.expected===true).every((s:any)=>s.status==='success'&&typeof s.fetched_at==='string'&&Number.isFinite(Date.parse(s.fetched_at))&&Date.now()-Date.parse(s.fetched_at)>=0&&Date.now()-Date.parse(s.fetched_at)<=24*60*60*1000);
 const accountByCanonical=new Map(accounts.map((a:any)=>[a.canonical_account_id,a]));
 const accountOptions=assignments.accounts.map((a:any)=>{const source=accountByCanonical.get(a.canonical_account_id),age=Date.now()-Date.parse(source?.balance_updated_at??'');return{...a,name:source?.name??source?.official_name??a.name,mask:source?.mask??a.mask,balance_status:source?.balance_currency_code==='USD'&&source?.current_balance!=null&&Number.isFinite(Number(source.current_balance))&&Number.isFinite(age)&&age>=0&&age<=36*60*60*1000?'verified':'unavailable'};});
 const creditOptions=assignments.credit_accounts.map((a:any)=>{const source=accountByCanonical.get(a.canonical_account_id);return{...a,name:source?.name??source?.official_name??a.name,mask:source?.mask??a.mask};});
 return{...assignments,accounts:accountOptions,credit_accounts:creditOptions,streams,budget_targets:budgetTargets,categories:variable.categories,variable_spend_status:variable.status,unknown_bills:variable.unknown_bills,recurring_complete:recurring.coverage?.complete===true,recurring_fresh:freshSources,recurring_history_generation:recurring.history_generation,history_generation:variable.generation};
}
async function buildCashScopeFundingProjection(context:Context,envelope:any,base:any,timezone:string,today:string){
 const before=await serviceClient().rpc('finance_action_revision',{p_household_id:context.householdId});if(before.error)throw new Error('Financial source revision unavailable.');
 const current=await cashForecastFundingRead(context,envelope.plan.plan_id,timezone,today),rows=current.assignments as any[],accounts=envelope.accounts??[];
 if(!current.recurring_complete||!current.recurring_fresh||current.variable_spend_status!=='available'||String(current.history_generation)!==String(current.recurring_history_generation))throw new Error('Recurring or prepared history is stale or incomplete.');
 const attachedStreams=current.streams.map((stream:any)=>{const row=rows.find(a=>a.assignment_kind==='recurring_stream'&&a.assignment_key===stream.stream_key);return{...stream,funding_association:row?{stream_identity_fingerprint:row.identity_fingerprint,funding_canonical_account_id:row.funding_canonical_account_id,source_canonical_account_id:row.transfer_source_canonical_account_id,destination_canonical_account_id:row.transfer_destination_canonical_account_id,transfer_pair_id:row.transfer_pair_id,settled_by_stream_key:row.settled_by_stream_key,settled_credit_account_ids:row.settled_credit_account_ids}:null};});
 const targetAssignments=rows.filter(a=>a.assignment_kind==='budget_target').map(a=>({budget_target_id:a.assignment_key,canonical_account_id:a.funding_canonical_account_id,category_identity_fingerprint:a.identity_fingerprint}));
 const horizonDays=30,end=new Date(`${today}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+horizonDays);const endExclusive=end.toISOString().slice(0,10),occurrences=attachedStreams.flatMap((s:any)=>buildStreamOccurrences(s,today,endExclusive,{includeTransfers:true}));
 const monthEnd=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0,12)).toISOString().slice(0,10),forecastDate=monthEnd>=today&&monthEnd<=endExclusive?monthEnd:endExclusive;
 const variableSpend={status:current.variable_spend_status,unknown_bills:current.unknown_bills,categories:(current.categories??[]).map((c:any)=>({...c,forecast_date:forecastDate}))};
 const projection=projectCashScopeFromFunding({today,accountIds:base.canonical_account_ids,accounts,streams:attachedStreams,occurrences,variableSpend,categoryFunding:targetAssignments,horizonDays,now:Date.now(),recurringCoverageComplete:current.recurring_complete&&current.recurring_fresh,historyFresh:current.variable_spend_status==='available'&&String(current.history_generation)===String(current.recurring_history_generation),sourceRevision:String(before.data)});
 const after=await serviceClient().rpc('finance_action_revision',{p_household_id:context.householdId});if(after.error||String(after.data)!==String(before.data))throw new Error('Financial sources changed while funding projection was prepared.');
 const remainingByTarget=new Map((current.categories??[]).map((c:any)=>[String(c.id),c.remaining])),accountByCanonical=new Map(accounts.map((a:any)=>[a.canonical_account_id,a]));
 const summary={status:projection.status,reason:projection.reason,unresolved:projection.unresolved??[],household_id:context.householdId,actor_user_id:context.userId,plan_id:envelope.plan.plan_id,plan_version:envelope.plan.version,timezone,today,canonical_account_ids:base.canonical_account_ids,accounts:current.accounts,credit_accounts:current.credit_accounts,assignments:current.assignments,streams:current.streams.map((s:any)=>({stream_key:s.stream_key,description:s.description,recurring_kind:s.recurring_kind,canonical_account_id:s.canonical_account_id,account_type:accountByCanonical.get(s.canonical_account_id)?.type??null,flow_type:s.flow_type,identity_fingerprint:recurringFundingIdentity(s),version:rows.find(a=>a.assignment_kind==='recurring_stream'&&a.assignment_key===s.stream_key)?.version??0})),budget_targets:current.budget_targets.map((t:any)=>({...t,projected_remaining:remainingByTarget.get(String(t.budget_target_id))??0,version:rows.find(a=>a.assignment_kind==='budget_target'&&a.assignment_key===t.budget_target_id)?.version??0})),unknown_bills:current.unknown_bills};
 return{projection:projection.status==='current'?{...projection,identity:{household_id:context.householdId,actor_user_id:context.userId,plan_id:envelope.plan.plan_id,plan_version:envelope.plan.version,timezone,today,canonical_account_ids:base.canonical_account_ids}}:null,summary};
}
async function audit(db: any, context: Context, action: string, entityType: string, entityId: string, metadata: Row) { const { error } = await db.from("finance_audit_events").insert({ household_id: context.householdId, actor_user_id: context.userId, action, entity_type: entityType, entity_id: entityId, metadata }); if (error) console.error("Could not write audit event", error.message); }
async function plaid(item: Item, path: string, body: Row, deadline?: number) {
  const controller = new AbortController();
  const remaining = deadline === undefined ? 8000 : Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(`https://${item.plaid_environment}.plaid.com${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: required("PLAID_CLIENT_ID").trim(), secret: required("PLAID_SECRET").trim(), ...body }), signal: controller.signal });
    // Keep the same signal active while consuming the body; headers alone do
    // not mean the provider request has finished.
    return { ok: response.ok, data: await response.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}
async function sp500History(startDate: string, endDate: string) {
  const url = new URL(`https://api.massive.com/v2/aggs/ticker/I:SPX/range/1/day/${startDate}/${endDate}`);
  url.searchParams.set("sort", "asc"); url.searchParams.set("limit", "50000"); url.searchParams.set("apiKey", required("MASSIVE_API_KEY").trim());
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === "ERROR") throw new Error(`Massive request returned ${response.status}.`);
  return (Array.isArray(data.results) ? data.results : []).flatMap((row: any) => { const timestamp = finite(row.t), close = finite(row.c); return timestamp > 0 && close > 0 ? [{ snapshot_date: new Date(timestamp).toISOString().slice(0, 10), close }] : []; });
}
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> { const results = Array<R>(items.length); let cursor = 0; async function run() { while (cursor < items.length) { const index = cursor++; results[index] = await worker(items[index]); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run)); return results; }
function resolveRequestTimeZone(value:unknown){try{return resolveCalendarTimeZone(value);}catch{throw new RequestError("timezone must be a valid IANA time zone.");}}
function dateOnly(value:Date){return value.toISOString().slice(0,10);}
function buildRecurringSchedule(streams:any[],startDate:string,days:number,complete:boolean,timeZone="UTC"){const end=new Date(startDate+"T00:00:00Z");end.setUTCDate(end.getUTCDate()+days);const endDate=dateOnly(end),occurrences=streams.flatMap(stream=>buildStreamOccurrences(stream,startDate,endDate,{includeExcluded:true}));return{start_date:startDate,end_date:endDate,timezone:timeZone,horizon_days:days,complete,occurrences};}
function buildStreamOccurrences(stream:any,startDate:string,endExclusive:string,options:{includeExcluded?:boolean;includeTransfers?:boolean}={}){
  const transfer=planningStreamKind(stream)==="internal-transfer";
  if(stream.is_active!==true||(!options.includeExcluded&&stream.include_in_forecast===false)||(!options.includeTransfers&&stream.primary_eligible===false)||(!options.includeTransfers&&Array.isArray(stream.review_reasons)&&stream.review_reasons.length>0)||(transfer&&!options.includeTransfers)||stream.expected_amount==null||!Number.isFinite(Number(stream.expected_amount))||Number(stream.expected_amount)<=0||!stream.predicted_next_date||!isSupportedRecurringFrequency(stream.frequency))return[];
  const start=new Date(startDate+"T00:00:00Z"),end=new Date(endExclusive+"T00:00:00Z");let occurrence=new Date(stream.predicted_next_date+"T00:00:00Z");if(!Number.isFinite(occurrence.getTime())||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))return[];
  const anchorDay=occurrence.getUTCDate(),dates:string[]=[];let guard=0,previousDate=dateOnly(previousOccurrence(occurrence,stream.frequency,anchorDay));
  while(occurrence<start&&guard++<5000){previousDate=dateOnly(occurrence);occurrence=nextOccurrence(occurrence,stream.frequency,anchorDay);}
  guard=0;while(occurrence<end&&guard++<40){if(occurrence>=start)dates.push(dateOnly(occurrence));occurrence=nextOccurrence(occurrence,stream.frequency,anchorDay);}
  if(stream.pending_occurrence_date&&dates.length){const pending=Date.parse(stream.pending_occurrence_date+"T00:00:00Z"),candidates=[...(previousDate?[{date:previousDate,index:-1}]:[]),...dates.map((date,index)=>({date,index})),{date:dateOnly(occurrence),index:-2}].map(row=>({...row,distance:Math.abs(Date.parse(row.date+"T00:00:00Z")-pending)})).filter(row=>row.distance<=7*86400000).sort((a,b)=>a.distance-b.distance);const closest=candidates[0],tie=closest&&candidates[1]?.distance===closest.distance;if(closest&&closest.index>=0&&!tie)dates.splice(closest.index,1);}
  return filterLifecycleOccurrences(dates.map(date=>({stream_key:stream.stream_key,date,amount:Math.abs(Number(stream.expected_amount)),flow_type:stream.flow_type,recurring_kind:stream.recurring_kind,account_id:stream.account_id,account_name:stream.account_name,description:stream.description,include_in_forecast:stream.include_in_forecast!==false})),stream);
}
function nextOccurrence(value: Date, frequency: string, anchorDay=value.getUTCDate()) { const next = new Date(value); if (frequency === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7); else if (frequency === "BIWEEKLY") next.setUTCDate(next.getUTCDate() + 14); else if (frequency === "SEMI_MONTHLY") next.setUTCDate(next.getUTCDate() + 15); else if (frequency === "ANNUALLY") {const month=next.getUTCMonth();next.setUTCFullYear(next.getUTCFullYear()+1);if(next.getUTCMonth()!==month)next.setUTCDate(0);} else {const targetMonth=next.getUTCMonth()+1,year=next.getUTCFullYear()+Math.floor(targetMonth/12),month=(targetMonth%12+12)%12;next.setUTCDate(1);next.setUTCFullYear(year,month,1);const lastDay=new Date(Date.UTC(year,month+1,0)).getUTCDate();next.setUTCDate(Math.min(anchorDay,lastDay));} return next; }
function currentOrNextDate(value: string, frequency: string, timeZone=DEFAULT_CALENDAR_TIME_ZONE, now=new Date()) { let result = new Date(`${value}T00:00:00Z`); if (!Number.isFinite(result.getTime())) return null; const anchorDay=result.getUTCDate(),today = new Date(`${calendarDate(now,timeZone)}T00:00:00Z`); let guard = 0; while (result < today && guard++ < 500) result = nextOccurrence(result, frequency,anchorDay); return result.toISOString().slice(0, 10); }
function deriveNextDate(lastDate:string,frequency:string,timeZone=DEFAULT_CALENDAR_TIME_ZONE){const last=new Date(`${lastDate}T00:00:00Z`);if(!Number.isFinite(last.getTime()))return null;return currentOrNextDate(nextOccurrence(last,frequency,last.getUTCDate()).toISOString().slice(0,10),frequency,timeZone);}
function preferObservedNextDate(lastDate:string,frequency:string,providerDate:string,timeZone=DEFAULT_CALENDAR_TIME_ZONE){const observed=deriveNextDate(lastDate,frequency,timeZone),provider=new Date(`${providerDate}T00:00:00Z`),derived=new Date(`${observed}T00:00:00Z`);if(!observed||!Number.isFinite(provider.getTime())||!Number.isFinite(derived.getTime()))return observed??providerDate;return Math.abs(provider.getTime()-derived.getTime())>8*86400000?observed:providerDate;}
function isSupportedRecurringFrequency(value:unknown){return ["WEEKLY","BIWEEKLY","SEMI_MONTHLY","MONTHLY","ANNUALLY"].includes(String(value??"").toUpperCase().replaceAll(" ","_"));}
function parseRecurringFrequency(value:unknown){const raw=string(value,"frequency",30).toUpperCase().replaceAll(" ","_");const aliases:Record<string,string>={ANNUAL:"ANNUALLY",YEARLY:"ANNUALLY",SEMIMONTHLY:"SEMI_MONTHLY",BI_WEEKLY:"BIWEEKLY"};const frequency=aliases[raw]??raw;if(!isSupportedRecurringFrequency(frequency))throw new RequestError("Unsupported recurring frequency.");return frequency;}
function recurringIdentityMatches(saved:any,current:any){if(!saved.canonical_account_id||saved.canonical_account_id!==String(current.canonical_account_id??current.account_id)||saved.flow_type!==current.flow_type||saved.currency_code!==current.currency_code)return false;const oldIds=Array.isArray(saved.transaction_ids)?saved.transaction_ids:[],newIds=Array.isArray(current.transaction_ids)?current.transaction_ids:[];return oldIds.some((id:string)=>newIds.includes(id));}
function findRecurringOverride(rows:any[],key:string,streamId:string|null,identity:any){return (rows.find(row=>row.stream_key===key)||rows.find(row=>streamId&&row.plaid_stream_id===streamId)||rows.find(row=>recurringIdentityMatches(row,identity)))??null;}
function manualTransactionMatch(manual:any,tx:any,account:any,explicit=false){if(!account||tx.pending||tx.excluded_from_totals)return false;const canonicalOk=!account.canonical_account_id||tx.canonical_account_id===account.canonical_account_id;if(tx.account_id!==manual.account_id&&!canonicalOk)return false;const inflow=manual.flow_type==="inflow",cardPayment=/credit.card.payment|card.repayment/i.test(String(tx.effective_category??"")),internalTransfer=manual.recurring_kind_override==="internal_transfer";if(internalTransfer){if(tx.effective_type!=="transfer"||cardPayment||(inflow?Number(tx.amount)>=0:Number(tx.amount)<=0))return false;}else if(inflow?!(Number(tx.amount)<0&&["income","other_inflow"].includes(String(tx.effective_type))):!(Number(tx.amount)>0&&(tx.effective_type==="expense"||tx.effective_type==="transfer"&&cardPayment)))return false;if((manual.currency_code??"USD")!==String(tx.iso_currency_code??"USD"))return false;if(explicit)return true;const expected=finite(manual.amount),actual=Math.abs(Number(tx.amount));if(expected<=0||Math.abs(expected-actual)>Math.max(5,expected*.15))return false;const needle=normalize(manual.match_text),merchant=normalize(tx.effective_merchant_name);const exactName=merchant===needle||merchant.startsWith(`${needle}-`)||merchant.includes(`-${needle}-`)||merchant.endsWith(`-${needle}`);if(!needle||needle.length<3||!exactName)return false;return dateNearCadence(String(tx.effective_transaction_date),String(manual.next_date),String(manual.frequency));}
function dateNearCadence(actualDate:string,nextDate:string,frequency:string){const actual=new Date(`${actualDate}T00:00:00Z`),next=new Date(`${nextDate}T00:00:00Z`);if(!Number.isFinite(actual.getTime())||!Number.isFinite(next.getTime()))return false;const anchor=next.getUTCDate();let start=new Date(next),guard=0;while(start>actual&&guard++<40)start=previousOccurrence(start,frequency,anchor);let cursor=start;for(let i=0;i<4&&cursor<=actual;i++)cursor=nextOccurrence(cursor,frequency,anchor);const candidates=[start,cursor,previousOccurrence(cursor,frequency,anchor)],tolerance=frequency==="WEEKLY"||frequency==="BIWEEKLY"?4:frequency==="SEMI_MONTHLY"?5:frequency==="ANNUALLY"?21:7;return candidates.some(date=>Math.abs(date.getTime()-actual.getTime())<=tolerance*86400000);}
function previousOccurrence(value:Date,frequency:string,anchorDay=value.getUTCDate()){const prior=new Date(value);if(frequency==="WEEKLY")prior.setUTCDate(prior.getUTCDate()-7);else if(frequency==="BIWEEKLY")prior.setUTCDate(prior.getUTCDate()-14);else if(frequency==="SEMI_MONTHLY")prior.setUTCDate(prior.getUTCDate()-15);else if(frequency==="ANNUALLY"){const month=prior.getUTCMonth();prior.setUTCFullYear(prior.getUTCFullYear()-1);if(prior.getUTCMonth()!==month)prior.setUTCDate(0);}else{const month=prior.getUTCMonth()-1,year=prior.getUTCFullYear()+Math.floor(month/12),target=(month%12+12)%12;prior.setUTCDate(1);prior.setUTCFullYear(year,target,1);prior.setUTCDate(Math.min(anchorDay,new Date(Date.UTC(year,target+1,0)).getUTCDate()));}return prior;}
function manualMatchesPlaid(manual: any, plaidStream: any, accountMap: Map<unknown, unknown>, linkedManualIds: Set<string> = new Set()) {
  const manualAccount = accountMap.get(manual.account_id) as any, plaidAccount = accountMap.get(plaidStream.account_id) as any;
    if (!manualAccount || !plaidAccount || plaidStream.flow_type !== (manual.flow_type === "outflow" ? "outflow" : "inflow")) return false;
  const sameAccount = manual.account_id === plaidStream.account_id || (manualAccount.canonical_account_id && manualAccount.canonical_account_id === plaidAccount.canonical_account_id);
  if (!sameAccount) return false;
  if (manual.plaid_stream_id && manual.plaid_stream_id === plaidStream.stream_id) return true;
  if (manual.plaid_stream_key && (manual.plaid_stream_key === plaidStream.stream_key || plaidStream.source_stream_keys?.includes(manual.plaid_stream_key))) return true;
  if (manual.source_transaction_id && plaidStream.transaction_ids.includes(manual.source_transaction_id)) return true;
  if ([...linkedManualIds].some(id => plaidStream.transaction_ids.includes(id))) return true;
  if(plaidStream.recurring_kind==="credit_card_repayment"||plaidStream.recurring_kind==="internal_transfer"&&manual.recurring_kind_override!=="internal_transfer")return false;
  const needle = normalize(manual.match_text), name = normalize(manual.name), haystack = normalize(`${plaidStream.description ?? ""} ${plaidStream.merchant_name ?? ""}`);
  const textMatch = needle.length >= 3 && (haystack === needle || haystack.startsWith(`${needle}-`) || haystack.includes(`-${needle}-`) || haystack.endsWith(`-${needle}`));
  const exactName = name.length >= 4 && (haystack === name || haystack.startsWith(`${name}-`) || haystack.includes(`-${name}-`) || haystack.endsWith(`-${name}`));
  const expected = finite(manual.amount), actual = finite(plaidStream.expected_amount ?? plaidStream.last_amount ?? plaidStream.average_amount);
  if(plaidStream.expected_amount==null&&actual===0&&(normalize(plaidStream.description)===needle||normalize(plaidStream.merchant_name)===needle||normalize(plaidStream.description)===name)&&sameCadence(manual.frequency,plaidStream.frequency))return true;
  // Provider average/last values may be stale and must never set the displayed
  // amount, but they are useful corroboration when binding a manual rule to a
  // provider identity after optional transaction history is unavailable.
  const identityAmounts=[plaidStream.expected_amount,plaidStream.last_amount,plaidStream.average_amount]
    .map((value:any)=>typeof value==="number"&&Number.isFinite(value)?Math.abs(value):null)
    .filter((value:number|null):value is number=>value!==null&&value>0);
  const amountMatch = expected > 0 && identityAmounts.some(value=>Math.abs(expected-value)<=Math.max(5,expected*.2));
  return (textMatch || exactName) && amountMatch && sameCadence(manual.frequency,plaidStream.frequency);
}
function manualRulesMatch(a:any,b:any,accountMap:Map<unknown,unknown>,aIds:Set<string>,bIds:Set<string>){
  const aa=accountMap.get(a.account_id) as any,ba=accountMap.get(b.account_id) as any;if(!aa||!ba)return false;
  if((a.account_id!==b.account_id&&(!aa.canonical_account_id||aa.canonical_account_id!==ba.canonical_account_id))||a.flow_type!==b.flow_type||(a.currency_code??"USD")!==(b.currency_code??"USD"))return false;
  const linked=(a.source_transaction_id&&a.source_transaction_id===b.source_transaction_id)||(a.plaid_stream_id&&a.plaid_stream_id===b.plaid_stream_id)||(a.plaid_stream_key&&a.plaid_stream_key===b.plaid_stream_key)||[...aIds].some(id=>bIds.has(id));if(linked)return true;
  const textA=normalize(a.match_text),textB=normalize(b.match_text),amountA=finite(a.amount),amountB=finite(b.amount);
  return textA.length>=3&&textA===textB&&sameCadence(a.frequency,b.frequency)&&amountA>0&&amountB>0&&Math.abs(amountA-amountB)<=Math.max(5,Math.min(amountA,amountB)*.05);
}
function planningStreamKind(stream: any) { const normalized=String(stream.recurring_kind??"");if(normalized==="income")return"income";if(normalized==="internal_transfer")return"internal-transfer";if(normalized==="credit_card_repayment")return"repayment";if(normalized==="needs_review")return"needs-review";if(normalized==="subscription")return"subscription";if(normalized==="expense")return"bill"; const primary = String(stream.personal_finance_category_primary ?? "").toLowerCase(), detail = String(stream.personal_finance_category_detailed ?? "").toLowerCase(), description = String(stream.description ?? stream.merchant_name ?? ""); if (primary.includes("credit_card_payment") || detail.includes("credit_card_payment") || /credit card (?:payment|repayment)/i.test(description)) return "repayment"; if (/^transfer/.test(primary) || /^transfer/.test(detail) || /\b(?:online )?transfer (?:to|from) (?:checking|savings|chk|sav)\b/i.test(description) || /\b(?:internal|inter-?account) transfer\b/i.test(description)) return "internal-transfer"; return stream.flow_type === "inflow" ? "income" : "bill"; }

function recurringKey(item: Item, account: any, flow: string, stream: any) { return [normalize(item.institution_name ?? "institution"), normalize(account.canonical_account_id ?? account.mask ?? account.account_id), flow, stream.stream_id?`plaid-${normalize(stream.stream_id)}`:normalize(stream.description ?? stream.merchant_name ?? "recurring"), stream.stream_id?"":"legacy"].join("|").slice(0, 240); }
export function serviceClient() { return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } }); }
function required(name: string) { const value = Deno.env.get(name); if (!value) throw new Error("Server configuration is incomplete."); return value; }
function record(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function only(body: Row, allowed: string[]) { const extra = Object.keys(body).find(key => !allowed.includes(key)); if (extra) throw new RequestError(`Unknown request property: ${extra}.`); }
function string(value: unknown, name: string, max: number) { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new RequestError(`${name} is invalid.`); return value.trim(); }
function nullableString(value: unknown, name: string, max: number) { if (value == null || value === "") return null; return string(value, name, max); }
function boolean(value: unknown, name: string) { if (typeof value !== "boolean") throw new RequestError(`${name} must be boolean.`); return value; }
function finite(value: unknown) { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) ? number : 0; }
function hashText(text:string){let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);return(hash>>>0).toString(16);}
function preparedHistoryFailureCode(error:unknown){const message=error instanceof Error?error.message:"";if(message.includes("changed during lookup"))return"generation_changed";if(message.includes("count"))return"invalid_count";if(message.includes("bounded lookup limit"))return"row_limit";if(message.includes("pagination"))return"pagination_incomplete";return"prepared_history_unavailable";}
function variableSpendFailureCode(error:unknown){const message=error instanceof Error?error.message:"";if(message.includes("Prepared transaction history is stale"))return"prepared_history_incomplete";if(message.includes("Transaction history changed"))return"generation_changed";if(message.includes("pagination"))return"pagination_incomplete";if(message.includes("Flexible budget estimate"))return"estimate_unavailable";if(message.includes("Complete budget history"))return"recurring_or_history_incomplete";if(message.includes("Complete financial data"))return"budget_inputs_unavailable";if(message.includes("exceeds the complete evaluation limit"))return"history_limit";return"unexpected";}
function forecastSnapshotTimeZone(snapshot:any){return snapshot?.source_provenance?.forecast_inputs?.timezone??snapshot?.source_provenance?.timezone??DEFAULT_CALENDAR_TIME_ZONE;}
function forecastEconomicChanges(previous:any,current:{accountStates:any[];events:any[];variableSpend:any}){
 if(!previous)return[];
 const changes:any[]=[];
 const priorAccounts=new Map((previous.account_states??[]).map((a:any)=>[a.canonical_account_id,a]));
 for(const account of current.accountStates){const prior:any=priorAccounts.get(account.canonical_account_id);if(prior&&Number(prior.balance)!==Number(account.balance))changes.push({kind:"balance_changed",canonical_account_id:account.canonical_account_id,before:prior.balance,after:account.balance,delta:round(Number(account.balance)-Number(prior.balance))});}
 const eventKey=(event:any)=>`${event.stream_key??""}|${event.date??""}`;
 const oldEvents=new Map((previous.events??[]).filter((event:any)=>event.forecast_adjustment!==true).map((event:any)=>[eventKey(event),event])),newEvents=new Map(current.events.filter((event:any)=>event.forecast_adjustment!==true).map((event:any)=>[eventKey(event),event]));
 for(const [key,event] of newEvents){const before:any=oldEvents.get(key);if(!before)changes.push({kind:"scheduled_event_added",stream_key:event.stream_key??null,date:event.date,amount:event.amount});else if(Number(before.amount)!==Number(event.amount)||JSON.stringify(before.categories??null)!==JSON.stringify(event.categories??null))changes.push({kind:"scheduled_event_changed",stream_key:event.stream_key??null,date:event.date,before:before.amount,after:event.amount,delta:round(Number(event.amount)-Number(before.amount))});}
 for(const [key,event] of oldEvents)if(!newEvents.has(key))changes.push({kind:"scheduled_event_removed",stream_key:event.stream_key??null,date:event.date,amount:event.amount});
 const priorVariable=previous.source_provenance?.forecast_inputs?.variable_spend;
 if(priorVariable?.status==="available"&&current.variableSpend?.status==="available"&&(Number(priorVariable.amount)!==Number(current.variableSpend.amount)||JSON.stringify(priorVariable.categories??[])!==JSON.stringify(current.variableSpend.categories??[])))changes.push({kind:"variable_spend_changed",before:Number(priorVariable.amount),after:Number(current.variableSpend.amount),delta:round(Number(current.variableSpend.amount)-Number(priorVariable.amount)),before_categories:priorVariable.categories??[],categories:current.variableSpend.categories??[]});
 return changes;
}
function strictNumber(value: unknown, name: string) { const number = typeof value === "number" ? value : Number(value); if (!Number.isFinite(number)) throw new RequestError(`${name} is invalid.`); return number; }
function amountValue(value: any) { if(value==null)return null;const raw=record(value)?value.amount:value;if(raw==null||raw==="")return null;const number=Number(raw);return Number.isFinite(number)?number:null; }
function money(value: unknown, name: string) { const number = strictNumber(value, name); if (number < 0 || number > 1_000_000_000) throw new RequestError(`${name} is invalid.`); return round(number); }
function percentage(value: unknown, name: string) { const number = strictNumber(value, name); if (number < 0 || number > 100) throw new RequestError(`${name} is invalid.`); return number; }
function uuid(value: unknown, name: string) { const result = string(value, name, 50); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new RequestError(`${name} must be a UUID.`); return result; }
function date(value: unknown, name: string) { if (value == null || value === "") return null; const result = string(value, name, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new RequestError(`${name} must use YYYY-MM-DD.`); return result; }
function shiftDate(value: string, days: number) { const result = new Date(`${value}T00:00:00Z`); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10); }
function normalize(value: unknown) { return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-") : ""; }
function round(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers }); }

export async function consistentPlanFinancialState(db:any,context:Context){
 const beforeResult=await db.rpc('finance_action_revision',{p_household_id:context.householdId});if(beforeResult.error)throw new Error(beforeResult.error.message);const before=beforeResult.data;
 const knownResult=await db.from('finance_planning_forecast_snapshots').select('*').eq('household_id',context.householdId).eq('horizon_days',30).eq('input_quality','complete').order('request_started_at',{ascending:false}).limit(1).maybeSingle();if(knownResult.error)throw new Error(knownResult.error.message);
 const accounts=await householdAccounts(db,context.householdId),recurring=await recurringResponse(context,knownResult.data,accounts),planning=await planningResponse(context,{horizon_days:30},recurring,accounts),state=await buildAuthoritativeFinancialState(db,context,recurring,planning),afterResult=await db.rpc('finance_action_revision',{p_household_id:context.householdId});if(afterResult.error)throw new Error(afterResult.error.message);const after=afterResult.data;
 if(typeof before!=='string'||before!==after)throw new RequestError('Financial data changed during plan review. Refresh and try again.',409);
 return {...state,financialRevision:after,budget_timezone:DEFAULT_CALENDAR_TIME_ZONE};
}
export async function getBudgetCategoryContext(db:any,context:Context,scope:{month:string;asOfDate:string;timezone:string}){
 const financial=await consistentPlanFinancialState(db,context);
 return mapBudgetCategoryContext(context,scope,financial);
}
export function mapBudgetCategoryContext(context:Context,scope:{month:string;asOfDate:string;timezone:string},financial:any){
 const scopeCurrent=financial.today===scope.asOfDate&&financial.today.slice(0,7)===scope.month&&scope.timezone==='UTC';
 const sourceRows=Array.isArray(financial.recurringSourceCoverage)?financial.recurringSourceCoverage:[],recurringFresh=sourceRows.length?sourceRows.every((source:any)=>{const fetched=Date.parse(String(source.fetched_at||'')),age=Date.now()-fetched;return source.expected!==true||source.status==='not_applicable'||source.status==='success'&&Number.isFinite(fetched)&&age>=0&&age<24*60*60*1000;}):financial.recurringGeneratedAt!=null;
 const generationValid=(value:any)=>typeof value==='number'?Number.isSafeInteger(value)&&value>=0:typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)&&Number.isSafeInteger(Number(value));
 const commonHistory=financial.history?.complete===true&&generationValid(financial.history?.generation)&&financial.history.currency_verified===true;
 const recurringGenerationValid=generationValid(financial.recurringHistoryGeneration);
 const recurringGenerationMatches=commonHistory&&recurringGenerationValid&&Number(financial.history.generation)===Number(financial.recurringHistoryGeneration);
 const recurringComplete=financial.recurringComplete===true&&recurringGenerationMatches&&recurringFresh;
 const recurringReady=recurringComplete&&financial.budgetCoachingReady===true&&financial.unknownBills===0;
 const targets=Array.isArray(financial.budgetTargets)?financial.budgetTargets:[],coaches=Array.isArray(financial.budgetCoaching)?financial.budgetCoaching:[];
 const categories=targets.map((target:any)=>{
  const coach=coaches.find((row:any)=>String(row.id)===String(target.budget_target_id));
  const sameCategory=targets.filter((other:any)=>String(other.category).trim().toLowerCase()===String(target.category).trim().toLowerCase());
  const bills=(financial.budgetContextBills||[]).filter((bill:any)=>String(bill.category||'').trim().toLowerCase()===String(target.category).trim().toLowerCase());
  const streams=(financial.recurring||[]).filter((stream:any)=>String(stream.category||'').trim().toLowerCase()===String(target.category).trim().toLowerCase());
  const invalidBill=bills.some((bill:any)=>bill.amountValid!==true||bill.currency_verified!==true||typeof bill.currency_code!=='string'||bill.currency_code.toUpperCase()!=='USD')||streams.some((stream:any)=>stream.currencyVerified!==true||typeof stream.currency!=='string'||stream.currency.toUpperCase()!=='USD');
  const lifecycleUnsupported=streams.some((stream:any)=>stream.lifecyclePaused===true||(Array.isArray(stream.lifecycleSkippedDates)&&stream.lifecycleSkippedDates.some((date:any)=>typeof date==='string'&&date.startsWith(scope.month)))||typeof stream.pendingOccurrenceDate==='string')||bills.some((bill:any)=>bill.lifecycle_paused===true||(Array.isArray(bill.lifecycle_skipped_dates)&&bill.lifecycle_skipped_dates.some((date:any)=>typeof date==='string'&&date.startsWith(scope.month)))||typeof bill.pending_occurrence_date==='string');
  const unsupported=target.subcategory!=null&&String(target.subcategory)!==''?'subcategory_not_supported':sameCategory.length!==1?'ambiguous_category_target':target.currency_code!=='USD'?'currency_not_supported':null;
  const baseReason=!scopeCurrent?'scope_mismatch':!commonHistory?'history_unavailable':!recurringReady?'recurring_or_history_incomplete':unsupported|| (lifecycleUnsupported?'lifecycle_or_pending_occurrence_unmodeled':null);
  const reserve=coach?.reserve,commitmentAvailable=!baseReason&&!invalidBill&&!!coach&&reserve!==null&&reserve!==undefined&&Number.isFinite(Number(reserve));
  const projected=coach?.projected,projectionAvailable=commitmentAvailable&&target.group==='Flexible'&&coach?.usable===true&&projected!==null&&projected!==undefined&&Number.isFinite(Number(projected));
  const reason=baseReason||(invalidBill?'bill_amount_or_currency_unknown':!coach?'category_estimate_unavailable':null);
  return {budget_target_id:target.budget_target_id,category:target.category,subcategory:target.subcategory,currency_code:target.currency_code,group:target.group,recurring_committed:{available:commitmentAvailable,amount:commitmentAvailable?Number(reserve):null,reason:commitmentAvailable?null:reason},projected_month_end_spend:{available:projectionAvailable,amount:projectionAvailable?Number(projected):null,reason:projectionAvailable?null:reason||(target.group!=='Flexible'?'projection_requires_flexible_category':'history_or_coach_gate')}};
 });
 return {household_id:context.householdId,scope:{household_id:context.householdId,month:scope.month,as_of_date:scope.asOfDate,timezone:scope.timezone},financial_revision:financial.financialRevision,coverage:{complete:commonHistory&&recurringReady&&scopeCurrent,history_complete:commonHistory,history_generation:financial.history?.generation??null,history_period_start:financial.history?.period_start??null,history_period_end:financial.history?.period_end??null,eligible_transaction_count:financial.history?.eligible_transaction_count??null,transaction_currency_verified:financial.history?.currency_verified===true,allocation_coverage:financial.history?.allocation_coverage??{status:'unavailable',parent_count:null,unavailable_parent_count:null},recurring_complete:recurringComplete,recurring_fresh:recurringFresh,recurring_generated_at:financial.recurringGeneratedAt??null,recurring_configuration_revision:financial.recurringConfigurationRevision??null,recurring_history_generation:financial.recurringHistoryGeneration??null,recurring_history_generation_valid:recurringGenerationValid,recurring_history_generation_matches:recurringGenerationMatches,history_ready:financial.budgetCoachingReady===true},categories};
}
export async function refreshAgentState(context:Context){
 const {error}=await serviceClient().rpc('reconcile_financial_plan_lifecycle',{p_household_id:context.householdId,p_user_id:context.userId});
 if(error)throw new Error(error.message);
 const state=await consistentPlanFinancialState(serviceClient(),context);
 return evaluateAgentEvents(context,state,true);
}

/** Refreshes detector/snapshot evidence for read-only Assistant checks without
 * reconciling or changing any saved user plan/autonomy policy. */
export async function refreshAssistantEvidenceOnly(context:Context){
 const state=await consistentPlanFinancialState(serviceClient(),context);
 return evaluateAgentEvents(context,state,true,true);
}
export async function getAgentStateForAssistant(context:Context){return getAgentState(context,false,null,true);}





async function cachedSavingsForecastResponse(context:Context,horizon:number,timezone:string){
  return buildCachedSavingsForecastResponse(context,horizon,timezone,{
    loadForecast:(ctx,days,zone)=>cachedPlanningResponse(ctx,days,zone),
    db:serviceClient(),
    today:calendarDate(new Date(),timezone),
    now:new Date().toISOString(),
  });
}





function sameGoalCreationPayload(left:unknown,right:unknown){if(!record(left)||!record(right))return false;return ["goal_type","goal_category","deadline_date","name","target_amount","current_amount","monthly_contribution"].every(key=>String(left[key]??"")===String(right[key]??""));}





async function saveGoalSavingsSettings(context:Context,body:Row){
  only(body,["action","household_id","goal_id","tracking_mode","links","policy","request_key"]);
  const goalId=uuid(body.goal_id,"goal_id"),mode=string(body.tracking_mode,"tracking_mode",30),policy=body.policy===undefined?"balanced":string(body.policy,"policy",30),requestKey=string(body.request_key,"request_key",100);
  if(!["manual","balance","net_contributions"].includes(mode))throw new RequestError("Choose manual, balance-based, or net-contribution tracking.");
  if(!["conservative","balanced","proactive"].includes(policy))throw new RequestError("Choose a supported savings policy.");
  if(!Array.isArray(body.links)||body.links.length>8)throw new RequestError("Link up to eight accounts, each with an explicit allocation.");
  const links=body.links.map((item:any)=>{if(!record(item))throw new RequestError("Every account link needs a canonical account.");const canonical_account_id=uuid(item.canonical_account_id,"canonical_account_id");if(item.allocated_amount===undefined||item.allocated_amount===null)return {canonical_account_id};return {canonical_account_id,allocated_amount:money(item.allocated_amount,"allocated_amount")};});
  if(mode!=="manual"&&!links.length)throw new RequestError("Link at least one canonical account before enabling automatic tracking.");
  const db=serviceClient();const {data,error}=await db.rpc("save_goal_savings_settings",{p_household_id:context.householdId,p_user_id:context.userId,p_goal_id:goalId,p_tracking_mode:mode,p_links:links,p_policy:policy,p_request_key:requestKey});
  if(error)throw new RequestError(error.message,409);
  await refreshAgentState(context).catch(()=>{});
  return {goal:data};
}





async function getSavingsActivity(context:Context,body:Row){
  return getSavingsActivityRead(context,body,serviceClient(),{
    loadForecast:(ctx,timezone)=>cachedSavingsForecastResponse(ctx,90,timezone),
  });
}





/** Lightweight persisted savings summary for Planning cards; never scans activity rows. */
async function getSavingsOverview(context:Context,body:Row){
  only(body,["action","household_id","timezone"]);
  const timezone=resolveRequestTimeZone(body.timezone),today=calendarDate(new Date(),timezone),monthStart=`${today.slice(0,7)}-01`;
  const monthParts=today.slice(0,7).split("-").map(Number),nextMonth=new Date(Date.UTC(monthParts[0],monthParts[1],1,12));
  const through=`${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth()+1).padStart(2,"0")}-01`;
  const historyStartDate=new Date(Date.UTC(monthParts[0],monthParts[1]-1-36,1,12)).toISOString().slice(0,10);
  const db=serviceClient(),goalResult=await db.from("finance_planning_goals").select("goal_id,name,target_amount,current_amount,monthly_contribution,active,tracking_mode,savings_policy,goal_category,deadline_date").eq("household_id",context.householdId).eq("goal_type","save").eq("active",true).order("created_at");
  if(goalResult.error)throw new Error("Savings goals could not be loaded.");
  const goals=goalResult.data||[],ids=goals.map((goal:any)=>String(goal.goal_id));
  if(!ids.length)return {as_of:today,timezone,goals:[],forecast_status:"unavailable"};
  const [balances,monthly,history,plans,forecast]=await Promise.all([
    db.rpc("finance_get_goal_savings_account_balances",{p_household_id:context.householdId}),
    db.rpc("finance_get_savings_month_summary",{p_household_id:context.householdId,p_goal_ids:ids,p_from:monthStart,p_through:through}),
    db.rpc("finance_get_savings_monthly_history",{p_household_id:context.householdId,p_goal_ids:ids,p_from:historyStartDate,p_through:monthStart}),
    db.from("finance_household_plans").select("goal_id,priority,status,plan_type").eq("household_id",context.householdId).eq("status","active").eq("plan_type","savings").in("goal_id",ids),
    cachedSavingsForecastResponse(context,90,timezone).catch(()=>null),
  ]);
  for(const [name,result] of [["balances",balances],["monthly summary",monthly],["monthly history",history],["plan priorities",plans]] as any)if(result.error)throw new Error(`Savings ${name} could not be loaded.`);
  const rows=(value:any)=>Array.isArray(value?.data)?value.data:[];
  const balanceByGoal=new Map<string,number>();for(const row of rows(balances)){if(!ids.includes(String(row.goal_id)))continue;const amount=Number(row.current_allocated_balance);if(Number.isFinite(amount))balanceByGoal.set(String(row.goal_id),(balanceByGoal.get(String(row.goal_id))||0)+amount);}
  const monthByGoal=new Map(rows(monthly).map((row:any)=>[String(row.goal_id),row]));
  const historyByGoal=new Map<string,any[]>();for(const row of rows(history))historyByGoal.set(String(row.goal_id),[...(historyByGoal.get(String(row.goal_id))||[]),row]);
  const planByGoal=new Map(rows(plans).map((row:any)=>[String(row.goal_id),row]));
  const forecastInput=forecast?{ready:forecast.ready===true,complete:forecast.complete===true,reliable:forecast.reliable===true,current_for_forecast:forecast.current_for_forecast===true,projected_low:forecast.projected_low??null,potential_surplus_amount:forecast.potential_surplus_amount??null,surplus_basis:forecast.surplus_basis??null,potential_surplus_currency:forecast.potential_surplus_currency??null}:null;
  const intelligence=buildSavingsIntelligence({today,timezone,forecast:forecastInput,goals:goals.map((goal:any)=>{
    const goalId=String(goal.goal_id),quality=historyByGoal.get(goalId)||[];
    return {goalId,currentAmount:Number(goal.tracking_mode==="balance"?(balanceByGoal.get(goalId)??goal.current_amount):goal.current_amount)||0,targetAmount:Number(goal.target_amount),monthlyNetContributions:Number((monthByGoal.get(goalId) as any)?.month_net_contributions)||0,monthlyHistory:quality.map((row:any)=>({month:String(row.month_start).slice(0,7),net:Number(row.month_net_contributions)})),complete_month_count:Number(quality[0]?.complete_month_count)||0,history_complete:quality[0]?.history_complete===true,history_reliable:quality[0]?.history_reliable===true,internal_transfers_excluded:quality[0]?.internal_transfers_excluded===true,planPriority:(planByGoal.get(goalId) as any)?.priority??null,targetDate:goal.deadline_date??null};
  })});
  const estimateByGoal=new Map(intelligence.goals.map((item:any)=>[item.goalId,item]));
  return {as_of:today,timezone,forecast_status:intelligence.forecast_status,potential_surplus:intelligence.potential_surplus,prioritized_goals:intelligence.prioritized_goals,goals:goals.map((goal:any)=>{const goalId=String(goal.goal_id),summary:any=monthByGoal.get(goalId)||{},estimate:any=estimateByGoal.get(goalId);return {...goal,current_amount:Number(goal.tracking_mode==="balance"?(balanceByGoal.get(goalId)??goal.current_amount):goal.current_amount)||0,month_net_contributions:Number(summary.month_net_contributions)||0,month_needs_review_amount:Number(summary.month_needs_review_amount)||0,monthly_savings_pace:estimate?.monthly_savings_pace??null,estimated_completion_date:estimate?.estimated_completion_date??null};})};
}





async function authoritativeSavingsNotifications(context:Context,timezone:string){
  const db=serviceClient();
  const [cursorResult,stateResult,allocationResult,unassignedResult,sourceQualityResult]=await Promise.all([
    db.from("finance_goal_savings_reconcile_state").select("last_revision,last_generation,last_transaction_id,initial_scan_complete").eq("household_id",context.householdId).maybeSingle(),
    db.from("finance_prepared_transaction_state").select("revision,generation,dirty").eq("household_id",context.householdId).maybeSingle(),
    db.from("finance_goal_savings_activity_allocations").select("activity_id,goal_id,allocated_signed_amount,status").eq("household_id",context.householdId).eq("status","review").order("updated_at",{ascending:false}).limit(100),
    db.from("finance_goal_savings_activity").select("activity_id").eq("household_id",context.householdId).eq("status","review").order("updated_at",{ascending:false}).limit(100),
    db.rpc("finance_savings_notification_sources_current",{p_household_id:context.householdId}),
  ]);
  if(cursorResult.error||stateResult.error||allocationResult.error||unassignedResult.error||sourceQualityResult.error||sourceQualityResult.data!==true||!cursorResult.data||!stateResult.data||!cursorResult.data.initial_scan_complete||String(cursorResult.data.last_transaction_id||'')!==''||stateResult.data.dirty||Number(cursorResult.data.last_revision)!==Number(stateResult.data.revision)||Number(cursorResult.data.last_generation)!==Number(stateResult.data.generation))return null;
  const reviewAllocations=allocationResult.data||[],ids=[...new Set([...reviewAllocations.map((row:any)=>String(row.activity_id)),...(unassignedResult.data||[]).map((row:any)=>String(row.activity_id))])];
  const [activityResult,forecast]=await Promise.all([
    ids.length?db.from("finance_goal_savings_activity").select("activity_id,goal_id,transaction_date,amount,description,evidence,status").eq("household_id",context.householdId).in("activity_id",ids):Promise.resolve({data:[],error:null}),
    cachedSavingsForecastResponse(context,90,timezone).catch(()=>null),
  ]);
  if(activityResult.error)return null;
  const events=activityResult.data||[],eventById=new Map(events.map((event:any)=>[String(event.activity_id),event]));
  const metadataResult=ids.length?await db.rpc("finance_get_savings_activity_review_metadata",{p_household_id:context.householdId,p_activity_ids:ids}):{data:[],error:null};
  if(metadataResult.error)return null;
  const metadata=new Map((metadataResult.data||[]).map((row:any)=>[String(row.activity_id),row]));
  const goalsResult=await db.from("finance_planning_goals").select("goal_id,name,tracking_mode,savings_policy").eq("household_id",context.householdId).eq("goal_type","save").eq("active",true);
  if(goalsResult.error)return null;
  const goalIdsByActivity=new Map<string,Set<string>>();
  for(const allocation of reviewAllocations){const key=String(allocation.activity_id),set=goalIdsByActivity.get(key)||new Set<string>();set.add(String(allocation.goal_id));goalIdsByActivity.set(key,set);}
  const unresolved_reviews:any[]=[];
  for(const activityId of ids){const event:any=eventById.get(activityId);if(!event||event.status==='excluded')continue;const allowed=new Set(((metadata.get(activityId) as any)?.eligible_goal_ids||[]).map(String));const goalSet=goalIdsByActivity.get(activityId)||new Set<string>();if(!goalSet.size&&event.goal_id&&allowed.has(String(event.goal_id)))goalSet.add(String(event.goal_id));if(!goalSet.size&&event.status==='review')for(const goalId of allowed)goalSet.add(goalId);for(const goalId of goalSet)if(allowed.has(goalId))unresolved_reviews.push({activity_id:activityId,goal_id:goalId,transaction_date:event.transaction_date,amount:Math.abs(Number(event.amount)),currency:event.evidence?.currency_code?String(event.evidence.currency_code).toUpperCase():null,merchant:String(event.description||"").slice(0,120)});}
  const safeForecast=forecast?.current_for_forecast===true&&forecast?.complete===true&&forecast?.reliable===true&&forecast?.potential_surplus_currency==='USD';
  const amount=Number(forecast?.potential_surplus_amount);
  const proactiveGoal=(goalsResult.data||[]).filter((goal:any)=>goal.tracking_mode!=='manual'&&goal.savings_policy==='proactive').sort((a:any,b:any)=>String(a.goal_id).localeCompare(String(b.goal_id)))[0]||null;
  const opportunity=proactiveGoal&&unresolved_reviews.length===0&&safeForecast&&forecast?.surplus_basis==='after_committed_obligations_and_cash_floor'&&Number.isFinite(amount)&&amount>=25?{amount:Math.round(amount*100)/100,basis:'after_committed_obligations_and_cash_floor',status:'available',forecast_current:true,credited:false,currency:'USD',goal_id:String(proactiveGoal.goal_id)}:null;
  return {unresolved_reviews,opportunity};
}





async function reviewSavingsActivity(context:Context,body:Row){
  only(body,["action","household_id","activity_id","expected_revision","decision","allocations","idempotency_key","learn_rule"]);
  const activityId=uuid(body.activity_id,"activity_id"),expectedRevision=integer(body.expected_revision,"expected_revision",1,1000000),decision=string(body.decision,"decision",20),idempotencyKey=string(body.idempotency_key,"idempotency_key",100);
  if(!["confirmed","review","excluded"].includes(decision)||!Array.isArray(body.allocations)||body.allocations.length>8)throw new RequestError("Choose a valid review decision and up to eight goal allocations.");
  const allocations=body.allocations.map((row:any)=>{if(!record(row))throw new RequestError("Every allocation requires a goal, amount, and status.");return {goal_id:uuid(row.goal_id,"goal_id"),allocated_signed_amount:signedMoney(row.allocated_signed_amount,"allocated_signed_amount"),status:row.status===undefined?decision:string(row.status,"status",20),...(row.decision_reason?{decision_reason:string(row.decision_reason,"decision_reason",120)}:{})};});
  const learnRule=body.learn_rule===undefined?false:boolean(body.learn_rule,"learn_rule");
  const {data,error}=await serviceClient().rpc("decide_goal_savings_activity",{p_household_id:context.householdId,p_user_id:context.userId,p_activity_id:activityId,p_expected_revision:expectedRevision,p_decision:decision,p_allocations:allocations,p_idempotency_key:idempotencyKey,p_learn_rule:learnRule});
  if(error)throw new RequestError(error.message,409);
  await refreshAgentState(context).catch(()=>{});
  return data;
}





async function undoSavingsActivityDecision(context:Context,body:Row){
  only(body,["action","household_id","audit_id","expected_revision","idempotency_key"]);
  const {data,error}=await serviceClient().rpc("undo_goal_savings_activity_decision",{p_household_id:context.householdId,p_user_id:context.userId,p_audit_id:uuid(body.audit_id,"audit_id"),p_expected_revision:integer(body.expected_revision,"expected_revision",1,1000000),p_idempotency_key:string(body.idempotency_key,"idempotency_key",100)});
  if(error)throw new RequestError(error.message,409);await refreshAgentState(context).catch(()=>{});return data;
}




function signedMoney(value: unknown, name: string) { const number = strictNumber(value, name); if (Math.abs(number) > 1_000_000_000) throw new RequestError(`${name} is invalid.`); return round(number); }



function integer(value:unknown,label:string,min:number,max:number){if(typeof value!=="number"||!Number.isSafeInteger(value)||value<min||value>max)throw new RequestError(label+" must be a bounded integer.",400);return value;}

export async function collectDailyInvestmentEvidence(context:Context){
 const db=serviceClient();if(!await folio2WorkerAllowed(db,context.householdId))return{status:'disabled'};
 try{return await collectInvestmentHousehold(db,context,{loadItems:()=>householdItems(db,context.householdId),request:plaid});}catch{return{status:'unavailable'};}
}
