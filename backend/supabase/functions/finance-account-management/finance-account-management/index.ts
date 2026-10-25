import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { resolvePlaidAccessToken } from "../_shared/plaid-access-token.ts";
import { currentSessionActive } from "../_shared/current-session.ts";
import { createClient } from "jsr:@supabase/supabase-js@2"

type Row = Record<string, any>
class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
const options = { auth: { persistSession: false, autoRefreshToken: false } }

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return json({}, 204)
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
  try {
    const authorization = request.headers.get("authorization")
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Sign in required.")
    const auth = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), options)
    const { data: identity, error: authError } = await auth.auth.getUser(authorization.slice(7))
    if (authError || !identity.user) throw new HttpError(401, "Sign in required.")
    if (!await currentSessionActive(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), authorization)) throw new HttpError(401, "Sign in required.");
    const body = await request.json().catch(() => null)
    if (!isRecord(body)) throw new HttpError(400, "Expected a JSON object.")

    const action = text(body.action, "action", 40)
    const allowed = new Set(["list", "detail", "save_manual", "save_manual_atomic", "review_status", "confirm_status", "set_status", "delete", "create_link_token", "exchange_public_token", "complete_hosted_link", "resolve_duplicate", "history_batch"])
    if (!allowed.has(action)) throw new HttpError(400, "Invalid action.")
    const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), options)
    const { householdId, role } = await membership(db, identity.user.id, optionalText(body.household_id, 36))

    if (action === "list") return json(await listAccounts(db, householdId, body.include_closed === true))
    if (action === "detail") { const detail=await accountDetail(db, householdId, body, identity.user.id); return json({...detail, account:{...detail.account, management_permission:{user_id:identity.user.id,household_id:householdId,owner:role==="owner"}}}); }
    if (action === "history_batch") return json(await accountHistoryBatch(db, householdId, body));
    if (action === "save_manual_atomic") return json(await saveManualAtomic(db, householdId, identity.user.id, body))
    if (action === "save_manual") return json(await saveManual(db, householdId, identity.user.id, body))
    if (action === "review_status" || action === "confirm_status") { requireOwner(role); return json(await reviewedStatus(db, householdId, identity.user.id, body)); }
    if (action === "set_status") {
      requireOwner(role)
      return json(await setStatus(db, householdId, identity.user.id, body))
    }
    if (action === "delete") {
      requireOwner(role)
      if (body.confirm_permanent !== true) throw new HttpError(400, "Permanent deletion requires explicit confirmation.")
      return json(await deleteAccount(db, householdId, identity.user.id, body))
    }
    if (action === "create_link_token") return json(await createLinkToken(db, householdId, identity.user.id, body))
    if (action === "complete_hosted_link") return json(await completeHostedLink(db, householdId, identity.user.id, body))
    if (action === "resolve_duplicate") {
      requireOwner(role)
      return json(await resolveDuplicate(db, householdId, identity.user.id, body))
    }
    return json(await exchangePublicToken(db, householdId, identity.user.id, body))
  } catch (error) {
    console.error("Account management failed", error instanceof Error ? error.message : error)
    return json({ error: error instanceof HttpError ? error.message : "Could not manage household accounts." }, error instanceof HttpError ? error.status : 500)
  }
})

async function membership(db: any, userId: string, householdInput?: string) {
  let query = db.from("finance_household_members").select("household_id,role").eq("user_id", userId)
  if (householdInput) query = query.eq("household_id", householdInput)
  const { data, error } = await query.limit(2)
  check(error)
  if (!data?.length) throw new HttpError(403, "No access to this household.")
  if (data.length !== 1) throw new HttpError(400, "Select a household using household_id.")
  return { householdId: data[0].household_id as string, role: data[0].role as string }
}

async function listAccounts(db: any, householdId: string, includeClosed: boolean) {
  const { data: items, error: itemError } = await db.from("plaid_items")
    .select("item_id,institution_id,institution_name,institution_logo,institution_primary_color,institution_url,connection_status,connection_error_code,last_sync_attempt_at,last_successful_sync_at")
    .eq("household_id", householdId)
  check(itemError)
  const itemMap = new Map((items ?? []).map((item: Row) => [item.item_id, item]))
  let linkedQuery = db.from("finance_household_accounts").select("canonical_account_id,account_id,item_id,name,official_name,mask,type,subtype,current_balance,available_balance,credit_limit,balance_currency_code,balance_updated_at,lifecycle_status,closed_at,updated_at,persistent_account_id,match_method,match_confidence,source_count")
    .eq("household_id", householdId)
  if (!includeClosed) linkedQuery = linkedQuery.eq("lifecycle_status", "active")
  const { data: linked, error: linkedError } = await linkedQuery.order("name")
  check(linkedError)
  let manualQuery = db.from("finance_manual_accounts").select("*").eq("household_id", householdId)
  if (!includeClosed) manualQuery = manualQuery.eq("lifecycle_status", "active")
  const { data: manual, error: manualError } = await manualQuery.order("name")
  check(manualError)
  const { data: manualRelationships, error: manualRelationshipError } = await db.from("finance_manual_account_relationships")
    .select("household_id,asset_manual_account_id,debt_manual_account_id").eq("household_id", householdId)
  check(manualRelationshipError)
  const linkedDebtIds = [...new Set((manualRelationships ?? []).map((row: Row) => row.debt_manual_account_id))]
  const { data: linkedDebtRows, error: linkedDebtError } = linkedDebtIds.length
    ? await db.from("finance_manual_accounts").select("manual_account_id,version,current_value,currency_code,lifecycle_status,name").eq("household_id", householdId).in("manual_account_id", linkedDebtIds)
    : { data: [], error: null }
  check(linkedDebtError)
  const linkedDebtByAsset = new Map((manualRelationships ?? []).map((row: Row) => [row.asset_manual_account_id, row.debt_manual_account_id]))
  const linkedAssetByDebt = new Map((manualRelationships ?? []).map((row: Row) => [row.debt_manual_account_id, row.asset_manual_account_id]))
  const linkedDebtById = new Map((linkedDebtRows ?? []).map((row: Row) => [row.manual_account_id, row]))
  const { data: candidates, error: candidateError } = await db.from("finance_account_match_candidates")
    .select("candidate_id,source_account_id_a,source_account_id_b,confidence,match_reason")
    .eq("household_id", householdId).eq("status", "pending").order("created_at")
  check(candidateError)
  const candidateSourceIds = [...new Set((candidates ?? []).flatMap((row: Row) => [row.source_account_id_a, row.source_account_id_b]))]
  const { data: candidateSources, error: candidateSourceError } = candidateSourceIds.length
    ? await db.from("plaid_accounts").select("account_id,item_id,name,official_name,mask,type,subtype").in("account_id", candidateSourceIds)
    : { data: [], error: null }
  check(candidateSourceError)
  const candidateSourceMap = new Map((candidateSources ?? []).map((row: Row) => [row.account_id, row]))
  return {
    household_id: householdId,
    generated_at: new Date().toISOString(),
    accounts: [
      ...(linked ?? []).map((a: Row) => ({ ...a, account_kind: "plaid", asset_group: assetGroup(a.type), balance_status: a.balance_updated_at ? "current" : "unavailable", institution: itemMap.get(a.item_id) ?? null })),
      ...(manual ?? []).map((a: Row) => ({ ...a, account_id: a.manual_account_id, account_kind: "manual", type: a.account_class, subtype: a.asset_type, current_balance: a.current_value, balance_currency_code: a.currency_code, asset_group: a.account_class === "liability" ? "Liabilities" : "Manual assets", balance_status: "manual", ...(linkedDebtByAsset.has(a.manual_account_id) ? { linked_debt_account_id: linkedDebtByAsset.get(a.manual_account_id), linked_debt_summary: linkedDebtById.get(linkedDebtByAsset.get(a.manual_account_id)) ?? null } : {}), ...(linkedAssetByDebt.has(a.manual_account_id) ? { linked_asset_account_id: linkedAssetByDebt.get(a.manual_account_id) } : {}), institution: { institution_name: a.institution_name, connection_status: "manual" } })),
    ],
    duplicate_candidates: (candidates ?? []).map((candidate: Row) => ({
      ...candidate,
      account_a: candidateSourceMap.get(candidate.source_account_id_a) ?? null,
      account_b: candidateSourceMap.get(candidate.source_account_id_b) ?? null,
    })),
  }
}

function accountRecentSplitRows(rows: Row[], payload: unknown): Row[] {
  const evidence=Array.isArray(payload)?payload:[],counts=new Map<string,number>();
  for(const item of evidence)counts.set(String(item?.transaction_id),1+(counts.get(String(item?.transaction_id))??0));
  return rows.map(row=>{
    const found=evidence.find(item=>item?.transaction_id===row.transaction_id),children=found?.split_allocations;
    let status="unavailable";
    if(counts.get(String(row.transaction_id))===1&&found?.split_status==="passthrough"&&Array.isArray(children)&&children.length===0)status="passthrough";
    if(counts.get(String(row.transaction_id))===1&&found?.split_status==="available"&&Array.isArray(children)&&children.length>=2&&children.length<=40){
      const cents=Number(row.amount)*100,ids=new Set(),indexes=new Set();let total=0;
      const valid=Number.isSafeInteger(Math.round(cents))&&Math.abs(cents-Math.round(cents))<1e-6&&children.every((child:Row)=>{
        if(!isUuid(String(child.allocation_id||""))||ids.has(child.allocation_id)||!Number.isSafeInteger(child.allocation_index)||child.allocation_index<0||indexes.has(child.allocation_index)||child.allocation_status!=="split"||child.parent_transaction_id!==row.transaction_id||child.account_id!==row.account_id||child.canonical_account_id!==row.canonical_account_id||child.effective_transaction_date!==row.effective_transaction_date||child.currency_code!==row.iso_currency_code||child.pending!==row.pending||!Number.isSafeInteger(child.amount_cents)||(cents>0&&child.amount_cents<0)||(cents<0&&child.amount_cents>0))return false;
        ids.add(child.allocation_id);indexes.add(child.allocation_index);total+=child.amount_cents;return true;
      });
      if(valid&&total===Math.round(cents))status="available";
    }
    return {...row,split_status:status};
  });
}

async function accountHistoryBatch(db: any, householdId: string, body: Row) {
  const accounts = body.accounts
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 100) throw new HttpError(400, "accounts must contain between 1 and 100 account identities.")
  const start = dateValue(body.start_date), end = dateValue(body.end_date)
  if (!start || !end || start > end) throw new HttpError(400, "A valid start_date and end_date are required.")
  const requested: Row[] = [], keys = new Set<string>()
  for (const item of accounts) {
    if (!isRecord(item)) throw new HttpError(400, "Invalid account identity.")
    const id = text(item.account_id, "account_id", 200), kind = item.account_kind === "manual" ? "manual" : item.account_kind === "plaid" ? "plaid" : null
    const canonicalId = kind === "plaid" ? optionalText(item.canonical_account_id, 36) : undefined
    if (!kind || (canonicalId && !isUuid(canonicalId))) throw new HttpError(400, "Invalid account identity.")
    const key = `${kind}:${id}`
    if (keys.has(key)) throw new HttpError(400, "Account identities must be unique.")
    keys.add(key); requested.push({account_id:id,account_kind:kind,canonical_account_id:canonicalId})
  }
  const plaid = requested.filter(item=>item.account_kind==="plaid"), manual = requested.filter(item=>item.account_kind==="manual")
  const [plaidResult, manualResult] = await Promise.all([
    plaid.length ? db.from("finance_household_accounts").select("account_id,canonical_account_id").eq("household_id",householdId).in("account_id",plaid.map(item=>item.account_id)) : Promise.resolve({data:[],error:null}),
    manual.length ? db.from("finance_manual_accounts").select("manual_account_id").eq("household_id",householdId).in("manual_account_id",manual.map(item=>item.account_id)) : Promise.resolve({data:[],error:null}),
  ])
  check(plaidResult.error); check(manualResult.error)
  const plaidBySource = new Map((plaidResult.data||[]).map((row:Row)=>[row.account_id,row]))
  const manualFound = new Set((manualResult.data||[]).map((row:Row)=>row.manual_account_id))
  for(const item of plaid){const found=plaidBySource.get(item.account_id);if(!found||item.canonical_account_id&&item.canonical_account_id!==found.canonical_account_id)throw new HttpError(404,"One or more accounts were not found in this household.");item.canonical_account_id=found.canonical_account_id;}
  if(manual.some(item=>!manualFound.has(item.account_id)))throw new HttpError(404,"One or more accounts were not found in this household.")
  const pagedRead = async (table:string, columns:string, idField:string, ids:string[], ordering:string[]) => {
    if(!ids.length)return [] as Row[]
    const rows:Row[]=[];let offset=0
    for(;;){let query=db.from(table).select(columns).eq("household_id",householdId).in(idField,ids).gte("snapshot_date",start).lte("snapshot_date",end);for(const field of ordering)query=query.order(field);const {data,error}=await query.range(offset,offset+999);check(error);if(!Array.isArray(data)||data.length>1000)throw new HttpError(503,"Account history could not be verified as complete.");const page=data;rows.push(...page);if(rows.length>100000)throw new HttpError(413,"Requested account history exceeds the supported complete range.");if(page.length<1000)break;offset+=1000;}
    return rows
  }
  const canonicalIds=plaid.map(item=>item.canonical_account_id), manualIds=manual.map(item=>item.account_id)
  const [plaidHistory,manualHistory]=await Promise.all([
    pagedRead("finance_canonical_account_balance_snapshots","canonical_account_id,account_id,snapshot_date,recorded_at,current_balance,available_balance,credit_limit,currency_code,source","canonical_account_id",canonicalIds,["canonical_account_id","snapshot_date","recorded_at","account_id"]),
    pagedRead("finance_manual_account_snapshots","manual_account_id,snapshot_date,recorded_at,value,currency_code","manual_account_id",manualIds,["manual_account_id","snapshot_date","recorded_at"]),
  ])
  const histories=requested.map(item=>{const rows=item.account_kind==="manual"?manualHistory.filter(row=>row.manual_account_id===item.account_id):plaidHistory.filter(row=>row.canonical_account_id===item.canonical_account_id),seen=new Set<string>();for(const row of rows){const date=String(row.snapshot_date||"");if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<start||date>end||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||seen.has(date))throw new HttpError(503,"Account history could not be verified as complete.");seen.add(date);}return {account_id:item.account_id,account_kind:item.account_kind,...(item.canonical_account_id?{canonical_account_id:item.canonical_account_id}:{}),balance_history:rows}})
  return {start_date:start,end_date:end,complete:true,accounts:histories}
}

async function accountDetail(db: any, householdId: string, body: Row, userId: string) {
  const accountId = text(body.account_id, "account_id", 200)
  const kind = body.account_kind === "manual" ? "manual" : "plaid"
  const start = dateValue(body.start_date) ?? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)
  const end = dateValue(body.end_date) ?? new Date().toISOString().slice(0, 10)
  if (start > end) throw new HttpError(400, "start_date must precede end_date.")
  const recentLimit = integer(body.recent_limit, 10, 1, 50)
  if (body.include_recent_transactions !== undefined && typeof body.include_recent_transactions !== "boolean") throw new HttpError(400, "include_recent_transactions must be boolean.")
  const includeRecentTransactions = body.include_recent_transactions !== false
  if (kind === "manual") {
    const { data: account, error } = await db.from("finance_manual_accounts").select("*").eq("household_id", householdId).eq("manual_account_id", accountId).maybeSingle()
    check(error); if (!account) throw new HttpError(404, "Account not found.")
    const history = await accountHistory(db,householdId,"manual",accountId,start,end);
    return { account: { ...account, account_id: account.manual_account_id, account_kind: "manual" }, balance_history: history.rows, history_coverage: history.coverage, recent_transactions: [], recent_transactions_included: includeRecentTransactions }
  }
  const { data: items, error: itemError } = await db.from("plaid_items").select("item_id,institution_id,institution_name,institution_logo,institution_primary_color,institution_url,connection_status,connection_error_code,last_sync_attempt_at,last_successful_sync_at").eq("household_id", householdId)
  check(itemError); const itemMap = new Map((items ?? []).map((i: Row) => [i.item_id, i]))
  const canonicalId=optionalText(body.canonical_account_id,36);
  if(canonicalId&&!isUuid(canonicalId))throw new HttpError(400,"Invalid canonical account ID.");
  const { data: account, error } = await db.from("finance_household_accounts").select("*").eq("household_id", householdId).eq(canonicalId?"canonical_account_id":"account_id",canonicalId??accountId).maybeSingle()
  check(error); if (!account) throw new HttpError(404, "Account not found.")
  const history = await accountHistory(db,householdId,"plaid",account.canonical_account_id,start,end);
  let recentWithSplits:Row[]=[];
  if(includeRecentTransactions){
    const { data: recent, error: recentError } = await db.from("finance_effective_transactions").select("transaction_id,account_id,canonical_account_id,effective_transaction_date,effective_merchant_name,amount,iso_currency_code,pending,effective_category,effective_subcategory").eq("household_id", householdId).eq("canonical_account_id", account.canonical_account_id).order("effective_transaction_date", { ascending: false }).limit(recentLimit)
    check(recentError)
    let proof:any=null;
    if(recent?.length){const result=await db.rpc("finance_account_recent_split_evidence",{p_household_id:householdId,p_user_id:userId,p_transaction_ids:recent.map((row:Row)=>row.transaction_id)});if(result.error?.code==="42501")throw new HttpError(403,"Membership required.");if(!result.error)proof=result.data;}
    recentWithSplits=accountRecentSplitRows(recent??[],proof);
  }
  return { account: { ...account, account_kind: "plaid", institution: itemMap.get(account.item_id) ?? null }, balance_history: history.rows, history_coverage: history.coverage, recent_transactions: recentWithSplits, recent_transactions_included: includeRecentTransactions }
}

async function saveManual(db: any, householdId: string, userId: string, body: Row) {
  const id = optionalText(body.account_id, 36)
  const accountClass = enumValue(body.account_class, ["asset", "liability"], "account_class")
  const assetType = enumValue(body.asset_type, ["real_estate", "vehicle", "other_asset", "manual_liability"], "asset_type")
  if (accountClass === "liability" && assetType !== "manual_liability") throw new HttpError(400, "Liabilities must use manual_liability.")
  const value = number(body.current_value, "current_value", 0, 999999999999.99)
  const row = { household_id: householdId, name: text(body.name, "name", 120), account_class: accountClass, asset_type: assetType, current_value: value, currency_code: currency(body.currency_code), institution_name: optionalText(body.institution_name, 120) ?? "Manual", notes: optionalText(body.notes, 2000) ?? null, updated_by: userId, updated_at: new Date().toISOString(), ...(id ? {} : { created_by: userId }) }
  let result: Row
  if (id) {
    const { data, error } = await db.from("finance_manual_accounts").update(row).eq("household_id", householdId).eq("manual_account_id", id).select().maybeSingle(); check(error)
    if (!data) throw new HttpError(404, "Account not found."); result = data
  } else {
    const { data, error } = await db.from("finance_manual_accounts").insert(row).select().single(); check(error); result = data
  }
  const { error: snapshotError } = await db.from("finance_manual_account_snapshots").upsert({ household_id: householdId, manual_account_id: result.manual_account_id, snapshot_date: new Date().toISOString().slice(0, 10), recorded_at: new Date().toISOString(), value, currency_code: row.currency_code }, { onConflict: "manual_account_id,snapshot_date" })
  check(snapshotError); await audit(db, householdId, userId, id ? "account.updated" : "account.created", "manual_account", result.manual_account_id)
  return { account: { ...result, account_id: result.manual_account_id, account_kind: "manual" }, created: !id }
}

async function saveManualAtomic(db: any, householdId: string, userId: string, body: Row) {
  onlyFields(body, ["action", "household_id", "idempotency_key", "snapshot_date", "account", "linked_debt"])
  const idempotencyKey = text(body.idempotency_key, "idempotency_key", 200)
  if (idempotencyKey.length < 8) throw new HttpError(400, "Invalid idempotency_key.")
  const snapshotDate = dateValue(body.snapshot_date)
  if (!snapshotDate) throw new HttpError(400, "Invalid snapshot_date.")
  if (!isRecord(body.account)) throw new HttpError(400, "Invalid account.")
  onlyFields(body.account, ["account_id", "expected_version", "name", "account_class", "asset_type", "current_value", "currency_code", "institution_name", "notes"])
  const accountBody = body.account
  const accountId = optionalText(accountBody.account_id, 36)
  if (accountId && !isUuid(accountId)) throw new HttpError(400, "Invalid account_id.")
  const expectedVersion = accountBody.expected_version === undefined ? undefined : integer(accountBody.expected_version, 1, 1, 2147483647)
  if (Boolean(accountId) !== (expectedVersion !== undefined)) throw new HttpError(400, "account_id and expected_version must be supplied together.")
  const accountClass = enumValue(accountBody.account_class, ["asset", "liability"], "account_class")
  const assetType = enumValue(accountBody.asset_type, ["real_estate", "vehicle", "other_asset", "manual_liability"], "asset_type")
  if (accountClass === "liability" && assetType !== "manual_liability") throw new HttpError(400, "Liabilities must use manual_liability.")
  const currencyCode = currency(accountBody.currency_code)
  const normalizedAccount = {
    ...(accountId ? { account_id: accountId, expected_version: expectedVersion } : {}),
    name: text(accountBody.name, "name", 120),
    account_class: accountClass,
    asset_type: assetType,
    current_value: cents(accountBody.current_value, "current_value"),
    currency_code: currencyCode,
    institution_name: optionalText(accountBody.institution_name, 120) ?? "Manual",
    notes: optionalText(accountBody.notes, 2000) ?? null,
  }
  let linkedDebt: Row | null = null
  if (body.linked_debt !== undefined && body.linked_debt !== null) {
    if (!isRecord(body.linked_debt)) throw new HttpError(400, "Invalid linked_debt.")
    onlyFields(body.linked_debt, ["account_id", "expected_version", "name", "current_value", "currency_code", "notes"])
    const debtId = optionalText(body.linked_debt.account_id, 36)
    if (debtId && !isUuid(debtId)) throw new HttpError(400, "Invalid linked debt account_id.")
    const debtExpectedVersion = body.linked_debt.expected_version === undefined ? undefined : integer(body.linked_debt.expected_version, 1, 1, 2147483647)
    if (Boolean(debtId) !== (debtExpectedVersion !== undefined)) throw new HttpError(400, "Linked debt account_id and expected_version must be supplied together.")
    if (debtId && debtId === accountId) throw new HttpError(400, "An account cannot link to itself.")
    linkedDebt = {
      ...(debtId ? { account_id: debtId, expected_version: debtExpectedVersion } : {}),
      ...(body.linked_debt.name === undefined ? {} : { name: text(body.linked_debt.name, "linked_debt.name", 120) }),
      current_value: cents(body.linked_debt.current_value, "linked_debt.current_value"),
      ...(body.linked_debt.notes === undefined ? {} : { notes: optionalText(body.linked_debt.notes, 2000) ?? null }),
    }
  }
  if (linkedDebt && (accountClass !== "asset" || currencyCode !== currency(body.linked_debt.currency_code ?? currencyCode))) {
    throw new HttpError(400, "Linked debt must use the asset currency.")
  }
  const requestPayload = { snapshot_date: snapshotDate, account: normalizedAccount, linked_debt: linkedDebt }
  let result: any
  try {
    const response = await db.rpc("finance_save_manual_account_atomic", {
      p_household_id: householdId, p_actor_user_id: userId, p_idempotency_key: idempotencyKey, p_request: requestPayload,
    })
    if (response.error) {
      const code = String(response.error.code ?? "")
      const status = code === "42501" ? 403 : code === "P0002" ? 404 : ["22023", "25001", "23502", "22P02"].includes(code) ? 400 : ["40001", "23505", "23514"].includes(code) ? 409 : 503
      throw new HttpError(status, status === 503 ? "The save outcome is unknown. Retry this exact request." : response.error.message || "Could not save manual account.")
    }
    result = response.data
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(503, "The save outcome is unknown. Retry this exact request.")
  }
  if (!isRecord(result) || result.saved !== true || !isRecord(result.account)) throw new HttpError(503, "The save receipt could not be verified. Retry this exact request.")
  return result
}

function cents(value: unknown, name: string) {
  const result = number(value, name, 0, 999999999999.99)
  if (Math.abs(Math.round(result * 100) - result * 100) > 1e-7) throw new HttpError(400, `Invalid ${name}.`)
  return result
}

function onlyFields(value: Row, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, "Unexpected manual-account field.")
}
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }

async function setStatus(db: any, householdId: string, userId: string, body: Row) {
  const id = text(body.account_id, "account_id", 200); const kind = body.account_kind === "manual" ? "manual" : "plaid"
  const status = enumValue(body.status, ["active", "closed"], "status"); const patch = { lifecycle_status: status, closed_at: status === "closed" ? new Date().toISOString() : null, closed_by: status === "closed" ? userId : null, updated_at: new Date().toISOString() }
  let query = kind === "manual" ? db.from("finance_manual_accounts").update(patch).eq("household_id", householdId).eq("manual_account_id", id) : db.from("plaid_accounts").update(patch).eq("account_id", id).in("item_id", await itemIds(db, householdId))
  const { data, error } = await query.select().maybeSingle(); check(error); if (!data) throw new HttpError(404, "Account not found.")
  await audit(db, householdId, userId, status === "closed" ? "account.closed" : "account.reopened", `${kind}_account`, id)
  return { account_id: id, account_kind: kind, status, data_retained: true }
}

async function deleteAccount(db: any, householdId: string, userId: string, body: Row) {
  const id = text(body.account_id, "account_id", 200); const kind = body.account_kind === "manual" ? "manual" : "plaid"
  const rpc = kind === "manual" ? "finance_permanently_delete_manual_account" : "finance_permanently_delete_plaid_account"
  const params = kind === "manual" ? { p_household_id: householdId, p_manual_account_id: id, p_actor_user_id: userId } : { p_household_id: householdId, p_account_id: id, p_actor_user_id: userId }
  const { data, error } = await db.rpc(rpc, params); check(error); return data
}

async function createLinkToken(db: any, householdId: string, userId: string, body: Row) {
  const updateAccountId = optionalText(body.update_account_id, 200); let accessToken: string | undefined
  if (updateAccountId) {
    const { data, error } = await db.from("plaid_accounts").select("item_id,plaid_items!inner(access_token,household_id)").eq("account_id", updateAccountId).eq("plaid_items.household_id", householdId).maybeSingle(); check(error)
    accessToken = data?.plaid_items?.access_token ? await resolvePlaidAccessToken(db, data.item_id, data.plaid_items.access_token) : undefined; if (!accessToken) throw new HttpError(404, "Account not found.")
  }
  const linkBody: Row = accessToken
    ? { user: { client_user_id: `${householdId}:${userId}` }, client_name: "Folio", country_codes: ["US"], language: "en", access_token: accessToken }
    : { user: { client_user_id: `${householdId}:${userId}` }, client_name: "Folio", country_codes: ["US"], language: "en", products: ["transactions"], optional_products: ["investments", "liabilities"], transactions: { days_requested: 730 }, hosted_link: {} }
  const redirectUri = Deno.env.get("PLAID_REDIRECT_URI")?.trim(); if (redirectUri) linkBody.redirect_uri = redirectUri
  const data = await plaid("/link/token/create", linkBody)
  return { link_token: data.link_token, hosted_link_url: data.hosted_link_url ?? null, expiration: data.expiration, request_id: data.request_id, mode: accessToken ? "update" : "create" }
}

async function completeHostedLink(db: any, householdId: string, userId: string, body: Row) {
  const linkToken = text(body.link_token, "link_token", 500)
  const data = await plaid("/link/token/get", { link_token: linkToken })
  const sessions = Array.isArray(data.link_sessions) ? [...data.link_sessions].reverse() : []
  let publicToken: string | undefined
  for (const session of sessions) {
    const additions = session?.results?.item_add_results
    if (Array.isArray(additions)) publicToken = additions.find((result: Row) => typeof result?.public_token === "string")?.public_token
    if (!publicToken && typeof session?.on_success?.public_token === "string") publicToken = session.on_success.public_token
    if (publicToken) break
  }
  if (!publicToken) throw new HttpError(409, "The Plaid connection is not finished yet. Complete the institution sign-in, then try again.")
  return await exchangePublicToken(db, householdId, userId, { public_token: publicToken })
}

async function exchangePublicToken(db: any, householdId: string, userId: string, body: Row) {
  const publicToken = text(body.public_token, "public_token", 500); const exchange = await plaid("/item/public_token/exchange", { public_token: publicToken })
  const itemData = await plaidWithEnvironment("/item/get", { access_token: exchange.access_token }, environment())
  const institutionId = itemData.item?.institution_id ?? null
  let institution: Row = {}
  if (institutionId) institution = (await plaidWithEnvironment("/institutions/get_by_id", { institution_id: institutionId, country_codes: ["US"], options: { include_optional_metadata: true } }, environment())).institution ?? {}
  const now = new Date().toISOString()
  const { error } = await db.from("plaid_items").upsert({ item_id: exchange.item_id, household_id: householdId, access_token: exchange.access_token, plaid_environment: environment(), institution_id: institutionId, institution_name: institution.name ?? null, institution_logo: institution.logo ?? null, institution_primary_color: institution.primary_color ?? null, institution_url: institution.url ?? null, connection_status: "connected", connection_error_code: null, connection_error_message: null, last_successful_sync_at: now, updated_at: now }, { onConflict: "item_id" })
  check(error); await audit(db, householdId, userId, "plaid_item.connected", "plaid_item", exchange.item_id)
  return { connected: true, item_id: exchange.item_id, institution: { institution_id: institutionId, name: institution.name ?? null, logo: institution.logo ?? null, primary_color: institution.primary_color ?? null } }
}

async function resolveDuplicate(db: any, householdId: string, userId: string, body: Row) {
  const candidateId = text(body.candidate_id, "candidate_id", 36)
  const decision = enumValue(body.decision, ["merge", "keep_separate"], "decision")
  const { error } = await db.rpc("finance_resolve_account_match_candidate", {
    p_household_id: householdId,
    p_candidate_id: candidateId,
    p_decision: decision,
    p_actor_user_id: userId,
  })
  check(error)
  await audit(db, householdId, userId, `account_match.${decision}`, "account_match_candidate", candidateId)
  return { candidate_id: candidateId, decision, resolved: true }
}

async function itemIds(db: any, householdId: string): Promise<string[]> { const { data, error } = await db.from("plaid_items").select("item_id").eq("household_id", householdId); check(error); return (data ?? []).map((r: Row) => r.item_id) }
async function audit(db: any, householdId: string, userId: string, action: string, entityType: string, entityId: string) { const { error } = await db.from("finance_audit_events").insert({ household_id: householdId, actor_user_id: userId, action, entity_type: entityType, entity_id: entityId }); check(error) }
async function plaid(path: string, body: Row) { return plaidWithEnvironment(path, body, environment()) }
async function plaidWithEnvironment(path: string, body: Row, env: string) { const response = await fetch(`https://${env}.plaid.com${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: required("PLAID_CLIENT_ID").trim(), secret: required("PLAID_SECRET").trim(), ...body }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { console.error("Plaid request failed", { path, error_code: data.error_code, request_id: data.request_id }); throw new HttpError(502, "Plaid could not complete the request.") } return data }
function environment() {
  const configured = Deno.env.get("PLAID_ENV") ?? Deno.env.get("PLAID_ENVIRONMENT") ?? "production"
  const normalized = configured
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.plaid\.com\/?$/, "")
    .replace(/\/+$/, "")
  const value = normalized === "prod" ? "production" : normalized === "dev" ? "development" : normalized
  if (!["sandbox", "development", "production"].includes(value)) {
    throw new HttpError(500, "Invalid Plaid environment. Use sandbox, development, or production.")
  }
  return value
}
function requireOwner(role: string) { if (role !== "owner") throw new HttpError(403, "Only the household owner may perform this action.") }
function required(name: string) { const value = Deno.env.get(name); if (!value) throw new HttpError(500, "Server configuration is incomplete."); return value }
function check(error: any) { if (error) { console.error("Database operation failed", error.code ?? error.message); throw new HttpError(500, "Could not update household data.") } }
function isRecord(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value) }
function text(value: unknown, name: string, max: number) { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new HttpError(400, `Invalid ${name}.`); return value.trim() }
function optionalText(value: unknown, max: number) { if (value === undefined || value === null || value === "") return undefined; return text(value, "text value", max) }
function enumValue<T extends string>(value: unknown, allowed: T[], name: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new HttpError(400, `Invalid ${name}.`); return value as T }
function number(value: unknown, name: string, min: number, max: number) { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, `Invalid ${name}.`); return value }
function integer(value: unknown, fallback: number, min: number, max: number) { if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new HttpError(400, "Invalid integer value."); return value }
function currency(value: unknown) { const result = value === undefined ? "USD" : text(value, "currency_code", 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(result)) throw new HttpError(400, "Invalid currency_code."); return result }
function dateValue(value: unknown) { if (value === undefined) return undefined; const result = text(value, "date", 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new HttpError(400, "Invalid date."); return result }
function assetGroup(type: string) { if (type === "depository") return "Cash"; if (type === "investment") return "Investments"; if (["credit", "loan"].includes(type)) return "Liabilities"; return "Other" }
function json(body: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,apikey" } }) }

async function reviewedStatus(db: any, householdId: string, userId: string, body: Row) {
 const review=body.action==="review_status";
 onlyFields(body,review?["action","household_id","account_kind","account_id","status"]:["action","household_id","review_id","idempotency_key","confirm"]);
 let params: Row;
 if(review){
  if(!isUuid(body.account_id??""))throw new HttpError(400,"Canonical or manual account ID required.");
  params={p_household_id:householdId,p_actor_user_id:userId,p_kind:enumValue(body.account_kind,["plaid","manual"],"account_kind"),p_account_id:body.account_id,p_status:enumValue(body.status,["active","closed"],"status")};
 }else{
  if(body.confirm!==true||!isUuid(body.review_id??"")||!isUuid(body.idempotency_key??""))throw new HttpError(400,"Reviewed confirmation and retry key required.");
  params={p_household_id:householdId,p_actor_user_id:userId,p_review_id:body.review_id,p_idempotency_key:body.idempotency_key};
 }
 try{
  const {data,error}=await db.rpc(review?"finance_review_account_status":"finance_confirm_account_status",params);
  if(error){const code=String(error.code??"");throw new HttpError(code==="42501"?403:code==="P0002"?404:["40001","23505"].includes(code)?409:["22023","22P02"].includes(code)?400:503,"Account status could not be verified. Retry the same request.");}
  if(!isRecord(data)||data.household_id!==householdId||data.actor_user_id!==userId||!isUuid(data.review_id??"")||data.data_retained!==true||!["active","closed"].includes(data.status)||!["manual","plaid"].includes(data.account_kind)||!isUuid(data.account_id??"")||!isRecord(data.facts))throw new HttpError(503,"Account status response could not be verified.");
  if(review){if(data.account_id!==body.account_id||data.account_kind!==body.account_kind||data.status!==body.status||!Number.isFinite(Date.parse(data.expires_at)))throw new HttpError(503,"Account review could not be verified.");}
  else if(data.saved!==true||data.review_id!==body.review_id||data.idempotency_key!==body.idempotency_key)throw new HttpError(503,"Save outcome unknown. Retry the same confirmation.");
  return data;
 }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(503,"Save outcome unknown. Retry the same request before changing status.");}
}

async function accountHistory(db:any, householdId:string, kind:string, accountId:string, start:string, end:string){
 const table=kind==="manual"?"finance_manual_account_snapshots":"finance_canonical_account_balance_snapshots";
 const identity=kind==="manual"?"manual_account_id":"canonical_account_id";
 const columns=kind==="manual"?"manual_account_id,snapshot_date,recorded_at,value,currency_code":"canonical_account_id,account_id,snapshot_date,recorded_at,current_balance,available_balance,credit_limit,currency_code,source";
 const rows:Row[]=[],seen=new Set<string>();let complete=false,reason:string|null=null,pages=0;
 for(let offset=0;offset<100000;offset+=1000){
  let result:any;try{result=await db.from(table).select(columns).eq("household_id",householdId).eq(identity,accountId).gte("snapshot_date",start).lte("snapshot_date",end).order("snapshot_date").order("recorded_at").range(offset,offset+999);}catch{reason="source_error";break;}
  pages++;
  if(result?.error||!Array.isArray(result?.data)||result.data.length>1000){reason="source_error";break;}
  for(const row of result.data){const key=row?.snapshot_date;if(row?.[identity]!==accountId||typeof key!=="string"||key<start||key>end||!/^\d{4}-\d{2}-\d{2}$/.test(key)||!Number.isFinite(Date.parse(key))||new Date(key).toISOString().slice(0,10)!==key||seen.has(key)){reason="invalid_or_changed_history";break;}seen.add(key);rows.push(row);}
  if(reason)break;
  if(result.data.length<1000){complete=true;break;}
 }
 if(!complete&&!reason)reason="page_limit";
 return {rows,coverage:{pagination_complete:complete,pages_read:pages,rows_read:rows.length,period_complete:null,requested_start_date:start,requested_end_date:end,account_id:accountId,account_kind:kind,reason}};
}


