import {
  isAssistantWatch,
  isRecord,
  type AssistantWatch,
  type AssistantWatchPreview,
} from "./folio-assistant-contract";

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validLocalTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 64) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

/** Finance transaction IDs may be opaque Plaid text, unlike UUID message IDs. */
export function isAssistantTransactionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasCorrectScheduledInstant(schedule: NonNullable<AssistantWatch["schedule"]>): boolean {
  const instant = Date.parse(schedule.due_at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(schedule.due_at) || !Number.isFinite(instant) || !Number.isInteger(schedule.utc_offset_minutes) || Math.abs(schedule.utc_offset_minutes) > 14 * 60) return false;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  const zoneDate = `${get("year")}-${get("month")}-${get("day")}`;
  const zoneTime = `${get("hour")}:${get("minute")}`;
  const zoneOffset = Math.round((Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), Number(get("hour")), Number(get("minute"))) - Math.floor(instant / 60_000) * 60_000) / 60_000);
  return zoneDate === schedule.local_date && zoneTime === schedule.local_time && zoneOffset === schedule.utc_offset_minutes &&
    new Date(instant).getUTCSeconds() === 0 && new Date(instant).getUTCMilliseconds() === 0;
}

function validUtcInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

/** Validate structured, server-signed review details before allowing confirmation. */
export function parseAssistantWatchPreview(value: unknown): AssistantWatchPreview | null {
  if (!isRecord(value) || !isAssistantWatch(value) ||
      typeof value.timing_note !== "string" || !value.timing_note.trim() || value.timing_note.length > 700 ||
      typeof value.push_available !== "boolean") return null;

  if (value.template !== "one_time_follow_up" && value.template !== "expected_refund") {
    return value as unknown as AssistantWatchPreview;
  }

  if (!value.schedule ||
      !validCalendarDate(value.schedule.local_date) || !validLocalTime(value.schedule.local_time) ||
      !validTimeZone(value.schedule.timezone) || !hasCorrectScheduledInstant(value.schedule) ||
      !validUtcInstant(value.expires_at) || Date.parse(value.schedule.due_at) <= Date.now() ||
      Date.parse(value.expires_at) <= Date.parse(value.schedule.due_at) ||
      (value.delivery !== "chat" && value.delivery !== "chat_and_push")) return null;

  if (value.template === "one_time_follow_up") {
    const followUp = value.follow_up;
    if (!followUp || !["reminder", "cash_flow", "budget", "recurring", "account_health"].includes(followUp.check)) return null;
    if (followUp.check === "reminder" && (!followUp.reminder_text?.trim() || followUp.reminder_text.length > 280)) return null;
    if (followUp.check === "budget" && !followUp.category_name?.trim()) return null;
    if (followUp.check !== "budget" && followUp.category_name !== undefined) return null;
    if (followUp.check !== "reminder" && followUp.reminder_text !== undefined) return null;
  } else {
    const refund = value.refund;
    if (!refund || !isAssistantTransactionId(refund.original_transaction_id) ||
        !validCalendarDate(refund.expected_by_date) || !validCalendarDate(refund.original_date) ||
        refund.expected_by_date !== value.schedule.local_date || !refund.original_merchant.trim() ||
        !Number.isSafeInteger(refund.expected_amount_minor) || refund.expected_amount_minor <= 0 ||
        !Number.isSafeInteger(refund.original_amount_minor) || refund.original_amount_minor <= 0 ||
        !Number.isSafeInteger(refund.baseline_received_minor) || refund.baseline_received_minor < 0 ||
        refund.baseline_received_minor >= refund.expected_amount_minor ||
        refund.expected_amount_minor > refund.original_amount_minor || refund.currency !== "USD") return null;
    try { new Intl.NumberFormat("en-US", { style: "currency", currency: refund.currency }); }
    catch { return null; }
  }

  return value as unknown as AssistantWatchPreview;
}

export function formatAssistantDate(value: string): string {
  if (!validCalendarDate(value)) return "Date unavailable";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function formatAssistantClock(value: string): string {
  if (!validLocalTime(value)) return "time unavailable";
  const [hour, minute] = value.split(":").map(Number);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatAssistantOffset(minutesEastOfUtc: number): string {
  const sign = minutesEastOfUtc < 0 ? "−" : "+";
  const magnitude = Math.abs(minutesEastOfUtc);
  return `UTC${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
}

export function formatAssistantMinorAmount(amountMinor: number, currency: string): string | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / (10 ** exponent));
  } catch { return null; }
}

export function formatAssistantInstant(value: string, timezone: string): string | null {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || !validTimeZone(timezone)) return null;
  try {
    const date = new Date(instant);
    const parts = new Intl.DateTimeFormat(undefined, {
      weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h12", timeZone: timezone,
    }).format(date);
    const offset = Math.round((Date.UTC(
      Number(new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric" }).format(date)),
      Number(new Intl.DateTimeFormat("en", { timeZone: timezone, month: "numeric" }).format(date)) - 1,
      Number(new Intl.DateTimeFormat("en", { timeZone: timezone, day: "numeric" }).format(date)),
      Number(new Intl.DateTimeFormat("en", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(date)),
      Number(new Intl.DateTimeFormat("en", { timeZone: timezone, minute: "numeric" }).format(date)),
    ) - Math.floor(instant / 60_000) * 60_000) / 60_000);
    return `${parts} ${timezone} (${formatAssistantOffset(offset)})`;
  } catch { return null; }
}

export function assistantWatchOutcomeLabel(outcome: AssistantWatch["last_outcome"]): string {
  switch (outcome) {
    case "pending": return "Waiting for the next check";
    case "completed": return "Follow-up completed";
    case "received": return "Refund received · verified against a linked posted transaction";
    case "partial": return "Partial refund · verified posted receipts so far";
    case "not_received": return "No refund verified by the expected date";
    case "needs_review": return "Needs review · Folio could not confirm a unique refund match";
    case "unavailable": return "Check unavailable · Folio could not verify current data";
    case "missed": return "Missed · no check completed before the review window ended";
    default: return "No check yet";
  }
}
