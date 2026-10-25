type Row=Record<string,any>;
export function expandPreparedBudgetRows(
  parents: Row[],
): { available: boolean; rows: Row[]; parentCount: number; allocationCount: number; splitParentCount: number } {
  const rows: Row[] = [];
  let allocationCount = 0;
  let splitParentCount = 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const parent of parents) {
    const allocations = parent.split_allocations;
    if (parent.split_status === "passthrough") {
      if (!Array.isArray(allocations) || allocations.length !== 0) return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount: 0 };
      rows.push(parent);
      continue;
    }
    splitParentCount += 1;
    if (parent.split_status !== "available" || !Array.isArray(allocations) || allocations.length < 2 || allocations.length > 40 ||
      typeof parent.transaction_id !== "string" || !parent.transaction_id || !(typeof parent.iso_currency_code==='string'&&/^[A-Z]{3}$/.test(parent.iso_currency_code)) || !Number.isFinite(Number(parent.amount)) ||
      !Number.isFinite(Number(parent.amount) * 100) || !Number.isSafeInteger(Math.round(Number(parent.amount) * 100)) ||
      Math.abs(Number(parent.amount) * 100 - Math.round(Number(parent.amount) * 100)) > 1e-6 ||
      typeof parent.pending !== "boolean" || typeof parent.excluded_from_totals !== "boolean" ||
      typeof parent.transaction_excluded_from_budget !== "boolean" || typeof parent.account_id !== "string" || !parent.account_id) {
      return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount };
    }
    const parentCents = Math.round(Number(parent.amount) * 100);
    const ids = new Set<string>(), indexes = new Set<number>();
    let sumCents = 0;
    const children: Row[] = [];
    for (const allocation of allocations) {
      const id = String(allocation?.allocation_id ?? "");
      const index = allocation?.allocation_index;
      const cents = allocation?.amount_cents;
      const category = String(allocation?.category_name ?? "").trim();
      const type = String(allocation?.effective_type ?? "");
      if (!uuid.test(id) || ids.has(id) || !Number.isSafeInteger(index) || index < 0 || index >= 40 || indexes.has(index) ||
        allocation?.allocation_status !== "split" || allocation.parent_transaction_id !== parent.transaction_id ||
        !uuid.test(String(allocation.category_id ?? "")) || !category || !["expense", "income"].includes(type) || type !== parent.effective_type ||
        allocation.currency_code !== parent.iso_currency_code ||
        !(allocation.subcategory === null || typeof allocation.subcategory === "string") || !Number.isSafeInteger(cents) ||
        typeof allocation.pending !== "boolean" || allocation.pending !== parent.pending ||
        allocation.effective_transaction_date !== parent.effective_transaction_date ||
        allocation.account_id !== parent.account_id ||
        typeof allocation.excluded_from_totals !== "boolean" || allocation.excluded_from_totals !== parent.excluded_from_totals ||
        typeof allocation.transaction_excluded_from_budget !== "boolean" || allocation.transaction_excluded_from_budget !== parent.transaction_excluded_from_budget ||
        typeof allocation.category_excluded_from_budget !== "boolean" ||
        (parentCents > 0 && cents < 0) || (parentCents < 0 && cents > 0) ||
        (parentCents === 0 && cents !== 0)) {
        return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount };
      }
      ids.add(id); indexes.add(index); sumCents += cents;if(!Number.isSafeInteger(sumCents))return {available:false,rows:[],parentCount:parents.length,allocationCount:0,splitParentCount};
      children.push({
        ...parent,
        transaction_id: parent.transaction_id,
        effective_category: category,
        effective_subcategory: allocation.subcategory === null ? null : String(allocation.subcategory),
        effective_type: type,
        amount: cents / 100,
        iso_currency_code: String(allocation.currency_code),
        category_excluded_from_budget: allocation.category_excluded_from_budget,
      });
    }
    if (parentCents === 0 || sumCents !== parentCents) return { available: false, rows: [], parentCount: parents.length, allocationCount: 0, splitParentCount };
    allocationCount += children.length;
    rows.push(...children);
  }
  return { available: true, rows, parentCount: parents.length, allocationCount, splitParentCount };
}

export async function loadAllocationBudgetRows(db:any,householdId:string,start:string,end:string,generation:unknown):Promise<{complete:boolean;rows:Row[]}>{
 const fail=()=>({complete:false,rows:[]});
 if(!Number.isSafeInteger(generation)||Number(generation)<0)return fail();
 const rows:Row[]=[],seen=new Set<string>();let afterDate:string|null=null,afterId:string|null=null;
 try{for(let offset=0;offset<20000;offset+=1000){
 const {data,error}=await db.rpc('finance_query_prepared_transactions',{p_household_id:householdId,p_start_date:start,p_end_date:end,p_include_pending:true,p_after_date:afterDate,p_after_transaction_id:afterId,p_limit:1000,p_expected_generation:generation});
 if(error||data?.fresh!==true||data.stale===true||data.restart_required===true||data.generation!==generation||typeof data.has_more!=='boolean'||!Array.isArray(data.transactions)||data.transactions.length>1000)return fail();
 for(const tx of data.transactions){if(typeof tx.transaction_id!=='string'||!tx.transaction_id||seen.has(tx.transaction_id)||typeof tx.effective_transaction_date!=='string'||tx.effective_transaction_date<start||tx.effective_transaction_date>end)return fail();seen.add(tx.transaction_id);}
 const expanded=expandPreparedBudgetRows(data.transactions);if(!expanded.available)return fail();rows.push(...expanded.rows);
 if(!data.has_more)return{complete:true,rows};
 const last=data.transactions.at(-1);if(!last||data.next_date!==last.effective_transaction_date||data.next_transaction_id!==last.transaction_id||afterDate!==null&&(data.next_date<afterDate||data.next_date===afterDate&&data.next_transaction_id<=afterId!))return fail();
 afterDate=data.next_date;afterId=data.next_transaction_id;
 }}catch{return fail();}return fail();
}
