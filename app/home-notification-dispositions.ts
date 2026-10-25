export type HomeNotificationDisposition = {
  disposition: "dismissed" | "snoozed";
  snoozed_until: string | null;
  updated_at: string;
};

export type HomeNotificationDispositions = Record<string, HomeNotificationDisposition>;

const MAX_DISPOSITIONS = 200;
const MAX_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000 + 60_000;

export function homeRefundDispositionKey(transactionId: unknown): string | null {
  if (typeof transactionId !== "string") return null;
  const id = transactionId.trim();
  if (!id || id.length > 180 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return `refund:${id}`;
}

export function homeActivityDispositionKey(action: unknown): string | null {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const row = action as Record<string, unknown>;
  const id = String(row.action_id || row.id || (row.created_at && row.action_type ? `${row.created_at}|${row.action_type}` : "")).trim();
  if (!id || id.length > 180 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return `activity:${id}`;
}

export function validHomeNotificationDispositionKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const [kind, ...parts] = key.split(":");
  const id = parts.join(":");
  if (!id || id.length > 180 || /[\u0000-\u001f\u007f]/.test(id)) return false;
  return kind === "refund" ? homeRefundDispositionKey(id) === key : kind === "activity";
}

export function parseHomeNotificationDispositions(value: unknown, now = Date.now()): HomeNotificationDispositions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const valid: Array<[string, HomeNotificationDisposition]> = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!validHomeNotificationDispositionKey(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.disposition !== "dismissed" && item.disposition !== "snoozed") continue;
    if (typeof item.updated_at !== "string" || !Number.isFinite(Date.parse(item.updated_at))) continue;
    let snoozedUntil: string | null = null;
    if (item.disposition === "snoozed") {
      if (typeof item.snoozed_until !== "string") continue;
      const until = Date.parse(item.snoozed_until);
      const updated = Date.parse(item.updated_at);
      if (!Number.isFinite(until) || until <= now || until <= updated || until - updated > MAX_SNOOZE_MS) continue;
      snoozedUntil = new Date(until).toISOString();
    } else if (item.snoozed_until !== null) continue;
    valid.push([key, { disposition: item.disposition, snoozed_until: snoozedUntil, updated_at: new Date(Date.parse(item.updated_at)).toISOString() }]);
  }
  valid.sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at));
  return Object.fromEntries(valid.slice(0, MAX_DISPOSITIONS));
}

export function homeRefundIsSuppressed(transactionId: unknown, dispositions: unknown, now = Date.now()): boolean {
  const key = homeRefundDispositionKey(transactionId);
  if (!key) return false;
  const entry = parseHomeNotificationDispositions(dispositions, now)[key];
  return entry?.disposition === "dismissed" || Boolean(entry?.disposition === "snoozed" && entry.snoozed_until && Date.parse(entry.snoozed_until) > now);
}

export function setHomeRefundDisposition(
  dispositions: unknown,
  transactionId: unknown,
  disposition: "dismissed" | "snoozed",
  now = Date.now(),
): HomeNotificationDispositions | null {
  const key = homeRefundDispositionKey(transactionId);
  if (!key) return null;
  const updated = new Date(now).toISOString();
  const next: HomeNotificationDispositions = {
    ...parseHomeNotificationDispositions(dispositions, now),
    [key]: {
      disposition,
      snoozed_until: disposition === "snoozed" ? new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString() : null,
      updated_at: updated,
    },
  };
  return parseHomeNotificationDispositions(next, now);
}

export function setHomeActivityDisposition(
  dispositions: unknown,
  key: unknown,
  disposition: "dismissed" | "snoozed",
  now = Date.now(),
): HomeNotificationDispositions | null {
  if (typeof key !== "string" || !key.startsWith("activity:") || !validHomeNotificationDispositionKey(key)) return null;
  const updated = new Date(now).toISOString();
  const next: HomeNotificationDispositions = {
    ...parseHomeNotificationDispositions(dispositions, now),
    [key]: {
      disposition,
      snoozed_until: disposition === "snoozed" ? new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString() : null,
      updated_at: updated,
    },
  };
  return parseHomeNotificationDispositions(next, now);
}
