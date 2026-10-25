type Scope = 'ask_folio' | 'coaching' | 'scenario';

async function authenticatedRpc(name: string, authorization: string, body: Record<string, unknown>) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!base || !key || !authorization.startsWith('Bearer ')) return null;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3500),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function hasActiveFolioSession(authorization: string) {
  const result = await authenticatedRpc('folio_validate_current_session', authorization, {});
  return result === true ? { active: true, unavailable: false } : result === false
    ? { active: false, unavailable: false }
    : { active: false, unavailable: true };
}

export async function takeFolioModelToken(scope: Scope, authorization: string) {
  const result = await authenticatedRpc('folio_take_model_rate_token', authorization, { p_scope: scope });
  if (!result || typeof result !== 'object' || typeof (result as any).allowed !== 'boolean') {
    return { allowed: false, unavailable: true, code: 'security_check_unavailable' as const, retryAfterSeconds: 60 };
  }
  const retryAfter = Number((result as any).retry_after_seconds);
  return { allowed: (result as any).allowed === true, unavailable: false, code: String((result as any).code || 'denied'), retryAfterSeconds: Number.isInteger(retryAfter) ? Math.max(1, Math.min(3600, retryAfter)) : 60 };
}
