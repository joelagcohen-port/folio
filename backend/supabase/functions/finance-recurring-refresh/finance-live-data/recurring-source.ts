/** Bank-parent source classification; an allocation never becomes a recurring source. */
export async function recurringSourceTransaction(db:any,householdId:string,userId:string,transactionId:string,RequestError:any,manualStreamId:string|null=null){
 const {data,error}=await db.rpc('finance_recurring_source_transaction',{p_household_id:householdId,p_user_id:userId,p_transaction_id:transactionId,p_manual_stream_id:manualStreamId});
 if(error)throw new RequestError(error.code==='42501'?'Household membership changed.':'Recurring source evidence is unavailable.',error.code==='42501'?403:503);
 if(!data)throw new RequestError('Select a current posted bank transaction in this household.',404);
 if(data.transaction_id!==transactionId||!['current','accepted_successor'].includes(data.source_identity_state)||(data.source_identity_state==='accepted_successor'&&(!manualStreamId||!data.current_bank_transaction_id||data.current_bank_transaction_id===transactionId))||(data.source_identity_state==='current'&&data.current_bank_transaction_id!==transactionId)||!['available','passthrough'].includes(data.split_status)||!['income','expense','refund','other_inflow','transfer'].includes(data.effective_type)||(data.split_status==='available'&&data.effective_category!==null))throw new RequestError('Recurring source evidence changed or is unavailable.',409);
 return data;
}
