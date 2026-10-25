type Row = Record<string, unknown>;

const boundedText = (value: unknown, limit = 120): string | null => {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, limit) : null;
};

function merchantCounterparties(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function primaryMerchantCounterparty(transaction: Row): Row | null {
  const candidates = merchantCounterparties(transaction.counterparties)
    .filter((item) => item.type === "merchant");
  if (!candidates.length) return null;
  const id = boundedText(transaction.merchant_entity_id, 180);
  if (id) return candidates.find((item) => boundedText(item.entity_id, 180) === id) ?? null;
  return candidates[0] ?? null;
}

export function safeBusinessLocation(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row;
  const result: Record<string, string> = {};
  for (const key of ["city", "region", "postal_code", "country"] as const) {
    const text = boundedText(row[key], key === "postal_code" ? 24 : 80);
    if (text) result[key] = text;
  }
  return Object.keys(result).length ? result : null;
}

export function safeMerchantWebsite(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const clean = value.trim();
    const bareDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(clean);
    if (!clean.startsWith("https://") && !bareDomain) return null;
    const url = new URL(bareDomain ? `https://${clean}` : clean);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const labels = host.split(".");
    const validDns = labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) && /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels.at(-1) || "");
    const ipLiteral = host.startsWith("[") || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host);
    const privateSuffix = ["localhost", "local", "internal", "test", "invalid", "example", "onion"];
    if (url.protocol !== "https:" || !validDns || ipLiteral || url.port || url.username || url.password ||
        privateSuffix.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    url.hostname = host;
    return url.origin;
  } catch {
    return null;
  }
}

/** Keep only merchant business metadata; never persist precise coordinates or free-form location payloads. */
export function merchantMetadataFromTransaction(transaction: unknown): {
  merchant_entity_id: string | null;
  location: Record<string, string> | null;
  website: string | null;
} {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return { merchant_entity_id: null, location: null, website: null };
  }
  const row = transaction as Row;
  const counterparty = primaryMerchantCounterparty(row);
  return {
    merchant_entity_id: boundedText(row.merchant_entity_id, 180) ?? boundedText(counterparty?.entity_id, 180),
    location: safeBusinessLocation(row.location) ?? safeBusinessLocation(counterparty?.location),
    website: safeMerchantWebsite(row.website) ?? safeMerchantWebsite(counterparty?.website),
  };
}
