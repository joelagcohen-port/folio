export type CategoryCatalogRow = {
  category_name: string;
  category_type: "income" | "expense" | "transfer";
  group_name?: string;
  emoji?: string;
};

export const builtInNonExpenseCategories: CategoryCatalogRow[] = [
  { category_type: "income", group_name: "Income", category_name: "Paychecks", emoji: "💵" },
  { category_type: "income", group_name: "Income", category_name: "Interest", emoji: "💸" },
  { category_type: "income", group_name: "Income", category_name: "Business Income", emoji: "💰" },
  { category_type: "income", group_name: "Income", category_name: "Other Income", emoji: "💰" },
  { category_type: "income", group_name: "Income", category_name: "Dividends & Capital Gains", emoji: "📈" },
  { category_type: "transfer", group_name: "Transfers", category_name: "Transfer", emoji: "🔁" },
  { category_type: "transfer", group_name: "Transfers", category_name: "Credit Card Payment", emoji: "💳" },
  { category_type: "transfer", group_name: "Transfers", category_name: "Balance Adjustments", emoji: "⚖️" },
  { category_type: "transfer", group_name: "Transfers", category_name: "Buy", emoji: "➡️" },
  { category_type: "transfer", group_name: "Transfers", category_name: "Sell", emoji: "⬅️" },
];

const aliases = new Map([
  ["payment", "Credit Card Payment"],
  ["credit payment", "Credit Card Payment"],
  ["card payment", "Credit Card Payment"],
  ["credit card payments", "Credit Card Payment"],
  ["paycheck", "Paychecks"],
  ["salary", "Paychecks"],
]);

const normalize = (value: unknown) => String(value || "").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

export function mergeCategoryCatalog(expenseCategories: unknown): CategoryCatalogRow[] {
  const rows = Array.isArray(expenseCategories) ? expenseCategories : [];
  const expenses = rows.flatMap((item): CategoryCatalogRow[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.category_name !== "string" || row.category_type !== "expense") return [];
    return [{
      category_name: row.category_name,
      category_type: "expense",
      group_name: typeof row.group_name === "string" ? row.group_name : undefined,
      emoji: typeof row.emoji === "string" ? row.emoji : undefined,
    }];
  });
  const seen = new Set<string>();
  return [...builtInNonExpenseCategories, ...expenses].filter((row) => {
    const key = normalize(row.category_name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function canonicalCategoryName(value: unknown, catalog: CategoryCatalogRow[], expenseOnly = false): string | null {
  const requested = normalize(value);
  if (!requested) return null;
  const allowed = expenseOnly ? catalog.filter((row) => row.category_type === "expense") : catalog;
  const exact = allowed.find((row) => normalize(row.category_name) === requested);
  if (exact) return exact.category_name;
  const alias = aliases.get(requested);
  if (!alias) return null;
  return allowed.find((row) => normalize(row.category_name) === normalize(alias))?.category_name ?? null;
}

export function canonicalizeCategoryActions<T extends { tool: string; args: Record<string, unknown> }>(actions: T[], catalog: CategoryCatalogRow[]) {
  const categoryTools = new Set(["save_budget_target", "update_transaction", "save_categorization_rule", "refund_relationship"]);
  const invalid: string[] = [];
  const canonicalized = actions.map((action) => {
    if (!categoryTools.has(action.tool) || typeof action.args.category !== "string") return action;
    const category = canonicalCategoryName(action.args.category, catalog, action.tool === "save_budget_target");
    if (!category) {
      invalid.push(action.args.category);
      return action;
    }
    return { ...action, args: { ...action.args, category } };
  });
  return { actions: canonicalized, invalid: [...new Set(invalid)] };
}
