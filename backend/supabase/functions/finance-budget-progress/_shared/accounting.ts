/**
 * Household accounting contract for finance_effective_transactions.
 *
 * The effective view owns reconciliation (including pending/posted replacement
 * and cross-account payment mirrors). A row can remain visible in transaction
 * history while being excluded from household spending or cash flow.
 */
export type AccountingTransaction = Record<string, any>;

export function countsTowardBudget(tx: AccountingTransaction): boolean {
  return tx?.effective_type === "expense" &&
    tx?.excluded_from_totals !== true &&
    tx?.category_excluded_from_budget !== true &&
    tx?.transaction_excluded_from_budget !== true;
}

export function countsTowardCashFlowExpense(tx: AccountingTransaction): boolean {
  return tx?.effective_type === "expense" &&
    tx?.excluded_from_totals !== true &&
    tx?.category_excluded_from_cash_flow !== true &&
    tx?.transaction_excluded_from_cash_flow !== true;
}

/** Eligible effective rows for a Cash Flow aggregation, including inflows. */
export function countsTowardCashFlow(tx: AccountingTransaction): boolean {
  if (tx?.excluded_from_totals === true ||
    tx?.category_excluded_from_cash_flow === true ||
    tx?.transaction_excluded_from_cash_flow === true) return false;
  return ["income", "expense", "refund", "other_inflow"].includes(String(tx?.effective_type ?? ""));
}

/**
 * Return forecastable variable spending after actual spending and known bills
 * have already been accounted for. Do not replace this with a recurring-only
 * projection: unreserved projected spending must remain in the cash forecast.
 */
export function projectedVariableSpend(projectedCategorySpend: number, alreadySpent: number, knownRecurringReserve: number): number {
  return Math.max(0, projectedCategorySpend - alreadySpent - knownRecurringReserve);
}

