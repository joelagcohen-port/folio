type Row=Record<string,any>;
// Service-only maintenance; no actor UUID, policy grant, or customer mutation route.
export async function runRolloverBoundary(db:any,householdId:string):Promise<{available:boolean;results:Row[]}>{
 try{const {data,error}=await db.rpc('finance_run_household_rollover_boundary_system',{h:householdId});
 if(error||data?.household_id!==householdId||data.actor_user_id!==null||data.actor_kind!=='service_worker'||!Array.isArray(data.results)||data.results.some((r:Row)=>typeof r?.budget_target_id!=='string'||!['complete','unavailable'].includes(r.result?.status)))return{available:false,results:[]};
 return{available:data.results.every((r:Row)=>r.result.status==='complete'),results:data.results};
 }catch{return{available:false,results:[]};}
}
export async function refreshWithRolloverBoundary(db:any,context:{householdId:string},refresh:(context:any)=>Promise<any>){
 const before=await runRolloverBoundary(db,context.householdId);let value:any,error:any;
 try{value=await refresh(context);}catch(failure){error=failure;}
 const after=await runRolloverBoundary(db,context.householdId);
 // A prepared-source refresh can unblock month close. Retry the read once only.
 if(!before.available&&after.available)return refresh(context);
 if(error)throw error;return value;
}
