export async function currentSessionActive(url: string, anonKey: string, authorization: string): Promise<boolean> {
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/folio_validate_current_session`, { method: "POST", headers: { apikey: anonKey, authorization, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3500) });
  if (!response.ok) throw new Error("Could not verify the active session.");
  return await response.json() === true;
}
