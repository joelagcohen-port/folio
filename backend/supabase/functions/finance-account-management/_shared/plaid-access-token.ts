export async function resolvePlaidAccessToken(db: any, itemId: string, stored: string): Promise<string> {
  if (!stored.startsWith("vault:")) return stored;
  const { data, error } = await db.rpc("finance_resolve_plaid_access_token", { p_item_id: itemId });
  if (error || typeof data !== "string" || !data) throw new Error("Plaid credential unavailable.");
  return data;
}


