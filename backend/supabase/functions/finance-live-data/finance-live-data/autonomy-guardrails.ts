type Row=Record<string,any>;
import {classifyAutonomyPreviewRisk} from './action-service.ts';
import {classifyActionRisk} from './action-risk.ts';
import {getEffectiveCategoryFloor} from '../_shared/budget-adjustment-policy.ts';
export const AUTONOMY_HARD_MAX_AMOUNT_CENTS=25000;
export const AUTONOMY_HARD_MAX_MONTHLY_AMOUNT_CENTS=50000;
export const AUTONOMY_MIN_CONFIDENCE=0.95;
export const AUTONOMY_CONFIDENCE_THRESHOLDS={normalize_merchant:.98,correct_category:.98,archive_expired:1,linked_transfer:.99,recurring_metadata:.95} as const;
const catalogRisk=(kind:string,evidence:Row)=>classifyActionRisk(kind,evidence);
export const AUTONOMY_ACTION_CATALOG=[
 {action_type:'reallocate_budget',label:'Bounded plan adjustment',risk_level:catalogRisk('reallocate_budget',{bounded_source_evidence:true,amount:25,from_category_id:'source',to_category_id:'destination',category_ids:['source','destination']}),autonomy_levels:['recommend_only','confirm','bounded_plan'],preview_only:false,max_amount_cents:AUTONOMY_HARD_MAX_AMOUNT_CENTS,max_monthly_amount_cents:AUTONOMY_HARD_MAX_MONTHLY_AMOUNT_CENTS,default_min_confidence:AUTONOMY_MIN_CONFIDENCE,min_categories:2,empty_means_none:true,requires_limits:true,scope_fields:['category_ids','plan_ids'],scope_description:'Only approved changes between selected categories in an active spending plan with a flexible source category.'},
 {action_type:'archive_expired',label:'Expired alert cleanup',risk_level:catalogRisk('archive_expired',{event_status:'expired',event_expired:true}),autonomy_levels:['recommend_only','confirm','auto_low_risk'],preview_only:false,scope_fields:[],scope_description:'Only expired alerts with no customer response.',requires_limits:false,default_min_confidence:1},
 {action_type:'normalize_merchant',label:'Merchant cleanup',risk_level:catalogRisk('normalize_merchant',{known_evidence:true,mapping_source:'confirmed_household_examples',confirmed_examples:3,confidence:.98}),autonomy_levels:['recommend_only','confirm','auto_low_risk'],preview_only:false,scope_fields:['account_ids','merchant_ids'],requires_limits:false,default_min_confidence:AUTONOMY_CONFIDENCE_THRESHOLDS.normalize_merchant},
 {action_type:'correct_category',label:'Known category correction',risk_level:catalogRisk('correct_category',{known_evidence:true,rule_created_by_user:true,rule_match_type:'exact',confidence:.98}),autonomy_levels:['recommend_only','confirm','auto_low_risk'],preview_only:false,scope_fields:['category_ids','account_ids'],requires_limits:false,default_min_confidence:AUTONOMY_CONFIDENCE_THRESHOLDS.correct_category},
];
const cents=(value:any):number|null=>{
 if(typeof value!=='number'||!Number.isFinite(value))return null;
 const scaled=value*100,rounded=Math.round(scaled);
 return Number.isSafeInteger(rounded)&&Math.abs(scaled-rounded)<1e-7?rounded:null;
};
const uniq=(items:any[])=>[...new Set(items.filter(item=>typeof item==='string'&&item.length>0))].sort();
function sameJson(a:any,b:any){return JSON.stringify(a??null)===JSON.stringify(b??null);}
const budgetCents=(value:any):number|null=>{
 if(typeof value!=='number'||!Number.isFinite(value))return null;
 const scaled=value*100,rounded=Math.round(scaled);
 return Number.isSafeInteger(rounded)&&Math.abs(scaled-rounded)<1e-7?rounded:null;
};
const strings=(value:any)=>Array.isArray(value)?[...new Set(value.filter((item:any)=>typeof item==='string'&&item.length>0))].sort():[];

// Eligibility uses a deterministic evidence score, not an LLM confidence.
// The .96 score is emitted only by buildBudgetAutonomyCandidates after all
// listed evidence predicates are satisfied and is independently checked here.
export function evaluateBudgetAutonomy(input:{policy:Row;candidate:Row;context:Row}){
 const {policy,candidate,context}=input,violations:string[]=[],checks:string[]=[];
 const monthly=candidate.monthly_budget_scope===true;
 const deny=(code:string)=>{if(!violations.includes(code))violations.push(code);};
 if(candidate.action_type!=='reallocate_budget'||policy?.action_type!=='reallocate_budget')deny('action_type_mismatch');
 const centralRisk=classifyActionRisk('reallocate_budget',candidate);
 if(candidate.risk_level!==centralRisk||centralRisk!=='medium')deny('risk_not_bounded_medium');
 if(policy?.enabled!==true||policy.autonomy_level!=='bounded_plan'||policy.execution_mode!=='live'||policy.execution_authorized!==true)deny('no_active_budget_permission');
 if(policy?.household_id!==context.household_id||candidate.household_id!==context.household_id||candidate.actor_user_id!==context.actor_user_id||!context.actor_user_id)deny('household_or_actor_mismatch');
 if(context.rollout_enabled!==true||context.kill_switch!==false)deny(context.kill_switch!==false?'kill_switch':'rollout_disabled');
 const today=typeof context.today==='string'?context.today:'';
 if(!today||policy.start_date&&policy.start_date>today||policy.end_date&&policy.end_date<today)deny('policy_outside_dates');
 if(candidate.fresh!==true||candidate.dispositioned===true)deny('candidate_not_fresh');
 const expires=Date.parse(String(candidate.expires_at||candidate.candidate_expires_at||''));
 if(!candidate.candidate_id||!candidate.candidate_version||!Number.isFinite(expires)||expires<=Date.now())deny('candidate_expired');
 if(typeof policy.version!=='number'||candidate.policy_version!==policy.version||context.policy_version!==policy.version)deny('policy_version_stale');
 const mode=policy.allowed_risk_levels;
 if(!Array.isArray(mode)||mode.length!==1||mode[0]!=='medium')deny('risk_not_allowed');
 const confidence=typeof candidate.confidence==='number'&&Number.isFinite(candidate.confidence)&&candidate.confidence>=0&&candidate.confidence<=1?candidate.confidence:null;
 const policyConfidence=typeof policy.min_confidence==='number'&&Number.isFinite(policy.min_confidence)&&policy.min_confidence>=0&&policy.min_confidence<=1?policy.min_confidence:null;
 if(policyConfidence===null)deny('invalid_policy_confidence');
 if(confidence===null||policyConfidence===null||confidence<Math.max(AUTONOMY_MIN_CONFIDENCE,policyConfidence)||candidate.confidence_basis?.kind!==(monthly?'posted_overage_with_monthly_category_permission':'posted_overage_with_plan_flexibility')||candidate.confidence_basis?.complete!==true)deny('confidence_evidence_incomplete');
 if(context.financial_revision_before!==context.financial_revision_after||!context.financial_revision_before||candidate.financial_revision!==context.financial_revision_after)deny('stale_financial_revision');
 if(!context.state_version_before||context.state_version_before!==context.state_version_after||candidate.state_version!==context.state_version_after)deny('stale_state_version');
 if(!sameJson(context.plan_versions_before,context.plan_versions_after)||!sameJson(candidate.plan_versions,context.plan_versions_after))deny('stale_plan_version');
 if(!candidate.recommendation_version||candidate.recommendation_version!==context.recommendation_version)deny('stale_recommendation_version');
 if(monthly&&(candidate.budget_month!==today.slice(0,7)||context.snapshot_month!==today.slice(0,7)))deny('stale_budget_month');
 const planId=String(candidate.plan_id||''),allowedPlans=strings(policy.scope?.plan_ids),allowedCategories=strings(policy.scope?.category_ids),candidateCategories=strings(candidate.category_ids);
 if(monthly ? policy.monthly_budget_scope!==true||policy.scope?.monthly_budget!==true||allowedPlans.length!==0||candidate.plan_id!=null||candidate.plan_version!=null||candidate.plan_delegated===true
   : !planId||!allowedPlans.includes(planId)||candidate.plan_delegated!==true)deny('plan_or_category_scope_mismatch');
 if(!candidateCategories.includes(candidate.from_category_id)||!candidateCategories.includes(candidate.to_category_id)||candidateCategories.length!==2||candidateCategories.some((id:string)=>!allowedCategories.includes(id)))deny('plan_or_category_scope_mismatch');
 const activePlan=(Array.isArray(context.active_plans)?context.active_plans:[]).find((plan:Row)=>String(plan.plan_id)===planId&&plan.status==='active'&&plan.plan_type==='spending_reduction'&&Number(plan.version)===Number(candidate.plan_version));
 const planStart=activePlan?.starts_on,planEnd=activePlan?.ends_on;
 const planWindowValid=typeof planStart==='string'&&typeof planEnd==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(planStart)&&/^\d{4}-\d{2}-\d{2}$/.test(planEnd)&&planStart<=today&&planEnd>=today;
 const targetIds=strings([candidate.from_budget_target_id,candidate.to_budget_target_id]);
 if(!monthly&&(!activePlan||!planWindowValid||!Array.isArray(activePlan.category_ids)||targetIds.length!==2||targetIds.some((id:string)=>!activePlan.category_ids.includes(id))||!Array.isArray(activePlan.constraints)||!activePlan.constraints.some((rule:Row)=>rule.kind==='flexible_category'&&rule.category_id===candidate.from_budget_target_id&&rule.level==='soft'&&(!rule.expires_on||rule.expires_on>=today))))deny('plan_delegation_not_current');
 if(monthly&&([candidate.from_category_id,candidate.to_category_id].some((id:string)=>policy.budget_category_permission_states?.[id]!=='automatic')))deny('category_permission_not_automatic');
 const sourceId=String(candidate.from_category_id||''),destinationId=String(candidate.to_category_id||''),protectedIds=strings([...(Array.isArray(context.protected_category_ids)?context.protected_category_ids:[]),...(Array.isArray(policy.protected_category_ids)?policy.protected_category_ids:[])]);
 if(candidate.affects_core_goal===true||candidate.protected_category_involved===true||protectedIds.includes(sourceId)||protectedIds.includes(destinationId))deny('protected_plan_or_category');
 if(context.state_complete!==true||context.history_complete!==true||context.recurring_complete!==true||context.forecast_complete!==true||context.unknown_bills!==false||context.unknown_currency!==false||context.duplicate_accounts===true||context.unresolved_identity_ambiguity===true)deny('financial_evidence_incomplete');
 if((Array.isArray(context.overlapping_candidate_ids)?context.overlapping_candidate_ids:[]).includes(candidate.candidate_id)||candidate.conflicts_with_state===true)deny('conflicting_action');
 const amount=budgetCents(candidate.amount),limit=budgetCents(policy.max_amount),monthlyLimit=budgetCents(policy.max_monthly_amount),cashLimit=budgetCents(policy.cash_floor);
 if(amount===null||amount<=0||limit===null||limit<=0||monthlyLimit===null||monthlyLimit<=0||cashLimit===null||cashLimit<0)deny('invalid_amount_limits');
 if(amount!==null&&(amount>AUTONOMY_HARD_MAX_AMOUNT_CENTS||limit!==null&&amount>limit))deny('per_action_limit');
 if(monthlyLimit!==null&&monthlyLimit>AUTONOMY_HARD_MAX_MONTHLY_AMOUNT_CENTS)deny('monthly_limit_above_central_maximum');
 const used=budgetCents(context.executed_monthly_amount),batch=budgetCents(context.batch_simulated_amount);
 if(context.actual_usage_known!==true||used===null||used<0||batch===null||batch<0)deny('monthly_usage_unavailable');
 if(amount!==null&&used!==null&&batch!==null&&monthlyLimit!==null&&used+batch+amount>monthlyLimit)deny('monthly_limit');
 const balances=candidate.category_balances||{},donor=balances[sourceId]||{},receiver=balances[destinationId]||{},targetFrom=budgetCents(donor.target),targetTo=budgetCents(receiver.target),expected=candidate.expected_targets||{};
 if(targetFrom===null||targetTo===null||budgetCents(expected[sourceId])!==targetFrom||budgetCents(expected[destinationId])!==targetTo)deny('budget_targets_stale');
 const activeMinimums=context.category_minimums||{},policyMinimums=policy.category_minimums||{};
 const hasActiveMinimum=Object.hasOwn(activeMinimums,sourceId),hasPolicyMinimum=Object.hasOwn(policyMinimums,sourceId);
 const spare=budgetCents(candidate.safe_spare),overage=budgetCents(receiver.posted_overage),sourceSpent=budgetCents(donor.spent),reserve=budgetCents(donor.known_reserve),projected=budgetCents(donor.projected_spend),additionalReserve=budgetCents(policy.budget_category_reserves?.[sourceId]??0),activeMinimum=hasActiveMinimum?budgetCents(activeMinimums[sourceId]):0,policyMinimum=hasPolicyMinimum?budgetCents(policyMinimums[sourceId]):0;
 if(spare===null||overage===null||sourceSpent===null||reserve===null||projected===null||additionalReserve===null||activeMinimum===null||policyMinimum===null||reserve<0||projected<0||additionalReserve<0||activeMinimum<0||policyMinimum<0)deny('donor_or_overage_evidence_incomplete');
 if(amount!==null&&(spare===null||overage===null||amount>spare||amount>overage))deny('donor_spare_or_posted_overage');
 const effectiveFloor=sourceSpent===null||reserve===null||projected===null||additionalReserve===null||activeMinimum===null||policyMinimum===null?null:budgetCents(getEffectiveCategoryFloor({consumed:sourceSpent/100,committed:reserve/100,projected:projected/100,legacyMinimum:Math.max(activeMinimum,policyMinimum)/100,customerReserve:additionalReserve/100})??NaN);
 if(targetFrom!==null&&amount!==null&&(effectiveFloor===null||targetFrom-amount<effectiveFloor))deny('donor_minimum');
 const forecastLow=budgetCents(context.forecast_low),hardFloor=budgetCents(context.hard_cash_floor);
 if(forecastLow===null||hardFloor===null||cashLimit===null||forecastLow<Math.max(hardFloor,cashLimit))deny('cash_floor');
 if(!violations.length)checks.push('explicit_owner_budget_delegation',monthly?'monthly_category_permissions':'active_plan_flexible_donor','posted_overage_evidence','canonical_posted_transactions','high_confidence_evidence','monthly_usage_and_caps','protected_categories','cash_floor','fresh_versions','household_kill_switch');
 const money=(value:any)=>typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value):null;
 const requested=money(candidate.amount),perActionAllowed=money(Math.min(Number(policy.max_amount)||0,AUTONOMY_HARD_MAX_AMOUNT_CENTS/100)),monthlyRemaining=typeof context.executed_monthly_amount==='number'&&typeof policy.max_monthly_amount==='number'?money(Math.max(0,Number(policy.max_monthly_amount)-context.executed_monthly_amount-(Number(context.batch_simulated_amount)||0))):null;
 const messages:Record<string,string>={
  kill_switch:'Automatic budget changes are paused right now. Folio left the budgets unchanged.',
  rollout_disabled:'Automatic budget changes are not available right now. Folio left the budgets unchanged.',
  no_active_budget_permission:'Folio will ask you before changing budget amounts because automatic adjustments are not enabled.',
  policy_outside_dates:'This automatic-action setting is outside its active dates. Review it in Settings before Folio can use it.',
  candidate_expired:'This suggestion has expired. Review the latest budget recommendation instead.',
  candidate_not_fresh:'You already reviewed this suggestion, or it is no longer current.',
  stale_financial_revision:'Your financial information changed. Folio left the budgets unchanged; review the current amounts.',
  stale_state_version:'Your financial picture changed. Folio left the budgets unchanged; review the latest plan.',
  stale_plan_version:'The active plan changed. Review its current categories before making a budget adjustment.',
  stale_recommendation_version:'This recommendation has changed. Review the latest suggestion before proceeding.',
  plan_or_category_scope_mismatch:'This change is outside the plan or categories you allowed Folio to adjust.',
  plan_delegation_not_current:'The selected plan is no longer active or does not mark this source category as flexible.',
  protected_plan_or_category:'This adjustment would change a protected category. Folio left the budgets unchanged.',
  financial_evidence_incomplete:'Folio could not confirm complete current spending and cash-flow information, so it left the budgets unchanged.',
  confidence_evidence_incomplete:'Recent spending does not support this change clearly enough. Folio left the budgets unchanged.',
  stale_budget_targets:'A budget amount changed. Review the current plan before making another adjustment.',
  donor_or_overage_evidence_incomplete:'Folio could not confirm the current budget amounts or spending totals, so it left the budgets unchanged.',
  donor_spare_or_posted_overage:'The source budget does not have enough safe room, or posted spending no longer exceeds the destination target.',
  donor_minimum:'This adjustment would leave too little in the source budget to cover its current spending and known bills.',
  cash_floor:'The connected-cash forecast would fall below a protected amount. Folio left the budgets unchanged.',
  conflicting_action:'Another budget change is already waiting for review. Folio did not make an overlapping adjustment.',
  monthly_usage_unavailable:'Folio could not confirm how much of this month’s limit has been used, so it left the budgets unchanged.',
  invalid_amount_limits:'Review the per-change and monthly limits before allowing automatic budget adjustments.'
 };
 let reason='This adjustment fits your active plan, current posted spending, and the limits you chose.';
 if(violations.length){const code=violations.find((item:string)=>messages[item])||violations[0];reason=messages[code]||'Folio left the budgets unchanged because the current plan or spending information needs review.';if(code==='per_action_limit'&&requested&&perActionAllowed)reason=`This change is ${requested}, above the ${perActionAllowed} per-adjustment limit you set.`;if(code==='monthly_limit'&&requested&&monthlyRemaining)reason=`This change is ${requested}, above the ${monthlyRemaining} remaining in your monthly limit.`;if(code==='monthly_limit_above_central_maximum')reason='The monthly limit is above the maximum Folio can manage automatically. Lower it in Settings.';}
 return {allowed:violations.length===0,violations,checks,risk_level:centralRisk,confidence,reason,rule:'bounded_active_plan_reallocation',would_execute:violations.length===0,status:violations.length?'blocked':'eligible',prior_values:candidate.prior_values||{},proposed_values:candidate.proposed_values||{amount:candidate.amount,from_category_id:sourceId,to_category_id:destinationId}};
}
function result(candidate:Row,checks:string[],context:Row,overrides:Row={}){
 const confidence=typeof candidate.confidence==='number'&&Number.isFinite(candidate.confidence)?candidate.confidence:null;
 const blockers=['dry_run_mode'];if(context.rollout_enabled!==true)blockers.push('rollout_disabled');if(context.kill_switch!==false)blockers.push('kill_switch');
 return {would_execute:false,status:'dry_run_blocked',risk_level:overrides.risk_level||'high',reason:overrides.reason,rule:overrides.rule,checks:[...checks,overrides.rule],confidence,prior_values:candidate.prior_values||{},proposed_values:candidate.proposed_values||{},execution_allowed:false,execution_blockers:blockers,...overrides};
}
export function evaluateAutonomyGuardrails(input:{policy:Row;candidate:Row;context:Row}){
 const {policy,candidate,context}=input,checks:string[]=[];
 const block=(reason:string,rule:string,risk='high')=>result(candidate,checks,context,{reason,rule,risk_level:risk});
 const kind=candidate.action_type;
 if(!AUTONOMY_ACTION_CATALOG.some(row=>row.action_type===kind))return block('This action type is not supported by the preview catalogue.','unsupported_action','high');
 if(policy?.action_type!==kind)return block('This policy does not authorize the proposed action.','policy_action_type_mismatch','high');
 if(kind==='reallocate_budget'&&candidate.affects_core_goal===true)return block('This candidate affects a protected plan or goal.','core_goal_protection','high');
 const centralRisk=classifyAutonomyPreviewRisk(kind,candidate);
 if(candidate.risk_level!==centralRisk||centralRisk==='high')return block('The action risk does not match its centrally defined bounded class.','risk_class_mismatch','high');
 if(policy.enabled!==true)return block('This policy is disabled.','policy_disabled','low');
 if(!['recommend_only','confirm','auto_low_risk'].includes(policy.autonomy_level))return block('The policy level is unknown.','unknown_autonomy_level','high');
 if(policy.execution_mode!=='dry_run'||policy.execution_authorized!==false)return block('Only persistent dry-run policies are supported in this phase.','execution_mode_not_dry_run','high');
 if(!context.household_id||candidate.household_id!==context.household_id||policy.household_id!==context.household_id)return block('Candidate, policy, and current context must belong to the same household.','household_mismatch','high');
 if(!context.actor_user_id||candidate.actor_user_id!==context.actor_user_id)return block('Candidate actor must match the authenticated actor.','actor_mismatch','high');
 const today=typeof context.today==='string'?context.today:null;
 if(!today||!(policy.start_date==null||policy.start_date<=today)||!(policy.end_date==null||policy.end_date>=today))return block('The policy is not active for the current date.','policy_outside_dates','low');
 if(candidate.fresh!==true||candidate.dispositioned===true)return block('Only fresh, still eligible candidates can be previewed.','candidate_not_fresh','low');
 const candidateExpiry=candidate.candidate_expires_at||candidate.expires_at;
 if(!candidate.candidate_id||!candidate.candidate_version||!candidateExpiry||!Number.isFinite(Date.parse(candidateExpiry))||Date.parse(candidateExpiry)<=Date.now())return block('Candidate identity, version, or time-to-live is missing or expired.','candidate_ttl','low');
 if(context.kill_switch!==true&&context.rollout_enabled!==true)checks.push('rollout_controls_observed');
 if(context.financial_revision_before!==context.financial_revision_after||!context.financial_revision_before)return block('Financial data changed during evaluation.','stale_financial_revision');
 if(context.state_version_before!==context.state_version_after||!context.state_version_before)return block('The committed financial state changed during evaluation.','stale_state_version');
 if(!sameJson(context.plan_versions_before,context.plan_versions_after))return block('An active plan changed during evaluation.','stale_plan_version');
 if(candidate.financial_revision!==context.financial_revision_after||candidate.state_version!==context.state_version_after||!sameJson(candidate.plan_versions,context.plan_versions_after))return block('Candidate evidence does not match the latest financial, state, and plan versions.','candidate_version_mismatch');
 if(!candidate.recommendation_version||candidate.recommendation_version!==context.recommendation_version)return block('Recommendation evidence is stale.','stale_recommendation_version');
 if(typeof policy.version!=='number'||policy.version!==context.policy_version)return block('The policy changed during evaluation.','stale_policy_version');
 if(kind==='archive_expired'){
  if(policy.autonomy_level!=='auto_low_risk')return block('Only auto_low_risk policies may produce hypothetical eligibility; execution remains disabled.','policy_level_preview_only','low');
  if(!Array.isArray(policy.allowed_risk_levels)||!policy.allowed_risk_levels.includes('low')||policy.allowed_risk_levels.some((risk:string)=>risk!=='low'))return block('The policy does not explicitly allow the centrally defined low-risk class.','risk_scope_mismatch','high');
  if(candidate.event_status!=='expired'||candidate.event_expired!==true||candidate.dispositioned!==false||candidate.confidence!==1||conflictsFor(candidate,context))return block('This insight lacks explicit current expired, undispositioned, nonconflicting evidence.','expired_event_evidence','low');
  checks.push('catalogue_low_risk','expired_event','current_versions','dry_run_only');
  const eligible=policy.autonomy_level==='auto_low_risk';
  return {would_execute:eligible,status:eligible?'dry_run_would_execute':'dry_run_blocked',risk_level:'low',reason:'The expired insight is eligible for archive review; this preview will not change its state.',rule:'expired_insight_archive_preview',checks,confidence:1,prior_values:{status:candidate.event_status},proposed_values:{action:'archive_expired'},execution_allowed:false,execution_blockers:['dry_run_mode',...(context.rollout_enabled===true?[]:['rollout_disabled']),...(context.kill_switch===false?[]:['kill_switch'])]};
 }
 if(kind!=='reallocate_budget')return block('This action type is not supported by the preview catalogue.','unsupported_action');
 if(context.state_complete!==true||context.history_complete!==true||context.recurring_complete!==true||context.forecast_complete!==true)return block('Current financial evidence is incomplete.','incomplete_financial_evidence','high');
 if(context.duplicate_accounts===true||context.unresolved_identity_ambiguity===true)return block('Unresolved duplicate identities make current evidence ambiguous.','duplicate_account_identity');
 if(context.unknown_currency!==false)return block('Unknown or non-USD transaction currency prevents a safe comparison.','unknown_currency');
 const ids=uniq(Array.isArray(candidate.category_ids)?candidate.category_ids:[]),policyIds=uniq(Array.isArray(policy.scope?.category_ids)?policy.scope.category_ids:[]);
 const sourceId=candidate.from_category_id,destinationId=candidate.to_category_id;
 if(ids.length!==2||!sourceId||!destinationId||sourceId===destinationId||!ids.includes(sourceId)||!ids.includes(destinationId)||policyIds.length<2||ids.some(id=>!policyIds.includes(id)))return block('The exact source and destination categories must both be in explicit policy scope.','category_scope_mismatch','medium');
 for(const field of ['plan_ids','account_ids','merchant_ids']){
  const allowed=uniq(Array.isArray(policy.scope?.[field])?policy.scope[field]:[]),actual=uniq(Array.isArray(candidate.scope?.[field])?candidate.scope[field]:[]);
  if(allowed.length&&(!actual.length||actual.some(id=>!allowed.includes(id))))return block(`The candidate does not match the policy ${field.replace('_ids','')} scope.`,`scope_${field}_mismatch`,'medium');
 }
 if(candidate.affects_core_goal===true)return block('This candidate could affect an active core goal.','core_goal_protection','high');
 const protectedIds=uniq([...(Array.isArray(context.protected_category_ids)?context.protected_category_ids:[]),...(Array.isArray(policy.protected_category_ids)?policy.protected_category_ids:[])]);
 if(ids.some(id=>protectedIds.includes(id)))return block('A selected category is protected by a household plan or preference.','protected_category','high');
 const conflicts=Array.isArray(context.overlapping_candidate_ids)?context.overlapping_candidate_ids:[];
 if(conflicts.includes(candidate.candidate_id))return block('Another current preview overlaps this category or plan scope; no partial changes are previewed.','overlapping_candidate','medium');
 const confidence=typeof candidate.confidence==='number'&&Number.isFinite(candidate.confidence)&&candidate.confidence>=0&&candidate.confidence<=1?candidate.confidence:null;
 if(confidence===null||confidence<Math.max(AUTONOMY_MIN_CONFIDENCE,typeof policy.min_confidence==='number'?policy.min_confidence:AUTONOMY_MIN_CONFIDENCE))return block('Deterministic recommendation evidence is below the confidence threshold.','low_confidence','medium');
 const amount=cents(candidate.amount),maxAmount=cents(policy.max_amount),maxMonthly=cents(policy.max_monthly_amount),cashFloor=cents(policy.cash_floor);
 if(amount===null||amount<=0)return block('The current recommendation has no valid whole-cent amount.','invalid_amount','medium');
 if(maxAmount===null||maxAmount<=0||maxMonthly===null||maxMonthly<=0||cashFloor===null||cashFloor<0)return block('Explicit positive action and monthly limits plus a nonnegative cash floor are required.','missing_policy_limits','medium');
 if(amount>AUTONOMY_HARD_MAX_AMOUNT_CENTS||amount>maxAmount)return block('The recommended transfer exceeds the fixed action limit or policy limit.','action_amount_limit','medium');
 if(!Array.isArray(policy.allowed_risk_levels)||!policy.allowed_risk_levels.includes('medium')||policy.allowed_risk_levels.some((risk:string)=>risk!=='medium'))return block('This preview supports only centrally classified medium-risk budget actions.','risk_scope_mismatch','high');
 const actualUsed=cents(context.executed_monthly_amount);
 if(context.actual_usage_known!==true||actualUsed===null||actualUsed<0)return block('Actual monthly usage is unavailable or invalid, so the cap cannot be checked safely.','unknown_actual_usage','medium');
 const simulatedUsed=cents(context.batch_simulated_amount);
 if(simulatedUsed===null||simulatedUsed<0)return block('Current preview-batch usage is unavailable or invalid.','unknown_batch_usage','medium');
 if(actualUsed+simulatedUsed+amount>maxMonthly)return block('This action would exceed the monthly cap after actual spending and this preview batch.','monthly_cap','medium');
 const balances=candidate.category_balances||{},source=cents(balances[sourceId]?.target),destination=cents(balances[destinationId]?.target),expected=candidate.expected_targets||{};
 if(source===null||destination===null||cents(expected[sourceId])!==source||cents(expected[destinationId])!==destination)return block('Current and expected category targets must be known and match exactly.','stale_category_targets','medium');
 const minima=policy.category_minimums||{},activeMinima=context.category_minimums||{},spent=cents(balances[sourceId]?.spent),reserve=cents(balances[sourceId]?.known_reserve),projected=cents(balances[sourceId]?.projected_spend);
 if(spent===null||reserve===null||projected===null)return block('Known spending, reserves, and projected source spending are required.','incomplete_source_evidence','medium');
 const policyMin=Object.hasOwn(minima,sourceId)?cents(minima[sourceId]):0,activeMin=Object.hasOwn(activeMinima,sourceId)?cents(activeMinima[sourceId]):0;
 if(policyMin===null||activeMin===null||policyMin<0||activeMin<0)return block('A configured category minimum is invalid.','invalid_category_minimum','medium');
 const sourceMin=Math.max(policyMin,activeMin,spent+reserve,projected),safeSlack=cents(candidate.safe_spare);
 if(safeSlack===null||safeSlack<amount||source-amount<sourceMin)return block('The source category would exceed its current safe slack or fall below a protected minimum.','category_minimum','medium');
 const forecastLow=cents(context.forecast_low),hardFloor=cents(context.hard_cash_floor);
 if(forecastLow===null||hardFloor===null||forecastLow<Math.max(cashFloor,hardFloor))return block('A complete current cash forecast must maintain both configured and active-plan floors.','cash_floor','medium');
 checks.push('catalogue_medium_risk','explicit_category_scope','current_confidence','action_and_monthly_caps','category_minimum','protected_categories','cash_floor','financial_revision','state_version','plan_versions','dry_run_only');
 const eligible=policy.autonomy_level==='auto_low_risk';
 return {would_execute:eligible,status:eligible?'dry_run_would_execute':'dry_run_blocked',risk_level:'medium',reason:eligible?'All current policy and evidence checks pass; this remains a preview and will not execute.':'This policy level supports recommendations or confirmation only; no autonomous eligibility is implied.',rule:'bounded_budget_reallocation_preview',checks,confidence,prior_values:candidate.prior_values||{targets:{[sourceId]:source/100,[destinationId]:destination/100}},proposed_values:candidate.proposed_values||{amount:amount/100,from_category_id:sourceId,to_category_id:destinationId},execution_allowed:false,execution_blockers:['dry_run_mode',...(context.rollout_enabled===true?[]:['rollout_disabled']),...(context.kill_switch===false?[]:['kill_switch'])]};
}

// Deterministic Phase 4B eligibility check shared by live execution and previews.
export function evaluateLowRiskMaintenance(input:{policy:Row;candidate:Row;context:Row}) {
 const {policy,candidate,context}=input, violations:string[]=[];
 const kind=String(candidate.action_type||''),catalog=AUTONOMY_ACTION_CATALOG.find(item=>item.action_type===kind);
 const threshold=AUTONOMY_CONFIDENCE_THRESHOLDS[kind as keyof typeof AUTONOMY_CONFIDENCE_THRESHOLDS];
 const deny=(code:string)=>violations.push(code);
 if(!catalog||!threshold)deny('unsupported_action');
 if(!policy||policy.action_type!==kind||policy.enabled!==true||policy.autonomy_level!=='auto_low_risk'||policy.execution_mode!=='live'||policy.execution_authorized!==true)deny('no_active_execution_permission');
 if(policy?.allowed_risk_levels?.length!==1||policy.allowed_risk_levels[0]!=='low')deny('risk_not_allowed');
 if(candidate.risk_level!=='low'||classifyActionRisk(kind,candidate)!=='low')deny('risk_class_mismatch');
 if(candidate.household_id!==context.household_id||policy?.household_id!==context.household_id||candidate.actor_user_id!==context.actor_user_id)deny('household_or_actor_mismatch');
 if(context.rollout_enabled!==true||context.kill_switch!==false)deny(context.kill_switch!==false?'kill_switch':'rollout_disabled');
 if(!candidate.fresh||candidate.dispositioned||candidate.pending||candidate.manual_review||candidate.user_override)deny('candidate_no_longer_eligible');
 // Recurring estimates are derived read-model values. The low-risk maintenance
 // engine must never turn them into writes to user-owned recurring overrides.
 const recurringOverrideFields=['amount_override','frequency_override','next_date_override','category_override','match_text_override','include_in_forecast','active','override_not_recurring'];
 const proposed=candidate.proposed_values&&typeof candidate.proposed_values==='object'?candidate.proposed_values:{};
 if(recurringOverrideFields.some(field=>Object.hasOwn(proposed,field)))deny('recurring_user_override_mutation');
 if(!candidate.candidate_id||!candidate.candidate_version||!candidate.financial_revision||candidate.financial_revision!==context.financial_revision)deny('candidate_stale');
 const expiry=candidate.candidate_expires_at||candidate.expires_at;
 if(!expiry||!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now())deny('candidate_expired');
 if(!context.state_version||candidate.state_version!==context.state_version)deny('state_version_stale');
 if(!sameJson(candidate.plan_versions,context.plan_versions))deny('plan_versions_stale');
 if(typeof policy.version!=='number'||candidate.policy_version!==policy.version)deny('policy_version_stale');
 if(policy.start_date&&policy.start_date>context.today||policy.end_date&&policy.end_date<context.today)deny('policy_outside_dates');
 const confidence=typeof candidate.confidence==='number'&&Number.isFinite(candidate.confidence)?candidate.confidence:null;
 if(confidence===null||confidence<Math.max(threshold,Number(policy.min_confidence)||threshold)||confidence>1)deny('confidence_too_low');
 if(candidate.known_evidence!==true)deny('known_evidence_required');
 const scope=policy.scope||{};
 if(Array.isArray(scope.account_ids)&&scope.account_ids.length&&(!candidate.canonical_account_id||!scope.account_ids.includes(candidate.canonical_account_id)))deny('account_scope_mismatch');
 if(Array.isArray(scope.merchant_ids)&&scope.merchant_ids.length&&(!candidate.source_merchant||!scope.merchant_ids.includes(candidate.source_merchant)))deny('merchant_scope_mismatch');
 if(kind==='correct_category'&&(!Array.isArray(scope.category_ids)||!scope.category_ids.includes(candidate.category_id)))deny('category_scope_mismatch');
 if(kind==='correct_category'&&Array.isArray(context.protected_category_ids)&&(context.protected_category_ids.includes(candidate.category_id)||candidate.source_category_id&&context.protected_category_ids.includes(candidate.source_category_id)))deny('protected_category');
 if(candidate.affects_core_goal===true)deny('active_plan_protection');
 if(Array.isArray(context.conflicting_candidate_ids)&&context.conflicting_candidate_ids.includes(candidate.candidate_id)||Array.isArray(context.overlapping_candidate_ids)&&context.overlapping_candidate_ids.includes(candidate.candidate_id))deny('conflicting_action');
 if(kind==='correct_category'&&(!candidate.rule_id||candidate.rule_match_type!=='exact'||candidate.rule_created_by_user!==true))deny('explicit_rule_required');
 if(kind==='normalize_merchant'&&(candidate.mapping_source!=='confirmed_household_examples'||candidate.confirmed_examples<3||candidate.user_override_conflict))deny('confirmed_merchant_mapping_required');
 return {allowed:violations.length===0,violations,escalationRequired:violations.length>0,confidence,minimum_confidence:threshold||null};
}

function conflictsFor(candidate:Row,context:Row){return Array.isArray(context.overlapping_candidate_ids)&&context.overlapping_candidate_ids.includes(candidate.candidate_id);}

export function overlappingAutonomyCandidates(candidates:Row[]){
 const conflicts=new Set<string>();
 for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
  const a=candidates[i],b=candidates[j],aCategories=uniq(a.category_ids||[]),bCategories=uniq(b.category_ids||[]),aPlans=uniq(a.scope?.plan_ids||[]),bPlans=uniq(b.scope?.plan_ids||[]);
  if(aCategories.some(id=>bCategories.includes(id))||aPlans.some(id=>bPlans.includes(id))){conflicts.add(String(a.candidate_id));conflicts.add(String(b.candidate_id));}
 }
 return [...conflicts];
}
