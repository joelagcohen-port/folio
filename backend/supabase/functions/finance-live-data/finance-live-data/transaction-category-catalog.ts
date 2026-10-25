type Row = Record<string, unknown>;

export async function readTransactionCategoryCatalog(db: any, householdId: string) {
  const { data, error } = await db
    .from("finance_categories")
    .select("category_id,category_name,category_type,group_name,active,excluded_from_budget,excluded_from_cash_flow")
    .eq("household_id", householdId)
    .eq("active", true)
    .order("group_name", { ascending: true })
    .order("category_name", { ascending: true });

  if (error || !Array.isArray(data)) throw new Error("The active household transaction categories are unavailable.");
  const transaction_categories = data.filter((row: Row) =>
    typeof row.category_id === "string" && typeof row.category_name === "string" &&
    typeof row.group_name === "string" && ["expense", "income", "transfer"].includes(String(row.category_type)) &&
    row.active === true,
  ).map((row: Row) => ({
    category_id: row.category_id,
    category_name: row.category_name,
    category_type: row.category_type,
    group_name: row.group_name,
    active: true,
    excluded_from_budget: row.excluded_from_budget === true,
    excluded_from_cash_flow: row.excluded_from_cash_flow === true,
  }));
  return { transaction_categories };
}
