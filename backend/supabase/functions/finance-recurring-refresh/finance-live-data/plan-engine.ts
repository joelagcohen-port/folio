import "./savings-math.js";
// Household plans interpret existing goals, Budget Coach and Planning evidence.
// They do not change budgets or treat cash-balance movement as savings.
type Row=Record<string,any>;
const cents=(n:number)=>Math.round(n*100)/100;
const num=(v:any):number|null=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))?null:Number(v);
const dateMonth=(day:string)=>Number(day.slice(0,4))*12+Number(day.slice(5,7));
const activeConstraint=(c:Row,today:string)=>!c.expires_on||c.expires_on>=today;
export function planInputMaterial(state:Row,compact:Row,plans:Row[],goals:Row[],memories:Row[]){
 return {today:state.today,financial:compact,budgets:state.budgets,coaching:state.budgetCoaching,planning:state.planning,recurring:state.recurring,accounts:state.accounts,duplicateCandidates:state.duplicateCandidates,readiness:[state.budgetsReady,state.recurringReady,state.accountsReady,state.budgetCoachingReady,state.recurringComplete],memories,plans:plans.map(p=>[p.plan_id,p.version,p.status,p.priority,p.lifecycle_reason,p.completion_source,p.completed_at,p.ended_at,p.lifecycle_history]),goals};
}
export function verifiedPlanLifecycleDecision(plan:Row,goal:Row|null,today:string){
 if(plan.status!=='active')return {status:plan.status,reason:plan.lifecycle_reason||null,source:plan.completion_source||null};
 if(plan.plan_type==='savings'&&goal?.active===true){const current=num(goal.current_amount),target=num(goal.target_amount);if(current!==null&&target!==null&&current>=0&&target>0&&current>=target)return {status:'completed',reason:today>String(plan.ends_on)?'verified_goal_after_deadline':'verified_goal',source:'tracked_goal_balance'};}
 if(today>String(plan.ends_on)){if(plan.plan_type!=='savings')return {status:'ended',reason:'deadline_elapsed_unverified',source:null};const current=num(goal?.current_amount),target=num(goal?.target_amount),verified=goal?.active===true&&current!==null&&target!==null&&current>=0&&target>0;return {status:'ended',reason:verified?'deadline_unmet':'deadline_unverified',source:null};}
 return {status:'active',reason:null,source:null};
}
export function evaluateFinancialPlan(plan:Row,state:Row,goal:Row|null){
 const today=String(state.today||''),period=today.slice(0,7),constraints=(Array.isArray(plan.constraints)?plan.constraints:[]).filter((c:Row)=>activeConstraint(c,today));
 const lifecycle=verifiedPlanLifecycleDecision(plan,goal,today);
 const result:Row={plan_id:plan.plan_id,goal_id:plan.goal_id,plan_name:plan.name||goal?.name||'Financial plan',plan_version:plan.version,plan_type:plan.plan_type,status:lifecycle.status,priority:Number.isInteger(Number(plan.priority))?Number(plan.priority):3,lifecycle_reason:plan.lifecycle_reason||lifecycle.reason,completion_source:plan.completion_source||lifecycle.source,completed_at:plan.completed_at||null,ended_at:plan.ended_at||null,lifecycle_history:Array.isArray(plan.lifecycle_history)?plan.lifecycle_history:[],period_key:period,starts_on:plan.starts_on,ends_on:plan.ends_on,goal_name:goal?.name||null,assessment:'unknown',metric:null,target:null,shortfall:null,reasons:[],evidence:[],active_constraints:constraints,assumptions:[]};
 if(lifecycle.status==='completed')return {...result,assessment:'completed',reasons:[lifecycle.source==='tracked_goal_balance'?'The tracked savings goal reached its target.':'You marked this plan complete.']};
 if(lifecycle.status==='ended')return {...result,assessment:'ended_unmet',reasons:[lifecycle.reason==='deadline_unmet'?'The plan ended before its tracked goal reached the target.':'The plan period ended; achievement was not verified.']};
 if(plan.status!=='active'||today<plan.starts_on||today>plan.ends_on)return {...result,assessment:'inactive',reasons:['Plan is paused or outside its active window.']};
 if(plan.plan_type==='savings'&&(!goal||goal.active===false)){result.reasons.push('The linked savings goal is unavailable.');return result;}
 const warnings=Array.isArray(state.planning?.warnings)?state.planning.warnings:[];
 const points=state.planning?.ready===true&&state.planning?.complete===true&&state.planning?.reliable===true&&Array.isArray(state.planning.points)?state.planning.points:[];
 const horizon=Number(state.planning?.horizonDays);
 const completePoints=Number.isInteger(horizon)&&horizon>0&&points.length===horizon+1&&points.every((p:Row,i:number)=>p.date===new Date(Date.parse(today+'T00:00:00Z')+i*86400000).toISOString().slice(0,10)&&num(p.balance)!==null);
 const low=completePoints?Math.min(...points.map((p:Row)=>Number(p.balance))):null;
 const floors=constraints.filter((c:Row)=>c.kind==='cash_floor'&&c.level==='hard').map((c:Row)=>Number(c.amount));
 if(plan.plan_type==='cash_floor')floors.push(Number(plan.floor_amount));
 if(floors.length){if(low===null){result.reasons.push('Complete connected-cash forecast is unavailable for the protected floor.');return result;}
  const floor=Math.max(...floors);result.evidence.push({source:'existing_planning_forecast',horizon_days:horizon,scope:'Connected cash accounts',projected_low:cents(low),floor});
  if(low<floor){result.assessment='at_risk';result.metric=cents(low);result.target=floor;result.shortfall=cents(floor-low);result.reasons.push('The projected connected-cash low breaches a protected floor.');return result;}
 }
 if(plan.plan_type==='cash_floor'){result.assessment='on_track';result.metric=cents(low!);result.target=Number(plan.floor_amount);return result;}
 if(plan.plan_type==='spending_reduction'){
  const ids=Array.isArray(plan.category_ids)?plan.category_ids:[],baseline=num(plan.baseline_monthly),reduction=num(plan.target_monthly);
  const budgets=Array.isArray(state.budgets)?state.budgets:[],coaching=Array.isArray(state.budgetCoaching)?state.budgetCoaching:[];
  const rows=ids.map((id:string)=>({budget:budgets.find((b:Row)=>b.id===id),forecast:coaching.find((c:Row)=>c.id===id)}));
  if(!state.budgetCoachingReady||!ids.length||baseline===null||reduction===null||rows.some(({budget,forecast}:Row)=>!budget||forecast?.usable!==true||num(forecast.projected)===null)){
   result.reasons.push('Complete Budget Coach projections for the selected categories are unavailable.');return result;
  }
  const projected=cents(rows.reduce((sum:number,{forecast}:Row)=>sum+Number(forecast.projected),0)),achieved=cents(baseline-projected);
  result.metric=achieved;result.target=reduction;result.shortfall=cents(Math.max(0,reduction-achieved));
  result.evidence.push({source:'existing_budget_coach',baseline_monthly:baseline,projected_spend:projected,category_ids:ids});
  for(const {budget,forecast} of rows)result.evidence.push({source:'existing_budget_coach_category',category_id:budget.id,category_name:budget.name||null,current_target:num(budget.target),spent:num(budget.spent),known_reserve:num(forecast.reserve),projected_spend:num(forecast.projected)});
  result.assessment=achieved+0.01<reduction?'at_risk':'on_track';
  if(result.assessment==='at_risk')result.reasons.push('Projected monthly spending is above the confirmed reduction target.');
  return result;
 }
 if(plan.plan_type==='savings'){
  if(!goal)return result;
  const current=num(goal.current_amount),target=num(goal.target_amount),contribution=num(plan.target_monthly),base=num(plan.activation_current_amount);
  if(current===null||target===null||contribution===null||base===null||!plan.activated_at){result.reasons.push('Tracked goal progress or the activation baseline is unavailable.');return result;}
  const projection=(globalThis as any).FolioSavingsMath.project({today,starts_on:plan.starts_on,ends_on:plan.ends_on,current,target,monthly:contribution});
  if(!projection){result.reasons.push('Savings timing is unavailable.');return result;}
  const {months:monthsRemaining,projected,shortfall:gap}=projection;
  result.metric=cents(current);result.target=target;result.shortfall=gap;
  result.assumptions.push('Future monthly contributions are a plan assumption, not verified savings or cash surplus.');
  result.evidence.push({source:'existing_goal_tracked_amount',current:cents(current),activation_amount:cents(base),monthly_contribution:contribution,months_remaining:monthsRemaining,projected_at_end:projected,goal_updated_at:goal.updated_at||null});
  if(gap>0){result.assessment='at_risk';result.reasons.push('The stated contribution would leave the tracked goal short at the plan end.');return result;}
  // No automatic account attribution: only a post-activation goal edit verifies progress.
  const elapsed=dateMonth(today)-dateMonth(String(plan.activated_at).slice(0,10));
  if(current<target&&(current===base||!(Date.parse(String(goal.updated_at||''))>Date.parse(String(plan.activated_at))))){result.reasons.push(gap===0?'The planned contributions meet the goal target; no post-activation savings progress is confirmed yet.':'No post-activation goal progress has been confirmed.');return result;}
  if(elapsed>0){
   const expected=cents(Math.min(target,base+elapsed*contribution));
   if(current+Math.max(25,contribution*.1)<expected){result.assessment='at_risk';result.shortfall=cents(expected-current);result.reasons.push('The updated tracked goal amount is behind the contribution pace.');return result;}
  }
  result.assessment='on_track';return result;
 }
 result.reasons.push('Plan type is unsupported.');return result;
}

const stableId=(value:string)=>{let hash=2166136261;for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619);return(hash>>>0).toString(16).padStart(8,'0');};
/**
 * Build potential category-spending adjustments for one active spending plan.
 * These are planning suggestions, never a forecast that a member will spend less.
 * Only categories the member explicitly marked flexible can be considered.
 */
export function recommendSpendingAdjustments(plan:Row,state:Row,allPlans:Row[]=[],memories:Row[]=[]){
 const today=String(state.today||''),period=today.slice(0,7),base={plan_id:plan.plan_id,plan_version:plan.version,period_key:period,financial_state_version:state.financialStateVersion||null,financial_revision:state.financialRevision||null,recommendation_id:'',status:'unknown_evidence',adjustments:[],potential_total:0,unresolved_shortfall:null,causal_evidence:[],message:''};
 const finish=(value:Row)=>({...value,recommendation_id:stableId(JSON.stringify({plan_id:value.plan_id,plan_version:value.plan_version,period_key:value.period_key,financial_state_version:value.financial_state_version,financial_revision:value.financial_revision,status:value.status,adjustments:value.adjustments,unresolved_shortfall:value.unresolved_shortfall}))});
 if(plan.status!=='active'||plan.plan_type!=='spending_reduction'||today<plan.starts_on||today>plan.ends_on)return finish({...base,status:'inactive',message:'Only an active spending-reduction plan can receive category suggestions.'});
 if(!state.budgetCoachingReady||!Array.isArray(state.budgets)||!Array.isArray(state.budgetCoaching))return finish({...base,message:'Complete Budget Coach evidence is unavailable, so Folio cannot size category suggestions.'});
 const evaluation=evaluateFinancialPlan(plan,state,null);
 if(evaluation.assessment==='unknown'||evaluation.shortfall===null)return finish({...base,message:'The plan gap cannot be measured from complete current inputs.'});
 if(evaluation.evidence?.some((item:Row)=>item.source==='existing_planning_forecast')&&evaluation.assessment==='at_risk')return finish({...base,status:'cash_floor_conflict',message:'The connected-cash forecast breaches a protected floor. This is a cash-risk review, not a monthly spending gap, so Folio will not propose category reductions to resolve it.',causal_evidence:evaluation.evidence});
 const gap=Math.max(0,cents(Number(evaluation.shortfall))),threshold=Math.max(25,cents(Number(plan.target_monthly||0)*.05));
 if(gap<threshold)return finish({...base,status:'no_material_gap',unresolved_shortfall:gap,causal_evidence:[{source:'existing_budget_coach',measured_shortfall:gap,material_threshold:threshold}],message:'The remaining plan gap is below the review threshold.'});
 const permanentlyProtected=new Set(memories.filter((m:Row)=>typeof m?.key==='string'&&m.key.startsWith('budget_category_protection:')&&m.value?.scope==='permanent').map((m:Row)=>String(m.value?.category_id||m.key.slice('budget_category_protection:'.length))));
 const flexible=(Array.isArray(plan.constraints)?plan.constraints:[]).filter((c:Row)=>c.kind==='flexible_category'&&activeConstraint(c,today)&&!permanentlyProtected.has(String(c.category_id)));
 if(!flexible.length)return finish({...base,status:'no_flexible_categories',unresolved_shortfall:gap,causal_evidence:[{source:'member_plan_constraints',eligible_category_count:0}],message:'Choose at least one category Folio may consider before it can suggest cuts.'});
 const active=[...(Array.isArray(allPlans)?allPlans:[]),plan].filter((p:Row,index:number,rows:Row[])=>p.status==='active'&&today>=p.starts_on&&today<=p.ends_on&&rows.findIndex(row=>row.plan_id===p.plan_id)===index),floorFor=(id:string)=>{
  let floor=0;for(const p of active)for(const rule of Array.isArray(p.constraints)?p.constraints:[])if(activeConstraint(rule,today)&&rule.category_id===id){if(rule.kind==='minimum_budget'&&rule.level==='hard'){const amount=rule.amount===null||rule.amount===undefined||rule.amount===''||typeof rule.amount==='boolean'?NaN:Number(rule.amount);if(!Number.isFinite(amount)||amount<0)return Infinity;floor=Math.max(floor,amount);}if(rule.kind==='protected_category'&&rule.level==='hard')return Infinity;}return floor;
 };
 const preferenceMemory=memories.find((m:Row)=>m.key==='budget_donor_order'&&Array.isArray(m.value)&&(!m.effectiveFrom||m.effectiveFrom<=today)&&(!m.effectiveUntil||m.effectiveUntil>=today)),preference=preferenceMemory?.value||[],rank=(name:string)=>{const index=preference.findIndex((value:unknown)=>String(value).toLowerCase()===name.toLowerCase());return index<0?preference.length+1:index;},numberOrNull=(value:unknown):number|null=>value===null||value===undefined||value===''||typeof value==='boolean'||!Number.isFinite(Number(value))?null:Number(value);
 const targetIds=new Set(Array.isArray(plan.category_ids)?plan.category_ids:[]),declined=new Set(Array.isArray(state.declinedCategoryIds)?state.declinedCategoryIds.map(String):[]);
 const seen=new Set<string>(),candidates=flexible.filter((rule:Row)=>targetIds.has(rule.category_id)&&!declined.has(String(rule.category_id))&&!seen.has(rule.category_id)&&Boolean(seen.add(rule.category_id))).map((rule:Row)=>{const budget=state.budgets.find((b:Row)=>b.id===rule.category_id),forecast=state.budgetCoaching.find((b:Row)=>b.id===rule.category_id);if(!budget||!forecast||forecast.usable!==true)return null;const floor=floorFor(String(rule.category_id)),target=numberOrNull(budget.target),spent=numberOrNull(budget.spent),projected=numberOrNull(forecast.projected),reserve=numberOrNull(forecast.reserve);if(!Number.isFinite(floor)||target===null||spent===null||projected===null||reserve===null||target<0||spent<0||projected<0||reserve<0)return null;const safeFloor=Math.max(floor,spent+reserve),capacity=cents(Math.max(0,Math.min(target-safeFloor,projected-safeFloor)));if(capacity<threshold)return null;return{budget,forecast,floor:safeFloor,projected,capacity,rank:rank(String(budget.name||'')),confidence:String(forecast.confidence||'')};}).filter(Boolean) as Row[];
 candidates.sort((a,b)=>a.rank-b.rank||b.capacity-a.capacity||a.confidence.localeCompare(b.confidence)||String(a.budget.name).localeCompare(String(b.budget.name))||String(a.budget.id).localeCompare(String(b.budget.id)));
 let remaining=gap;const adjustments:Row[]=[],evidence:Row[]=[];
 for(const candidate of candidates){if(remaining<threshold)break;const amount=cents(Math.min(candidate.capacity,remaining));if(amount<threshold)continue;const targetAfter=cents(Math.min(candidate.budget.target-amount,candidate.projected-amount)),targetDecrease=cents(candidate.budget.target-targetAfter);adjustments.push({category_id:candidate.budget.id,category_name:candidate.budget.name,current_monthly_target:candidate.budget.target,proposed_monthly_target:targetAfter,target_decrease:targetDecrease,potential_reduction:amount,confidence:candidate.confidence});evidence.push({source:'existing_budget_coach',category_id:candidate.budget.id,current_target:candidate.budget.target,proposed_target:targetAfter,target_decrease:targetDecrease,spent:candidate.budget.spent,known_reserve:candidate.forecast.reserve||0,projected_spend:candidate.projected,potential_behavioral_reduction:amount,minimum_budget_floor:candidate.floor,eligible_capacity:candidate.capacity,confidence:candidate.confidence});remaining=cents(Math.max(0,remaining-amount));}
 const total=cents(adjustments.reduce((sum:number,item:Row)=>sum+Number(item.potential_reduction),0));
 return finish({...base,status:remaining>0?'insufficient_capacity':'ready',adjustments,potential_total:total,unresolved_shortfall:remaining,causal_evidence:evidence,message:remaining>0?`These member-approved flexible categories offer ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(total)} in potential reductions; ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(remaining)} of the plan gap remains unresolved.`:'These are potential spending reductions if you choose to stay within the suggested targets. They are not verified savings or cash available to contribute.'});
}

export function planRiskEvent(plan:Row,evaluation:Row){
 if(evaluation.assessment!=='at_risk')return null;
 const facts={plan_id:plan.plan_id,plan_version:plan.version,goal_id:plan.goal_id,plan_type:plan.plan_type,period_key:evaluation.period_key,metric:evaluation.metric,target:evaluation.target,shortfall:evaluation.shortfall,reason:evaluation.reasons[0],evidence:evaluation.evidence};
 const gap=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(evaluation.shortfall));
 const forecastFloor=evaluation.evidence?.some((item:Row)=>item.source==='existing_planning_forecast');
 const context=forecastFloor||plan.plan_type==='cash_floor'?`The connected-cash forecast is ${gap} below the protected floor.`:plan.plan_type==='spending_reduction'?`The Budget Coach projection is ${gap} short of the monthly reduction.`:`The tracked goal plus assumed contributions is ${gap} short of the target.`;
 return {event_type:'plan_at_risk',fingerprint:`plan_at_risk:${plan.plan_id}:${evaluation.period_key}`,severity:.9,urgency:.8,confidence:.9,actionability:.85,novelty:.9,facts,title:`${evaluation.plan_name} needs review`,summary:context,recommended_actions:[{id:`plan_at_risk:${plan.plan_id}:review`,action_type:'review',label:'Review plan',payload:{destination:'planning',plan_id:plan.plan_id},confidence:.9,risk_level:'low',reversible:true,requires_confirmation:false}]};
}
