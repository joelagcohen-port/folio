// Additive handlers for the existing authenticated finance-live-data router.
// Dependency injection preserves its session/household validation and service client.
export function goalSettingsHandlers(db:any, RequestError:any) {
 const id=(value:any,label:string)=>{if(typeof value!=='string'||!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value))throw new RequestError(`Invalid ${label}.`,400);return value.toLowerCase();};
 const uuidValid=(value:any)=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
 const stable=(value:any):string=>JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])));
 const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const only=(body:any,keys:string[])=>{if(!object(body)||Object.keys(body).some(key=>!keys.includes(key)))throw new RequestError('Invalid goal settings request.',400);};
 const call=async(name:string,args:any)=>{let result;try{result=await db.rpc(name,args);}catch{throw new RequestError('Goal settings response unavailable. Retry with the same request.',503);}if(result.error){const code=result.error.code;throw new RequestError(code==='42501'?'Household access or review unavailable.':code==='40001'||code==='23505'?'Goal settings changed. Refresh and review again.':code==='22023'?'Invalid goal settings.':'Goal settings response unavailable. Retry with the same request.',code==='42501'?403:code==='40001'||code==='23505'?409:code==='22023'?400:503);}return result.data;};
 const validState=(state:any,context:any,goalId:string)=>object(state)&&object(state.goal)&&state.goal.household_id===context.householdId&&state.goal.goal_id===goalId&&state.goal.goal_type==='save'&&state.goal.active===true&&Array.isArray(state.links)&&state.links.every((l:any)=>object(l)&&l.household_id===context.householdId&&l.goal_id===goalId);
 return {
  async get(context:any,body:any){
   only(body,['action','household_id','goal_id']);const goalId=id(body.goal_id,'goal ID');
   const state=await call('finance_goal_settings_state',{p_household_id:context.householdId,p_goal_id:goalId});
   if(!validState(state,context,goalId))throw new RequestError('Active savings goal unavailable.',503);
   return {state};
  },
  async review(context:any,body:any){
   only(body,['action','household_id','goal_id','expected_state','settings']);const goalId=id(body.goal_id,'goal ID');
   if(!validState(body.expected_state,context,goalId)||!object(body.settings))throw new RequestError('Refresh the goal before reviewing.',400);
   const review=await call('review_goal_savings_settings',{p_household_id:context.householdId,p_user_id:context.userId,p_goal_id:goalId,p_expected_state:body.expected_state,p_settings:body.settings});
   if(!object(review)||review.household_id!==context.householdId||review.actor_user_id!==context.userId||review.goal_id!==goalId||!validState(review.before_state,context,goalId)||!uuidValid(review.review_id)||stable(review.before_state)!==stable(body.expected_state)||stable(review.requested_settings)!==stable(body.settings)||!Number.isFinite(Date.parse(review.expires_at)))throw new RequestError('Goal review response unavailable.',503);
   return {review};
  },
  async confirm(context:any,body:any){
   only(body,['action','household_id','review_id','idempotency_key','confirm']);if(body.confirm!==true)throw new RequestError('Review and confirm goal settings.',400);
   const reviewId=id(body.review_id,'review ID'),key=id(body.idempotency_key,'confirmation key');
   const receipt=await call('confirm_goal_savings_settings',{p_household_id:context.householdId,p_user_id:context.userId,p_review_id:reviewId,p_idempotency_key:key});
   if(!object(receipt)||receipt.household_id!==context.householdId||receipt.actor_user_id!==context.userId||receipt.review_id!==reviewId||receipt.idempotency_key!==key||!object(receipt.goal)||receipt.goal.household_id!==context.householdId||receipt.goal.goal_type!=='save'||!uuidValid(receipt.goal.goal_id)||!object(receipt.settings)||!Number.isFinite(Date.parse(receipt.confirmed_at)))throw new RequestError('Goal confirmation response unavailable. Retry with the same request.',503);
   return {receipt};
  }
 };
}
