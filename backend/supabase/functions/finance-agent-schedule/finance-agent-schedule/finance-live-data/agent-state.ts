// Shared deterministic state/lifecycle policy. No provider calls or financial writes.
import { agentEventChangedMaterially, scoreAgentEvent, type AgentEvent } from './agent-events.ts';
type Row = Record<string, any>;
export const EVENT_TYPES = ['budget_pace_risk','budget_projection_improved','recurring_amount_change','new_recurring_detected','income_received','income_missing','recurring_payment_missing','account_sync_issue','cash_floor_risk','income_materially_different','forecast_change','goal_progress_change','duplicate_account_suspected','plan_at_risk','refund_applied','savings_review_needed','savings_opportunity','autonomy_action_needs_review'] as const;
export function activeAgentMemories(rows: unknown, today: string): Row[] {
  return (Array.isArray(rows) ? rows : []).filter(m => m && m.active !== false && ['fact','preference','goal','decision','completed_change'].includes(m.kind) && typeof m.summary === 'string' && (!m.effectiveFrom || m.effectiveFrom <= today) && (!m.effectiveUntil || m.effectiveUntil >= today) && (!m.expires_at || Date.parse(m.expires_at) > Date.parse(today+'T23:59:59Z'))).slice(-24).map(m => ({key:String(m.key||'').slice(0,80),kind:m.kind,summary:m.summary.slice(0,280),value:m.value ?? null,effectiveFrom:m.effectiveFrom||null,effectiveUntil:m.effectiveUntil||null}));
}
export function activePermanentCategoryPreferences(rows: unknown, today: string): Row[] {
  return (Array.isArray(rows) ? rows : []).filter(m => m && m.active !== false && m.kind === 'preference' && typeof m.key === 'string' && m.key.startsWith('budget_category_protection:') && m.value?.scope === 'permanent' && typeof m.value?.category_id === 'string' && m.value.category_id === m.key.slice('budget_category_protection:'.length) && typeof m.summary === 'string' && (!m.effectiveFrom || m.effectiveFrom <= today) && (!m.effectiveUntil || m.effectiveUntil >= today)).map(m => ({key:String(m.key).slice(0,80),kind:'preference',summary:m.summary.slice(0,280),value:m.value,effectiveFrom:m.effectiveFrom||null,effectiveUntil:m.effectiveUntil||null}));
}
export function deliveryChannels(score: number): string[] {
  if(score < .2) return [];
  const channels=['weekly_review'];
  if(score >= .4) channels.push('in_app','home','chat');
  if(score >= .65) channels.push('assistant_inbox');
  // Push is deliberately only a future candidate, never a delivery side effect.
  return channels;
}
export function reconcileEvents(detected: AgentEvent[], previous: Row[], now: string, householdId: string) {
  const oldByKey=new Map(previous.map(row=>[row.fingerprint,row]));
  return detected.map(event=>{
    const old=oldByKey.get(event.fingerprint);
    // Compare against the last material revision, not the previous poll: small
    // changes must accumulate until the threshold is crossed.
    const changed=!!old && agentEventChangedMaterially(event.event_type,old.material_facts||old.facts,event.facts);
    const revived=old?.status==='expired';
    const score=scoreAgentEvent(event);
    const version=old ? Number(old.event_version||1)+(changed||revived?1:0) : 1;
    return {...event,household_id:householdId,event_version:version,material_facts:!old||changed||revived||event.event_type==='savings_review_needed'?event.facts:old.material_facts||old.facts,
      title:old&&!changed&&!revived?old.title:event.title,summary:old&&!changed&&!revived?old.summary:event.summary,
      attention_score:score,status:score<.2?'suppressed':!old||changed||revived||old.status==='suppressed'?'new':old.status,
      first_seen_at:old?.first_seen_at||now,last_seen_at:now,updated_at:now,
      expires_at:new Date(Date.parse(now)+45*86400000).toISOString()};
  });
}
export function evaluatedPlanIdsForReconciliation(evaluations: Row[], previousSnapshot: Row|null, currentSnapshot: Row, existingEvents: Row[] = []) {
  const priorPlans=new Map((Array.isArray(previousSnapshot?.plan_versions)?previousSnapshot.plan_versions:[]).map((plan:Row)=>[String(plan.plan_id),plan]));
  const priorGoals=new Map((Array.isArray(previousSnapshot?.goals)?previousSnapshot.goals:[]).map((goal:Row)=>[String(goal.id),goal]));
  const goals=new Map((Array.isArray(currentSnapshot.goals)?currentSnapshot.goals:[]).map((goal:Row)=>[String(goal.id),goal]));
  return evaluations.filter((evaluation:Row)=>{
    if(evaluation.assessment!=='unknown')return true;
    const id=String(evaluation.plan_id),priorPlan:any=priorPlans.get(id),priorGoal:any=priorGoals.get(String(evaluation.goal_id||'')),goal:any=goals.get(String(evaluation.goal_id||''));
    // Keep a same-version risk when evidence is temporarily unavailable, but retire it when its own plan or linked goal changed.
    if(!priorPlan||Number(priorPlan.version)!==Number(evaluation.plan_version)||JSON.stringify(priorGoal??null)!==JSON.stringify(goal??null))return true;
    const staleRisk=existingEvents.some((event:Row)=>event.event_type==='plan_at_risk'&&event.facts?.plan_id===id&&event.status!=='expired'&&(
      Number(event.facts?.plan_version)!==Number(evaluation.plan_version)||
      evaluation.target!==null&&evaluation.target!==undefined&&Number(event.facts?.target)!==Number(evaluation.target)||
      typeof evaluation.shortfall==='number'&&Number.isFinite(evaluation.shortfall)&&evaluation.shortfall===0&&Number(event.facts?.shortfall)>0
    ));
    return staleRisk;
  }).map((evaluation:Row)=>evaluation.plan_id);
}
export function currentPlanRiskEvents(events: Row[], activePlans: Row[]) {
  const current = new Map(activePlans.map((plan:Row)=>[String(plan.plan_id),plan]));
  const numericEvidence=(value:any)=>((typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value)))?Number(value):null;
  return events.filter((event:Row)=>{
    if(event.event_type!=='plan_at_risk') return true;
    const plan=current.get(String(event.facts?.plan_id||'')) as Row|undefined;
    if(plan&&plan.status!=='active') return false;
    if(!plan||String(plan.version)!==String(event.facts?.plan_version)) return false;
    const latest=plan.latest;
    if(!latest||String(latest.plan_version??plan.version)!==String(plan.version)) return true;
    const shortfall=numericEvidence(latest.shortfall);
    if(shortfall!==null&&shortfall<=0) return false;
    if(['on_track','completed','ended_unmet','inactive'].includes(latest.assessment)) return false;
    const target=numericEvidence(latest.target),eventTarget=numericEvidence(event.facts?.target),eventShortfall=numericEvidence(event.facts?.shortfall);
    if(target!==null&&eventTarget!==null&&target!==eventTarget) return false;
    if(shortfall!==null&&eventShortfall!==null&&shortfall!==eventShortfall) return false;
    return true;
  });
}
export function currentRefundActivity(events: Row[], refunds: Row[]) {
  const matched = new Set((refunds||[]).filter((r:Row)=>r.refund_status==='matched'&&r.relationship_type==='refund').map((r:Row)=>String(r.transaction_id)));
  return (events||[]).filter((event:Row)=>event.event_type==='refund_applied'&&matched.has(String(event.facts?.transaction_id||''))).slice(0,20);
}
export function compactFinancialState(state: Row): Row {
  const budgets=(state.budgets||[]).map((b:Row)=>({id:b.id,name:b.name,target:b.target,available_capacity:b.availableCapacity??null,remaining_capacity:Number.isFinite(b.rollover?.capacity?.remaining_cents)?Number(b.rollover.capacity.remaining_cents)/100:Number.isFinite(b.availableCapacity)&&Number.isFinite(b.spent)?Math.round((Number(b.availableCapacity)-Number(b.spent))*100)/100:null,opening_carry:b.openingCarry??null,spent:b.spent,projected:(state.budgetCoaching||[]).find((c:Row)=>c.id===b.id)?.projected??null})).sort((a:Row,b:Row)=>String(a.id).localeCompare(String(b.id)));
  const budgetSpendReady=state.budgetsReady===true&&budgets.every((budget:Row)=>typeof budget.spent==='number'&&Number.isFinite(budget.spent));
  // Service-only authoritative snapshot evidence used by locked budget actions.
  // Keep the hardened recurring reserve and completeness flags beside the
  // household revision so the executor can fail closed on stale projections.
  const budgetCoaching=(state.budgetCoaching||[]).map((item:Row)=>({id:item.id,projected:item.projected,reserve:item.reserve,usable:item.usable===true,historyMonths:item.historyMonths,transfer:item.transfer?{fromId:item.transfer.fromId,amount:item.transfer.amount}:null})).sort((a:Row,b:Row)=>String(a.id).localeCompare(String(b.id)));
  const forecastIsCurrent=state.planning?.currentForForecast===true;
  const points=forecastIsCurrent&&state.planning?.ready&&state.planning?.complete&&state.planning?.reliable?state.planning.points||[]:[];
  const low=points.reduce((a:Row|null,b:Row)=>!a||b.balance<a.balance?b:a,points.length&&state.planning?.seriesContract==='dated-end-of-day-v1'&&typeof state.planning.startingBalance==='number'&&Number.isFinite(state.planning.startingBalance)?{date:points[0].date,balance:state.planning.startingBalance}:null);
  const economicChanges=forecastIsCurrent&&Array.isArray(state.planning?.economicChanges)?state.planning.economicChanges.flatMap((change:unknown)=>{
    if(!change||typeof change!=='object'||Array.isArray(change))return[];
    const row=change as Row,kind=String(row.kind||'');if(!['balance_changed','scheduled_event_added','scheduled_event_changed','scheduled_event_removed','variable_spend_changed'].includes(kind))return[];
    const safe:Row={kind};for(const key of ['before','after','delta','amount']){const value=Number(row[key]);if(row[key]!==null&&row[key]!==undefined&&row[key]!==''&&Number.isFinite(value))safe[key]=value;}
    if(typeof row.date==='string'&&/^20\d\d-\d\d-\d\d$/.test(row.date))safe.date=row.date;
    return Object.keys(safe).length>1?[safe]:[];
  }).slice(0,12):[];
  const variableSpend=forecastIsCurrent&&state.planning?.variableSpend?.status==='available'?{status:'available',amount:Number(state.planning.variableSpend.amount),categories:(Array.isArray(state.planning.variableSpend.categories)?state.planning.variableSpend.categories:[]).flatMap((category:unknown)=>{
    if(!category||typeof category!=='object'||Array.isArray(category))return[];const row=category as Row,name=typeof row.name==='string'?row.name.slice(0,80):'';const amount=Number(row.remaining);return name&&Number.isFinite(amount)?[{name,remaining:amount}]:[];
  }).slice(0,40)}:null;
  const rawSavings=state.savingsNotifications&&typeof state.savingsNotifications==='object'&&!Array.isArray(state.savingsNotifications)?state.savingsNotifications:state.savings_notifications&&typeof state.savings_notifications==='object'&&!Array.isArray(state.savings_notifications)?state.savings_notifications:null;
  const savingsNotifications=rawSavings?{
    unresolved_reviews:(Array.isArray(rawSavings.unresolved_reviews)?rawSavings.unresolved_reviews:[]).flatMap((item:unknown)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))return[];
      const row=item as Row,activity_id=typeof row.activity_id==='string'?row.activity_id.trim().slice(0,120):'',goal_id=typeof row.goal_id==='string'?row.goal_id.trim().slice(0,120):'',transaction_date=typeof row.transaction_date==='string'&&/^20\d\d-\d\d-\d\d$/.test(row.transaction_date)?row.transaction_date:null;
      return activity_id&&goal_id&&transaction_date?[{activity_id,goal_id,transaction_date}]:[];
    }).slice(0,100),
    opportunity:(()=>{const value=rawSavings.opportunity;if(!value||typeof value!=='object'||Array.isArray(value))return null;const amount=Number(value.amount),currency=typeof value.currency==='string'?value.currency.slice(0,3).toUpperCase():'';if(value.status!=='available'||value.basis!=='after_committed_obligations_and_cash_floor'||value.forecast_current!==true||value.credited!==false||!Number.isFinite(amount)||amount<25||currency!=='USD')return null;return{amount:Math.round(amount*100)/100,basis:value.basis,status:'available',forecast_current:true,credited:false,currency,goal_id:typeof value.goal_id==='string'?value.goal_id.slice(0,120):null};})()
  }:null;
  return {today:state.today,month:state.today.slice(0,7),evaluated_plan_ids:Array.isArray(state.planEvaluatedIds)?state.planEvaluatedIds:[],budgets,budget_coaching:budgetCoaching,budget_coaching_ready:state.budgetCoachingReady===true,budget_unknown_bills:Number.isInteger(state.unknownBills)?state.unknownBills:null,duplicate_accounts:Array.isArray(state.duplicateCandidates)?state.duplicateCandidates.length>0:null,unresolved_identity_ambiguity:Array.isArray(state.duplicateCandidates)?state.duplicateCandidates.length>0:null,budgets_ready:budgetSpendReady,accounts_ready:state.accountsReady===true,spent:budgetSpendReady?budgets.reduce((n:number,b:Row)=>n+b.spent,0):null,target:budgets.reduce((n:number,b:Row)=>n+Number(b.target),0),available_capacity:state.budgetsReady===true?budgets.reduce((n:number,b:Row)=>n+Number(b.available_capacity),0):null,forecast:low?{date:low.date,balance:low.balance,horizon:state.planning.horizonDays}:null,forecast_current:forecastIsCurrent,forecast_contract_revision:1,
    forecast_economic_changes:economicChanges,
    income_projection:state.incomeProjection&&typeof state.incomeProjection==='object'?state.incomeProjection:null,
    forecast_events:Array.isArray(state.planning?.events)?state.planning.events.flatMap((event:unknown)=>{
      if(!event||typeof event!=='object'||Array.isArray(event))return[];
      const row=event as Row,date=typeof row.date==='string'&&/^20\d\d-\d\d-\d\d$/.test(row.date)?row.date:null;
      const amount=Number(row.amount),flow=String(row.flow_type||''),kind=String(row.recurring_kind||'');
      if(!date||!Number.isFinite(amount)||!['inflow','outflow'].includes(flow))return[];
      return [{date,amount,name:typeof row.name==='string'?row.name.slice(0,120):'Scheduled activity',flow_type:flow,recurring_kind:kind||null,include_in_forecast:row.include_in_forecast!==false,stream_key:typeof row.stream_key==='string'?row.stream_key:null}];
    }).slice(0,80):[],variable_spend:variableSpend,
    refunds:(state.refunds||[]).slice(0,50).map((r:Row)=>({transaction_id:r.transaction_id,original_transaction_id:r.original_transaction_id,date:r.date,amount:r.amount,currency:r.currency,effective_category:r.effective_category,merchant:r.merchant,refund_status:r.refund_status,relationship_type:r.relationship_type,source:r.source,budget_applied:r.budget_applied,needs_review:r.needs_review})),refund_summary:state.refundSummary||null,savings_notifications:savingsNotifications,
    recurringComplete:state.recurringComplete===true,recurring:(state.recurring||[]).map((r:Row)=>({id:r.streamKey||r.streamId||r.stream_key||r.id||r.name,name:r.name,type:r.type,flow:r.flow,amount:r.expectedAmount??r.amount,expectedAmount:r.expectedAmount??r.amount,lastAmount:r.lastAmount,averageAmount:r.averageAmount,lastDate:r.lastDate,nextDate:r.dateIso,expectedDate:r.expectedDate||r.dateIso,frequency:r.frequency,nextDateOverride:r.nextDateOverride??null,currency:r.currency,status:r.status,maturity:r.maturity,increase:r.increase})).sort((a:Row,b:Row)=>String(a.id).localeCompare(String(b.id))),
    accounts:(state.accounts||[]).map((a:Row)=>({id:a.id,institution:a.institution,status:a.status})).sort((a:Row,b:Row)=>String(a.id).localeCompare(String(b.id))),
    goals:(state.goals||[]).map((g:Row)=>({id:g.goal_id||g.id,name:g.name,current:Number(g.current_amount??g.current),target:Number(g.target_amount??g.target),type:g.goal_type||g.type})),
    transaction_ids:Array.isArray(state.transactionIds)?[...new Set(state.transactionIds)].sort():[]};
}
export function financialDeltas(before: Row|null, after: Row): Row[] {
  if(!before)return [];
  const deltas:Row[]=[];
  const add=(type:string,key:string,facts:Row)=>deltas.push({type,key,facts});
  if(before.month===after.month){
    const ids=new Set(before.transaction_ids||[]),count=(after.transaction_ids||[]).filter((id:string)=>!ids.has(id)).length;
    if(count)add('new_transactions',after.month,{count});
    for(const b of after.budgets||[]){const old=(before.budgets||[]).find((v:Row)=>v.id===b.id);if(old&&b.projected!==null&&old.projected!==null&&Math.abs(b.projected-old.projected)>=Math.max(25,b.target*.05))add('budget_projection_change',b.id,{name:b.name,before:old.projected,after:b.projected});}
  }
  if(after.forecast_current===true&&before.forecast&&after.forecast&&before.forecast.horizon===after.forecast.horizon&&Math.abs(after.forecast.balance-before.forecast.balance)>=Math.max(250,Math.abs(before.forecast.balance)*.05))add('forecast_change',String(after.forecast.horizon),{before:before.forecast.balance,after:after.forecast.balance,date:after.forecast.date});
  if(after.forecast_current===true&&before.variable_spend?.status==='available'&&after.variable_spend?.status==='available'){
    const delta=Number(after.variable_spend.amount)-Number(before.variable_spend.amount);
    if(Number.isFinite(delta)&&Math.abs(delta)>=Math.max(25,Math.abs(Number(before.variable_spend.amount))*.05))add('forecast_change',`${after.forecast?.horizon??0}:variable_spend`,{before:Number(before.variable_spend.amount),after:Number(after.variable_spend.amount),delta,component:'variable_spend'});
  }
  if(before.recurringComplete&&after.recurringComplete){for(const r of after.recurring||[]){const old=(before.recurring||[]).find((v:Row)=>v.id===r.id);if(!old)add('new_recurring_detected',r.id,{name:r.name});}}
  for(const a of after.accounts||[]){const old=(before.accounts||[]).find((v:Row)=>v.id===a.id);if(old&&old.status!==a.status)add('account_health_change',a.id,{institution:a.institution,before:old.status,after:a.status});}
  return deltas.slice(0,20);
}
export function materialStateVersion(state:Row,events:Row[],memories:Row[]) {
  // Exact financial state version and narrative version serve different purposes.
  // Event revisions/qualitative state gate the LLM; cents changing do not.
  return JSON.stringify({month:state.month,events:events.map(e=>[e.fingerprint,e.event_version,e.status]),memories,goals:state.goals});
}
