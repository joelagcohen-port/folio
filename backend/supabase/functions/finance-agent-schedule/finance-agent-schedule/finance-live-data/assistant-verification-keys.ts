export function loadAssistantVerificationKeys(): Record<string, JsonWebKey> {
  const configured = Deno.env.get("FOLIO_ASSISTANT_VERIFY_KEYS_JSON");
  if (!configured) return Object.create(null) as Record<string, JsonWebKey>;
  try {
    const parsed: unknown = JSON.parse(configured);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null) as Record<string, JsonWebKey>;
    const keys = Object.create(null) as Record<string, JsonWebKey>;
    for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (candidate.kty !== "EC" || candidate.crv !== "P-256" || candidate.alg !== "ES256" || candidate.ext !== true ||
          (candidate.key_ops !== undefined && (!Array.isArray(candidate.key_ops) || !candidate.key_ops.every((op) => op === "verify"))) ||
          typeof candidate.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(candidate.x) ||
          typeof candidate.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(candidate.y) || 
          (candidate.kid !== undefined && candidate.kid !== kid) || "d" in candidate) continue;
      keys[kid] = { key_ops: ["verify"], ext: true, kty: "EC", crv: "P-256", alg: "ES256", x: candidate.x, y: candidate.y };
    }
    return keys;
  } catch {
    return Object.create(null) as Record<string, JsonWebKey>;
  }
}
