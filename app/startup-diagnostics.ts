const HOST_STAGES = new Set([
  "boot_started", "theme_resolved", "session_restore_started", "session_restored",
  "session_expired", "dashboard_iframe_loaded", "shell_rendered", "cached_snapshot_available",
  "first_meaningful_content", "fresh_state_committed", "agent_refresh_completed", "session_ready", "cache_ready", "shell_ready", "core_state_ready", "degraded", "boot_failed", "boot_watchdog", "core_watchdog",
]);

export const STARTUP_DIAGNOSTIC_RESOURCES = [
  "folio-guided.js", "folio-coaching.js", "folio-savings.js",
  "folio-recurring-history.js", "folio-rental.js", "folio-select.js",
  "folio-guided.css", "folio-coaching.css", "folio-select.css",
  "folio-rental.css", "folio-refund.css",
] as const;

const CHILD_STAGES = new Set([
  "document_start", "script_loaded", "script_error", "runtime_error",
  "stylesheet_loaded", "stylesheet_error", "unhandled_rejection", "app_ready",
  "boot_started", "session_restore_started", "session_ready", "cache_ready", "shell_ready", "core_state_ready",
  "degraded", "boot_failed", "boot_watchdog", "core_watchdog", "optional_feature_failed", "initial_render_failed", "secondary_feature_failed", "core_refresh_failed", "renderer_failed",
]);
const ERROR_NAMES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError", "AbortError", "TimeoutError", "unknown"]);
const REJECTION_TYPES = new Set([...ERROR_NAMES, "string", "number", "boolean", "object", "null", "undefined"]);
const ERROR_SOURCES = new Set(["/dashboard", "dashboard.html", ...STARTUP_DIAGNOSTIC_RESOURCES.filter((asset) => asset.endsWith(".js"))]);

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};
const option = (value: unknown, allowed: readonly string[], fallback = "unknown") =>
  typeof value === "string" && allowed.includes(value) ? value : fallback;
const yesNo = (value: unknown) => value === true ? "yes" : value === false ? "no" : "unknown";
const safeMs = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 600_000 ? Math.round(value) : null;

export type StartupChildMilestone = { stage: string; asset?: string; ms?: number; phase?: string; errorClass?: string; errorName?: string; errorType?: string; source?: string; line?: number; column?: number };

export function sanitizeStartupMilestone(value: unknown): StartupChildMilestone | null {
  const item = record(value);
  if (typeof item.stage !== "string" || !CHILD_STAGES.has(item.stage)) return null;
  const result: StartupChildMilestone = { stage: item.stage };
  if (typeof item.asset === "string" && (STARTUP_DIAGNOSTIC_RESOURCES as readonly string[]).includes(item.asset)) result.asset = item.asset;
  const ms = safeMs(item.ms);
  if (ms !== null) result.ms = ms;
  const phases = ["BOOTING", "SESSION_RESTORING", "SESSION_READY", "CACHE_READY", "SHELL_READY", "CORE_STATE_READY", "DEGRADED", "APP_READY", "FAILED"];
  if (typeof item.phase === "string" && phases.includes(item.phase)) result.phase = item.phase;
  if (typeof item.errorClass === "string" && ERROR_NAMES.has(item.errorClass)) result.errorClass = item.errorClass;
  if (item.stage === "runtime_error") {
    if (typeof item.errorName === "string" && ERROR_NAMES.has(item.errorName)) result.errorName = item.errorName;
    if (typeof item.source === "string" && ERROR_SOURCES.has(item.source)) result.source = item.source;
    for (const key of ["line", "column"] as const) {
      const position = item[key];
      if (typeof position === "number" && Number.isSafeInteger(position) && position >= 0 && position <= 1_000_000) result[key] = position;
    }
  } else if (item.stage === "unhandled_rejection" && typeof item.errorType === "string" && REJECTION_TYPES.has(item.errorType)) {
    result.errorType = item.errorType;
  }
  return result;
}

export function formatStartupDiagnostics(value: unknown): string {
  const input = record(value);
  const frame = record(input.frame);
  const worker = record(input.serviceWorker);
  const cache = record(input.cache);
  const lines = ["Folio startup diagnostics", "No session, account, transaction, or financial values are included."];

  const timings = Array.isArray(input.timings) ? input.timings.flatMap((item) => {
    const row = record(item);
    const ms = safeMs(row.ms);
    return typeof row.stage === "string" && HOST_STAGES.has(row.stage) && ms !== null ? [`${row.stage}: ${ms} ms`] : [];
  }).slice(0, 16) : [];
  lines.push(`Host stages: ${timings.length ? timings.join("; ") : "none recorded"}`);

  lines.push(`Frame: path=${option(frame.path, ["/dashboard", "/dashboard.html", "other", "not-created"])}; load=${option(frame.load, ["pending", "loaded", "error"])}; access=${option(frame.access, ["same-origin", "blocked", "no-frame"])}; document=${option(frame.readyState, ["loading", "interactive", "complete"])}; dashboard-root=${yesNo(frame.root)}; app-ready=${yesNo(frame.appReady)}`);
  lines.push(`Service worker: controlled=${yesNo(worker.controlled)}; script=${option(worker.script, ["/sw.js", "other", "unknown"])}`);

  const dashboardCache = option(cache.dashboard, ["present", "missing", "unavailable"]);
  const assetCache = record(cache.assets);
  const assets = STARTUP_DIAGNOSTIC_RESOURCES.map((asset) => `${asset}=${option(assetCache[asset], ["present", "missing", "unavailable"])}`);
  lines.push(`Cache: dashboard=${dashboardCache}; resources=${assets.join(", ")}`);

  const milestones = Array.isArray(input.childMilestones)
    ? input.childMilestones.map(sanitizeStartupMilestone).filter((item): item is StartupChildMilestone => item !== null).slice(-24)
    : [];
  lines.push(`Dashboard milestones: ${milestones.length ? milestones.map((item) => {
    const runtime = item.stage === "runtime_error"
      ? `(${item.errorName ?? "unknown"}${item.source ? `@${item.source}${item.line === undefined ? "" : `:${item.line}${item.column === undefined ? "" : `:${item.column}`}`}` : ""})`
      : item.stage === "unhandled_rejection" ? `(${item.errorType ?? "unknown"})`
      : item.errorClass ? `(${item.errorClass})`
      : item.phase ? `(${item.phase})`
      : item.asset ? `(${item.asset})` : "";
    return `${item.stage}${runtime}${item.ms === undefined ? "" : `@${item.ms}ms`}`;
  }).join("; ") : "none received"}`);
  return lines.join("\n");
}
