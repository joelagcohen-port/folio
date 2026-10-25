export function savingsPlanCreateHandlers(db:any, RequestError:any) {
 const validId=(value:any)=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
 const id=(value:any)=>{if(!validId(value))throw new RequestError('Invalid creation identity.',400);return value.toLowerCase();};
 const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const stable=(value:any):string=>JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])));
 const only=(body:any,keys:string[])=>{if(!object(body)||Object.keys(body).some(key=>!keys.includes(key)))throw new RequestError('Invalid savings creation request.',400);};
 const call=async(name:string,args:any)=>{let result;try{result=await db.rpc(name,args);}catch{throw new RequestError('Savings creation response unavailable. Retry the same request.',503);}if(result.error){const code=result.error.code;throw new RequestError(code==='42501'?'Household access or review unavailable.':code==='40001'||code==='23505'?'Savings facts changed. Review again.':code==='22023'?'Invalid savings values.':'Savings creation response unavailable. Retry the same request.',code==='42501'?403:code==='40001'||code==='23505'?409:code==='22023'?400:503);}return result.data;};
 return {
  async review(context:any,body:any){
   only(body,['action','household_id','values']);if(!object(body.values))throw new RequestError('Review the savings goal details.',400);
   const review=await call('review_savings_goal_plan_creation',{p_household_id:context.householdId,p_user_id:context.userId,p_values:body.values});
   if(!object(review)||review.household_id!==context.householdId||review.actor_user_id!==context.userId||!validId(review.review_id)||!Number.isFinite(Date.parse(review.expires_at))||stable(review.requested_values)!==stable(body.values))throw new RequestError('Savings review response unavailable.',503);
   return {review};
  },
  async confirm(context:any,body:any){
   only(body,['action','household_id','review_id','idempotency_key','confirm']);if(body.confirm!==true)throw new RequestError('Review and confirm the savings objective.',400);
   const reviewId=id(body.review_id),key=id(body.idempotency_key);
   const receipt=await call('confirm_savings_goal_plan_creation',{p_household_id:context.householdId,p_user_id:context.userId,p_review_id:reviewId,p_idempotency_key:key});
   if(!object(receipt)||receipt.household_id!==context.householdId||receipt.actor_user_id!==context.userId||receipt.review_id!==reviewId||receipt.idempotency_key!==key||!object(receipt.goal)||!object(receipt.plan)||receipt.goal.household_id!==context.householdId||receipt.plan.household_id!==context.householdId||receipt.goal.goal_type!=='save'||receipt.plan.plan_type!=='savings'||receipt.plan.goal_id!==receipt.goal.goal_id||!validId(receipt.goal.goal_id)||!validId(receipt.plan.plan_id)||receipt.plan.version!==1||!object(receipt.settings)||!Number.isFinite(Date.parse(receipt.confirmed_at)))throw new RequestError('Savings confirmation response unavailable. Retry the same request.',503);
   return {receipt};
  }
 };
}
