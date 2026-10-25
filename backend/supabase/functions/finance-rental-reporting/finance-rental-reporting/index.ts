import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildRentalCsv, buildRentalReport, validateMortgageSplit, type RentalClassification, type RentalPeriod, type ReportingScope, type RentalTransaction, type RentalTreatment } from "../_shared/rental-reporting.ts";

import { buildAllocationAwareRentalReport, buildAllocationAwareRentalCsv, type ParentEvidence } from "../_shared/rental-allocation-report.ts";

type Row = Record<string, any>;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const txFields = "household_id,transaction_id,account_id,canonical_account_id,effective_transaction_date,amount,iso_currency_code,pending,effective_merchant_name,name,original_description,effective_category,effective_type,plaid_primary_category,plaid_detailed_category,transfer_network,transfer_direction,pending_transaction_id,refund_relationship_type,refund_original_transaction_id,refund_status";
const categoryKeys = new Set(["rent","late_fees","other_rental_income","advertising","cleaning_maintenance","insurance","legal_professional","management_fees","mortgage_interest","repairs","supplies","property_taxes","utilities","hoa","other","capital_improvement","mortgage_principal","mortgage_payment","mortgage_escrow","transfer","owner_contribution","owner_draw","personal_exclude","needs_review","security_deposit_received","security_deposit_applied","security_deposit_returned"]);
const treatments = new Set<RentalTreatment>(["rental_income","operating_expense","capital_improvement","mortgage_principal","mortgage_payment","transfer","owner_contribution","owner_draw","personal_exclude","needs_review","security_deposit_received","security_deposit_applied","security_deposit_returned"]);
const MAX_ROWS = 20000;

Deno.serve(async request => {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Sign in required.");
    const anon = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), options);
    const { data: identity, error: authError } = await anon.auth.getUser(authorization.slice(7));
    if (authError || !identity.user) throw new HttpError(401, "Sign in required.");
    if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new HttpError(401, "Sign in required.");
    const body = await request.json().catch(() => null);
    if (!record(body)) throw new HttpError(400, "Expected an object.");
    const allowed = new Set(["action","household_id","scope","period","include_pending","tax_year","include_transactions","confirm","transaction_id","treatment","category","notes","reviewed","deposit_applications","deposit_received_transaction_id","deposit_received_allocation_id","expected_deposit_received_allocation_revision","expected_deposit_received_allocation_amount_cents","mortgage_split","query","start_date","end_date","amount_min","amount_max","limit","changes","expected","ask_scope_guard","expected_scope","expected_period","expected_classification_updated_at","expected_transaction","clear_mortgage_split","idempotency_key","allocation_id","classification","review_id","request_id","transaction_ids"]);
    if (Object.keys(body).some(key => !allowed.has(key))) throw new HttpError(400, "Unknown input field.");
    const action = body.action;
    if (!["get_accounts","get_preferences","save_preferences","get_report","search_transactions","preview_classifications","save_classification","save_classification_reviewed_atomic","read_rental_children","review_rental_child","confirm_rental_child"].includes(action)) throw new HttpError(400, "Invalid action.");
    const householdId = requiredText(body.household_id, 36);
    const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), options);
    const { data: member, error: memberError } = await db.from("finance_household_members").select("household_id,role").eq("household_id", householdId).eq("user_id", identity.user.id).maybeSingle();
    check(memberError); if (!member) throw new HttpError(403, "No access to this household.");
    if (action === "read_rental_children") {
      if (!Array.isArray(body.transaction_ids) || body.transaction_ids.length > 500 || body.transaction_ids.some((id: unknown) => typeof id !== "string" || !id)) throw new HttpError(400, "Choose transaction identities.");
      return json({ household_id: householdId, actor_user_id: identity.user.id, rows: await loadRentalChildEvidence(db, identity.user.id, householdId, body.transaction_ids) });
    }
    if (action === "review_rental_child") {
      if (!uuid(body.allocation_id) || !record(body.classification)) throw new HttpError(400, "Choose an allocation and its explicit classification.");
      const { data, error } = await db.rpc("finance_review_rental_child", {p_household:householdId,p_actor:identity.user.id,p_transaction:requiredText(body.transaction_id,200),p_allocation:body.allocation_id,p_classification:body.classification});
      if(error)throw childRpcError(error,false);
      if(!data||data.household_id!==householdId||data.actor_user_id!==identity.user.id||!uuid(data.review_id)||data.transaction_id!==body.transaction_id||data.allocation_id!==body.allocation_id||!record(data.evidence)||!record(data.classification))throw new HttpError(503,"Child review evidence unavailable.");
      return json(data);
    }
    if (action === "confirm_rental_child") {
      if(!uuid(body.review_id)||!uuid(body.request_id)||body.confirm!==true)throw new HttpError(400,"Explicit reviewed confirmation required.");
      let result;try{result=await db.rpc("finance_confirm_rental_child",{p_household:householdId,p_actor:identity.user.id,p_review:body.review_id,p_request:body.request_id,p_confirm:true});}catch{throw new HttpError(503,"Child save outcome unknown. Retry the exact request.");}
      if(result.error)throw childRpcError(result.error,true);const data=result.data,receipt=data?.receipt,c=receipt?.classification;
      if(data?.saved!==true||data.household_id!==householdId||data.actor_user_id!==identity.user.id||receipt?.review_id!==body.review_id||receipt?.request_id!==body.request_id||c?.household_id!==householdId||c?.actor_user_id!==identity.user.id||!uuid(c?.allocation_id)||!record(c?.classification))throw new HttpError(503,"Child save outcome unknown. Retry the exact request.");
      return json(data);
    }
    if (action === "get_accounts") return await getAccounts(db, householdId);
    if (action === "get_preferences") return await getPreferences(db, identity.user.id, householdId);
    if (action === "save_preferences") return await savePreferences(db, identity.user.id, householdId, body);
    if (action === "search_transactions") return await searchRentalTransactions(db, identity.user.id, householdId, body);
    if (action === "preview_classifications") return await previewClassifications(db, identity.user.id, householdId, body);
    if (action === "save_classification") return await saveClassification(db, identity.user.id, householdId, body);
    if (action === "save_classification_reviewed_atomic") return await saveClassificationAtomic(db, identity.user.id, householdId, body);
    return await getReport(db, identity.user.id, householdId, body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: error instanceof HttpError ? error.message : "Could not load rental reporting." }, status);
  }
});

async function getAccounts(db: any, householdId: string) {
  const { data, error } = await db.from("finance_household_accounts").select("canonical_account_id,account_id,name,official_name,mask,type,subtype,lifecycle_status,source_count,balance_currency_code").eq("household_id", householdId).limit(501);
  check(error); if ((data?.length ?? 0) > 500) throw new HttpError(422, "Household account limit exceeded.");
  return json({ accounts: (data ?? []).map((a: Row) => ({ canonical_account_id: a.canonical_account_id, name: a.official_name || a.name, mask: a.mask, type: a.type, subtype: a.subtype, lifecycle_status: a.lifecycle_status, currency: a.balance_currency_code || "USD" })) });
}
async function getPreferences(db: any, userId: string, householdId: string) {
  const { data, error } = await db.from("finance_rental_reporting_preferences").select("selected_scope,period_type,period_start,period_end,tax_year,updated_at").eq("user_id", userId).eq("household_id", householdId).maybeSingle();
  check(error); return json({ preference: data ?? null });
}
async function getSavedRentalSelection(db:any,userId:string,householdId:string) {
  const {data,error}=await db.from("finance_rental_reporting_preferences").select("selected_scope,period_type,period_start,period_end,tax_year").eq("user_id",userId).eq("household_id",householdId).maybeSingle();check(error);
  if(!data)throw new HttpError(409,"Choose and save a Rental P&L account and period before using rental transaction actions.");
  const scope=parseScope(data.selected_scope);await validateScope(db,householdId,scope);
  const period=parsePeriod({type:data.period_type,start_date:data.period_start,end_date:data.period_end});
  return {scope,period};
}
async function searchRentalTransactions(db:any,userId:string,householdId:string,body:Row) {
  const {scope,period}=await getSavedRentalSelection(db,userId,householdId);
  const query=requiredText(body.query,120).toLocaleLowerCase("en-US");
  const start=body.start_date===undefined?period.start_date:date(body.start_date),end=body.end_date===undefined?period.end_date:date(body.end_date);
  if(start>end)throw new HttpError(400,"Search start date must be on or before its end.");
  const min=body.amount_min===undefined?null:finiteAmount(body.amount_min),max=body.amount_max===undefined?null:finiteAmount(body.amount_max);
  if(min!==null&&max!==null&&min>max)throw new HttpError(400,"Amount minimum must be no greater than its maximum.");
  const cap=int(body.limit,25,1,50),matches:Row[]=[],supersededPending=new Set<string>();let offset=0;
  while(true){let request=db.from("finance_effective_transactions").select(txFields).eq("household_id",householdId).in("canonical_account_id",scope.canonical_account_ids).gte("effective_transaction_date",start).lte("effective_transaction_date",end).order("transaction_id").range(offset,offset+999);if(body.include_pending!==true)request=request.eq("pending",false);const {data,error}=await request;check(error);const rows=data??[];for(const tx of rows){if(tx.pending_transaction_id)supersededPending.add(String(tx.pending_transaction_id));const merchant=String(tx.effective_merchant_name||tx.name||"").toLocaleLowerCase("en-US"),description=String(tx.original_description||"").toLocaleLowerCase("en-US"),abs=Math.abs(Number(tx.amount));if((merchant.includes(query)||description.includes(query))&&(min===null||abs>=min)&&(max===null||abs<=max))matches.push(tx);}offset+=rows.length;if(rows.length<1000)break;if(offset>MAX_ROWS)throw new HttpError(422,"Search range contains too many transactions. Narrow the dates or amount.");}
  const deduped=matches.filter((tx:Row)=>tx.pending!==true||!supersededPending.has(tx.transaction_id));
  const sorted=deduped.sort((a,b)=>String(b.effective_transaction_date).localeCompare(String(a.effective_transaction_date))),has_more=sorted.length>cap,limited=sorted.slice(0,cap);
  const successorById=await resolvedPendingSuccessors(db,householdId,limited);
  const ids=limited.map((tx:Row)=>tx.transaction_id);const classById=new Map<string,Row>();
  for(let i=0;i<ids.length;i+=500){const {data,error}=await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,category,reviewed,updated_at,mortgage_split,deposit_applications,deposit_received_transaction_id").eq("household_id",householdId).in("transaction_id",ids.slice(i,i+500));check(error);for(const row of data??[])classById.set(row.transaction_id,row);}
  const accountRows=await db.from("finance_household_accounts").select("canonical_account_id,name,official_name,mask").eq("household_id",householdId).in("canonical_account_id",scope.canonical_account_ids);check(accountRows.error);const names=new Map((accountRows.data??[]).map((a:Row)=>[a.canonical_account_id,`${a.official_name||a.name}${a.mask?` ••••${a.mask}`:""}`]));
  const childRows=await loadRentalChildEvidence(db,userId,householdId,ids);const childById=new Map(childRows.map(c=>[c.transaction_id,c]));
  for(const tx of limited){const facts=childById.get(tx.transaction_id)?.parent_facts;if(!facts||Object.entries(facts).some(([key,value])=>JSON.stringify(value??null)!==JSON.stringify(tx[key]??null)))throw new HttpError(409,"Rental transaction changed during search. Search again.");}
  return json({scope,period,total_count:sorted.length,has_more,transactions:limited.map((tx:Row)=>{const c=classById.get(tx.transaction_id),child=childById.get(tx.transaction_id);return {rental_child_evidence:child,transaction_id:tx.transaction_id,date:tx.effective_transaction_date,merchant:tx.effective_merchant_name||tx.name||"Transaction",description:tx.original_description||tx.name||"",amount:Number(tx.amount),currency:tx.iso_currency_code||"USD",account:names.get(tx.canonical_account_id)||"Rental account",canonical_account_id:tx.canonical_account_id,pending:tx.pending===true,pending_transaction_id:tx.pending_transaction_id??null,household_category:child?.split_status==="available"?"Split transaction":tx.effective_category||null,effective_type:tx.effective_type??null,refund_status:tx.refund_status??null,refund_relationship_type:tx.refund_relationship_type??null,refund_original_transaction_id:tx.refund_original_transaction_id??null,expected_transaction:rentalExpectedEvidence(tx,successorById.get(tx.transaction_id)),classification_updated_at:c?.updated_at??null,rental_treatment:child?.split_status!=="passthrough"?"split":c?.treatment??null,rental_category:child?.split_status!=="passthrough"?null:c?.category??null,rental_reviewed:child?.split_status==="available"?child.children.every(v=>v.classification?.reviewed===true):c?.reviewed===true,has_mortgage_split:Boolean(c?.mortgage_split),has_deposit_details:Boolean((c?.deposit_applications??[]).length||c?.deposit_received_transaction_id)};})});
}
async function previewClassifications(db:any,userId:string,householdId:string,body:Row) {
  const {scope,period}=await getSavedRentalSelection(db,userId,householdId);
  if(body.expected_scope!==undefined&&!sameScope(body.expected_scope,scope))throw new HttpError(409,"Rental account scope changed after this proposal. Search and review the transactions again.");
  if(body.expected_period!==undefined&&!samePeriod(body.expected_period,period))throw new HttpError(409,"Rental reporting period changed after this proposal. Search and review the transactions again.");
  if(!Array.isArray(body.changes)||body.changes.length<1||body.changes.length>20)throw new HttpError(400,"Choose between 1 and 20 rental classifications.");
  const changes=body.changes.map((change:unknown)=>{if(!record(change))throw new HttpError(400,"Invalid rental classification proposal.");const transaction_id=requiredText(change.transaction_id,200),treatment=requiredText(change.treatment,64),category=requiredText(change.category,64);if(!treatments.has(treatment as RentalTreatment))throw new HttpError(400,"Choose a supported rental reporting treatment.");if(!categoryKeys.has(category))throw new HttpError(400,"Choose a supported rental reporting category.");validateRentalPair(treatment,category);return {transaction_id,treatment,category};});
  await requireParentRentalRows(db,userId,householdId,changes.map((c:Row)=>c.transaction_id));
  const ids=changes.map((c:Row)=>c.transaction_id);if(new Set(ids).size!==ids.length)throw new HttpError(400,"A transaction may appear only once in a rental classification batch.");
  const {data:txRows,error:txError}=await db.from("finance_effective_transactions").select(txFields).eq("household_id",householdId).in("canonical_account_id",scope.canonical_account_ids).in("transaction_id",ids);check(txError);
  const successorById=await resolvedPendingSuccessors(db,householdId,txRows??[]);
  const byId=new Map((txRows??[]).map((tx:Row)=>[tx.transaction_id,tx]));if(ids.some((id:string)=>!byId.has(id)))throw new HttpError(404,"One or more selected transactions are unavailable in the saved Rental P&L account scope.");
  const {data:classes,error:classError}=await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,category,notes,reviewed,deposit_applications,deposit_received_transaction_id,deposit_received_allocation_id,mortgage_split,updated_at").eq("household_id",householdId).in("transaction_id",ids);check(classError);const classById=new Map((classes??[]).map((c:Row)=>[c.transaction_id,c]));
  for(const change of changes){const tx=byId.get(change.transaction_id)!,c=classById.get(change.transaction_id);if(String(tx.iso_currency_code||"USD").toUpperCase()!=="USD")throw new HttpError(422,"Rental classification actions currently require USD transactions.");if((c?.mortgage_split||c?.treatment?.startsWith("security_deposit")||c?.deposit_received_transaction_id||(c?.deposit_applications??[]).length)&&change.treatment!==c?.treatment)throw new HttpError(409,"This transaction has mortgage or security-deposit details. Review it in transaction detail before changing its treatment.");if(change.treatment.startsWith("security_deposit"))throw new HttpError(422,"Security-deposit receipts, applications, and returns need linked details. Edit them in transaction detail.");if(change.treatment==="mortgage_payment"){if(Number(tx.amount)<=0)throw new HttpError(422,"Mortgage payment split is available only for a money-out transaction.");if(c?.treatment==="mortgage_payment"&&c.reviewed===true){const split=validateMortgageSplit(c.mortgage_split,Number(tx.amount),true);if(split.valid&&split.complete)throw new HttpError(409,"This mortgage payment already has a confirmed split. Review it in transaction detail before changing it.");}}}
  if(body.expected!==undefined){if(!Array.isArray(body.expected))throw new HttpError(400,"Invalid rental confirmation snapshot.");const expectedById=new Map(body.expected.filter(record).map((item:Row)=>[item.transaction_id,item]));if(expectedById.size!==changes.length)throw new HttpError(409,"The rental proposal changed. Search and review it again.");for(const change of changes){const tx=byId.get(change.transaction_id)!,c=classById.get(change.transaction_id),expected=expectedById.get(change.transaction_id);if(!expected||expected.treatment!==change.treatment||expected.category!==change.category||expected.canonical_account_id!==tx.canonical_account_id||expected.date!==tx.effective_transaction_date||Number(expected.amount)!==Number(tx.amount)||expected.merchant!==String(tx.effective_merchant_name||tx.name||"Transaction")||expected.classification_updated_at!==(c?.updated_at??null)||expected.current_treatment!==(c?.treatment??null)||expected.current_category!==(c?.category??null)||expected.current_reviewed!==(c?.reviewed===true))throw new HttpError(409,"Transaction or rental classification changed after this proposal. Search and review the updated transaction.");}}
  const namesResult=await db.from("finance_household_accounts").select("canonical_account_id,name,official_name,mask").eq("household_id",householdId).in("canonical_account_id",scope.canonical_account_ids);check(namesResult.error);const names=new Map((namesResult.data??[]).map((a:Row)=>[a.canonical_account_id,`${a.official_name||a.name}${a.mask?` ••••${a.mask}`:""}`]));
  const entries=changes.map((change:Row)=>{const tx=byId.get(change.transaction_id)!,c=classById.get(change.transaction_id);return {transaction_id:tx.transaction_id,date:tx.effective_transaction_date,merchant:tx.effective_merchant_name||tx.name||"Transaction",amount:Number(tx.amount),currency:tx.iso_currency_code||"USD",account:names.get(tx.canonical_account_id)||"Rental account",canonical_account_id:tx.canonical_account_id,treatment:change.treatment,category:change.category,current_treatment:c?.treatment??null,current_category:c?.category??null,current_reviewed:c?.reviewed===true,classification_updated_at:c?.updated_at??null,expected_transaction:rentalExpectedEvidence(tx,successorById.get(tx.transaction_id))};});
  return json({scope,period,entries});
}
async function resolvedPendingSuccessors(db:any,householdId:string,rows:Row[]){
  const pending=rows.filter((tx:Row)=>tx.pending===true);
  const ids=await Promise.all(pending.map(async(tx:Row)=>{const {data,error}=await db.rpc("finance_folio2_resolve_pending_successor",{p_household_id:householdId,p_transaction_id:tx.transaction_id});check(error);return data as string|null;}));
  const successorIds=[...new Set(ids.filter((id):id is string=>typeof id==="string"&&id.length>0))],byId=new Map<string,Row>();
  for(let i=0;i<successorIds.length;i+=500){const {data,error}=await db.from("finance_effective_transactions").select(txFields).eq("household_id",householdId).in("transaction_id",successorIds.slice(i,i+500));check(error);for(const row of data??[])byId.set(row.transaction_id,row);}
  const result=new Map<string,Row>();for(let i=0;i<pending.length;i++){const successor=byId.get(ids[i] as string);if(successor)result.set(pending[i].transaction_id,successor);}return result;
}
function validateRentalPair(treatment:string,category:string){
  if(treatment==="rental_income"&&! ["rent","late_fees","other_rental_income"].includes(category))throw new HttpError(400,"Rental income needs a rental income category.");
  if(treatment==="operating_expense"&&! ["advertising","cleaning_maintenance","insurance","legal_professional","management_fees","mortgage_interest","repairs","supplies","property_taxes","utilities","hoa","other"].includes(category))throw new HttpError(400,"Operating expense needs a rental expense category.");
  if(treatment==="mortgage_payment"&&category!=="mortgage_payment")throw new HttpError(400,"Mortgage payment classification needs the Mortgage payment category.");
  if(["capital_improvement","mortgage_principal","transfer","owner_contribution","owner_draw","personal_exclude","needs_review"].includes(treatment)&&category!==treatment)throw new HttpError(400,"Rental special treatment and category must match.");
  if(treatment.startsWith("security_deposit"))throw new HttpError(400,"Security-deposit changes require linked transaction detail.");
}
function stableJson(value:any):string{if(Array.isArray(value))return`[${value.map(stableJson).join(",")}]`;if(value&&typeof value==="object")return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;return JSON.stringify(value);}
function rentalExpectedEvidence(tx:Row,successor?:Row){return {canonical_account_id:tx.canonical_account_id,date:tx.effective_transaction_date,amount:Number(tx.amount),currency:String(tx.iso_currency_code||"USD").toUpperCase(),pending:tx.pending===true,pending_transaction_id:tx.pending_transaction_id??null,pending_successor:successor?{transaction_id:successor.transaction_id,canonical_account_id:successor.canonical_account_id,amount:Number(successor.amount),date:successor.effective_transaction_date,currency:String(successor.iso_currency_code||"USD").toUpperCase(),pending:successor.pending===true}:null,merchant:String(tx.effective_merchant_name||tx.name||"Transaction"),description:String(tx.original_description||tx.name||""),effective_category:tx.effective_category??null,effective_type:tx.effective_type??null,refund_status:tx.refund_status??null,refund_relationship_type:tx.refund_relationship_type??null,refund_original_transaction_id:tx.refund_original_transaction_id??null};}
async function savePreferences(db: any, userId: string, householdId: string, body: Row) {
  const scope = parseScope(body.scope);
  await validateScope(db, householdId, scope);
  const period = parsePeriod(body.period);
  const taxYear = int(body.tax_year, Number(period.end_date.slice(0, 4)), 1900, 9999);
  const row = { user_id: userId, household_id: householdId, selected_scope: scope, period_type: period.type, period_start: period.start_date, period_end: period.end_date, tax_year: taxYear, updated_at: new Date().toISOString() };
  const { error } = await db.from("finance_rental_reporting_preferences").upsert(row, { onConflict: "user_id,household_id" }); check(error);
  return json({ preference: row });
}
async function saveClassification(db: any, userId: string, householdId: string, body: Row) {
  await requireParentRentalRows(db,userId,householdId,[requiredText(body.transaction_id,200)]);
  if (body.confirm !== true) throw new HttpError(400, "Confirm the rental classification change before saving.");
  const transactionId = requiredText(body.transaction_id, 200);
  if (!treatments.has(body.treatment)) throw new HttpError(400, "Choose a rental treatment.");
  const category = body.category === null || body.category === undefined || body.category === "" ? null : requiredText(body.category, 64);
  if (category && !categoryKeys.has(category)) throw new HttpError(400, "Choose a supported rental category.");
  if (body.treatment === "rental_income" && !["rent","late_fees","other_rental_income"].includes(category ?? "")) throw new HttpError(400, "Rental income needs an income category.");
  if (body.treatment === "operating_expense" && !["advertising","cleaning_maintenance","insurance","legal_professional","management_fees","mortgage_interest","repairs","supplies","property_taxes","utilities","hoa","other"].includes(category ?? "")) throw new HttpError(400, "Operating expenses need an expense category.");
  if(body.treatment==="mortgage_payment"&&category!==null&&category!=="mortgage_payment")throw new HttpError(400,"Mortgage payment classification needs the Mortgage payment category.");
  if(body.treatment!=="mortgage_payment"&&body.mortgage_split!==undefined&&body.mortgage_split!==null)throw new HttpError(400,"Mortgage splits belong only to mortgage payment classifications.");
  if (body.reviewed !== undefined && typeof body.reviewed !== "boolean") throw new HttpError(400, "Invalid review state.");
  const { data: tx, error: txError } = await db.from("finance_effective_transactions").select("transaction_id,canonical_account_id,amount,pending,effective_type,household_id,effective_transaction_date").eq("household_id", householdId).eq("transaction_id", transactionId).maybeSingle();
  check(txError); if (!tx) throw new HttpError(404, "Transaction is not available in this household.");
  const {data:existing,error:existingError}=await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,category,notes,reviewed,deposit_applications,deposit_received_transaction_id,deposit_received_allocation_id,mortgage_split,updated_at").eq("household_id",householdId).eq("transaction_id",transactionId).maybeSingle();check(existingError);
  if(body.ask_scope_guard===true){const selection=await getSavedRentalSelection(db,userId,householdId);if(!sameScope(body.expected_scope,selection.scope)||!samePeriod(body.expected_period,selection.period))throw new HttpError(409,"Rental account scope or period changed after this proposal. Search and review the transactions again.");if(!selection.scope.canonical_account_ids.includes(tx.canonical_account_id))throw new HttpError(404,"Transaction is no longer within the saved Rental P&L account scope.");if((existing?.updated_at??null)!==(body.expected_classification_updated_at??null))throw new HttpError(409,"Rental classification changed after this proposal. Review it again.");const expected=body.expected_transaction;if(!record(expected)||expected.canonical_account_id!==tx.canonical_account_id||expected.date!==tx.effective_transaction_date||Number(expected.amount)!==Number(tx.amount))throw new HttpError(409,"Transaction changed after this proposal. Review it again.");}
  if(body.ask_scope_guard===true&&existing?.mortgage_split&&body.treatment!=="mortgage_payment"&&body.clear_mortgage_split!==true)throw new HttpError(409,"This transaction has mortgage split details. Confirm the split change in transaction detail.");
  if(body.ask_scope_guard===true&&(existing?.treatment?.startsWith("security_deposit")||existing?.deposit_received_transaction_id||(existing?.deposit_applications??[]).length)&&body.treatment!==existing.treatment)throw new HttpError(409,"This transaction has security-deposit details. Edit it in transaction detail.");
  let mortgageSplit:any=null;
  if(body.treatment==="mortgage_payment"){
    if(Number(tx.amount)<=0)throw new HttpError(400,"A mortgage payment split must match a positive bank outflow.");
    const result=validateMortgageSplit(body.mortgage_split===undefined?(existing?.mortgage_split??{}):body.mortgage_split,Number(tx.amount),body.reviewed===true);
    if(!result.valid)throw new HttpError(400,result.error||"Invalid mortgage split.");
    mortgageSplit=result.split;
  }
  const apps = body.deposit_applications===undefined?(existing?.deposit_applications??[]):validateApplications(body.deposit_applications);
  const linkedReceipt = body.deposit_received_transaction_id === undefined ? existing?.deposit_received_transaction_id??null : body.deposit_received_transaction_id === null || body.deposit_received_transaction_id === "" ? null : requiredText(body.deposit_received_transaction_id, 200);
  if (body.treatment === "security_deposit_received" || body.treatment === "security_deposit_applied") {
    if (Number(tx.amount) >= 0 || apps.reduce((sum, app) => sum + app.amount, 0) > Math.abs(Number(tx.amount)) + .005) throw new HttpError(400, "A security deposit receipt must be a money-in transaction, and applications cannot exceed the deposit.");
    if (body.treatment === "security_deposit_applied" && !apps.length) throw new HttpError(400, "Add at least one application amount before marking a deposit applied.");
    if (apps.some(app => app.date < String(tx.effective_transaction_date))) throw new HttpError(400, "A deposit cannot be applied before it was received.");
    const { data: oldReceiptClass, error: oldReceiptError } = await db.from("finance_rental_transaction_classifications").select("transaction_id").eq("household_id", householdId).eq("treatment", "security_deposit_returned").eq("deposit_received_transaction_id", transactionId);
    check(oldReceiptError);
    const returnIds=(oldReceiptClass??[]).map((r:Row)=>r.transaction_id).filter((id:string)=>id!==transactionId);
    let returnedTotal=0;
    for(let i=0;i<returnIds.length;i+=500){const {data,error}=await db.from("finance_effective_transactions").select("amount").eq("household_id",householdId).in("transaction_id",returnIds.slice(i,i+500));check(error);returnedTotal+=(data??[]).reduce((sum:number,r:Row)=>sum+Number(r.amount),0);}
    if(returnedTotal+apps.reduce((sum,app)=>sum+app.amount,0)>Math.abs(Number(tx.amount))+.005)throw new HttpError(400,"Returns and applications cannot exceed the original deposit.");
  }
  if (body.treatment === "security_deposit_returned") {
    if (Number(tx.amount) <= 0 || !linkedReceipt) throw new HttpError(400, "A deposit return must be a money-out transaction linked to its original receipt.");
    const { data: receipt, error } = await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,deposit_applications").eq("household_id", householdId).eq("transaction_id", linkedReceipt).maybeSingle();
    check(error); if (!receipt || !["security_deposit_received","security_deposit_applied"].includes(receipt.treatment)) throw new HttpError(400, "The linked receipt is not a classified security deposit.");
    const { data: receiptTx, error: receiptTxError } = await db.from("finance_effective_transactions").select("amount,canonical_account_id").eq("household_id", householdId).eq("transaction_id", linkedReceipt).maybeSingle();
    check(receiptTxError); if (!receiptTx || receiptTx.canonical_account_id !== tx.canonical_account_id) throw new HttpError(400, "The linked deposit must belong to the same canonical account.");
    const { data: priorReturns, error: priorReturnsError } = await db.from("finance_rental_transaction_classifications").select("transaction_id").eq("household_id", householdId).eq("treatment", "security_deposit_returned").eq("deposit_received_transaction_id", linkedReceipt);
    check(priorReturnsError);
    const priorIds = (priorReturns ?? []).map((r: Row) => r.transaction_id).filter((id: string) => id !== transactionId);
    let priorTotal = 0;
    for (let i=0;i<priorIds.length;i+=500) { const {data,error}=await db.from("finance_effective_transactions").select("amount").eq("household_id",householdId).in("transaction_id",priorIds.slice(i,i+500));check(error);priorTotal+=(data??[]).reduce((sum:number,r:Row)=>sum+Number(r.amount),0); }
    if (priorTotal + Number(tx.amount) + (receipt.deposit_applications ?? []).reduce((sum:number,app:Row)=>sum+Number(app.amount),0) > Math.abs(Number(receiptTx.amount)) + .005) throw new HttpError(400, "Returns and applications cannot exceed the original deposit.");
  }
  const row = { household_id: householdId, transaction_id: transactionId, treatment: body.treatment, category, notes: body.notes===undefined?existing?.notes??null:text(body.notes, 1000), reviewed: body.reviewed===undefined?existing?.reviewed===true:body.reviewed===true, deposit_applications: apps, deposit_received_transaction_id: linkedReceipt, deposit_received_allocation_id: null, mortgage_split:mortgageSplit, updated_by: userId, updated_at: new Date().toISOString() };
  const { error } = await db.from("finance_rental_transaction_classifications").upsert(row, { onConflict: "household_id,transaction_id" }); check(error);
  return json({ classification: row });
}
async function saveClassificationAtomic(db: any, userId: string, householdId: string, body: Row) {
  await requireParentRentalRows(db,userId,householdId,[requiredText(body.transaction_id,200)]);
  if (body.confirm !== true) throw new HttpError(400, "Confirm the rental classification change before saving.");
  const transactionId = requiredText(body.transaction_id, 200);
  if(!["category","notes","reviewed","deposit_applications","deposit_received_transaction_id","mortgage_split","expected_classification_updated_at","expected_transaction","idempotency_key"].every(key=>Object.prototype.hasOwnProperty.call(body,key)))throw new HttpError(400,"Reviewed save requires a complete transaction snapshot and classification payload.");
  if (!treatments.has(body.treatment)) throw new HttpError(400, "Choose a rental treatment.");
  const category = body.category === null || body.category === undefined || body.category === "" ? null : requiredText(body.category, 64);
  if (category && !categoryKeys.has(category)) throw new HttpError(400, "Choose a supported rental category.");
  if (body.treatment === "rental_income" && !["rent","late_fees","other_rental_income"].includes(category ?? "")) throw new HttpError(400, "Rental income needs an income category.");
  if (body.treatment === "operating_expense" && !["advertising","cleaning_maintenance","insurance","legal_professional","management_fees","mortgage_interest","repairs","supplies","property_taxes","utilities","hoa","other"].includes(category ?? "")) throw new HttpError(400, "Operating expenses need an expense category.");
  if(body.treatment==="mortgage_payment"&&category!==null&&category!=="mortgage_payment")throw new HttpError(400,"Mortgage payment classification needs the Mortgage payment category.");
  if(body.treatment!=="mortgage_payment"&&body.mortgage_split!==undefined&&body.mortgage_split!==null)throw new HttpError(400,"Mortgage splits belong only to mortgage payment classifications.");
  if (typeof body.reviewed !== "boolean") throw new HttpError(400, "Invalid review state.");
  const idempotencyKey=requiredText(body.idempotency_key,128);
  if(!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey))throw new HttpError(400,"Provide a stable idempotency key for this reviewed save.");
  if(body.expected_classification_updated_at===undefined)throw new HttpError(400,"Review the current rental classification version before saving.");
  if(body.ask_scope_guard===true)throw new HttpError(409,"Saved Rental P&L scope confirmation is not included in this reviewed atomic action. Review the transaction again in the current scope.");
  const expectedTransaction=body.expected_transaction;
  const replayArgs={p_household_id:householdId,p_actor_id:userId,p_transaction_id:transactionId,p_request:body,p_idempotency_key:idempotencyKey};
  const {data:replay,error:replayError}=await db.rpc("finance_folio2_replay_rental_classification",replayArgs);check(replayError);
  if(replay?.ok===false)throw new HttpError(replay.status===403?403:replay.status===409?409:503,replay.error||"Could not confirm the reviewed rental save.");if(replay?.found===true)return json({classification:replay.classification,idempotent_replay:true});
  const { data: tx, error: txError } = await db.from("finance_effective_transactions").select("transaction_id,canonical_account_id,amount,pending,effective_type,household_id,effective_transaction_date,iso_currency_code,pending_transaction_id,effective_merchant_name,name,original_description,effective_category,refund_status,refund_relationship_type,refund_original_transaction_id").eq("household_id", householdId).eq("transaction_id", transactionId).maybeSingle();
  check(txError); if (!tx) throw new HttpError(404, "Transaction is not available in this household.");
  let pendingSuccessor:Row|null=null;
  if(tx.pending===true){const {data:successorId,error:successorIdError}=await db.rpc("finance_folio2_resolve_pending_successor",{p_household_id:householdId,p_transaction_id:transactionId});check(successorIdError);if(successorId){const {data:successor,error:successorError}=await db.from("finance_effective_transactions").select("transaction_id,canonical_account_id,amount,pending,effective_transaction_date,iso_currency_code").eq("household_id",householdId).eq("transaction_id",successorId).maybeSingle();check(successorError);if(successor)pendingSuccessor={transaction_id:successor.transaction_id,canonical_account_id:successor.canonical_account_id,amount:Number(successor.amount),date:successor.effective_transaction_date,currency:String(successor.iso_currency_code||"USD").toUpperCase(),pending:successor.pending===true};}}
  const currentEvidence={canonical_account_id:tx.canonical_account_id,date:tx.effective_transaction_date,amount:Number(tx.amount),currency:String(tx.iso_currency_code||"USD").toUpperCase(),pending:tx.pending===true,pending_transaction_id:tx.pending_transaction_id??null,pending_successor:pendingSuccessor,merchant:String(tx.effective_merchant_name||tx.name||"Transaction"),description:String(tx.original_description||tx.name||""),effective_category:tx.effective_category??null,effective_type:tx.effective_type??null,refund_status:tx.refund_status??null,refund_relationship_type:tx.refund_relationship_type??null,refund_original_transaction_id:tx.refund_original_transaction_id??null};
  if(!record(expectedTransaction)||stableJson(expectedTransaction)!==stableJson(currentEvidence))throw new HttpError(409,"Transaction evidence changed after review. Review it again.");
  const {data:existing,error:existingError}=await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,category,notes,reviewed,deposit_applications,deposit_received_transaction_id,deposit_received_allocation_id,mortgage_split,updated_at").eq("household_id",householdId).eq("transaction_id",transactionId).maybeSingle();check(existingError);
  if(body.ask_scope_guard===true){const selection=await getSavedRentalSelection(db,userId,householdId);if(!sameScope(body.expected_scope,selection.scope)||!samePeriod(body.expected_period,selection.period))throw new HttpError(409,"Rental account scope or period changed after this proposal. Search and review the transactions again.");if(!selection.scope.canonical_account_ids.includes(tx.canonical_account_id))throw new HttpError(404,"Transaction is no longer within the saved Rental P&L account scope.");const expected=body.expected_transaction;if(!record(expected)||expected.canonical_account_id!==tx.canonical_account_id||expected.date!==tx.effective_transaction_date||Number(expected.amount)!==Number(tx.amount))throw new HttpError(409,"Transaction changed after this proposal. Review it again.");}
  if(body.ask_scope_guard===true&&existing?.mortgage_split&&body.treatment!=="mortgage_payment"&&body.clear_mortgage_split!==true)throw new HttpError(409,"This transaction has mortgage split details. Confirm the split change in transaction detail.");
  if(body.ask_scope_guard===true&&(existing?.treatment?.startsWith("security_deposit")||existing?.deposit_received_transaction_id||(existing?.deposit_applications??[]).length)&&body.treatment!==existing.treatment)throw new HttpError(409,"This transaction has security-deposit details. Edit it in transaction detail.");
  let mortgageSplit:any=null;
  if(body.treatment==="mortgage_payment"){
    if(Number(tx.amount)<=0)throw new HttpError(400,"A mortgage payment split must match a positive bank outflow.");
    const result=validateMortgageSplit(body.mortgage_split,Number(tx.amount),body.reviewed===true);
    if(!result.valid)throw new HttpError(400,result.error||"Invalid mortgage split.");
    mortgageSplit=result.split;
  }
  const apps = validateApplications(body.deposit_applications);
  const linkedReceipt = body.deposit_received_transaction_id === null || body.deposit_received_transaction_id === "" ? null : requiredText(body.deposit_received_transaction_id, 200);
  const linkedAllocation = body.deposit_received_allocation_id === null || body.deposit_received_allocation_id === undefined || body.deposit_received_allocation_id === "" ? null : body.deposit_received_allocation_id;
  if (linkedAllocation !== null && (!uuid(linkedAllocation) || body.treatment !== "security_deposit_returned" || !linkedReceipt)) throw new HttpError(400, "Choose a valid receipt allocation for a deposit return.");
  if (linkedAllocation !== null) {
    const revision=requiredText(body.expected_deposit_received_allocation_revision,256);
    const cents=Number(body.expected_deposit_received_allocation_amount_cents);
    if (!revision || !Number.isSafeInteger(cents) || cents >= 0) throw new HttpError(400, "Review the current receipt allocation before confirming.");
  }
  if (body.treatment === "security_deposit_received" || body.treatment === "security_deposit_applied") {
    if (Number(tx.amount) >= 0 || apps.reduce((sum, app) => sum + app.amount, 0) > Math.abs(Number(tx.amount)) + .005) throw new HttpError(400, "A security deposit receipt must be a money-in transaction, and applications cannot exceed the deposit.");
    if (body.treatment === "security_deposit_applied" && !apps.length) throw new HttpError(400, "Add at least one application amount before marking a deposit applied.");
    if (apps.some(app => app.date < String(tx.effective_transaction_date))) throw new HttpError(400, "A deposit cannot be applied before it was received.");
    const { data: oldReceiptClass, error: oldReceiptError } = await db.from("finance_rental_transaction_classifications").select("transaction_id").eq("household_id", householdId).eq("treatment", "security_deposit_returned").eq("deposit_received_transaction_id", transactionId);
    check(oldReceiptError);
    const returnIds=(oldReceiptClass??[]).map((r:Row)=>r.transaction_id).filter((id:string)=>id!==transactionId);
    let returnedTotal=0;
    for(let i=0;i<returnIds.length;i+=500){const {data,error}=await db.from("finance_effective_transactions").select("amount").eq("household_id",householdId).in("transaction_id",returnIds.slice(i,i+500));check(error);returnedTotal+=(data??[]).reduce((sum:number,r:Row)=>sum+Number(r.amount),0);}
    if(returnedTotal+apps.reduce((sum,app)=>sum+app.amount,0)>Math.abs(Number(tx.amount))+.005)throw new HttpError(400,"Returns and applications cannot exceed the original deposit.");
  }
  if (body.treatment === "security_deposit_returned") {
    if (Number(tx.amount) <= 0 || !linkedReceipt) throw new HttpError(400, "A deposit return must be a money-out transaction linked to its original receipt.");
    if (linkedAllocation === null) {
      const { data: receipt, error } = await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,deposit_applications").eq("household_id", householdId).eq("transaction_id", linkedReceipt).maybeSingle();
      check(error); if (!receipt || !["security_deposit_received","security_deposit_applied"].includes(receipt.treatment)) throw new HttpError(400, "The linked deposit is not a classified receipt.");
      const { data: receiptTx, error: receiptTxError } = await db.from("finance_effective_transactions").select("amount,canonical_account_id").eq("household_id", householdId).eq("transaction_id", linkedReceipt).maybeSingle();
      check(receiptTxError); if (!receiptTx || receiptTx.canonical_account_id !== tx.canonical_account_id) throw new HttpError(400, "The linked deposit must belong to the same canonical account.");
      const { data: priorReturns, error: priorReturnsError } = await db.from("finance_rental_transaction_classifications").select("transaction_id").eq("household_id", householdId).eq("treatment", "security_deposit_returned").eq("deposit_received_transaction_id", linkedReceipt);
      check(priorReturnsError);
      const priorIds = (priorReturns ?? []).map((r: Row) => r.transaction_id).filter((id: string) => id !== transactionId);
      let priorTotal = 0;
      for (let i=0;i<priorIds.length;i+=500) { const {data,error}=await db.from("finance_effective_transactions").select("amount").eq("household_id",householdId).in("transaction_id",priorIds.slice(i,i+500));check(error);priorTotal+=(data??[]).reduce((sum:number,r:Row)=>sum+Number(r.amount),0); }
      if (priorTotal + Number(tx.amount) + (receipt.deposit_applications ?? []).reduce((sum:number,app:Row)=>sum+Number(app.amount),0) > Math.abs(Number(receiptTx.amount)) + .005) throw new HttpError(400, "Returns and applications cannot exceed the original deposit.");
    }
  }
  const payload={treatment:body.treatment,category,notes:text(body.notes,1000),reviewed:body.reviewed,deposit_applications:apps,deposit_received_transaction_id:linkedReceipt,deposit_received_allocation_id:linkedAllocation,mortgage_split:mortgageSplit};
  const {data,error}=await db.rpc("finance_folio2_save_rental_classification_with_allocation",{p_household_id:householdId,p_actor_id:userId,p_transaction_id:transactionId,p_payload:payload,p_request:body,p_expected_evidence:expectedTransaction,p_expected_updated_at:body.expected_classification_updated_at??null,p_idempotency_key:idempotencyKey});
  if(error){const code=String(error.code||"");if(code==="40001")throw new HttpError(409,"The reviewed transaction or receipt allocation changed. Review it again.");if(code==="23514"||code==="22023")throw new HttpError(400,error.message||"The receipt allocation is unavailable.");if(code==="55P03")throw new HttpError(503,"The deposit is being updated. Retry the exact reviewed save.");check(error);} if(!data||data.ok!==true)throw new HttpError(data?.status===403?403:data?.status===409?409:data?.status===400?400:data?.status===503?503:500,data?.error||"Could not save reviewed rental classification.");
  return json({classification:data.classification,idempotent_replay:data.idempotent_replay===true});
}
async function getReport(db: any, userId: string, householdId: string, body: Row) {
  let scope: any = body.scope, periodInput: any = body.period, taxYear: number | undefined = body.tax_year;
  if (!scope || !periodInput) {
    const { data, error } = await db.from("finance_rental_reporting_preferences").select("selected_scope,period_type,period_start,period_end,tax_year").eq("user_id", userId).eq("household_id", householdId).maybeSingle();
    check(error); if (!data) return json({ selection_required: true, report: null });
    scope ??= data.selected_scope; periodInput ??= { type: data.period_type, start_date: data.period_start, end_date: data.period_end }; taxYear ??= data.tax_year;
  }
  scope = parseScope(scope); periodInput = parsePeriod(periodInput); taxYear = int(taxYear, Number(periodInput.end_date.slice(0, 4)), 1900, 9999);
  await validateScope(db, householdId, scope);
  const includePending = body.include_pending === true;
  const yearStart = `${taxYear}-01-01`, yearEnd = `${taxYear}-12-31`;
  const from = periodInput.start_date < yearStart ? periodInput.start_date : yearStart;
  const through = periodInput.end_date > yearEnd ? periodInput.end_date : yearEnd;
  let rows: Row[] = [], cursor = "";
  while (true) {
    let query = db.from("finance_effective_transactions").select(txFields).eq("household_id", householdId).in("canonical_account_id", scope.canonical_account_ids).gte("effective_transaction_date", from).lte("effective_transaction_date", through).order("transaction_id").limit(500);
    if (cursor) query = query.gt("transaction_id", cursor);
    if (!includePending) query = query.eq("pending", false);
    const { data, error } = await query; check(error); if (!data?.length) break; rows.push(...data); cursor = data[data.length - 1].transaction_id;
    if (rows.length > MAX_ROWS) throw new HttpError(422, "This report covers too many transactions. Choose a narrower date range.");
  }
  // Historical security-deposit receipts are loaded by their classification IDs alone,
  // so opening liability coverage never requires reading the full ledger history.
  const allClasses: Row[] = []; for (let offset=0; ;offset+=1000) { const { data, error } = await db.from("finance_rental_transaction_classifications").select("transaction_id,treatment,category,notes,reviewed,deposit_applications,deposit_received_transaction_id,deposit_received_allocation_id,mortgage_split,household_id").eq("household_id", householdId).order("transaction_id").range(offset,offset+999); check(error); allClasses.push(...(data??[])); if (!data?.length || data.length<1000) break; if (allClasses.length>MAX_ROWS) throw new HttpError(422,"Too many rental classifications to summarize."); }
  const classes = (allClasses ?? []) as RentalClassification[];
  const historicIds = classes.filter(c => ["security_deposit_received","security_deposit_applied","security_deposit_returned"].includes(c.treatment)).map(c => c.transaction_id).filter(id => !rows.some(row => row.transaction_id === id));
  const childHistory=await db.rpc("finance_rental_child_history",{p_household:householdId,p_actor:userId});if(childHistory.error)throw childRpcError(childHistory.error,false);if(childHistory.data?.household_id!==householdId||childHistory.data?.actor_user_id!==userId||!Array.isArray(childHistory.data?.transaction_ids))throw new HttpError(503,"Rental lifecycle history unavailable.");
  for(const id of childHistory.data.transaction_ids){if(typeof id!=="string")throw new HttpError(503,"Invalid Rental lifecycle identity.");if(!historicIds.includes(id)&&!rows.some(row=>row.transaction_id===id))historicIds.push(id);}
  for (let i = 0; i < historicIds.length; i += 500) {
    const { data, error } = await db.from("finance_effective_transactions").select(txFields).eq("household_id", householdId).in("canonical_account_id", scope.canonical_account_ids).in("transaction_id", historicIds.slice(i, i + 500));
    check(error); rows.push(...(data ?? []));
  }
  const transactions = rows.map(row => ({ ...row, household_id: householdId, transaction_source_enabled: true })) as RentalTransaction[];
  const childEvidence=await loadRentalChildEvidence(db,userId,householdId,transactions.map(t=>t.transaction_id));
  const report = buildAllocationAwareRentalReport({ household_id: householdId, scope, period: periodInput, transactions, classifications: classes, include_pending: includePending, tax_year: taxYear },childEvidence);
  if (body.include_transactions === true) {
    const { data: accountRows, error: accountError } = await db.from("finance_household_accounts").select("canonical_account_id,name,official_name,mask").eq("household_id", householdId).in("canonical_account_id", scope.canonical_account_ids);
    check(accountError);
    const accountNames = Object.fromEntries((accountRows ?? []).map((a: Row) => [a.canonical_account_id, `${a.official_name || a.name}${a.mask ? ` ••••${a.mask}` : ""}`]));
    return json({ report, csv_text: buildAllocationAwareRentalCsv(report, accountNames) });
  }
  // Keep model tool responses compact and prevent raw transaction payload truncation.
  const details = new Map(report.transactions.map(tx => [tx.transaction_id, tx]));
  const reviewExamples = report.review.transaction_ids.slice(0, 6).flatMap(id => { const tx = details.get(id); return tx ? [{ merchant: tx.effective_merchant_name ?? tx.name ?? "Transaction", date: tx.effective_transaction_date, amount: tx.amount, treatment: tx.rental_treatment ?? "needs_review", reason: tx.rental_treatment === "needs_review" ? "Rental treatment needs review" : !tx.rental_reviewed ? "Classification is not confirmed" : "Review the transaction classification" }] : []; });
  const compactCategories = (rows: any[]) => rows.map(({ transaction_ids: _ids, ...row }) => row);
  const { transaction_ids: _depositIds, opening_breakdown: _openingBreakdown, received_breakdown: _receivedBreakdown, returned_breakdown: _returnedBreakdown, applied_breakdown: _appliedBreakdown, ending_breakdown: _endingBreakdown, ...compactDeposits } = report.security_deposits;
  const compact = { ...report, transactions: undefined, income_categories: compactCategories(report.income_categories), expense_categories: compactCategories(report.expense_categories), cash_flow_categories: compactCategories(report.cash_flow_categories), non_pnl_categories: compactCategories(report.non_pnl_categories), review: { count: report.review.count, amount: report.review.amount, examples: reviewExamples, examples_truncated: report.review.count > reviewExamples.length }, mortgage_review:{count:report.mortgage_review.count,amount:report.mortgage_review.amount}, tax_summary: { tax_year: report.tax_summary.tax_year, categories: compactCategories(report.tax_summary.categories), complete:report.tax_summary.complete, mortgage_review:{count:report.tax_summary.mortgage_review.count,amount:report.tax_summary.mortgage_review.amount} }, year_end_readiness: { ...report.year_end_readiness, transaction_ids: undefined }, security_deposits: compactDeposits, scope, generated_at: new Date().toISOString() };
  return json({ report: compact });
}

async function validateScope(db: any, householdId: string, scope: ReportingScope) {
  const { data, error } = await db.from("finance_household_accounts").select("canonical_account_id,lifecycle_status").eq("household_id", householdId).in("canonical_account_id", scope.canonical_account_ids).limit(501);
  check(error); const available = new Set((data ?? []).filter((a: Row) => !["deleted","removed"].includes(a.lifecycle_status)).map((a: Row) => a.canonical_account_id));
  if (scope.canonical_account_ids.some(id => !available.has(id))) throw new HttpError(409, "The selected reporting account is no longer available. Choose an account to continue.");
}
function parseScope(value: unknown): ReportingScope {
  if (!record(value) || !["account","account_group"].includes(value.type) || !Array.isArray(value.canonical_account_ids) || value.canonical_account_ids.length < 1 || value.canonical_account_ids.length > 50 || value.canonical_account_ids.some((id: unknown) => typeof id !== "string" || !id.trim() || id.length > 200) || new Set(value.canonical_account_ids).size !== value.canonical_account_ids.length) throw new HttpError(400, "Choose an available canonical reporting account.");
  if (value.type === "account" && value.canonical_account_ids.length !== 1) throw new HttpError(400, "An account scope contains exactly one account.");
  return { type: value.type, canonical_account_ids: value.canonical_account_ids };
}
function parsePeriod(value: unknown): RentalPeriod {
  if (!record(value) || !["month","quarter","year","custom"].includes(value.type)) throw new HttpError(400, "Choose a reporting period.");
  const start_date = date(value.start_date), end_date = date(value.end_date); if (start_date > end_date) throw new HttpError(400, "Period start must be on or before its end.");
  return { type: value.type, start_date, end_date, label: text(value.label, 80) ?? undefined };
}
function validateApplications(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, "Invalid deposit applications.");
  const apps = value.map((item: unknown) => {
    if (!record(item) || typeof item.application_id !== "string" || !item.application_id.trim() || !Number.isFinite(item.amount) || item.amount <= 0 || !["unpaid_rent","repairs_damage","cleaning","other"].includes(item.reason) || !["rent","late_fees","other_rental_income"].includes(item.category)) throw new HttpError(400, "Each deposit application needs an amount, date, reason, and reporting category.");
    return { application_id: item.application_id.slice(0, 100), date: date(item.date), amount: Math.round(item.amount * 100) / 100, reason: item.reason, category: item.category };
  });
  if (new Set(apps.map((app: Row) => app.application_id)).size !== apps.length) throw new HttpError(400, "Deposit application IDs must be unique.");
  return apps;
}
function date(value: unknown): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "Dates must be valid YYYY-MM-DD calendar dates."); const stamp = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10) !== value) throw new HttpError(400, "Dates must be valid YYYY-MM-DD calendar dates."); return value; }
function int(value: unknown, fallback: number, min: number, max: number): number { if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new HttpError(400, "Invalid tax year."); return value; }
function finiteAmount(value:unknown):number{if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new HttpError(400,"Amounts must be nonnegative numbers.");return value;}
function sameScope(value:unknown,scope:ReportingScope):boolean{if(!record(value)||value.type!==scope.type||!Array.isArray(value.canonical_account_ids)||value.canonical_account_ids.length!==scope.canonical_account_ids.length)return false;return scope.canonical_account_ids.every((id,index)=>value.canonical_account_ids[index]===id);}
function samePeriod(value:unknown,period:RentalPeriod):boolean{return record(value)&&value.type===period.type&&value.start_date===period.start_date&&value.end_date===period.end_date;}
function requiredText(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, "Invalid input."); return value.trim(); }
function text(value: unknown, max: number): string | null { if (value === undefined || value === null || value === "") return null; return requiredText(value, max); }
function record(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function required(name: string) { const value = Deno.env.get(name); if (!value) throw new HttpError(500, "Server configuration is incomplete."); return value; }
function check(error: unknown) { if (error) {const code=String((error as Row)?.code||"");if(code==="42501")throw new HttpError(403,"No access to this household.");if(["55P03","40001","57014","25001"].includes(code))throw new HttpError(409,"Rental data is being updated. Review the transaction and retry.");if(code==="23514")throw new HttpError(409,"Rental transaction evidence or deposit links changed. Review the transaction again.");throw new HttpError(503,"Could not read or save rental report data.");} }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }

function uuid(value:unknown):value is string{return typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
function childRpcError(error:Row,write:boolean){const code=String(error?.code||"");if(code==="42501")return new HttpError(403,"Household access denied.");if(code==="40001"||code==="23505")return new HttpError(409,"Rental allocation changed. Review again.");if(code.startsWith("22")||code==="23514")return new HttpError(400,"Invalid Rental child classification.");return new HttpError(503,write?"Child save outcome unknown. Retry the exact request.":"Rental allocation evidence unavailable.");}
async function loadRentalChildEvidence(db:any,userId:string,householdId:string,ids:string[]):Promise<ParentEvidence[]>{
 const unique=[...new Set(ids)],rows:ParentEvidence[]=[];for(let i=0;i<unique.length;i+=500){const requested=unique.slice(i,i+500);const {data,error}=await db.rpc("finance_read_rental_children",{p_household:householdId,p_actor:userId,p_transactions:requested});if(error)throw childRpcError(error,false);if(!data||data.household_id!==householdId||data.actor_user_id!==userId||!Array.isArray(data.rows)||data.rows.length!==requested.length||new Set(data.rows.map((r:Row)=>r.transaction_id)).size!==requested.length||data.rows.some((r:Row)=>!requested.includes(r.transaction_id)||!["passthrough","available","unavailable"].includes(r.split_status)||!Array.isArray(r.children)))throw new HttpError(503,"Complete Rental allocation coverage unavailable.");rows.push(...data.rows);}return rows;
}

async function requireParentRentalRows(db:any,userId:string,householdId:string,ids:string[]){const rows=await loadRentalChildEvidence(db,userId,householdId,ids);if(rows.some(row=>row.split_status!=="passthrough"))throw new HttpError(409,"Review each split allocation in transaction detail before changing its Rental classification.");}

