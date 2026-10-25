type Row=Record<string,any>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cents=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<=1e-6?Math.round(v*100):null;
export async function withRolloverCapacity(db:any,c:{householdId:string;userId:string},budgets:Row[],targets:Row[],month:string,timezone:string,generation:number){
 const unavailable=(reason:string)=>({complete:false,budgets:budgets.map(b=>({...b,availableCapacity:null,openingCarry:null,rollover:{status:'unavailable',reason}}))});
 if(!Number.isSafeInteger(generation)||generation<0)return unavailable('unverified_generation');
 if(!budgets.length)return{complete:true,budgets:[]};
 try{const system=c.userId==='recurring-refresh-worker',args=system?{h:c.householdId,m:month+'-01'}:{h:c.householdId,a:c.userId,m:month+'-01'};
 if(!system&&!uuid.test(c.userId))return unavailable('unverified_actor');
 const {data,error}=await db.rpc(system?'finance_get_budget_rollover_states_system':'finance_get_budget_rollover_states',args);
 if(error||data?.household_id!==c.householdId||data?.actor_user_id!==(system?null:c.userId)||system&&data?.reader_kind!=='service_worker'||data?.month!==month+'-01'||data?.generation!==generation||!Array.isArray(data.states))return unavailable('rollover_read_unavailable');
 const result=budgets.map(b=>{const matching=data.states.filter((r:Row)=>r?.budget_target_id===b.id),target=targets.find(t=>t.budget_target_id===b.id),state=matching[0],base=cents(b.target),spent=cents(b.spent);const bad=(reason:string)=>({...b,availableCapacity:null,openingCarry:null,rollover:{status:'unavailable',reason}});
 if(matching.length!==1||state?.household_id!==c.householdId||state?.actor_user_id!==(system?null:c.userId)||state?.setting_available!==true||typeof state.current_enabled!=='boolean'||typeof state.setting?.enabled!=='boolean'||!Number.isSafeInteger(state.setting.version)||state.setting.version<0||base===null||base<0||spent===null)return bad('rollover_setting_unavailable');
 if(state.current_enabled===false)return{...b,availableCapacity:b.target,openingCarry:0,rollover:{status:'available',current_enabled:false,setting:state.setting,capacity:null}};
 const cap=state.capacity;
 if(state.setting.timezone!==timezone||cap?.status!=='available'||cap.currency_code!=='USD'||!Number.isSafeInteger(cap.setting_version)||cap.setting_version<1||!Number.isSafeInteger(cap.revision)||cap.revision<0||cap.household_id!==c.householdId||cap.budget_target_id!==b.id||cap.month!==month+'-01'||cap.generation!==generation||cap.includes_pending!==true||cap.base_target_cents!==base||cap.spent_cents!==spent||!Number.isSafeInteger(cap.opening_carry_cents)||cap.opening_carry_cents<0||!Number.isSafeInteger(cap.available_cents)||cap.available_cents!==base+cap.opening_carry_cents||!Number.isSafeInteger(cap.remaining_cents)||cap.remaining_cents!==cap.available_cents-spent||cap.target_version!==target?.version||typeof cap.source_fingerprint!=='string'||!cap.source_fingerprint)return bad('rollover_capacity_unavailable');
 return{...b,availableCapacity:cap.available_cents/100,openingCarry:cap.opening_carry_cents/100,rollover:{status:'available',current_enabled:true,setting:state.setting,capacity:cap}};
 });
 return{complete:result.every(b=>b.rollover.status==='available'),budgets:result};
 }catch{return unavailable('rollover_read_unavailable');}
}
