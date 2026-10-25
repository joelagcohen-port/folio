export const DEFAULT_CALENDAR_TIME_ZONE = "UTC";

/** Validate request timezone context without accepting a client-selected date. */
export function resolveCalendarTimeZone(value: unknown, fallback = DEFAULT_CALENDAR_TIME_ZONE): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new RangeError("Invalid calendar time zone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new RangeError("Invalid calendar time zone.");
  }
  return value;
}

/** Format an instant as a calendar date in the requested zone. */
export function calendarDate(value: Date, timeZone = DEFAULT_CALENDAR_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((row) => row.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

