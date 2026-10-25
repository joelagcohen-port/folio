/** Deterministic rental reporting primitives shared by the Rental P&L UI and Ask Folio. */
export type ReportingScope = {
  type: "account" | "account_group";
  canonical_account_ids: string[];
};

export type RentalPeriod = {
  type: "month" | "quarter" | "year" | "custom";
  start_date: string;
  end_date: string;
  label?: string;
};

export type RentalTreatment =
  | "rental_income" | "operating_expense" | "capital_improvement" | "mortgage_principal" | "mortgage_payment"
  | "transfer" | "owner_contribution" | "owner_draw" | "personal_exclude" | "needs_review"
  | "security_deposit_received" | "security_deposit_applied" | "security_deposit_returned";

export type DepositApplication = {
  application_id: string;
  date: string;
  amount: number;
  reason: "unpaid_rent" | "repairs_damage" | "cleaning" | "other";
  category: "rent" | "late_fees" | "other_rental_income";
};

export type MortgageSplit = { principal?: number; interest?: number; escrow?: number; fees?: number; fee_category?: string | null; source?: { type: "statement" | "manual"; reference: string } };
export type MortgageAllocation = { component: "principal" | "interest" | "escrow" | "fees"; category: string | null; amount: number };

export type RentalClassification = {
  transaction_id: string;
  household_id: string;
  treatment: RentalTreatment;
  category: string | null;
  notes?: string | null;
  reviewed: boolean;
  deposit_applications?: DepositApplication[];
  deposit_received_transaction_id?: string | null;
  mortgage_split?: MortgageSplit | null;
};

export type RentalTransaction = {
  transaction_id: string;
  household_id: string;
  canonical_account_id: string;
  transaction_source_enabled: boolean;
  effective_transaction_date: string;
  amount: number; // Plaid convention: positive is money out, negative is money in.
  pending: boolean;
  effective_merchant_name?: string | null;
  name?: string | null;
  original_description?: string | null;
  effective_category?: string | null;
  effective_type?: string | null;
  plaid_primary_category?: string | null;
  plaid_detailed_category?: string | null;
  transfer_network?: string | null;
  transfer_direction?: string | null;
  pending_transaction_id?: string | null;
  refund_relationship_type?: string | null;
  refund_original_transaction_id?: string | null;
  refund_status?: string | null;
  rental_contributions?: { pnl_income: number; pnl_expense: number; cash_flow: number; tax_income: number; tax_expense: number; tax_special: number };
  rental_tax_deposit_applications?: DepositApplication[];
  rental_mortgage_split?: MortgageSplit | null;
  rental_mortgage_allocations?: MortgageAllocation[];
  [key: string]: unknown;
};

export type RentalReportInput = {
  household_id: string;
  scope: ReportingScope;
  period: RentalPeriod;
  transactions: RentalTransaction[];
  classifications: RentalClassification[];
  include_pending?: boolean;
  tax_year?: number;
};

export type RentalReportCategory = { key: string; label: string; amount: number; transaction_ids: string[] };
export type RentalReport = {
  household_id: string;
  scope: ReportingScope;
  period: RentalPeriod;
  posted_only: boolean;
  income: number;
  expenses: number;
  net_income: number;
  cash_in: number;
  cash_out: number;
  net_cash_flow: number;
  income_categories: RentalReportCategory[];
  expense_categories: RentalReportCategory[];
  cash_flow_categories: RentalReportCategory[];
  non_pnl_categories: RentalReportCategory[];
  review: { count: number; amount: number; transaction_ids: string[] };
  tax_summary: { tax_year: number; categories: RentalReportCategory[]; transaction_ids: string[]; complete: boolean; mortgage_review: { count: number; amount: number; transaction_ids: string[] } };
  pnl_complete: boolean;
  mortgage_review: { count: number; amount: number; transaction_ids: string[] };
  year_end_readiness: { reviewed_percent: number; total_posted: number; unresolved: number; transaction_ids: string[] };
  security_deposits: { opening_held: number; received: number; returned: number; applied: number; ending_held: number; coverage_uncertain: boolean; transaction_ids: string[]; opening_breakdown: DepositBalanceItem[]; received_breakdown: DepositBalanceItem[]; returned_breakdown: DepositBalanceItem[]; applied_breakdown: DepositBalanceItem[]; ending_breakdown: DepositBalanceItem[] };
  transactions: RentalTransaction[];
};
export type DepositBalanceItem = { transaction_id: string; date: string; type: "received" | "returned" | "applied" | "held"; amount: number; reason?: string; application_id?: string };

export const RENTAL_CATEGORIES: Readonly<Record<string, string>> = {
  rent: "Rent", late_fees: "Late fees", other_rental_income: "Other rental income",
  advertising: "Advertising", cleaning_maintenance: "Cleaning & maintenance", insurance: "Insurance",
  legal_professional: "Legal & professional", management_fees: "Management fees", mortgage_interest: "Mortgage interest",
  repairs: "Repairs", supplies: "Supplies", property_taxes: "Property taxes", utilities: "Utilities", hoa: "HOA", other: "Other",
  capital_improvement: "Capital improvement", mortgage_principal: "Mortgage principal", transfer: "Transfer",
  owner_contribution: "Owner contribution", owner_draw: "Owner draw", personal_exclude: "Personal / exclude", needs_review: "Needs review",
  security_deposit_applied: "Security deposit applied",
  security_deposit_received: "Security deposits received", security_deposit_returned: "Security deposits returned",
  mortgage_payment: "Mortgage payment", mortgage_escrow: "Mortgage escrow",
};

const INCOME_CATEGORIES = new Set(["rent", "late_fees", "other_rental_income"]);
const EXPENSE_CATEGORIES = new Set(["advertising", "cleaning_maintenance", "insurance", "legal_professional", "management_fees", "mortgage_interest", "repairs", "supplies", "property_taxes", "utilities", "hoa", "other"]);
const NON_PNL_TREATMENTS = new Set<RentalTreatment>(["capital_improvement", "mortgage_principal", "mortgage_payment", "transfer", "owner_contribution", "owner_draw", "personal_exclude", "needs_review", "security_deposit_received", "security_deposit_applied", "security_deposit_returned"]);
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const toCents = (value: number) => Math.round(value * 100);
const feeCategories = new Set(["advertising","cleaning_maintenance","insurance","legal_professional","management_fees","repairs","supplies","property_taxes","utilities","hoa","other"]);
export function validateMortgageSplit(value: unknown, bankAmount: number, confirmed: boolean): { valid: boolean; complete: boolean; split: MortgageSplit | null; allocations: MortgageAllocation[]; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, complete: false, split: null, allocations: [], error: "Provide mortgage allocation fields." };
  const raw=value as Record<string,unknown>, allowed=new Set(["principal","interest","escrow","fees","fee_category","source"]);
  if(Object.keys(raw).some(key=>!allowed.has(key)))return {valid:false,complete:false,split:null,allocations:[],error:"Mortgage split contains an unsupported field."};
  const fields=["principal","interest","escrow","fees"] as const;
  for(const key of fields) if(raw[key]!==undefined&&(typeof raw[key]!=="number"||!Number.isFinite(raw[key])||raw[key]<0||Math.abs(raw[key]*100-Math.round(raw[key]*100))>1e-7))return {valid:false,complete:false,split:null,allocations:[],error:`${key} must be a nonnegative amount in cents.`};
  const feeCategory=raw.fee_category===undefined||raw.fee_category===null||raw.fee_category===""?null:typeof raw.fee_category==="string"?raw.fee_category:null;
  if(raw.fee_category!==undefined&&raw.fee_category!==null&&raw.fee_category!==""&&(!feeCategory||!feeCategories.has(feeCategory)))return {valid:false,complete:false,split:null,allocations:[],error:"Choose a supported expense category for mortgage fees."};
  let source:MortgageSplit["source"];
  if(raw.source!==undefined){if(!raw.source||typeof raw.source!=="object"||Array.isArray(raw.source))return {valid:false,complete:false,split:null,allocations:[],error:"Mortgage source reference is invalid."};const src=raw.source as Record<string,unknown>;if(Object.keys(src).some(key=>!new Set(["type","reference"]).has(key))||!(src.type==="manual"||src.type==="statement")||typeof src.reference!=="string"||!src.reference.trim()||src.reference.length>200)return {valid:false,complete:false,split:null,allocations:[],error:"Choose a mortgage source type and enter its reference."};source={type:src.type,reference:src.reference.trim()};}
  const split:MortgageSplit={...(raw.principal!==undefined?{principal:raw.principal as number}:{}),...(raw.interest!==undefined?{interest:raw.interest as number}:{}),...(raw.escrow!==undefined?{escrow:raw.escrow as number}:{}),...(raw.fees!==undefined?{fees:raw.fees as number}:{}),fee_category:feeCategory,...(source?{source}:{})};
  const complete=fields.every(key=>typeof split[key]==="number");
  if(confirmed&&!complete)return {valid:false,complete:false,split,allocations:[],error:"Enter principal, interest, escrow, and fees before confirming the split."};
  const total=fields.reduce((sum,key)=>sum+(typeof split[key]==="number"?toCents(split[key]!):0),0);
  if(confirmed&&total!==toCents(bankAmount))return {valid:false,complete,split,allocations:[],error:"Mortgage split must equal the bank payment exactly."};
  if(confirmed&&!split.source)return {valid:false,complete,split,allocations:[],error:"Record whether this split came from a statement or manual entry, with a reference."};
  if(confirmed&&(split.fees??0)>0&&!feeCategory)return {valid:false,complete,split,allocations:[],error:"Choose an expense category for mortgage fees."};
  const allocations:MortgageAllocation[]=[{component:"principal",category:"mortgage_principal",amount:split.principal??0},{component:"interest",category:"mortgage_interest",amount:split.interest??0},{component:"escrow",category:"mortgage_escrow",amount:split.escrow??0},{component:"fees",category:feeCategory,amount:split.fees??0}].filter(item=>item.amount>0);
  return {valid:true,complete,split,allocations};
}
function isLikelyMortgage(tx: RentalTransaction): boolean {
  const category=String(tx.effective_category??"").trim().toLowerCase().replace(/[^a-z]+/g," ").trim();
  return ["mortgage","mortgage payment","home mortgage"].includes(category)||/^LOAN_PAYMENTS_MORTGAGE(?:_|$)/i.test(String(tx.plaid_detailed_category??""));
}
function addAmount(target: RentalReportCategory, value: number) { target.amount = roundMoney(target.amount + value); }

function assertIsoDate(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`Invalid ${name}.`);
}
function categoryKey(value: string | null | undefined): string {
  return String(value ?? "needs_review").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "needs_review";
}
function categoryLabel(key: string): string { return RENTAL_CATEGORIES[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function bucket(map: Map<string, RentalReportCategory>, key: string): RentalReportCategory {
  let item = map.get(key);
  if (!item) { item = { key, label: categoryLabel(key), amount: 0, transaction_ids: [] }; map.set(key, item); }
  return item;
}
function stableBuckets(map: Map<string, RentalReportCategory>): RentalReportCategory[] {
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function signedIncomeAmount(amount: number): number { return -amount; }
function isProviderTransfer(tx: RentalTransaction): boolean {
  if (tx.effective_type === "transfer") return true;
  return /^TRANSFER_(?:IN|OUT)(?:_|$)/i.test(String(tx.plaid_primary_category ?? "")) || /^TRANSFER_(?:IN|OUT)(?:_|$)/i.test(String(tx.plaid_detailed_category ?? ""));
}

/** Calculate account-scoped P&L and actual account cash movements. No inference or AI is used. */
export function buildRentalReport(input: RentalReportInput): RentalReport {
  const { household_id, scope, period } = input;
  if (!household_id) throw new Error("A household is required.");
  if (!scope || !["account", "account_group"].includes(scope.type) || !Array.isArray(scope.canonical_account_ids) || !scope.canonical_account_ids.length) throw new Error("Select an available reporting account.");
  if (new Set(scope.canonical_account_ids).size !== scope.canonical_account_ids.length || scope.canonical_account_ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("Reporting scope contains an invalid account.");
  assertIsoDate(period.start_date, "period start date"); assertIsoDate(period.end_date, "period end date");
  if (period.start_date > period.end_date) throw new Error("Period start must be on or before its end.");
  const scopeIds = new Set(scope.canonical_account_ids);
  const txById = new Map<string, RentalTransaction>();
  const currencies = new Set<string>();
  for (const row of input.transactions) {
    if (row.household_id !== household_id) throw new Error("Transaction household does not match report household.");
    if (!row.transaction_source_enabled) continue;
    if (!scopeIds.has(row.canonical_account_id)) continue;
    if (!Number.isFinite(row.amount)) throw new Error("A transaction has an invalid amount.");
    assertIsoDate(row.effective_transaction_date, "transaction date");
    if (typeof row.iso_currency_code === "string" && row.iso_currency_code) currencies.add(row.iso_currency_code);
    // View can theoretically expose multiple linked sources; keep one canonical transaction id.
    if (!txById.has(row.transaction_id)) txById.set(row.transaction_id, row);
  }
  if (currencies.size > 1 || [...currencies].some(currency => currency !== "USD")) throw new Error("Rental reports currently support one currency at a time; this scope contains unsupported or mixed currencies.");
  const classificationById = new Map<string, RentalClassification>();
  for (const c of input.classifications) {
    if (c.household_id !== household_id) throw new Error("Classification household does not match report household.");
    classificationById.set(c.transaction_id, c);
  }
  const classificationFor = (tx: RentalTransaction) => {
    const own = classificationById.get(tx.transaction_id);
    if (own || tx.refund_relationship_type !== "refund" || tx.refund_status !== "matched" || !tx.refund_original_transaction_id) return own;
    const original = classificationById.get(tx.refund_original_transaction_id);
    // Keep Rental P&L independent: inherit only a reviewed treatment with a
    // deterministic one-category meaning. Mortgage allocations and deposits
    // need their own explicit review because their treatment may be split.
    if (original?.reviewed && ["rental_income", "operating_expense", "capital_improvement", "mortgage_principal"].includes(original.treatment)) {
      return { ...original, transaction_id: tx.transaction_id, household_id: tx.household_id };
    }
    return undefined;
  };
  const allRows = [...txById.values()];
  const replacedPending = new Set(allRows.filter(t => !t.pending && typeof t.pending_transaction_id === "string").map(t => t.pending_transaction_id as string));
  const postedRows = allRows.filter(t => !t.pending && !replacedPending.has(t.transaction_id));
  const included = allRows.filter(t => !replacedPending.has(t.transaction_id) && t.effective_transaction_date >= period.start_date && t.effective_transaction_date <= period.end_date && (input.include_pending || !t.pending));
  const taxYear = input.tax_year ?? Number(period.end_date.slice(0, 4));
  if (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 9999) throw new Error("Invalid tax year.");
  const taxStart = `${taxYear}-01-01`, taxEnd = `${taxYear}-12-31`;
  const income = new Map<string, RentalReportCategory>(), expenses = new Map<string, RentalReportCategory>(), cash = new Map<string, RentalReportCategory>(), nonPnl = new Map<string, RentalReportCategory>();
  let incomeTotal = 0, expenseTotal = 0, cashIn = 0, cashOut = 0, reviewAmount = 0;
  const returnedByReceipt = new Map<string, number>();
  for (const tx of postedRows) {
    const c = classificationFor(tx);
    if (c?.treatment === "security_deposit_returned" && c.deposit_received_transaction_id && tx.amount > 0) returnedByReceipt.set(c.deposit_received_transaction_id, roundMoney((returnedByReceipt.get(c.deposit_received_transaction_id) ?? 0) + tx.amount));
  }
  const validReceiptById = new Map<string, boolean>();
  for (const tx of postedRows) {
    const c = classificationFor(tx);
    if (!c || !["security_deposit_received", "security_deposit_applied"].includes(c.treatment)) continue;
    const apps = Array.isArray(c.deposit_applications) ? c.deposit_applications : [];
    const appIds = apps.map(app => app.application_id);
    let valid = tx.amount < 0 && Array.isArray(apps) && new Set(appIds).size === appIds.length && apps.every(app => {
      try { assertIsoDate(app.date, "deposit application date"); } catch { return false; }
      return typeof app.application_id === "string" && Boolean(app.application_id.trim()) && app.date >= tx.effective_transaction_date && Number.isFinite(app.amount) && app.amount > 0 && ["unpaid_rent", "repairs_damage", "cleaning", "other"].includes(app.reason) && INCOME_CATEGORIES.has(app.category);
    });
    const appTotal = roundMoney(apps.reduce((sum, app) => sum + (Number.isFinite(app.amount) ? app.amount : 0), 0));
    const returned = returnedByReceipt.get(tx.transaction_id) ?? 0;
    valid = valid && c.reviewed && (c.treatment !== "security_deposit_applied" || apps.length > 0) && appTotal + returned <= Math.abs(tx.amount) + 0.001;
    validReceiptById.set(tx.transaction_id, valid);
  }
  const validReceiptIds = new Set([...validReceiptById].filter(([, valid]) => valid).map(([id]) => id));
  const contributions = new Map<string, NonNullable<RentalTransaction["rental_contributions"]>>();
  for (const tx of allRows) contributions.set(tx.transaction_id, { pnl_income: 0, pnl_expense: 0, cash_flow: 0, tax_income: 0, tax_expense: 0, tax_special: 0 });
  const mortgageChecks = new Map<string, ReturnType<typeof validateMortgageSplit>>();
  for(const tx of allRows){const c=classificationFor(tx);if(c?.treatment==="mortgage_payment")mortgageChecks.set(tx.transaction_id,validateMortgageSplit(c.mortgage_split,tx.amount,c.reviewed));}
  let depositOpening = 0, depositReceived = 0, depositReturned = 0, depositApplied = 0;
  const openingBreakdown: DepositBalanceItem[]=[], receivedBreakdown: DepositBalanceItem[]=[], returnedBreakdown: DepositBalanceItem[]=[], appliedBreakdown: DepositBalanceItem[]=[], endingBreakdown: DepositBalanceItem[]=[];
  const depositIds = new Set<string>();
  const currentApplicationSourceIds = new Set<string>();
  for (const tx of postedRows) {
    const c = classificationFor(tx);
    if (!c || !["security_deposit_received", "security_deposit_applied"].includes(c.treatment) || !validReceiptIds.has(tx.transaction_id)) continue;
    depositIds.add(tx.transaction_id);
    const amount = Math.abs(tx.amount);
    const receiptDate=tx.effective_transaction_date;
    const relatedReturns=postedRows.filter(returnTx => { const ret = classificationById.get(returnTx.transaction_id); return ret?.treatment === "security_deposit_returned" && ret.deposit_received_transaction_id === tx.transaction_id; });
    const priorReturns = relatedReturns.filter(r=>r.effective_transaction_date<period.start_date).reduce((sum,r)=>sum+r.amount,0);
    const priorApplications = (c.deposit_applications ?? []).filter(app => app.date < period.start_date).reduce((sum, app) => sum + app.amount, 0);
    const openingAmount=receiptDate<period.start_date?roundMoney(amount-priorReturns-priorApplications):0;
    if (openingAmount>0){depositOpening+=openingAmount;openingBreakdown.push({transaction_id:tx.transaction_id,date:period.start_date,type:"held",amount:openingAmount});}
    if (receiptDate >= period.start_date && receiptDate <= period.end_date) {depositReceived += amount;receivedBreakdown.push({transaction_id:tx.transaction_id,date:receiptDate,type:"received",amount});}
    const periodApplications = (c.deposit_applications ?? []).filter(app => app.date >= period.start_date && app.date <= period.end_date);
    for (const app of periodApplications) {
      const b = bucket(income, app.category); addAmount(b, app.amount); b.transaction_ids.push(tx.transaction_id); incomeTotal = roundMoney(incomeTotal + app.amount);
      contributions.get(tx.transaction_id)!.pnl_income = roundMoney(contributions.get(tx.transaction_id)!.pnl_income + app.amount);
      depositApplied += app.amount; currentApplicationSourceIds.add(tx.transaction_id); appliedBreakdown.push({transaction_id:tx.transaction_id,date:app.date,type:"applied",amount:app.amount,reason:app.reason,application_id:app.application_id});
    }
    const endingReturns=relatedReturns.filter(r=>r.effective_transaction_date<=period.end_date).reduce((sum,r)=>sum+r.amount,0),endingApplications=(c.deposit_applications??[]).filter(app=>app.date<=period.end_date).reduce((sum,app)=>sum+app.amount,0),endingAmount=roundMoney(receiptDate<=period.end_date?amount-endingReturns-endingApplications:0);
    if(endingAmount>0)endingBreakdown.push({transaction_id:tx.transaction_id,date:period.end_date,type:"held",amount:endingAmount});
  }
  for (const tx of postedRows) {
    const c = classificationFor(tx);
    if (c?.treatment !== "security_deposit_returned" || !c.deposit_received_transaction_id || !validReceiptIds.has(c.deposit_received_transaction_id)) continue;
    depositIds.add(tx.transaction_id); depositIds.add(c.deposit_received_transaction_id);
    if (tx.effective_transaction_date >= period.start_date && tx.effective_transaction_date <= period.end_date) {depositReturned += tx.amount;returnedBreakdown.push({transaction_id:tx.transaction_id,date:tx.effective_transaction_date,type:"returned",amount:tx.amount});}
  }
  const reviewIds: string[] = [];
  const renderable: RentalTransaction[] = [];
  const reviewApplicationSourceIds = new Set<string>();
  const periodMortgageIds=new Set<string>();
  for (const tx of included) {
    const c = classificationFor(tx);
    const providerTransfer = isProviderTransfer(tx);
    const mortgageCandidate=isLikelyMortgage(tx)&&(!c||!c.reviewed||c.treatment==="needs_review");
    const treatment: RentalTreatment = c?.treatment==="mortgage_payment" ? "mortgage_payment" : mortgageCandidate ? "needs_review" : providerTransfer ? "transfer" : c?.treatment ?? "needs_review";
    const category = categoryKey(mortgageCandidate?"needs_review":c?.category ?? (c?.treatment==="mortgage_payment"?"mortgage_payment":providerTransfer ? "transfer" : "needs_review"));
    if(mortgageCandidate||treatment==="mortgage_payment"&&!(c?.reviewed&&mortgageChecks.get(tx.transaction_id)?.valid&&mortgageChecks.get(tx.transaction_id)?.complete))periodMortgageIds.add(tx.transaction_id);
    const amount = Math.abs(tx.amount);
    const recognizedApps = c && validReceiptById.get(tx.transaction_id) === true ? (c.deposit_applications ?? []).filter(app => app.date >= period.start_date && app.date <= period.end_date) : [];
    const taxApps = c && c.reviewed && validReceiptById.get(tx.transaction_id) === true ? (c.deposit_applications ?? []).filter(app => app.date >= taxStart && app.date <= taxEnd) : [];
    const mortgageState=mortgageChecks.get(tx.transaction_id),mortgageConfirmed=treatment==="mortgage_payment"&&c?.reviewed===true&&mortgageState?.valid===true&&mortgageState.complete===true;
    const row = { ...tx, rental_treatment: treatment, rental_category: category, rental_reviewed: c?.reviewed ?? false, rental_notes: c?.notes ?? null, rental_deposit_applications: c?.deposit_applications ?? [], rental_recognized_deposit_applications: recognizedApps, rental_tax_deposit_applications: taxApps, deposit_received_transaction_id:c?.deposit_received_transaction_id??null, rental_mortgage_split:c?.mortgage_split??null, rental_mortgage_allocations:mortgageConfirmed?mortgageState.allocations:[], rental_mortgage_likely:mortgageCandidate } as RentalTransaction;
    renderable.push(row);
    // Needs-review always remains unresolved, even when a user marked it reviewed.
    // Personal exclusions only leave the review queue after explicit review.
    const validDeposit = treatment === "security_deposit_received" || treatment === "security_deposit_applied" ? validReceiptById.get(tx.transaction_id) === true : treatment === "security_deposit_returned" ? tx.amount > 0 && Boolean(c?.deposit_received_transaction_id) && validReceiptIds.has(c.deposit_received_transaction_id) : true;
    const mortgageValid=treatment!=="mortgage_payment"||mortgageChecks.get(tx.transaction_id)?.valid===true;
    const validPair = (treatment === "rental_income" && INCOME_CATEGORIES.has(category)) || (treatment === "operating_expense" && EXPENSE_CATEGORIES.has(category)) || NON_PNL_TREATMENTS.has(treatment) && (!treatment.startsWith("security_deposit") || validDeposit) && mortgageValid;
    const unresolved = treatment === "needs_review" || !validPair || !c || (!c.reviewed && treatment !== "personal_exclude") || (treatment === "personal_exclude" && !c.reviewed) || (treatment === "mortgage_payment" && !mortgageConfirmed);
    if (unresolved) { reviewIds.push(tx.transaction_id); reviewAmount = roundMoney(reviewAmount + amount); }
    if (tx.amount < 0) cashIn = roundMoney(cashIn + amount); else cashOut = roundMoney(cashOut + amount);
    contributions.get(tx.transaction_id)!.cash_flow = -tx.amount;
    const cashKey = !validPair ? "needs_review" : treatment === "rental_income" || treatment === "operating_expense" ? category : treatment === "security_deposit_applied" ? "security_deposit_received" : treatment;
    if(treatment==="mortgage_payment"&&mortgageConfirmed){for(const allocation of mortgageState.allocations){const key=allocation.category??"mortgage_payment",cashBucket=bucket(cash,key);addAmount(cashBucket,-allocation.amount);cashBucket.transaction_ids.push(tx.transaction_id);}}
    else{const cashBucket = bucket(cash, cashKey); addAmount(cashBucket, -tx.amount); cashBucket.transaction_ids.push(tx.transaction_id);}
    if ((NON_PNL_TREATMENTS.has(treatment)&&treatment!=="mortgage_payment") || !validPair || treatment==="mortgage_payment"&&!mortgageConfirmed) { const specialKey=!validPair?"needs_review":treatment==="security_deposit_applied"?"security_deposit_received":treatment;const special = bucket(nonPnl, specialKey); addAmount(special, -tx.amount); special.transaction_ids.push(tx.transaction_id); }
    if (treatment === "security_deposit_received" || treatment === "security_deposit_applied" || treatment === "security_deposit_returned") continue;
    if(treatment==="mortgage_payment"){
      if(mortgageConfirmed){
        for(const allocation of mortgageState.allocations){
          if(allocation.component==="interest"||allocation.component==="fees"&&allocation.category){const expenseKey=allocation.component==="interest"?"mortgage_interest":allocation.category!;const b=bucket(expenses,expenseKey);addAmount(b,allocation.amount);b.transaction_ids.push(tx.transaction_id);expenseTotal=roundMoney(expenseTotal+allocation.amount);contributions.get(tx.transaction_id)!.pnl_expense=roundMoney(contributions.get(tx.transaction_id)!.pnl_expense+allocation.amount);}
          if(allocation.component==="principal"||allocation.component==="escrow"){const specialKey=allocation.component==="principal"?"mortgage_principal":"mortgage_escrow";const b=bucket(nonPnl,specialKey);addAmount(b,-allocation.amount);b.transaction_ids.push(tx.transaction_id);}
        }
      }
      continue;
    }
    if (treatment === "personal_exclude" || treatment === "transfer" || treatment === "owner_contribution" || treatment === "owner_draw") continue;
    if (treatment === "rental_income" && INCOME_CATEGORIES.has(category)) {
      // Refunds/chargebacks on income reverse income, retaining Plaid signs.
      const signed = signedIncomeAmount(tx.amount); incomeTotal = roundMoney(incomeTotal + signed); addAmount(bucket(income, category), signed); bucket(income, category).transaction_ids.push(tx.transaction_id); contributions.get(tx.transaction_id)!.pnl_income = signed;
    } else if (treatment === "operating_expense" && EXPENSE_CATEGORIES.has(category)) {
      // A credit/refund reverses expenses. A refund larger than expense naturally nets positive.
      const signed = tx.amount; expenseTotal = roundMoney(expenseTotal + signed); addAmount(bucket(expenses, category), signed); bucket(expenses, category).transaction_ids.push(tx.transaction_id); contributions.get(tx.transaction_id)!.pnl_expense = signed;
    }
  }
  for (const tx of postedRows) {
    const c = classificationFor(tx);
    if (!c || !["security_deposit_received", "security_deposit_applied"].includes(c.treatment) || validReceiptById.get(tx.transaction_id) === true) continue;
    const currentApps = (c.deposit_applications ?? []).filter(app => typeof app.date === "string" && app.date >= period.start_date && app.date <= period.end_date);
    if (!currentApps.length) continue;
    if (!reviewIds.includes(tx.transaction_id)) { reviewIds.push(tx.transaction_id); reviewAmount = roundMoney(reviewAmount + currentApps.reduce((sum, app) => sum + (Number.isFinite(app.amount) && app.amount > 0 ? app.amount : 0), 0)); }
    reviewApplicationSourceIds.add(tx.transaction_id);
  }
  const taxRows = allRows.filter(t => !t.pending && t.effective_transaction_date >= taxStart && t.effective_transaction_date <= taxEnd && !replacedPending.has(t.transaction_id));
  const tax = new Map<string, RentalReportCategory>();
  const taxMortgageIds=new Set<string>();
  for (const tx of taxRows) {
    const c = classificationFor(tx); if(c?.treatment==="mortgage_payment"&&!c.reviewed){taxMortgageIds.add(tx.transaction_id);continue;} if (!c || !c.reviewed || c.treatment === "needs_review" || c.treatment === "personal_exclude" || c.treatment === "transfer" || c.treatment === "owner_contribution" || c.treatment === "owner_draw" || c.treatment === "security_deposit_returned") continue;
    if(isProviderTransfer(tx)&&c.treatment!=="mortgage_payment")continue;
    if (c.treatment === "security_deposit_received" || c.treatment === "security_deposit_applied") continue;
    if(c.treatment==="mortgage_payment"){
      const result=mortgageChecks.get(tx.transaction_id),confirmed=result?.valid&&result.complete&&c.reviewed;
      if(!confirmed){taxMortgageIds.add(tx.transaction_id);continue;}
      for(const allocation of result.allocations){if(allocation.component==="interest"||allocation.component==="fees"&&allocation.category){const key=allocation.component==="interest"?"mortgage_interest":allocation.category!,b=bucket(tax,key);addAmount(b,allocation.amount);b.transaction_ids.push(tx.transaction_id);contributions.get(tx.transaction_id)!.tax_expense=roundMoney(contributions.get(tx.transaction_id)!.tax_expense+allocation.amount);}}
      continue;
    }
    if (c.treatment === "capital_improvement" || c.treatment === "mortgage_principal") { const b = bucket(tax, c.treatment); addAmount(b, tx.amount); b.transaction_ids.push(tx.transaction_id); contributions.get(tx.transaction_id)!.tax_special = tx.amount; continue; }
    const category = categoryKey(c.category); if (!(INCOME_CATEGORIES.has(category) || EXPENSE_CATEGORIES.has(category))) continue;
    if ((c.treatment === "rental_income" && !INCOME_CATEGORIES.has(category)) || (c.treatment === "operating_expense" && !EXPENSE_CATEGORIES.has(category)) || !["rental_income", "operating_expense"].includes(c.treatment)) continue;
    const signed = c.treatment === "rental_income" ? signedIncomeAmount(tx.amount) : tx.amount;
    const b = bucket(tax, category); addAmount(b, signed); b.transaction_ids.push(tx.transaction_id); if (c.treatment === "rental_income") contributions.get(tx.transaction_id)!.tax_income = signed; else contributions.get(tx.transaction_id)!.tax_expense = signed;
  }
  for (const tx of postedRows) {
    const c = classificationFor(tx);
    if (!c || !["security_deposit_received", "security_deposit_applied"].includes(c.treatment) || validReceiptById.get(tx.transaction_id) !== true) continue;
    for (const app of c.deposit_applications ?? []) if (validReceiptById.get(tx.transaction_id) === true && c.reviewed && app.date >= taxStart && app.date <= taxEnd && app.category && Number.isFinite(app.amount)) { const b = bucket(tax, app.category); addAmount(b, app.amount); b.transaction_ids.push(tx.transaction_id); contributions.get(tx.transaction_id)!.tax_income = roundMoney(contributions.get(tx.transaction_id)!.tax_income + app.amount); }
  }
  for(const tx of taxRows){const c=classificationFor(tx);if(isLikelyMortgage(tx)&&(!c||!c.reviewed||c.treatment==="needs_review"))taxMortgageIds.add(tx.transaction_id);}
  const taxMortgageReviewIds=[...taxMortgageIds],taxMortgageReviewAmount=roundMoney(taxRows.filter(tx=>taxMortgageIds.has(tx.transaction_id)).reduce((sum,tx)=>sum+Math.abs(tx.amount),0));
  const periodMortgageReviewIds=[...periodMortgageIds],periodMortgageReviewAmount=roundMoney(included.filter(tx=>periodMortgageIds.has(tx.transaction_id)).reduce((sum,tx)=>sum+Math.abs(tx.amount),0));
  const applicationReadinessRows=postedRows.filter(tx=>{const c=classificationFor(tx);return Boolean(c&&["security_deposit_received","security_deposit_applied"].includes(c.treatment)&&(c.deposit_applications??[]).some(app=>typeof app.date==="string"&&app.date>=taxStart&&app.date<=taxEnd));});
  const taxMortgageRows=taxRows.filter(tx=>taxMortgageIds.has(tx.transaction_id));
  const readinessRows=[...new Map([...taxRows,...applicationReadinessRows,...taxMortgageRows].map(tx=>[tx.transaction_id,tx])).values()];
  const readinessUnresolvedRows=readinessRows.filter(tx=>{const c=classificationFor(tx);return !c||c.treatment==="needs_review"||!c.reviewed||c.treatment==="personal_exclude"&&!c.reviewed||["security_deposit_received","security_deposit_applied"].includes(c.treatment)&&validReceiptById.get(tx.transaction_id)!==true;});
  const readinessUnresolvedIds=new Set([...readinessUnresolvedRows.map(tx=>tx.transaction_id),...taxMortgageIds]);
  const yearUnresolved=readinessUnresolvedIds.size;
  const totalPosted=readinessRows.length;
  for (const tx of allRows) if (!renderable.some(row=>row.transaction_id===tx.transaction_id) && (currentApplicationSourceIds.has(tx.transaction_id)||reviewApplicationSourceIds.has(tx.transaction_id)||taxRows.some(t=>t.transaction_id===tx.transaction_id)||classificationById.has(tx.transaction_id))) {
    const c=classificationFor(tx);
    const m=mortgageChecks.get(tx.transaction_id),mortgageConfirmed=Boolean(c?.treatment==="mortgage_payment"&&c.reviewed&&m?.valid&&m.complete);
    renderable.push({...tx,rental_treatment:c?.treatment??"needs_review",rental_category:c?.category??"needs_review",rental_reviewed:c?.reviewed??false,rental_notes:c?.notes??null,rental_deposit_applications:c?.deposit_applications??[],rental_recognized_deposit_applications:c&&validReceiptById.get(tx.transaction_id)===true?(c.deposit_applications??[]).filter(a=>a.date>=period.start_date&&a.date<=period.end_date):[],rental_tax_deposit_applications:c&&c.reviewed&&validReceiptById.get(tx.transaction_id)===true?(c.deposit_applications??[]).filter(a=>a.date>=taxStart&&a.date<=taxEnd):[],deposit_received_transaction_id:c?.deposit_received_transaction_id??null,rental_mortgage_split:c?.mortgage_split??null,rental_mortgage_allocations:mortgageConfirmed?m!.allocations:[],rental_mortgage_likely:isLikelyMortgage(tx)&&(!c||c.treatment==="needs_review"&&!c.reviewed),rental_contributions:contributions.get(tx.transaction_id)} as RentalTransaction);
  }
  for (const row of renderable) row.rental_contributions = contributions.get(row.transaction_id);
  for (const row of renderable) row.rental_contributions = contributions.get(row.transaction_id);
  return {
    household_id, scope: { type: scope.type, canonical_account_ids: [...scope.canonical_account_ids] }, period,
    posted_only: !input.include_pending,
    income: roundMoney(incomeTotal), expenses: roundMoney(expenseTotal), net_income: roundMoney(incomeTotal - expenseTotal),
    cash_in: roundMoney(cashIn), cash_out: roundMoney(cashOut), net_cash_flow: roundMoney(cashIn - cashOut),
    income_categories: stableBuckets(income), expense_categories: stableBuckets(expenses), cash_flow_categories: stableBuckets(cash), non_pnl_categories: stableBuckets(nonPnl),
    review: { count: reviewIds.length, amount: reviewAmount, transaction_ids: reviewIds },
    tax_summary: { tax_year: taxYear, categories: stableBuckets(tax), transaction_ids: [...new Set(stableBuckets(tax).flatMap(c => c.transaction_ids))], complete:taxMortgageIds.size===0, mortgage_review:{count:taxMortgageIds.size,amount:taxMortgageReviewAmount,transaction_ids:taxMortgageReviewIds} },
    pnl_complete:periodMortgageIds.size===0,
    mortgage_review:{count:periodMortgageIds.size,amount:periodMortgageReviewAmount,transaction_ids:periodMortgageReviewIds},
    year_end_readiness: { reviewed_percent: totalPosted ? Math.round((totalPosted - yearUnresolved) / totalPosted * 100) : 100, total_posted: totalPosted, unresolved: yearUnresolved, transaction_ids: [...readinessUnresolvedIds] },
    security_deposits: { opening_held: roundMoney(depositOpening), received: roundMoney(depositReceived), returned: roundMoney(depositReturned), applied: roundMoney(depositApplied), ending_held: roundMoney(depositOpening + depositReceived - depositReturned - depositApplied), coverage_uncertain: !validReceiptIds.size || [...classificationById.values()].some(c => c.treatment === "security_deposit_returned" && (!c.deposit_received_transaction_id || !validReceiptIds.has(c.deposit_received_transaction_id))), transaction_ids: [...depositIds], opening_breakdown:openingBreakdown, received_breakdown:receivedBreakdown, returned_breakdown:returnedBreakdown, applied_breakdown:appliedBreakdown, ending_breakdown:endingBreakdown },
    transactions: [...renderable, ...postedRows.filter(tx => { const c = classificationFor(tx); return (currentApplicationSourceIds.has(tx.transaction_id) || reviewApplicationSourceIds.has(tx.transaction_id) || taxRows.some(yearTx => yearTx.transaction_id === tx.transaction_id) || Boolean(c && ["security_deposit_received","security_deposit_applied","security_deposit_returned"].includes(c.treatment))) && !renderable.some(r => r.transaction_id === tx.transaction_id); }).map(tx => { const c = classificationFor(tx); return { ...tx, rental_treatment: c?.treatment ?? "needs_review", rental_category: c?.category ?? "needs_review", rental_reviewed: c?.reviewed ?? false, rental_notes: c?.notes ?? null, rental_deposit_applications: c?.deposit_applications ?? [], rental_recognized_deposit_applications: c && validReceiptById.get(tx.transaction_id) === true ? (c.deposit_applications ?? []).filter(app => app.date >= period.start_date && app.date <= period.end_date) : [], rental_tax_deposit_applications: c && c.reviewed && validReceiptById.get(tx.transaction_id) === true ? (c.deposit_applications ?? []).filter(app => app.date >= taxStart && app.date <= taxEnd) : [], rental_contributions: contributions.get(tx.transaction_id) }; })] as RentalTransaction[],
  };
}

export function rentalPeriodFor(type: RentalPeriod["type"], referenceDate = new Date(), custom?: { start_date: string; end_date: string }): RentalPeriod {
  if (type === "custom") {
    if (!custom) throw new Error("Choose a custom date range.");
    assertIsoDate(custom.start_date, "period start date"); assertIsoDate(custom.end_date, "period end date");
    if (custom.start_date > custom.end_date) throw new Error("Period start must be on or before its end.");
    return { type, ...custom, label: `${custom.start_date} – ${custom.end_date}` };
  }
  const y = referenceDate.getFullYear(), m = referenceDate.getMonth();
  if (type === "year") return { type, start_date: `${y}-01-01`, end_date: `${y}-12-31`, label: String(y) };
  if (type === "quarter") { const q = Math.floor(m / 3); const startMonth = q * 3; const endDate = new Date(y, startMonth + 3, 0); return { type, start_date: `${y}-${String(startMonth + 1).padStart(2, "0")}-01`, end_date: `${y}-${String(startMonth + 3).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`, label: `Q${q + 1} ${y}` }; }
  return { type: "month", start_date: `${y}-${String(m + 1).padStart(2, "0")}-01`, end_date: `${y}-${String(m + 1).padStart(2, "0")}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, "0")}`, label: referenceDate.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
}

/** Deterministic CSV that keeps bank movements distinct from noncash deposit applications. */
export function buildRentalCsv(report: RentalReport, accountNames: Record<string, string> = {}): string {
  const columns = ["row_type","date","merchant","description","amount","account","rental_treatment","rental_category","household_category","notes","transaction_id","posted","bank_amount","cash_effect","pnl_income","pnl_expense","application_reason","mortgage_component","mortgage_source_type","mortgage_source_reference"];
  const quote = (value: unknown) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines: string[] = [columns.map(quote).join(",")];
  const rows = report.transactions ?? [];
  for (const tx of rows) {
    const txDate = String(tx.effective_transaction_date ?? "");
    const transactionInRange = txDate >= report.period.start_date && txDate <= report.period.end_date;
    const treatment = String(tx.rental_treatment ?? "needs_review");
    const category = categoryKey(String(tx.rental_category ?? "needs_review"));
    if (transactionInRange && (!report.posted_only || !tx.pending)) {
      const amount = Number(tx.amount), contribution=tx.rental_contributions;
      const depositReceipt = treatment === "security_deposit_received" || treatment === "security_deposit_applied";
      const income = depositReceipt ? 0 : contribution?.pnl_income ?? (treatment === "rental_income" && INCOME_CATEGORIES.has(category) ? -amount : 0);
      const expense = treatment==="mortgage_payment"?0:contribution?.pnl_expense ?? (treatment === "operating_expense" && EXPENSE_CATEGORIES.has(category) ? amount : 0);
      lines.push(["transaction",txDate,tx.effective_merchant_name ?? tx.name ?? "",tx.original_description ?? tx.name ?? "",amount,accountNames[tx.canonical_account_id] ?? tx.canonical_account_id,treatment,category,tx.effective_category ?? "",tx.rental_notes ?? tx.notes ?? "",tx.transaction_id,tx.pending ? "false" : "true",amount,-amount,income,expense,"","",tx.rental_mortgage_split?.source?.type??"",tx.rental_mortgage_split?.source?.reference??""] .map(quote).join(","));
      for(const allocation of tx.rental_mortgage_allocations??[]){const isExpense=allocation.component==="interest"||allocation.component==="fees"&&Boolean(allocation.category);lines.push(["mortgage_allocation",txDate,tx.effective_merchant_name??tx.name??"Mortgage payment",`Mortgage ${allocation.component}`,allocation.amount,accountNames[tx.canonical_account_id]??tx.canonical_account_id,"mortgage_payment",allocation.category??allocation.component,tx.effective_category??"",tx.rental_notes??tx.notes??"",tx.transaction_id,tx.pending?"false":"true",0,0,0,isExpense?allocation.amount:0,"",allocation.component,tx.rental_mortgage_split?.source?.type??"",tx.rental_mortgage_split?.source?.reference??""] .map(quote).join(","));}
    }
    const apps = Array.isArray(tx.rental_recognized_deposit_applications) ? tx.rental_recognized_deposit_applications as DepositApplication[] : [];
    for (const app of apps) {
      if (app.date < report.period.start_date || app.date > report.period.end_date) continue;
      lines.push(["deposit_application",app.date,tx.effective_merchant_name ?? tx.name ?? "Security deposit",`Security deposit applied: ${app.reason}`,app.amount,accountNames[tx.canonical_account_id] ?? tx.canonical_account_id,"security_deposit_applied",app.category,tx.effective_category ?? "",tx.rental_notes ?? tx.notes ?? "",tx.transaction_id,"true",0,0,app.amount,0,app.reason,"","",""] .map(quote).join(","));
    }
  }
  return lines.join("\r\n");
}
