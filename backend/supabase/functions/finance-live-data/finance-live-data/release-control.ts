// Called only after real authentication/household resolution. No client flags.
export async function folio2ReleaseState(db:any,householdId:string,actorId:string){
 const {data,error}=await db.rpc('finance_folio2_release_state',{p_household_id:householdId,p_actor_user_id:actorId});
 if(error||data?.household_id!==householdId||!['off','read_only','enabled'].includes(data.mode)||typeof data.writes_enabled!=='boolean'||typeof data.workers_enabled!=='boolean')return {household_id:householdId,mode:'off',writes_enabled:false,workers_enabled:false,compatibility_reads_required:true};
 return data;
}
export async function folio2WorkerAllowed(db:any,householdId:string){
 try{const {error}=await db.rpc('finance_assert_folio2_write',{p_household_id:householdId,p_worker:true});return !error;}catch{return false;}
}
