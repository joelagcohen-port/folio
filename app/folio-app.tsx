"use client";

import { FolioAgentActionSheet } from './folio-agent-action-sheet';
import { FolioAssistantSettings } from './folio-assistant-settings';
import { DEFAULT_FOLIO2_TAB_ORDER, DEFAULT_FOLIO2_WIDGET_ORDER, parseFolio2TabOrder, parseFolio2WidgetOrder, type Folio2WidgetId } from './folio2-tab-order';
import { FolioNotificationSettings, disconnectPushDevice, notificationRequest } from './folio-notifications';
import { FolioEventDetail, cacheNotificationEvents, clearUserEventDetailCache } from './folio-event-detail';
import { createAppBadgeReconciler } from './app-badge';
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { Bell, ChartCandlestick, ChartNoAxesCombined, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Fingerprint, Goal, Home, HousePlus, Landmark, LayoutDashboard, Link2, ListOrdered, LogOut, Menu, Palette, ReceiptText, RefreshCw, Repeat2, ScanEye, Settings, ShieldCheck, Sparkles, WalletCards, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, FormEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AskFolioPanel } from "./ask-folio-panel";
import { FolioAlertsSheet, type FolioAlertRow } from "./folio-alerts-sheet";
import { FolioFilterSheet, type FolioFilterDraft } from "./folio-filter-sheet";
import { createStartupLifecycle, isTrustedDashboardReadyMessage, nextDashboardFrameKey } from "./startup-gates";
import { confirmFolioWorkerTarget, createFolioUpdateController, didFolioRecoveryLand, isFolioReloadSafe } from "./folio-update";
import { homeRefundDispositionKey, parseHomeNotificationDispositions, setHomeActivityDisposition, setHomeRefundDisposition, validHomeNotificationDispositionKey, type HomeNotificationDispositions } from "./home-notification-dispositions";
import { formatStartupDiagnostics, sanitizeStartupMilestone, STARTUP_DIAGNOSTIC_RESOURCES, type StartupChildMilestone } from "./startup-diagnostics";
import { FOLIO2_DEFAULT_ROUTE, FOLIO2_ROOT_TABS, folioAuthNavigationPath, folioDashboardPath, existingPageForFolio2Route, existingScrollTargetForFolio2Route, folio2NavigationSpec, isFolio2AccountSegment, isFolio2ActivitySegment, isFolio2NavigationOptedIn, isFolio2PlanSegment, isFolio2TabSelected, routeForExistingPage, routeForFolio2RootSelection, routeForFolio2Segment, type Folio2Route, type Folio2Root, type Folio2Segment } from "./folio2-navigation";

type AuthMode = "password" | "magic" | "request-reset" | "set-password";
type AppearanceMode = "light" | "dark" | "system" | "time";
type PasskeyStatus = "checking" | "on" | "off" | "unavailable";
type MenuRefreshState = { state: "idle" | "refreshing" | "background" | "success" | "partial" | "error"; completedAt: number | null };
type SettingsSection = "home" | "personalize" | "folio" | "data" | "security" | "advanced";
type FolioPreferences = {
  themeColor: string;
  themeMode: AppearanceMode;
  dismissedAlertKeys: string[];
  dismissedInsightKeys: string[];
  askFolioMemories: AskFolioMemory[];
  mobileTabOrder: MobileTabPage[];
  folio2TabOrder: Folio2Root[];
  folio2WidgetOrder: Folio2WidgetId[];
};
type FolioBootTheme = { userId: string | null; hasCachedPreference: boolean; mode: AppearanceMode; appearance: "light" | "dark"; color: string };
type StartupWindow = Window & {
  __folioBootTheme?: FolioBootTheme;
  __folioMarkStartup?: (stage: string) => void;
  __folioStartupTimings?: unknown;
};
type AskFolioMemory = { id: string; key: string; summary: string; kind: "goal" | "decision" | "completed_change"; createdAt: string; effectiveFrom?: string; effectiveUntil?: string };
const DEFAULT_MOBILE_TAB_ORDER: MobileTabPage[] = ["home", "dashboard", "spending", "recurring", "budget", "planning", "investments", "accounts", "transactions", "rental"];

const DEFAULT_PREFERENCES: FolioPreferences = {
  themeColor: "#0F5132",
  themeMode: "system",
  dismissedAlertKeys: [],
  dismissedInsightKeys: [],
  askFolioMemories: [],
  mobileTabOrder: DEFAULT_MOBILE_TAB_ORDER,
  folio2TabOrder: DEFAULT_FOLIO2_TAB_ORDER,
  folio2WidgetOrder: [...DEFAULT_FOLIO2_WIDGET_ORDER],
};
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const isAppearanceMode = (value: unknown): value is AppearanceMode => value === "light" || value === "dark" || value === "system" || value === "time";
const THEME_CACHE_PREFIX = "folio-theme-preference-v1:";
const FOLIO2_TAB_ORDER_CACHE_PREFIX = "folio2-tab-order-v1:";
function bootTheme(): FolioBootTheme | null {
  if (typeof window === "undefined") return null;
  return (window as StartupWindow).__folioBootTheme ?? null;
}
function markStartup(stage: string) {
  if (typeof window !== "undefined") (window as StartupWindow).__folioMarkStartup?.(stage);
}
function cacheThemePreference(userId: string, themeMode: AppearanceMode, themeColor: string) {
  try { localStorage.setItem(`${THEME_CACHE_PREFIX}${userId}`, JSON.stringify({ themeMode, themeColor })); } catch {}
}
function readCachedFolio2TabOrder(userId: string): Folio2Root[] | null {
  try {
    const value = localStorage.getItem(`${FOLIO2_TAB_ORDER_CACHE_PREFIX}${userId}`);
    return value ? parseFolio2TabOrder(JSON.parse(value)) : null;
  } catch { return null; }
}
function cacheFolio2TabOrder(userId: string, order: Folio2Root[]) {
  try { localStorage.setItem(`${FOLIO2_TAB_ORDER_CACHE_PREFIX}${userId}`, JSON.stringify(order)); } catch {}
}
function isLocallyValidSession(session: Session | null): session is Session {
  if (!session?.user?.id || !session.access_token) return false;
  return !Number.isFinite(session.expires_at) || Number(session.expires_at) > Math.floor(Date.now() / 1000);
}
function parseAskFolioMemories(value: unknown): AskFolioMemory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AskFolioMemory[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const summary = typeof row.summary === "string" ? row.summary.trim().slice(0, 280) : "";
    const kind = row.kind === "goal" || row.kind === "decision" || row.kind === "completed_change" ? row.kind : null;
    const createdAt = typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : new Date().toISOString();
    const key = typeof row.key === "string" && /^[a-z0-9:_-]{3,80}$/i.test(row.key) ? row.key : `legacy:${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`;
    const effectiveFrom = typeof row.effectiveFrom === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(row.effectiveFrom) ? row.effectiveFrom : undefined;
    const effectiveUntil = typeof row.effectiveUntil === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(row.effectiveUntil) ? row.effectiveUntil : undefined;
    return summary && kind ? [{ id: typeof row.id === "string" && row.id.length <= 100 ? row.id : crypto.randomUUID(), key, summary, kind, createdAt, effectiveFrom, effectiveUntil }] : [];
  }).slice(-24);
}
function verifiedAskFolioMemories(value: unknown): AskFolioMemory[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const isDate = (date: unknown) => date === undefined || typeof date === "string" && /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
  const rows: AskFolioMemory[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || row.id.length > 100 || typeof row.key !== "string" || !/^[a-z0-9:_-]{3,80}$/i.test(row.key) ||
        typeof row.summary !== "string" || row.summary.trim().length < 8 || row.summary.length > 280 ||
        !(row.kind === "goal" || row.kind === "decision" || row.kind === "completed_change") ||
        typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) ||
        !isDate(row.effectiveFrom) || !isDate(row.effectiveUntil) ||
        typeof row.effectiveFrom === "string" && typeof row.effectiveUntil === "string" && row.effectiveFrom > row.effectiveUntil) return null;
    rows.push({ id: row.id, key: row.key, summary: row.summary.trim(), kind: row.kind, createdAt: row.createdAt,
      ...(typeof row.effectiveFrom === "string" ? { effectiveFrom: row.effectiveFrom } : {}),
      ...(typeof row.effectiveUntil === "string" ? { effectiveUntil: row.effectiveUntil } : {}) });
  }
  return rows;
}
function openOptionalBroadcastChannel(name: string): BroadcastChannel | null {
  try { return typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null; }
  catch { return null; }
}
function postOptionalBroadcastMessage(channel: BroadcastChannel | null, message: unknown) {
  try { channel?.postMessage(message); } catch { /* Cross-tab sync is best effort. */ }
}
function closeOptionalBroadcastChannel(channel: BroadcastChannel | null) {
  try { channel?.close(); } catch { /* Cross-tab sync is best effort. */ }
}
const MOBILE_NAV = [
  { page: "home", label: "Home", icon: Home }, { page: "dashboard", label: "Overview", icon: LayoutDashboard },
  { page: "spending", label: "Cash Flow", icon: ChartNoAxesCombined }, { page: "recurring", label: "Recurring", icon: Repeat2 },
  { page: "budget", label: "Budget", icon: WalletCards }, { page: "planning", label: "Planning", icon: Goal },
  { page: "investments", label: "Investments", icon: ChartCandlestick }, { page: "accounts", label: "Accounts", icon: Landmark },
  { page: "transactions", label: "Transactions", icon: ReceiptText },
  { page: "rental", label: "Rental P&L", icon: HousePlus },
];
const SETTINGS_CATEGORIES = [
  { section: "personalize", label: "Personalize", icon: Palette },
  { section: "folio", label: "Folio", icon: Sparkles },
  { section: "data", label: "Data & connections", icon: Link2 },
  { section: "security", label: "Security", icon: Fingerprint },
  { section: "advanced", label: "Advanced", icon: ScanEye },
] as const;
const SETTINGS_SECTION_TITLES: Record<Exclude<SettingsSection, "home">, string> = {
  personalize: "Personalize", folio: "Folio", data: "Data & connections", security: "Security", advanced: "Advanced",
};
type MobileTabPage = (typeof MOBILE_NAV)[number]["page"];
const FOLIO2_ROOT_PREFERENCE_PAGE: Record<Folio2Root, MobileTabPage> = { home: "home", activity: "spending", transactions: "transactions", accounts: "accounts", plan: "planning" };
const FOLIO2_PREFERENCE_ROOT: Partial<Record<MobileTabPage, Folio2Root>> = Object.fromEntries(Object.entries(FOLIO2_ROOT_PREFERENCE_PAGE).map(([root,page])=>[page,root])) as Partial<Record<MobileTabPage,Folio2Root>>;
function normalizeMobileTabOrder(value: unknown): MobileTabPage[] {
  const knownPages = new Set<MobileTabPage>(DEFAULT_MOBILE_TAB_ORDER);
  let selected = Array.isArray(value)
    ? value.filter((page): page is MobileTabPage => typeof page === "string" && knownPages.has(page as MobileTabPage))
    : [];
  // Older preferences called the default landing page "dashboard". Migrate
  // only legacy orders that have no explicit Home entry, keeping every other
  // custom position intact and allowing the normal deduplication below.
  if (selected.includes("dashboard") && !selected.includes("home")) {
    selected = selected.map((page) => page === "dashboard" ? "home" : page);
  }
  return [...new Set(selected), ...DEFAULT_MOBILE_TAB_ORDER.filter((page) => !selected.includes(page))];
}

export function FolioApp() {
  const dashboardFrame = useRef<HTMLIFrameElement | null>(null);
  function clearDashboardTransactionReplica(userId: string): Promise<void> {
    return new Promise((resolve) => {
      const frame = dashboardFrame.current?.contentWindow;
      if (!frame) { resolve(); return; }
      const requestId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", receive);
        window.clearTimeout(timer);
        resolve();
      };
      const receive = (event: MessageEvent) => {
        if (event.origin === window.location.origin && event.source === frame &&
            event.data?.type === "folio-transaction-replica-cleared" && event.data.requestId === requestId) finish();
      };
      const timer = window.setTimeout(finish, 2000);
      window.addEventListener("message", receive);
      frame.postMessage({ type: "folio-clear-transaction-replica", requestId, userId }, window.location.origin);
    });
  }
  const signingOutRef = useRef(false);
  const previousAuthUserRef = useRef<string | null>(null);
  const folio2TabOrderRevisionRef = useRef(0);
  const dashboardHost = useRef<HTMLElement | null>(null);
  const mobileTabs = useRef<HTMLElement | null>(null);
  const childStartupMilestones = useRef<StartupChildMilestone[]>([]);
  const settingsMenuButton = useRef<HTMLButtonElement | null>(null);
  const settingsLandingTrigger = useRef<HTMLButtonElement | null>(null);
  const settingsLandingCloseButton = useRef<HTMLButtonElement | null>(null);
  const settingsMenu = useRef<HTMLElement | null>(null);
  const settingsFirstRow = useRef<HTMLButtonElement | null>(null);
  const settingsBackButton = useRef<HTMLButtonElement | null>(null);
  const settingsReturnFocus = useRef<Exclude<SettingsSection, "home"> | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [config, setConfig] = useState<"loading" | "ready" | "missing">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("password");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authBootRetry, setAuthBootRetry] = useState(0);
  const [authBootSupportRef, setAuthBootSupportRef] = useState("");
  const [authBootReport, setAuthBootReport] = useState("");
  const [authBootReportCopied, setAuthBootReportCopied] = useState(false);
  const [authBootHostingReauth, setAuthBootHostingReauth] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const [callbackPending, setCallbackPending] = useState(false);
  const [mobileShell, setMobileShell] = useState({ enabled: false, title: "Home", page: "home", modal: false });
  const folio2NavigationEnabled = useSyncExternalStore(
    (listener) => { window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener); },
    () => isFolio2NavigationOptedIn(window.location.search),
    () => true,
  );
  const [folio2Route, setFolio2Route] = useState<Folio2Route>(FOLIO2_DEFAULT_ROUTE);
  const [folio2SegmentMemory, setFolio2SegmentMemory] = useState<{ activity: Folio2Segment; accounts: Folio2Segment; plan: Folio2Segment }>({ activity: "spending", accounts: "accounts", plan: "budget" });
  const folio2ScrollRequest = useRef(0);
  const folio2ScrollCleanup = useRef<(() => void) | null>(null);
  const folio2InitialHomeRouteSent = useRef(false);
  const folio2InitialHomeUser = useRef<string | null>(null);
  const folio2FrameRoutePending = useRef(false);
  const [layoutDiagnostics, setLayoutDiagnostics] = useState<string | null>(null);
  const [layoutCopied, setLayoutCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("home");
  const [settingsLandingOpen, setSettingsLandingOpen] = useState(false);
  const settingsLandingReturn = useRef(false);
  const [agentAction, setAgentAction] = useState<Record<string,unknown>|null>(null);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [assistantSettingsOpen, setAssistantSettingsOpen] = useState(false);
  const [passkeyStatus, setPasskeyStatus] = useState<PasskeyStatus>("checking");
  const [menuRefreshState, setMenuRefreshState] = useState<MenuRefreshState>({ state: "idle", completedAt: null });
  const updateBannerRef = useRef<HTMLDivElement | null>(null);
  const [notificationEventId, setNotificationEventId] = useState<string|null>(null);
  const [assistantMessageId, setAssistantMessageId] = useState<string|null>(null);
  const [assistantFallbackEventId, setAssistantFallbackEventId] = useState<string|null>(null);
  const [dashboardFrameKey, setDashboardFrameKey] = useState(0);
  const [dashboardAppReady, setDashboardAppReady] = useState(false);
  const dashboardAppReadyRef = useRef(false);
  const mobileShellRef = useRef(mobileShell);
  const lastUserActivityAt = useRef(Date.now());
  const updateRequiredRef = useRef(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const updateNowRef = useRef<() => Promise<void>>(async () => {});
  const updateLaunchContextRef = useRef<{ captured: boolean; recoveryTarget: string | null; prepared: boolean }>({ captured: false, recoveryTarget: null, prepared: false });
  const [dashboardBootStalled, setDashboardBootStalled] = useState(false);
  const [dashboardFrameLoad, setDashboardFrameLoad] = useState<"pending"|"loaded"|"error">("pending");
  const [startupDiagnostics, setStartupDiagnostics] = useState("");
  const [startupDiagnosticsStatus, setStartupDiagnosticsStatus] = useState("");
  const [assistantSettingsInitialScreen, setAssistantSettingsInitialScreen] = useState<"overview"|"budget"|"history">("overview");
  const clearDirtyFields = (doc: Document, scope: Document | Element = doc) => scope.querySelectorAll("[data-folio-user-dirty]").forEach(field => { field.removeAttribute("data-folio-user-dirty"); field.removeAttribute("data-folio-user-dirty-action"); });
  let dirtyActionSequence = 0;
  const editActionScope = (control: Element | null) => control?.parentElement?.closest("form,[role='dialog'],dialog,.folio-detail,.folio-budget-editor,.folio-goal-editor,.folio-recurring-editor,.folio-manual-asset-editor,.folio-rule-editor,.folio2-tx-editor-form") || control?.parentElement || null;
  const markDirtyAction = (view: (Window & { __folioPendingDirtyAction?: { id: string; scope: Element } }) | null, scope: Element | null) => {
    if (!view || !scope) return;
    const fields = [...scope.querySelectorAll("[data-folio-user-dirty]")];
    if (!fields.length) { view.__folioPendingDirtyAction = undefined; return; }
    const id = `${Date.now()}-${++dirtyActionSequence}`;
    fields.forEach(field => field.setAttribute("data-folio-user-dirty-action", id));
    view.__folioPendingDirtyAction = { id, scope };
  };
  const trackFieldEdit = (event: Event) => {
    const target = event.target as Element | null;
    const doc = (event.currentTarget as Document | null) || document, view = doc.defaultView as (Window & { __folioPendingDirtyAction?: { id: string; scope: Element } }) | null;
    if (view) view.__folioPendingDirtyAction = undefined;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) { target.removeAttribute("data-folio-user-dirty-action"); target.setAttribute("data-folio-user-dirty", "true"); }
  };
  const markEditAction = (event: Event) => {
    const target = event.target as Element | null, control = target?.closest("button,input[type=submit]") as HTMLButtonElement | HTMLInputElement | null;
    const action = control?.textContent?.trim() || (control?.tagName === "INPUT" ? (control as HTMLInputElement).value : "");
    const doc = (event.currentTarget as Document | null) || document, view = doc.defaultView as (Window & { __folioPendingDirtyAction?: { id: string; scope: Element } }) | null, scope = editActionScope(control);
    if (/\b(cancel|close|discard)\b/i.test(action)) { clearDirtyFields(doc, scope || doc); if (view) view.__folioPendingDirtyAction = undefined; }
    else if (/\b(save|apply|confirm|done)\b/i.test(action)) markDirtyAction(view, scope);
    else if (view) view.__folioPendingDirtyAction = undefined;
  };
  const markFormSubmit = (event: Event) => { const doc = (event.currentTarget as Document | null) || document, form = event.target as Element | null, view = doc.defaultView as (Window & { __folioPendingDirtyAction?: { id: string; scope: Element } }) | null; markDirtyAction(view, form); };
  const clearFormReset = (event: Event) => { const doc = (event.currentTarget as Document | null) || document, form = event.target as Element | null, view = doc.defaultView as (Window & { __folioPendingDirtyAction?: { id: string; scope: Element } }) | null, pending = view?.__folioPendingDirtyAction; clearDirtyFields(doc, form || doc); if (pending && form && (form.contains(pending.scope) || pending.scope.contains(form))) view.__folioPendingDirtyAction = undefined; };
  useLayoutEffect(() => {
    childStartupMilestones.current = [];
    setDashboardFrameLoad("pending");
    setStartupDiagnostics("");
    setStartupDiagnosticsStatus("");
  }, [dashboardFrameKey, session?.user.id]);
  useEffect(() => {
    if (config !== "ready" || !session) return;
    setDashboardAppReady(false);
    setDashboardBootStalled(false);
    const timer = window.setTimeout(() => setDashboardBootStalled(true), 15000);
    return () => window.clearTimeout(timer);
  }, [config, dashboardFrameKey, session?.user.id]);
  useEffect(() => { dashboardAppReadyRef.current = dashboardAppReady; }, [dashboardAppReady]);
  useEffect(() => { mobileShellRef.current = mobileShell; }, [mobileShell]);
  useLayoutEffect(() => {
    const valid=(id:unknown):id is string=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const fromUrl=()=>{
      const params=new URLSearchParams(location.search),messageId=params.get('folio_message'),eventId=params.get('folio_event');
      if(valid(messageId)){setAssistantMessageId(messageId);if(valid(eventId))setAssistantFallbackEventId(eventId);return;}
      if(valid(eventId))setNotificationEventId(eventId);
    };
    fromUrl();
    const receivePush=(event:MessageEvent)=>{
      if(typeof ServiceWorker==='undefined'||!(event.source instanceof ServiceWorker))return;
      try{if(new URL(event.source.scriptURL).origin!==location.origin)return;}catch{return;}
      if(event.data?.type==='folio-open-assistant-message'&&valid(event.data.message_id)){
        const url=new URL(location.href);url.searchParams.set('folio_message',event.data.message_id);
        if(valid(event.data.event_id)){url.searchParams.set('folio_event',event.data.event_id);setAssistantFallbackEventId(event.data.event_id);}
        history.replaceState({},'',url);setAssistantMessageId(event.data.message_id);return;
      }
      if(event.data?.type==='folio-open-notification'&&valid(event.data.event_id)){
        const url=new URL(location.href);url.searchParams.set('folio_event',event.data.event_id);history.replaceState({},'',url);setNotificationEventId(event.data.event_id);
      }
    };
    let dispatching=false,lastDispatch=0;
    const receiveState=(event:MessageEvent)=>{
      if(event.origin!==location.origin||event.source!==dashboardFrame.current?.contentWindow)return;
      if(event.data?.type==='folio-dashboard-diagnostic'){
        const milestone=sanitizeStartupMilestone(event.data);
        if(milestone){const current=childStartupMilestones.current;current.push(milestone);if(current.length>24)current.splice(0,current.length-24);}
        return;
      }
      if(event.data?.type==='folio-startup-mark'){markStartup(String(event.data.stage||''));return;}
      if(event.data?.type==='folio-api-contract-error'&&Number.isInteger(event.data.status)){
        const contentType=typeof event.data.contentType==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(event.data.contentType)?event.data.contentType:undefined;
        void fetch('/api/folio-telemetry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'api_contract_error',clientBuild:process.env.NEXT_PUBLIC_FOLIO_BUILD_ID,clientGeneration:Number(process.env.NEXT_PUBLIC_FOLIO_API_GENERATION||1),status:event.data.status,contentType}),keepalive:true}).catch(()=>undefined);
        window.dispatchEvent(new Event('folio-update-required'));
        return;
      }
      if(event.data?.type==='folio-dashboard-watchdog-expired'||event.data?.type==='folio-dashboard-boot-failed'){setDashboardBootStalled(true);return;}
      if(event.data?.type==='folio-dashboard-retry-request'){setDashboardAppReady(false);setDashboardBootStalled(false);setDashboardFrameLoad('pending');setStartupDiagnostics('');setStartupDiagnosticsStatus('');childStartupMilestones.current=[];setDashboardFrameKey(key=>nextDashboardFrameKey(key));return;}
      if(isTrustedDashboardReadyMessage(event,location.origin,dashboardFrame.current?.contentWindow||null)){
        setDashboardAppReady(true);
        setDashboardBootStalled(false);
        markStartup("shell_rendered");
        if(event.data?.type==='folio-dashboard-app-ready') return;
      }
      if(!session)return;
      if(event.data?.type==='folio-open-budget-permissions'){setAssistantSettingsInitialScreen('budget');setAssistantSettingsOpen(true);return;}
      if(event.data?.type==='folio-open-autonomy-settings'){setAssistantSettingsInitialScreen(event.data.initialScreen==='history'?'history':'overview');setAssistantSettingsOpen(true);return;}
      if(event.data?.type==='folio-return-assistant-settings'){setAssistantSettingsInitialScreen('overview');setAssistantSettingsOpen(true);return;}
      if(event.data?.type==='folio-return-settings'){
        if(folio2NavigationEnabled){setMenuOpen(false);setSettingsLandingOpen(true);window.requestAnimationFrame(()=>settingsLandingCloseButton.current?.focus());}
        else{setSettingsSection('home');setMenuOpen(true);}
        return;
      }
      if(event.data?.type==='folio-refresh-status'){
        if(event.data.source!=='saved-data')return;
        const state=event.data.state;
        if(state==='refreshing'){setMenuRefreshState({state,completedAt:null});return;}
        if(state==='background'){setMenuRefreshState({state,completedAt:Number(event.data.completedAt)||null});return;}
        if(state==='success'||state==='partial'||state==='error'){
          const completedAt=Number(event.data.completedAt);
          setMenuRefreshState({state,completedAt:Number.isFinite(completedAt)?completedAt:Date.now()});
        }
        return;
      }
      if(event.data?.type==='folio-agent-action'){setAgentAction(event.data.request);return;}
      if(event.data?.type==='folio-agent-action-completed'){notifyAgentChanged(event.data?.financial===true);return;}
      if(event.data?.type!=='folio-agent-state-ready')return;
      if(previousAuthUserRef.current===session.user.id&&Array.isArray(event.data.events))cacheNotificationEvents(session.user.id,event.data.events);
      // A separate request after render. Never await push delivery during launch.
      if(dispatching||Date.now()-lastDispatch<60000)return;
      dispatching=true;lastDispatch=Date.now();
      void notificationRequest(session.access_token,'dispatch').catch(()=>{}).finally(()=>{dispatching=false;});
    };
    const fromChat=(event:Event)=>setAgentAction((event as CustomEvent).detail);
    window.addEventListener('folio-agent-action',fromChat);
    const chatCompleted=(event:Event)=>notifyAgentChanged((event as CustomEvent<{financial?:boolean}>).detail?.financial===true);
    window.addEventListener('folio-agent-chat-completed',chatCompleted);
    const updates=session?openOptionalBroadcastChannel('folio-agent-events:'+session.user.id):null;
    try { if(updates)updates.onmessage=event=>{dashboardFrame.current?.contentWindow?.postMessage({type:event.data?.financial?'folio-agent-finances-changed':'folio-notifications-changed'},location.origin);window.dispatchEvent(new Event('folio-agent-updated'));}; } catch { /* Cross-tab sync is best effort. */ }
    navigator.serviceWorker?.addEventListener('message',receivePush);
    window.addEventListener('message',receiveState);window.addEventListener('popstate',fromUrl);
    return()=>{closeOptionalBroadcastChannel(updates);window.removeEventListener('folio-agent-chat-completed',chatCompleted);window.removeEventListener('folio-agent-action',fromChat);navigator.serviceWorker?.removeEventListener('message',receivePush);window.removeEventListener('message',receiveState);window.removeEventListener('popstate',fromUrl);};
  },[session?.access_token,session?.user.id]);
  function notifyAgentChanged(financial:boolean){
    dashboardFrame.current?.contentWindow?.postMessage({type:financial?'folio-agent-finances-changed':'folio-notifications-changed'},location.origin);
    window.dispatchEvent(new Event('folio-agent-updated'));
    if(session){const channel=openOptionalBroadcastChannel('folio-agent-events:'+session.user.id);postOptionalBroadcastMessage(channel,{changed:true,financial});closeOptionalBroadcastChannel(channel);}
  }
  function closeNotificationEvent(){dashboardFrame.current?.contentWindow?.postMessage({type:'folio-notifications-changed'},location.origin);setNotificationEventId(null);const url=new URL(location.href);url.searchParams.delete('folio_event');history.replaceState({},'',url);}
  function assistantMessageHandled(available:boolean){
    if(!available&&assistantFallbackEventId)setNotificationEventId(assistantFallbackEventId);
    setAssistantMessageId(null);setAssistantFallbackEventId(null);
    const url=new URL(location.href);url.searchParams.delete('folio_message');
    if(available)url.searchParams.delete('folio_event');
    history.replaceState({},'',url);
  }

  const [tabOrderOpen, setTabOrderOpen] = useState(false);
  const [tabOrderFolio2, setTabOrderFolio2] = useState(false);
  const [tabOrderDraft, setTabOrderDraft] = useState<MobileTabPage[]>(DEFAULT_MOBILE_TAB_ORDER);
  const [tabOrderSaving, setTabOrderSaving] = useState(false);
  const [tabOrderError, setTabOrderError] = useState("");
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [folioAlertRows, setFolioAlertRows] = useState<FolioAlertRow[]>([]);
  const [folioAlertRowsOwner, setFolioAlertRowsOwner] = useState<string | null>(null);
  const [folioFilterOpen, setFolioFilterOpen] = useState(false);
  const [folioFilterRequest, setFolioFilterRequest] = useState<FolioFilterDraft | null>(null);
  const [folioFilterOwner, setFolioFilterOwner] = useState<string | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  useEffect(() => { setAlertsOpen(false); setAlertCount(0); setFolioAlertRows([]); setFolioAlertRowsOwner(null); setFolioFilterOpen(false); setFolioFilterRequest(null); setFolioFilterOwner(null); }, [session?.user.id]);
  const [preferences, setPreferences] = useState<FolioPreferences>(() => {
    const cached = bootTheme();
    return cached ? { ...DEFAULT_PREFERENCES, themeMode: cached.mode, themeColor: cached.color, folio2TabOrder: cached.userId ? readCachedFolio2TabOrder(cached.userId) || DEFAULT_FOLIO2_TAB_ORDER : DEFAULT_FOLIO2_TAB_ORDER } : DEFAULT_PREFERENCES;
  });
  const [systemDark, setSystemDark] = useState(() => bootTheme()?.appearance === "dark");
  const [timeDark, setTimeDark] = useState(() => bootTheme()?.mode === "time" && bootTheme()?.appearance === "dark");
  const [preferencesLoaded, setPreferencesLoaded] = useState(() => bootTheme()?.hasCachedPreference === true);
  const [preferencesUserId, setPreferencesUserId] = useState<string | null>(() => bootTheme()?.hasCachedPreference ? bootTheme()?.userId ?? null : null);
  const [homeNotificationDispositions, setHomeNotificationDispositions] = useState<HomeNotificationDispositions>({});
  const [homeNotificationDispositionsReadyFor, setHomeNotificationDispositionsReadyFor] = useState<string | null>(null);
  const homeNotificationDispositionsRef = useRef<HomeNotificationDispositions>({});
  const homeNotificationDispositionsRevisionRef = useRef(0);
  const homeNotificationSessionGenerationRef = useRef(0);
  const homeNotificationWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const homeNotificationWritesInFlightRef = useRef(new Set<string>());

  useEffect(() => {
    homeNotificationSessionGenerationRef.current += 1;
    homeNotificationDispositionsRevisionRef.current += 1;
    homeNotificationDispositionsRef.current = {};
    setHomeNotificationDispositions({});
    setHomeNotificationDispositionsReadyFor(null);
  }, [session?.user.id]);

  useEffect(() => {
    markStartup("session_restore_started");
    let bootStage = "config_fetch";
    let bootContentType: string | undefined;
    const bootStartedAt = Date.now();
    const bootTimestamp = new Date(bootStartedAt).toISOString();
    const reportBootFailure = (stage: "config_fetch" | "config_response" | "config_json" | "config_invalid" | "session_restore", errorName: string, status?: number, authErrorCode?: string) => {
      const safeErrorName = ["AbortError", "TypeError", "SyntaxError", "Error"].includes(errorName) ? errorName : "unknown";
      const supportRef = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14);
      const clientBuild = process.env.NEXT_PUBLIC_FOLIO_BUILD_ID || "development";
      const contentType = bootContentType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(bootContentType) ? bootContentType : "unknown";
      const safeStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
      const safeAuthErrorCode = ["refresh_token_not_found", "session_not_found", "session_expired", "invalid_grant", "invalid_token", "unauthorized"].includes(authErrorCode || "") ? authErrorCode : undefined;
      const elapsedMs = Math.min(600_000, Math.max(0, Date.now() - bootStartedAt));
      setAuthBootSupportRef(supportRef);
      setAuthBootReportCopied(false);
      setAuthBootReport([`Folio startup support reference: ${supportRef}`, `Time: ${bootTimestamp}`, `Stage: ${stage}`, `Error: ${safeErrorName}`, ...(safeAuthErrorCode ? [`Auth code: ${safeAuthErrorCode}`] : []), `Status: ${safeStatus || "unknown"}`, `Content type: ${contentType}`, `Elapsed ms: ${elapsedMs}`, `Build: ${clientBuild}`].join("\n"));
      try { void fetch("/api/folio-telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "auth_boot_failed", stage, errorName: safeErrorName, supportRef, timestamp: bootTimestamp, elapsedMs, ...(safeAuthErrorCode ? { authErrorCode: safeAuthErrorCode } : {}), ...(safeStatus ? { status: safeStatus } : {}), ...(contentType !== "unknown" ? { contentType } : {}), clientBuild }), keepalive: true }).catch(() => undefined); } catch {}
    };
    const controller = new AbortController();
    let createdClient: SupabaseClient | null = null;
    const searchParams = new URLSearchParams(window.location.search);
    const recoveryRequested = searchParams.has("recovery");
    const authorizationCode = searchParams.get("code");
    const callback = searchParams.has("folio_auth") ||
      Boolean(authorizationCode) ||
      window.location.hash.includes("access_token=") ||
      window.location.hash.includes("error_description=");
    setCallbackPending(callback);
    let subscription: { unsubscribe: () => void } | undefined;
    const lifecycle = createStartupLifecycle();
    const timeout = window.setTimeout(() => {
      if (!lifecycle.expireBoot()) return;
      controller.abort();
      setCallbackPending(false);
      setAuthMessage("Folio is taking longer than expected to restore your secure session. Check your connection and try again.");
      reportBootFailure(bootStage as "config_fetch" | "session_restore", "AbortError");
      setConfig("missing");
    }, 12000);
    fetch("/api/config", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        bootContentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (!response.ok || response.redirected || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          const error = new Error("Runtime configuration is unavailable.") as Error & { stage?: string; status?: number };
          error.stage = "config_response"; error.status = response.status; throw error;
        }
        return response.json().catch(() => { const error = new Error("Runtime configuration could not be read.") as Error & { stage?: string; status?: number }; error.stage = "config_json"; error.status = response.status; throw error; });
      })
      .then(async (settings) => {
        if (!lifecycle.canContinueBoot()) return;
        if (!settings || typeof settings !== "object" || !settings.supabaseUrl || !settings.supabaseAnonKey) {
          lifecycle.finishPendingBoot();
          bootStage = "config_invalid";
          reportBootFailure("config_invalid", "Error");
          setAuthBootHostingReauth(false);
          setAuthMessage("Folio couldn’t load its sign-in settings. Check your connection and try again.");
          setConfig("missing");
          return;
        }
        let usableSupabaseUrl = false;
        try { const url = new URL(settings.supabaseUrl); usableSupabaseUrl = url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)); } catch {}
        if (!usableSupabaseUrl || typeof settings.supabaseAnonKey !== "string" || !settings.supabaseAnonKey) {
          const error = new Error("Runtime configuration is incomplete.") as Error & { stage?: string };
          error.stage = "config_invalid"; throw error;
        }
        bootStage = "session_restore";
        const next = createClient(settings.supabaseUrl, settings.supabaseAnonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            // Handle PKCE codes below so the client never races itself to
            // consume the single-use recovery code. Hash-based callbacks stay
            // on Supabase's normal automatic detection path.
            detectSessionInUrl: !authorizationCode,
            flowType: "pkce",
            experimental: { passkey: true },
          },
        });
        createdClient = next;
        setClient(next);
        subscription = next.auth.onAuthStateChange((event, nextSession) => {
          if (!lifecycle.canReceiveAuthEvent()) return;
          const validSession = isLocallyValidSession(nextSession) ? nextSession : null;
          const previousUser = previousAuthUserRef.current;
          if (event === "SIGNED_OUT" && previousUser) {
            clearUserEventDetailCache(previousUser);
            void clearDashboardTransactionReplica(previousUser);
          }
          if (previousUser !== (validSession?.user.id ?? null)) {
            homeNotificationSessionGenerationRef.current += 1;
            homeNotificationDispositionsRevisionRef.current += 1;
          }
          if (validSession && previousUser && previousUser !== validSession.user.id) {
            clearUserEventDetailCache(previousUser);
            void clearDashboardTransactionReplica(previousUser);
          }
          if (validSession) {
            previousAuthUserRef.current = validSession.user.id;
            signingOutRef.current = false;
          } else if (event === "SIGNED_OUT") {
            previousAuthUserRef.current = null;
          }
          setSession(validSession);
          if (event === "PASSWORD_RECOVERY" || (recoveryRequested && isLocallyValidSession(nextSession))) {
            setAuthMode("set-password");
            setCallbackPending(false);
            window.history.replaceState({}, document.title, folioAuthNavigationPath(window.location.pathname, window.location.search));
            return;
          }
          if (nextSession) {
            setCallbackPending(false);
            window.history.replaceState({}, document.title, folioAuthNavigationPath(window.location.pathname, window.location.search));
          }
        }).data.subscription;
        let recoverySession: Session | null = null;
        let recoveryError: Error | null = null;
        if (authorizationCode) {
          const { data, error } = await next.auth.exchangeCodeForSession(authorizationCode);
          if (!lifecycle.canContinueBoot()) return;
          recoverySession = data.session;
          recoveryError = error;
        }
        const { data, error } = await next.auth.getSession();
        if (!lifecycle.canContinueBoot()) return;
        const activeSession = recoverySession || data.session;
        const restoredSession = isLocallyValidSession(activeSession) ? activeSession : null;
        previousAuthUserRef.current = restoredSession?.user.id ?? null;
        setSession(restoredSession);
        markStartup(restoredSession ? "session_restored" : "session_expired");
        if (!restoredSession && (activeSession || error || recoveryError)) {
          const authError = (recoveryError || error) as (Error & { code?: string; status?: number }) | null;
          reportBootFailure("session_restore", "Error", authError?.status, authError?.code);
        }
        if (activeSession && !restoredSession) setAuthMessage("Your secure session has expired. Connect to the internet and sign in again.");
        setCallbackPending(false);
        if (recoveryError || error) setAuthMessage((recoveryError || error)?.message || "Folio could not finish signing in.");
        if (recoveryRequested && activeSession && restoredSession) {
          setAuthMode("set-password");
          window.history.replaceState({}, document.title, folioAuthNavigationPath(window.location.pathname, window.location.search));
        } else if (recoveryRequested) {
          setAuthMode("request-reset");
          setAuthMessage(recoveryError?.message || "This password setup link is no longer valid. Request a new one and open it in the same browser.");
        }
        if (callback && !activeSession && !error && !recoveryError && !recoveryRequested) {
          const hashError = new URLSearchParams(window.location.hash.slice(1)).get("error_description");
          setAuthMessage(hashError ? decodeURIComponent(hashError) : "That sign-in link could not be completed. Return to Folio and request a new link.");
        }
        lifecycle.finishBoot();
        setConfig("ready");
      })
      .catch((error) => {
        if (!lifecycle.finishPendingBoot()) return;
        setCallbackPending(false);
        const stage = ["config_fetch", "config_response", "config_json", "config_invalid", "session_restore"].includes(error?.stage) ? error.stage : bootStage;
        const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
        const errorName = ["AbortError", "TypeError", "SyntaxError", "Error"].includes(error?.name) ? error.name : "unknown";
        reportBootFailure(stage as "config_fetch" | "config_response" | "config_json" | "config_invalid" | "session_restore", errorName, status);
        setAuthBootHostingReauth(stage.startsWith("config_") && (status === 401 || status === 403 || /html/i.test(bootContentType || "") || errorName === "SyntaxError"));
        setAuthMessage(stage.startsWith("config_")
          ? "Folio couldn’t load its sign-in settings. Check your connection and try again. Your saved session has not been cleared."
          : "Folio couldn’t restore your secure session. Check your connection and try again. Your saved session has not been cleared.");
        setConfig("missing");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      lifecycle.dispose();
      controller.abort();
      subscription?.unsubscribe();
      if (typeof createdClient?.auth.stopAutoRefresh === "function") createdClient.auth.stopAutoRefresh();
      window.clearTimeout(timeout);
    };
  }, [authBootRetry]);

  useEffect(() => {
    const buildId = process.env.NEXT_PUBLIC_FOLIO_BUILD_ID || "development";
    const apiGeneration = Number(process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || 1);
    if (!updateLaunchContextRef.current.captured) {
      updateLaunchContextRef.current = { captured: true, recoveryTarget: new URL(window.location.href).searchParams.get("folio_upgrade"), prepared: false };
    }
    const reportPwa = (event: string, details: Record<string, unknown> = {}) => {
      const payload = { event, clientBuild: buildId, clientGeneration: apiGeneration, ...details };
      try { void fetch("/api/folio-telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), keepalive: true }).catch(() => undefined); } catch {}
    };
    let registration: ServiceWorkerRegistration | null = null;
    let disposed = false;
    const controller = createFolioUpdateController({
      buildId,
      apiGeneration,
      fetchVersion: async () => {
        const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        return response.ok ? await response.json() : null;
      },
      updateWorker: async (version) => {
        const workerUrl = "/sw.js";
        if (!("serviceWorker" in navigator)) {
          const response = await fetch(`/?folio_upgrade_probe=${encodeURIComponent(version.buildId)}`, { cache: "reload", signal: AbortSignal.timeout(8000) });
          if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return false;
          const html = await response.text();
          return html.includes("/_next/static/") && html.includes(`name="folio-build-id" content="${version.buildId}"`) && html.includes(`name="folio-api-generation" content="${version.apiGeneration}"`);
        }
        registration = await navigator.serviceWorker.register(workerUrl, { updateViaCache: "none" });
        await Promise.race([registration.update().catch(() => undefined), new Promise(resolve => window.setTimeout(resolve, 8000))]);
        const activeIdentity = async () => {
          const active = registration?.active;
          if (!active) return null;
          return await new Promise<{buildId?:string;apiGeneration?:number;minSupportedGeneration?:number}|null>((resolve) => {
            const channel = new MessageChannel();
            let settled = false;
            const finish = (value: {buildId?:string;apiGeneration?:number;minSupportedGeneration?:number}|null) => { if (settled) return; settled = true; window.clearTimeout(timer); channel.port1.close(); resolve(value); };
            const timer = window.setTimeout(() => finish(null), 1800);
            channel.port1.onmessage = (event) => finish(event.data || null);
            try { active.postMessage({ type: "folio-worker-identity" }, [channel.port2]); } catch { finish(null); }
          });
        };
        const waitForActivation = async () => {
          const worker = registration?.installing || registration?.waiting;
          if (!worker) return false;
          return await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (result: boolean) => { if (settled) return; settled = true; window.clearTimeout(timeout); worker.removeEventListener("statechange", changed); resolve(result); };
          const changed = () => { if (worker.state === "activated") finish(true); else if (worker.state === "redundant") finish(false); };
          const timeout = window.setTimeout(() => finish(false), 20000);
          worker.addEventListener("statechange", changed);
          changed();
          });
        };
        const staged = await confirmFolioWorkerTarget(version, activeIdentity, waitForActivation);
        reportPwa(staged ? "worker_ready" : "update_blocked", { serverBuild: version.buildId, serverGeneration: Number(version.apiGeneration) });
        return staged;
      },
      canAutoReload: (phase = "active") => {
        const frame = dashboardFrame.current;
        try {
          const doc = frame?.contentDocument;
          const modalOpen = mobileShellRef.current.modal || Boolean(document.querySelector('[role="dialog"],dialog[open]')) || Boolean(doc?.querySelector('[role="dialog"],dialog[open]')) || Boolean(document.querySelector('[data-folio-update-blocked="true"]'));
          const dirtyFields = Boolean(document.querySelector('[data-folio-user-dirty]')) || Boolean(doc?.querySelector('[data-folio-user-dirty]')) || document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLSelectElement || Boolean(doc && (doc.activeElement?.tagName === 'INPUT' || doc.activeElement?.tagName === 'TEXTAREA' || doc.activeElement?.tagName === 'SELECT'));
          const pendingRequests = (Number((frame?.contentWindow as (Window & { __folioPendingWrites?: number }) | null)?.__folioPendingWrites) || 0) + homeNotificationWritesInFlightRef.current.size;
          const phaseActivityValid = phase === "active" || lastUserActivityAt.current === autoWindowActivityAt;
          const immediate = (phase === "launch" || phase === "resume") && phaseActivityValid;
          return isFolioReloadSafe({ visible: document.visibilityState === "visible", modalOpen, dirtyFields, pendingRequests, appReady: dashboardAppReadyRef.current, idleMs: Date.now() - lastUserActivityAt.current, immediate, phaseActivityValid });
        } catch { return false; }
      },
      reload: (targetBuild) => {
        reportPwa("recovery_reload", { serverBuild: targetBuild });
        const url = new URL(window.location.href);
        url.searchParams.set("folio_upgrade", targetBuild.slice(0, 16));
        window.location.replace(url.href);
      },
      storage: {
        getItem: (key) => { try { return window.sessionStorage.getItem(key); } catch { return "1"; } },
        setItem: (key, value) => { try { window.sessionStorage.setItem(key, value); } catch {} },
        removeItem: (key) => { try { window.sessionStorage.removeItem(key); } catch {} },
      },
      setAvailable: (available) => { updateRequiredRef.current = available; if (!disposed) setUpdateRequired(available); },
    });
    updateNowRef.current = async () => { setUpdatePending(true); try { await controller.updateNow(); } finally { if (!disposed) setUpdatePending(false); } };
    const updateWorker = () => { if (document.visibilityState === "visible") void controller.check(); };
    const noteActivity = () => { lastUserActivityAt.current = Date.now(); };
    let autoWindowActivityAt = lastUserActivityAt.current;
    const checkInWindow = (phase: "launch" | "resume") => { autoWindowActivityAt = hiddenActivityAt; void controller.check(true, phase); };
    let hiddenActivityAt = lastUserActivityAt.current;
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : 0;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); hiddenActivityAt = lastUserActivityAt.current; return; }
      if (hiddenAt && Date.now() - hiddenAt >= 30_000 && document.visibilityState === "visible") checkInWindow("resume");
      hiddenAt = 0;
    };
    const updateTimer = window.setInterval(() => { if (updateRequiredRef.current && document.visibilityState === "visible") void controller.check(true); }, 30_000);
    const onWorkerMessage = (event: MessageEvent) => {
      if (!['folio-worker-compatibility-check','folio-worker-identity'].includes(event.data?.type) || !event.ports[0]) return;
      let validSource = false;
      try { const source = new URL((event.source as ServiceWorker | null)?.scriptURL || "", window.location.href); validSource = source.origin === window.location.origin && source.pathname === "/sw.js"; } catch {}
      event.ports[0].postMessage({ buildId, apiGeneration, compatible: validSource && Number(event.data.apiGeneration) >= Number(event.data.minSupportedGeneration) && apiGeneration >= Number(event.data.minSupportedGeneration) && apiGeneration === Number(event.data.apiGeneration) });
    };
    const onContractError = () => { void controller.check(true); };
    window.addEventListener("folio-update-required", onContractError);
    const startUpgradeCheck = async (phase: "active" | "launch" = "active") => {
      if (phase === "launch") autoWindowActivityAt = lastUserActivityAt.current;
      const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.timeout(8000) }).catch(() => null);
      const version = response?.ok ? await response.json().catch(() => null) : null;
      const url = new URL(window.location.href), attemptedBuild = url.searchParams.get("folio_upgrade") || updateLaunchContextRef.current.recoveryTarget;
      if (phase === "launch" && version?.buildId && !updateLaunchContextRef.current.prepared) {
        updateLaunchContextRef.current.prepared = true;
        controller.prepareLaunch(version.buildId, attemptedBuild);
      }
      if (attemptedBuild && version?.buildId) {
        const landedOnTarget = didFolioRecoveryLand(buildId, apiGeneration, version.buildId, Number(version.apiGeneration), attemptedBuild);
        reportPwa(landedOnTarget ? "recovery_success" : "update_blocked", { serverBuild: version.buildId, serverGeneration: Number(version.apiGeneration) });
        url.searchParams.delete("folio_upgrade");history.replaceState({}, "", url.href);
      }
      const mismatch = version && (version.buildId !== buildId || Number(version.apiGeneration) !== apiGeneration || Number(version.minSupportedGeneration) > apiGeneration);
      if (mismatch) { reportPwa("version_mismatch", { serverBuild: version.buildId, serverGeneration: Number(version.apiGeneration) }); if (phase === "launch") await controller.check(true, phase); else await controller.check(true); return; }
      reportPwa("client_loaded", { serverBuild: version?.buildId, serverGeneration: Number(version?.apiGeneration) });
      if ("serviceWorker" in navigator) {
        try { registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }); await registration.update(); registration.active?.postMessage({ type: "folio-client-ready" }); } catch {}
      }
    };
    let lastControllerCheck = 0;
    const onControllerChange = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastControllerCheck < 10_000) return;
      lastControllerCheck = Date.now();
      void startUpgradeCheck();
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onWorkerMessage);
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    }
    window.addEventListener("focus", updateWorker);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerdown", noteActivity, { passive: true });
    window.addEventListener("keydown", noteActivity, { passive: true });
    document.addEventListener("input", trackFieldEdit, true);
    document.addEventListener("change", trackFieldEdit, true);
    document.addEventListener("click", markEditAction, true);
    document.addEventListener("submit", markFormSubmit, true);
    document.addEventListener("reset", clearFormReset, true);
    const onPageHide = (event: PageTransitionEvent) => { hiddenActivityAt = lastUserActivityAt.current; if (!event.persisted) controller.stop(); else controller.pause(); };
    const onPageShow = () => { if (document.visibilityState === "visible") checkInWindow("resume"); };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    void startUpgradeCheck("launch");
    return () => { disposed = true; updateNowRef.current = async () => {}; window.clearInterval(updateTimer); controller.stop(); navigator.serviceWorker?.removeEventListener("message", onWorkerMessage); navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange); window.removeEventListener("folio-update-required", onContractError); window.removeEventListener("focus", updateWorker); document.removeEventListener("visibilitychange", onVisibilityChange); window.removeEventListener("pointerdown", noteActivity); window.removeEventListener("keydown", noteActivity); document.removeEventListener("input", trackFieldEdit, true); document.removeEventListener("change", trackFieldEdit, true); document.removeEventListener("click", markEditAction, true); document.removeEventListener("submit", markFormSubmit, true); document.removeEventListener("reset", clearFormReset, true); window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", onPageShow); };
  }, []);

  useEffect(() => {
    if (!client || !session?.user.id) return;
    const preferenceOwner = session.user.id;
    const homeSessionGenerationAtRead = homeNotificationSessionGenerationRef.current;
    const tabOrderRevisionAtRead = folio2TabOrderRevisionRef.current;
    const homeDispositionRevisionAtRead = homeNotificationDispositionsRevisionRef.current;
    const cachedTabOrder = readCachedFolio2TabOrder(preferenceOwner);
    if (cachedTabOrder) setPreferences((current) => ({ ...current, folio2TabOrder: cachedTabOrder }));
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    const homeDispositionController = new AbortController();
    const homeDispositionTimeout = window.setTimeout(() => homeDispositionController.abort(), 2500);
    const baseRead = Promise.resolve(client
      .from("finance_user_preferences")
      .select("theme_color,theme_mode,dismissed_alert_keys,dismissed_insight_keys,ask_folio_memories,mobile_tab_order")
      .eq("user_id", preferenceOwner)
      .abortSignal(controller.signal)
      .maybeSingle()).catch((error) => ({ data: null, error }));
    const homeDispositionRead = Promise.resolve(client
      .from("finance_user_preferences")
      .select("home_notification_dispositions")
      .eq("user_id", preferenceOwner)
      .abortSignal(homeDispositionController.signal)
      .maybeSingle()).catch((error) => ({ data: null, error }));
    void homeDispositionRead.then(({ data: homeDispositionData, error: homeDispositionError }) => {
      window.clearTimeout(homeDispositionTimeout);
      if (cancelled || previousAuthUserRef.current !== preferenceOwner || homeSessionGenerationAtRead !== homeNotificationSessionGenerationRef.current) return;
      if (homeDispositionError || homeDispositionRevisionAtRead !== homeNotificationDispositionsRevisionRef.current) return;
      const dispositions = parseHomeNotificationDispositions(homeDispositionData?.home_notification_dispositions);
      homeNotificationDispositionsRef.current = dispositions;
      setHomeNotificationDispositions(dispositions);
      setHomeNotificationDispositionsReadyFor(preferenceOwner);
    });
    const readFolio2Preferences = async () => {
      const read = (signal: AbortSignal) => Promise.resolve(client.from("finance_user_preferences").select("folio2_mobile_tab_order,folio2_widget_order").eq("user_id",preferenceOwner).abortSignal(signal).maybeSingle()).catch((error) => ({ data: null, error }));
      const first = await read(controller.signal);
      const firstErrorText = String(first.error?.message || "");
      if (!first.error || cachedTabOrder || cancelled || /column .* does not exist|schema cache/i.test(firstErrorText)) return first;
      const retryController = new AbortController();
      const retryTimeout = window.setTimeout(() => retryController.abort(), 1500);
      try { return await read(retryController.signal); }
      finally { window.clearTimeout(retryTimeout); }
    };
    const f2Read = readFolio2Preferences();
    void Promise.all([baseRead, f2Read]).then(([{ data, error }, { data: f2Data, error: f2Error }]) => {
        if (cancelled) return;
        if (error && bootTheme()?.userId === preferenceOwner) {
          const tabOrderChangedWhileReading = tabOrderRevisionAtRead !== folio2TabOrderRevisionRef.current;
          if (!f2Error && !tabOrderChangedWhileReading) {
            const order = parseFolio2TabOrder(f2Data?.folio2_mobile_tab_order);
            cacheFolio2TabOrder(preferenceOwner, order);
            setPreferences((current) => ({ ...current, folio2TabOrder: order, folio2WidgetOrder: parseFolio2WidgetOrder(f2Data?.folio2_widget_order) }));
          } else if (cachedTabOrder && !tabOrderChangedWhileReading) setPreferences((current) => ({ ...current, folio2TabOrder: cachedTabOrder }));
          setPreferencesLoaded(true);
          setPreferencesUserId(preferenceOwner);
          return;
        }
        const themeColor = typeof data?.theme_color === "string" && HEX_COLOR.test(data.theme_color)
          ? data.theme_color
          : DEFAULT_PREFERENCES.themeColor;
        const themeMode = isAppearanceMode(data?.theme_mode) ? data.theme_mode : DEFAULT_PREFERENCES.themeMode;
        const dismissedAlertKeys = Array.isArray(data?.dismissed_alert_keys)
          ? data.dismissed_alert_keys.filter((key): key is string => typeof key === "string")
          : [];
        const dismissedInsightKeys = Array.isArray(data?.dismissed_insight_keys)
          ? data.dismissed_insight_keys.filter((key): key is string => typeof key === "string" && key.length <= 2000)
          : [];
        let folio2TabOrder=DEFAULT_FOLIO2_TAB_ORDER, folio2WidgetOrder=[...DEFAULT_FOLIO2_WIDGET_ORDER];
        // Additive F2 columns are read separately so a client deployed before
        // the migration still loads all established preferences normally. Its
        // request runs beside the legacy row so that row latency cannot consume
        // the entire preference-read deadline.
        if(cancelled||previousAuthUserRef.current!==preferenceOwner)return;
        const tabOrderChangedWhileReading = tabOrderRevisionAtRead !== folio2TabOrderRevisionRef.current;
        if(!f2Error){
          if(!tabOrderChangedWhileReading){folio2TabOrder=parseFolio2TabOrder(f2Data?.folio2_mobile_tab_order);cacheFolio2TabOrder(preferenceOwner,folio2TabOrder);}
          folio2WidgetOrder=parseFolio2WidgetOrder(f2Data?.folio2_widget_order);
        } else {
          folio2TabOrder=cachedTabOrder || DEFAULT_FOLIO2_TAB_ORDER;
        }
        setPreferences((current) => ({ ...current, themeColor, themeMode, dismissedAlertKeys, dismissedInsightKeys, askFolioMemories: parseAskFolioMemories(data?.ask_folio_memories), mobileTabOrder: normalizeMobileTabOrder(data?.mobile_tab_order), folio2TabOrder: tabOrderChangedWhileReading ? current.folio2TabOrder : folio2TabOrder, folio2WidgetOrder }));
        cacheThemePreference(preferenceOwner, themeMode, themeColor);
        setPreferencesLoaded(true);
        setPreferencesUserId(preferenceOwner);
      })
      .catch(() => {
        if (cancelled) return;
        if (previousAuthUserRef.current === preferenceOwner && homeDispositionRevisionAtRead === homeNotificationDispositionsRevisionRef.current) {
          homeNotificationDispositionsRef.current = {};
          setHomeNotificationDispositions({});
          setHomeNotificationDispositionsReadyFor(null);
        }
        if (cachedTabOrder && tabOrderRevisionAtRead === folio2TabOrderRevisionRef.current) setPreferences((current) => ({ ...current, folio2TabOrder: cachedTabOrder }));
        setPreferencesLoaded(true);
        setPreferencesUserId(preferenceOwner);
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
      homeDispositionController.abort();
      window.clearTimeout(homeDispositionTimeout);
    };
  }, [client, session?.user.id]);

  useLayoutEffect(() => {
    if (!preferencesLoaded || preferencesUserId !== session?.user.id) return;
    const dark = preferences.themeMode === "dark" || (preferences.themeMode === "time" ? timeDark : preferences.themeMode === "system" && systemDark);
    const appearance = dark ? "dark" : "light";
    const background = dark ? "#050505" : "#f6f7f5";
    document.documentElement.dataset.folioTheme = appearance;
    document.documentElement.style.colorScheme = appearance;
    document.documentElement.style.backgroundColor = background;
    document.documentElement.classList.remove("appearance-light", "appearance-dark");
    document.documentElement.classList.add(`appearance-${appearance}`);
    document.body.style.backgroundColor = background;
    const root = document.querySelector<HTMLElement>("#__next");
    if (root) root.style.backgroundColor = background;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", background);
  }, [preferences.themeMode, preferencesLoaded, preferencesUserId, session?.user.id, systemDark, timeDark]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      const now = new Date();
      const hour = now.getHours();
      setTimeDark(hour < 7 || hour >= 19);
      const next = new Date(now);
      if (hour < 7) next.setHours(7, 0, 0, 0);
      else if (hour < 19) next.setHours(19, 0, 0, 0);
      else {
        next.setDate(next.getDate() + 1);
        next.setHours(7, 0, 0, 0);
      }
      timer = window.setTimeout(sync, Math.max(1000, next.getTime() - now.getTime() + 100));
    };
    sync();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const folioWindow = window as Window & { __folioSessionToken?: string };
    const channel = openOptionalBroadcastChannel("folio-session-v1");
    let dashboardAcknowledged = false;
    const sendSession = () => {
      if (signingOutRef.current) return;
      folioWindow.__folioSessionToken = session.access_token;
      postOptionalBroadcastMessage(channel, { type: "folio-session", token: session.access_token, userId: session.user.id });
      dashboardFrame.current?.contentWindow?.postMessage(
        { type: "folio-session", token: session.access_token, userId: session.user.id },
        window.location.origin,
      );
      sendDashboardPwaMode();
    };
    if (channel) {
      channel.onmessage = (event) => {
        if (event.data?.type === "folio-dashboard-session-ready") dashboardAcknowledged = true;
        if (event.data?.type === "folio-dashboard-ready") sendSession();
      };
    }
    const receiveReady = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== dashboardFrame.current?.contentWindow) return;
      const restoreSelectedRoute = () => {
        const route = folio2Route;
        const page = existingPageForFolio2Route(route);
        const screen = page === "folio2-spending" ? "spending" : page === "folio2-cashflow" ? "cashflow" : route.root === "activity" && route.segment === "recurring" ? "recurring" : route.root === "accounts" && route.segment === "investments" ? "investments" : route.root === "accounts" ? "accounts" : route.root === "plan" && route.segment === "budget" ? "budget" : route.root === "plan" && route.segment === "forecast" ? "forecast" : route.root === "plan" && route.segment === "goals" ? "goals" : route.root === "transactions" ? "transactions" : undefined;
        sendDashboardCommand({ type: "folio-open-page", page, ...(screen ? { folio2Screen: screen } : {}) });
        const title = route.root === "activity" ? "Activity" : route.root === "plan" ? "Plan" : FOLIO2_ROOT_TABS.find((tab) => tab.root === route.root)?.label || "Home";
        setMobileShell({ enabled: true, title, page: page.startsWith("folio2-") ? "dashboard" : page, modal: false });
        folio2InitialHomeRouteSent.current = true;
      };
      if (event.data?.type === "folio-dashboard-ready") {
        sendDashboardEmbeddedLayout();
        sendSession();
        if (folio2NavigationEnabled && folio2FrameRoutePending.current) {
          folio2FrameRoutePending.current = false;
          restoreSelectedRoute();
        }
        if (folio2NavigationEnabled && !folio2InitialHomeRouteSent.current) {
          restoreSelectedRoute();
        }
      }
      if (event.data?.type === "folio-dashboard-session-ready") {
        sendDashboardEmbeddedLayout();
        dashboardAcknowledged = true;
        if (folio2NavigationEnabled && folio2FrameRoutePending.current) {
          folio2FrameRoutePending.current = false;
          restoreSelectedRoute();
        }
        if (folio2NavigationEnabled && !folio2InitialHomeRouteSent.current) {
          restoreSelectedRoute();
        }
      }
    };
    window.addEventListener("message", receiveReady);
    sendSession();
    const retry = window.setInterval(() => {
      if (dashboardAcknowledged) window.clearInterval(retry);
      else sendSession();
    }, 500);
    return () => {
      window.removeEventListener("message", receiveReady);
      window.clearInterval(retry);
      if (folioWindow.__folioSessionToken === session.access_token) delete folioWindow.__folioSessionToken;
      closeOptionalBroadcastChannel(channel);
    };
  }, [session, folio2NavigationEnabled]);

  useLayoutEffect(() => {
    if (!session) return;
    sendDashboardEmbeddedLayout();
    if (!mobileShell.enabled && !folio2NavigationEnabled) return;
    const schedule = () => window.requestAnimationFrame(sendDashboardEmbeddedLayout);
    const nav = mobileTabs.current;
    const segments = dashboardHost.current?.querySelector<HTMLElement>(".dashboard-folio2-segments");
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (nav) observer?.observe(nav);
    if (segments) observer?.observe(segments);
    if (updateBannerRef.current) observer?.observe(updateBannerRef.current);
    window.addEventListener("resize", schedule, { passive: true });
    window.visualViewport?.addEventListener("resize", schedule, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [mobileShell.enabled, mobileShell.modal, alertsOpen, layoutDiagnostics, session, dashboardFrameKey, folio2NavigationEnabled, folio2Route, updateRequired]);

  useEffect(() => {
    const rail = mobileTabs.current;
    const active = rail?.querySelector<HTMLElement>('button[aria-current="page"]');
    if (!rail || !active) return;
    rail.scrollTo({ left: Math.max(0, active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [mobileShell.enabled, mobileShell.page]);

  useEffect(() => {
    if (!preferencesLoaded || preferencesUserId !== session?.user.id) return;
    dashboardFrame.current?.contentWindow?.postMessage(
      {
        type: "folio-preferences",
        themeColor: preferences.themeColor,
        themeMode: preferences.themeMode,
        dismissedAlertKeys: preferences.dismissedAlertKeys,
        dismissedInsightKeys: preferences.dismissedInsightKeys,
        homeNotificationUserId: session.user.id,
        homeNotificationDispositionsReady: homeNotificationDispositionsReadyFor === session.user.id,
        ...(homeNotificationDispositionsReadyFor === session.user.id ? { homeNotificationDispositions } : {}),
        ...(folio2NavigationEnabled ? { folio2WidgetOrder: preferences.folio2WidgetOrder } : {}),
      },
      window.location.origin,
    );
  }, [preferences, preferencesLoaded, preferencesUserId, homeNotificationDispositions, homeNotificationDispositionsReadyFor, session?.user.id]);

  useEffect(() => {
    if (!client || !session?.user.id) return;
    const reconcileBadge=createAppBadgeReconciler(navigator as Navigator&{setAppBadge?:(count:number)=>Promise<void>;clearAppBadge?:()=>Promise<void>});
    const persistPreferences = async (next: FolioPreferences) => {
      cacheThemePreference(session.user.id, next.themeMode, next.themeColor);
      const { error } = await client.from("finance_user_preferences").upsert({
        user_id: session.user.id,
        theme_color: next.themeColor,
        theme_mode: next.themeMode,
        dismissed_alert_keys: next.dismissedAlertKeys,
        dismissed_insight_keys: next.dismissedInsightKeys,
        ask_folio_memories: next.askFolioMemories,
        mobile_tab_order: next.mobileTabOrder,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) {
        dashboardFrame.current?.contentWindow?.postMessage(
          { type: "folio-preferences-save-error" },
          window.location.origin,
        );
      }
    };
    const receiveDashboardEvent = async (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== dashboardFrame.current?.contentWindow
      ) return;
      if (event.data?.type === "folio-alert-count") {
        if (event.data.user_id !== session.user.id) return;
        const count=Math.max(0,Math.floor(Number(event.data.count)||0));
        setAlertCount(count);
        void reconcileBadge(count);
        return;
      }
      if (event.data?.type === "folio-alert-panel-state") {
        if (event.data.user_id !== session.user.id) return;
        setAlertsOpen(event.data.open === true);
        return;
      }
      if (event.data?.type === "folio-alert-sheet-data") {
        if (!folio2NavigationEnabled || event.data.user_id !== session.user.id || !Array.isArray(event.data.active)) return;
        const rows = event.data.active.filter((row: any) => row && typeof row.key === "string" && typeof row.title === "string" && typeof row.detail === "string" && (row.eventId ? row.actorUserId === session.user.id && typeof row.householdId === "string" && (typeof row.eventVersion === "string" || Number.isSafeInteger(row.eventVersion)) : row.synthetic === true)).map((row: any) => ({ ...row, eventVersion: typeof row.eventVersion === "string" || typeof row.eventVersion === "number" ? row.eventVersion : undefined }));
        setFolioAlertRows(rows);
        setFolioAlertRowsOwner(session.user.id);
        return;
      }
        if (event.data?.type === "folio-open-transaction-filter" && folio2NavigationEnabled) {
        if (event.data.user_id !== session.user.id) return;
        const payload=event.data.request;
        if(!payload||payload.focus!=='all'||!Array.isArray(payload.months)||!Array.isArray(payload.categories)||!Array.isArray(payload.accounts)||!Array.isArray(payload.accountIds))return;
        const cleanOptions=(items:any[])=>items.filter(item=>item&&typeof item.value==='string'&&typeof item.label==='string').map(item=>({value:item.value.slice(0,100),label:item.label.slice(0,100)}));
        setFolioFilterRequest({focus:payload.focus,month:String(payload.month||'All dates'),category:String(payload.category||'All categories'),months:cleanOptions(payload.months),categories:cleanOptions(payload.categories),accounts:payload.accounts.filter((item:any)=>item&&typeof item.id==='string'&&typeof item.label==='string').map((item:any)=>({id:item.id.slice(0,120),label:item.label.slice(0,120)})),accountIds:payload.accountIds.filter((item:any)=>typeof item==='string').map((item:string)=>item.slice(0,120))});
        setFolioFilterOwner(session.user.id);setFolioFilterOpen(true);return;
      }
      if (event.data?.type === "folio-home-notification-disposition") {
        if (!client) return;
        const saveUserId = session.user.id;
        if (event.data.userId !== saveUserId) return;
        const sessionGeneration = homeNotificationSessionGenerationRef.current;
        const transactionId = String(event.data.transactionId || "").trim();
        const dispositionKey = typeof event.data.dispositionKey === "string" ? event.data.dispositionKey : homeRefundDispositionKey(transactionId);
        const preferenceKey = validHomeNotificationDispositionKey(dispositionKey) ? dispositionKey : null;
        const disposition = event.data.disposition;
        const requestId = String(event.data.requestId || "");
        if (!preferenceKey || !["dismissed", "snoozed"].includes(disposition) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return;
        const operationKey = `${saveUserId}:${preferenceKey}`;
        if (homeNotificationWritesInFlightRef.current.has(operationKey)) return;
        homeNotificationWritesInFlightRef.current.add(operationKey);
        const stillOwned = () => homeNotificationSessionGenerationRef.current === sessionGeneration && session?.user.id === saveUserId && previousAuthUserRef.current === saveUserId;
        const run = async () => {
          if (!stillOwned()) return;
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 8000);
          try {
            const latest = await client.from("finance_user_preferences").select("home_notification_dispositions").eq("user_id", saveUserId).abortSignal(controller.signal).maybeSingle();
            if (latest.error) throw new Error("Couldn’t load your saved Home notifications. Try again.");
            if (!stillOwned()) return;
            const next = preferenceKey.startsWith("activity:")
              ? setHomeActivityDisposition(latest.data?.home_notification_dispositions, preferenceKey, disposition as "dismissed" | "snoozed")
              : setHomeRefundDisposition(latest.data?.home_notification_dispositions, transactionId, disposition as "dismissed" | "snoozed");
            if (!next) throw new Error("This notification could not be updated.");
            const expected = next[preferenceKey];
            const saved = await client.from("finance_user_preferences").upsert({ user_id: saveUserId, home_notification_dispositions: next }, { onConflict: "user_id" }).select("home_notification_dispositions").abortSignal(controller.signal).single();
            if (saved.error) throw new Error("Couldn’t save this Home notification. Try again.");
            if (!stillOwned()) return;
            const verified = parseHomeNotificationDispositions(saved.data?.home_notification_dispositions);
            const entry = verified[preferenceKey];
            if (!expected || !entry || entry.disposition !== disposition || entry.updated_at !== expected.updated_at || entry.snoozed_until !== expected.snoozed_until) throw new Error("Folio couldn’t verify the saved Home notification. Try again.");
            homeNotificationDispositionsRef.current = verified;
            homeNotificationDispositionsRevisionRef.current += 1;
            setHomeNotificationDispositions(verified);
            dashboardFrame.current?.contentWindow?.postMessage({ type: "folio-home-notification-disposition-saved", userId: saveUserId, requestId, transactionId, dispositionKey: preferenceKey, disposition, dispositions: verified }, window.location.origin);
          } finally { window.clearTimeout(timeout); }
        };
        const queued = homeNotificationWriteQueueRef.current.then(run, run);
        homeNotificationWriteQueueRef.current = queued.then(() => {}, () => {});
        void queued.catch((error) => {
          if (stillOwned()) dashboardFrame.current?.contentWindow?.postMessage({ type: "folio-home-notification-disposition-error", userId: saveUserId, requestId, transactionId, dispositionKey: preferenceKey, message: error instanceof Error ? error.message : "Couldn’t save this Home notification. Try again." }, window.location.origin);
        }).finally(() => homeNotificationWritesInFlightRef.current.delete(operationKey));
        return;
      }
      if (event.data?.type === "folio2-widget-order") {
        if(!folio2NavigationEnabled||!preferencesLoaded||preferencesUserId!==session.user.id)return;
        const saveUserId=session.user.id;
        const folio2WidgetOrder=parseFolio2WidgetOrder(event.data.order);
        if(!Array.isArray(event.data.order)||event.data.order.length!==DEFAULT_FOLIO2_WIDGET_ORDER.length||JSON.stringify(event.data.order)!==JSON.stringify(folio2WidgetOrder))return;
        const {error}=await client.from("finance_user_preferences").upsert({user_id:saveUserId,folio2_widget_order:folio2WidgetOrder,updated_at:new Date().toISOString()},{onConflict:"user_id"});
        if(!session||session.user.id!==saveUserId||previousAuthUserRef.current!==saveUserId||preferencesUserId!==saveUserId)return;
        if(error){dashboardFrame.current?.contentWindow?.postMessage({type:"folio-preferences-save-error"},window.location.origin);return;}
        setPreferences((current)=>({...current,folio2WidgetOrder}));
        return;
      }
      if (event.data?.type === "folio-theme-change") {
        if (!preferencesLoaded || preferencesUserId !== session.user.id) return;
        const themeColor = String(event.data.themeColor || "");
        if (!HEX_COLOR.test(themeColor)) return;
        const next = { ...preferences, themeColor };
        setPreferences(next);
        void persistPreferences(next);
        return;
      }
      if (event.data?.type === "folio-theme-mode-change") {
        if (!preferencesLoaded || preferencesUserId !== session.user.id) return;
        const themeMode = event.data.themeMode;
        if (!isAppearanceMode(themeMode)) return;
        const next = { ...preferences, themeMode };
        setPreferences(next);
        void persistPreferences(next);
        return;
      }
      if (event.data?.type === "folio-dismiss-alert") {
        if (!preferencesLoaded || preferencesUserId !== session.user.id) return;
        const alertKey = String(event.data.alertKey || "").trim();
        if (!alertKey || alertKey.length > 240 || preferences.dismissedAlertKeys.includes(alertKey)) return;
        const next = {
          ...preferences,
          dismissedAlertKeys: [...preferences.dismissedAlertKeys, alertKey],
        };
        setPreferences(next);
        void persistPreferences(next);
        return;
      }
      if (event.data?.type === "folio-dismiss-guided-insight") {
        if (!preferencesLoaded || preferencesUserId !== session.user.id) return;
        const insightKey = String(event.data.insightKey || "").trim();
        if (!insightKey || insightKey.length > 2000 || preferences.dismissedInsightKeys.includes(insightKey)) return;
        const next = {
          ...preferences,
          dismissedInsightKeys: [...preferences.dismissedInsightKeys, insightKey].slice(-100),
        };
        setPreferences(next);
        void persistPreferences(next);
        return;
      }
      if (event.data?.type === "folio-restore-guided-insight") {
        if (!preferencesLoaded || preferencesUserId !== session.user.id) return;
        const insightKey = String(event.data.insightKey || "").trim();
        if (!insightKey || !preferences.dismissedInsightKeys.includes(insightKey)) return;
        const next = {
          ...preferences,
          dismissedInsightKeys: preferences.dismissedInsightKeys.filter((key) => key !== insightKey),
        };
        setPreferences(next);
        void persistPreferences(next);
      }
    };
    window.addEventListener("message", receiveDashboardEvent);
    return () => window.removeEventListener("message", receiveDashboardEvent);
  }, [client, preferences, preferencesLoaded, preferencesUserId, homeNotificationDispositionsReadyFor, session?.user.id]);

  function saveAskFolioMemory(memory: Omit<AskFolioMemory, "id" | "createdAt">, canonicalMemories: AskFolioMemory[]): Promise<boolean> {
    if (!session?.user.id || !preferencesLoaded || preferencesUserId !== session.user.id || !Array.isArray(canonicalMemories) || canonicalMemories.length > 24) return Promise.resolve(false);
    const summary = memory.summary.trim().slice(0, 280);
    const key = memory.key.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").slice(0, 80);
    if (!summary || !key || !["goal", "decision", "completed_change"].includes(memory.kind)) return Promise.resolve(false);
    const verified = verifiedAskFolioMemories(canonicalMemories);
    if (!verified || !verified.some((row) => row.key === key && row.summary === summary && row.kind === memory.kind && row.effectiveFrom === memory.effectiveFrom && row.effectiveUntil === memory.effectiveUntil)) return Promise.resolve(false);
    setPreferences((current) => ({ ...current, askFolioMemories: verified }));
    return Promise.resolve(true);
  }

  function adoptCanonicalAskFolioMemories(canonicalMemories: unknown): Promise<boolean> {
    if (!session?.user.id || !preferencesLoaded || preferencesUserId !== session.user.id) return Promise.resolve(false);
    const verified = verifiedAskFolioMemories(canonicalMemories);
    if (!verified) return Promise.resolve(false);
    setPreferences((current) => ({ ...current, askFolioMemories: verified }));
    return Promise.resolve(true);
  }

  function openTabOrderSettings() {
    settingsLandingReturn.current = folio2NavigationEnabled && settingsLandingOpen;
    if(settingsLandingReturn.current)setSettingsLandingOpen(false);
    setMenuOpen(false);
    setTabOrderFolio2(folio2NavigationEnabled);
    const normalized=normalizeMobileTabOrder(preferences.mobileTabOrder);
    setTabOrderDraft(folio2NavigationEnabled?preferences.folio2TabOrder.map((root)=>FOLIO2_ROOT_PREFERENCE_PAGE[root]):normalized);
    setTabOrderError("");
    setTabOrderOpen(true);
  }

  function closeTabOrderSettings() {
    setTabOrderOpen(false);
    if(settingsLandingReturn.current){
      settingsLandingReturn.current=false;
      setSettingsLandingOpen(true);
      window.requestAnimationFrame(()=>settingsLandingCloseButton.current?.focus());
    }
  }

  function moveMobileTab(page: MobileTabPage, direction: -1 | 1) {
    setTabOrderDraft((current) => {
      const index = current.indexOf(page);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  async function saveMobileTabOrder() {
    if (!client || !session?.user.id || !preferencesLoaded || preferencesUserId !== session.user.id) return;
    const mobileTabOrder = tabOrderFolio2?preferences.mobileTabOrder:normalizeMobileTabOrder(tabOrderDraft);
    const folio2TabOrder = tabOrderFolio2?tabOrderDraft.flatMap((page)=>FOLIO2_PREFERENCE_ROOT[page]||[]):preferences.folio2TabOrder;
    const saveUserId = session.user.id;
    if(tabOrderFolio2)folio2TabOrderRevisionRef.current++;
    setTabOrderSaving(true);
    setTabOrderError("");
    const { error } = await client.from("finance_user_preferences").upsert({
      user_id: saveUserId,
      ...(tabOrderFolio2 ? { folio2_mobile_tab_order: folio2TabOrder } : { mobile_tab_order: mobileTabOrder }),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    setTabOrderSaving(false);
    if(!session||session.user.id!==saveUserId||previousAuthUserRef.current!==saveUserId||preferencesUserId!==saveUserId)return;
    if (error) {
      setTabOrderError("Couldn’t save that order. Please try again.");
      return;
    }
    if(tabOrderFolio2)cacheFolio2TabOrder(saveUserId,folio2TabOrder);
    setPreferences((current) => ({ ...current, mobileTabOrder, folio2TabOrder }));
    closeTabOrderSettings();
  }

  useLayoutEffect(() => {
    if (!session) { setMobileShell({ enabled: false, title: "Home", page: "dashboard", modal: false }); return; }
    // The F2 host owns the mobile header while the iframe restores its session/data.
    // Enable the shell before the first authenticated paint so the child never starts
    // full-bleed underneath a header whose inset is waiting on a child navigation event.
    if (folio2NavigationEnabled) {
      setMobileShell((current) => current.enabled ? current : { enabled: true, title: "Home", page: "dashboard", modal: false });
    }
    const receiveShell = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== dashboardFrame.current?.contentWindow || event.data?.type !== "folio-mobile-shell") return;
      setDashboardAppReady(true);
      setDashboardBootStalled(false);
      markStartup("shell_rendered");
      const folio2ActivityPage = folio2NavigationEnabled && (event.data.page === "folio2-spending" || event.data.page === "folio2-cashflow");
      const folio2KnownPage = folio2ActivityPage || folio2NavigationEnabled && (event.data.page === "budget" || event.data.page === "planning" || event.data.page === "recurring" || event.data.page === "transactions" || event.data.page === "investments");
      const page = MOBILE_NAV.some((item) => item.page === event.data.page) || folio2KnownPage ? event.data.page : "dashboard";
      let title = String(event.data.title || "Folio").slice(0, 40);
      if (folio2NavigationEnabled) {
        const nextRoute = routeForExistingPage(page, folio2Route, folio2SegmentMemory, typeof event.data.folio2Screen === "string" ? event.data.folio2Screen : undefined);
        setFolio2Route(nextRoute);
        if (nextRoute.root !== "home") folio2InitialHomeRouteSent.current = true;
        if (nextRoute.root === "activity" && nextRoute.segment && isFolio2ActivitySegment(nextRoute.segment)) setFolio2SegmentMemory((current) => ({ ...current, activity: nextRoute.segment as Folio2Segment }));
        if (nextRoute.root === "accounts" && nextRoute.segment && isFolio2AccountSegment(nextRoute.segment)) setFolio2SegmentMemory((current) => ({ ...current, accounts: nextRoute.segment as Folio2Segment }));
        if (nextRoute.root === "plan" && nextRoute.segment && isFolio2PlanSegment(nextRoute.segment)) setFolio2SegmentMemory((current) => ({ ...current, plan: nextRoute.segment as Folio2Segment }));
        title = page === "rental" ? "Rental P&L" : nextRoute.root === "activity" ? "Activity" : nextRoute.root === "plan" ? "Plan" : FOLIO2_ROOT_TABS.find((tab) => tab.root === nextRoute.root)?.label || title;
      }
      setMobileShell({ enabled: folio2NavigationEnabled || event.data.enabled === true, title, page, modal: event.data.modal === true });
    };
    window.addEventListener("message", receiveShell);
    return () => window.removeEventListener("message", receiveShell);
  }, [session?.user.id, folio2NavigationEnabled, folio2Route, folio2SegmentMemory]);

  useEffect(() => {
    const userId = session?.user.id || null;
    if (folio2InitialHomeUser.current !== userId) {
      folio2InitialHomeUser.current = userId;
      folio2InitialHomeRouteSent.current = false;
      folio2FrameRoutePending.current = true;
    }
  }, [session?.user.id]);

  function showAuthMode(mode: AuthMode) {
    setAuthMode(mode);
    setAuthMessage("");
    setPassword("");
    setConfirmPassword("");
  }

  async function signInWithPassword(event: FormEvent) {
    event.preventDefault();
    if (!client || !email.trim() || !password) return;
    setAuthBusy(true);
    setAuthMessage("Signing in securely…");
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (data.session) setSession(data.session);
    setAuthMessage(error ? error.message : "");
    setAuthBusy(false);
  }

  function passkeyErrorMessage(error: { code?: string; message: string } | null) {
    if (error?.code === "passkey_disabled") return "Face ID is not enabled for Folio yet. Try your password or email link for now.";
    return error?.message || "Folio could not use Face ID. Try your password or email link instead.";
  }

  async function signInWithPasskey() {
    if (!client) return;
    setAuthBusy(true);
    setAuthMessage("Confirm with Face ID…");
    const { data, error } = await client.auth.signInWithPasskey();
    if (data.session) setSession(data.session);
    setAuthMessage(error ? passkeyErrorMessage(error) : "");
    setAuthBusy(false);
  }

  async function registerPasskey() {
    if (!client || !session) return;
    setAuthBusy(true);
    setAccountMessage("Confirm with Face ID to finish setup…");
    const { error } = await client.auth.registerPasskey();
    setAccountMessage(error ? passkeyErrorMessage(error) : "Face ID is ready for future Folio sign-ins.");
    if (!error) setPasskeyStatus("on");
    setAuthBusy(false);
  }

  async function signOutFromSettings() {
    if(!client||!session)return;
    signingOutRef.current=true;
    clearUserEventDetailCache(session.user.id);
    await clearDashboardTransactionReplica(session.user.id);
    await disconnectPushDevice(session.access_token).catch(()=>{});
    const result=await client.auth.signOut();
    if(result?.error){signingOutRef.current=false;setAccountMessage('Could not sign out. Please try again.');}
  }

  useEffect(() => {
    if (!menuOpen || (!folio2NavigationEnabled && settingsSection !== "security") || !client || !session) return;
    let active = true;
    setPasskeyStatus("checking");
    void client.auth.passkey.list().then(({ data, error }) => {
      if (!active) return;
      setPasskeyStatus(error || !Array.isArray(data) ? "unavailable" : data.length ? "on" : "off");
    }).catch(() => { if (active) setPasskeyStatus("unavailable"); });
    return () => { active = false; };
  }, [menuOpen, settingsSection, folio2NavigationEnabled, client, session?.user.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => settingsFirstRow.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen]);

  useEffect(() => {
    setMenuRefreshState({ state: "idle", completedAt: null });
  }, [session?.user.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const timer = window.setInterval(() => setMenuRefreshState((current) => current.completedAt ? { ...current } : current), 60_000);
    return () => window.clearInterval(timer);
  }, [menuOpen]);

  async function requestPasswordReset(event: FormEvent) {
    event.preventDefault();
    if (!client || !email.trim()) return;
    setAuthBusy(true);
    setAuthMessage("Sending your password setup email…");
    const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}${folioAuthNavigationPath("/", window.location.search, "recovery")}`,
    });
    setAuthMessage(error ? error.message : "Check your email to set your Folio password.");
    setAuthBusy(false);
  }

  async function updatePassword(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    if (!session) {
      setAuthMode("request-reset");
      setAuthMessage("Your password setup session expired. Request a new email and open it in the same browser.");
      return;
    }
    if (password.length < 8) {
      setAuthMessage("Use at least 8 characters for your password.");
      return;
    }
    if (password !== confirmPassword) {
      setAuthMessage("Those passwords do not match.");
      return;
    }
    setAuthBusy(true);
    setAuthMessage("Saving your password…");
    const { error } = await client.auth.updateUser({ password });
    if (error) {
      setAuthMessage(error.message);
    } else {
      setAuthMessage("");
      setAuthMode("password");
      setPassword("");
      setConfirmPassword("");
      window.history.replaceState({}, document.title, folioAuthNavigationPath(window.location.pathname, window.location.search));
    }
    setAuthBusy(false);
  }

  async function sendMagicLink(event: FormEvent) {
    event.preventDefault();
    if (!client || !email.trim()) return;
    setAuthBusy(true);
    setAuthMessage("Sending your secure sign-in link…");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}${folioAuthNavigationPath("/", window.location.search, "sign-in")}` },
    });
    setAuthMessage(error ? error.message : "Check your email to finish signing in.");
    setAuthBusy(false);
  }

  function sendDashboardCommand(message: { type: string; page?: string; folio2Screen?: string; transaction_id?: string; goal_id?: string; savings_activity_id?: string; returnTo?: "assistant" | "settings" }) {
    dashboardFrame.current?.contentWindow?.postMessage(message, window.location.origin);
    if (folio2NavigationEnabled && message.type === "folio-open-page" && message.page) {
      const label = MOBILE_NAV.find((item) => item.page === message.page)?.label || (message.page === "dashboard" ? "Home" : "Folio");
      setMobileShell((current) => ({ ...current, page: message.page?.startsWith("folio2-") ? "dashboard" : message.page!, title: label }));
    }
    setMenuOpen(false);
  }

  function openFolio2Route(route: Folio2Route) {
    folio2InitialHomeRouteSent.current = true;
    folio2FrameRoutePending.current = false;
    folio2ScrollCleanup.current?.();
    folio2ScrollCleanup.current = null;
    const scrollRequest = ++folio2ScrollRequest.current;
    setFolio2Route(route);
    if (route.root === "activity" && route.segment && isFolio2ActivitySegment(route.segment)) setFolio2SegmentMemory((current) => ({ ...current, activity: route.segment as Folio2Segment }));
    if (route.root === "accounts" && route.segment && isFolio2AccountSegment(route.segment)) setFolio2SegmentMemory((current) => ({ ...current, accounts: route.segment as Folio2Segment }));
    if (route.root === "plan" && route.segment && isFolio2PlanSegment(route.segment)) setFolio2SegmentMemory((current) => ({ ...current, plan: route.segment as Folio2Segment }));
    const page = existingPageForFolio2Route(route);
    sendDashboardCommand({ type: "folio-open-page", page, ...(page === "folio2-spending" ? { folio2Screen: "spending" } : page === "folio2-cashflow" ? { folio2Screen: "cashflow" } : route.root === "activity" && route.segment === "recurring" ? { folio2Screen: "recurring" } : route.root === "accounts" && route.segment === "investments" ? { folio2Screen: "investments" } : route.root === "accounts" ? { folio2Screen: "accounts" } : route.root === "plan" && route.segment === "budget" ? { folio2Screen: "budget" } : route.root === "plan" && route.segment === "forecast" ? { folio2Screen: "forecast" } : route.root === "plan" && route.segment === "goals" ? { folio2Screen: "goals" } : route.root === "transactions" ? { folio2Screen: "transactions" } : {}) });
    setMobileShell((current) => ({ ...current, page: page.startsWith("folio2-") ? "dashboard" : page, title: route.root === "activity" ? "Activity" : route.root === "plan" ? "Plan" : FOLIO2_ROOT_TABS.find((tab) => tab.root === route.root)?.label || "Folio" }));
    const target = existingScrollTargetForFolio2Route(route);
    if (target) {
      const frameDocument = dashboardFrame.current?.contentDocument;
      const frameWindow = frameDocument?.defaultView;
      let timeout = 0;
      let scrollWhenReady = () => {};
      const observer = frameDocument && frameWindow ? new frameWindow.MutationObserver(() => scrollWhenReady()) : null;
      const cleanup = () => {
        observer?.disconnect();
        if (timeout) window.clearTimeout(timeout);
      };
      scrollWhenReady = () => {
        if (scrollRequest !== folio2ScrollRequest.current || !frameDocument || !frameWindow) {
          cleanup();
          return;
        }
        const element = frameDocument.querySelector<HTMLElement>(target);
        if (element) {
          cleanup();
          if (folio2ScrollCleanup.current === cleanup) folio2ScrollCleanup.current = null;
          element.scrollIntoView({ block: "start", behavior: "instant" });
        }
      };
      timeout = window.setTimeout(() => {
        cleanup();
        if (folio2ScrollCleanup.current === cleanup) folio2ScrollCleanup.current = null;
      }, 5000);
      folio2ScrollCleanup.current = cleanup;
      if (frameDocument?.documentElement) observer?.observe(frameDocument.documentElement, { childList: true, subtree: true });
      window.requestAnimationFrame(scrollWhenReady);
      window.requestAnimationFrame(scrollWhenReady);
    }
  }

  function openSettingsSection(section: SettingsSection) {
    if (section === "home") return;
    settingsReturnFocus.current = section;
    setSettingsSection(section);
    window.requestAnimationFrame(() => settingsBackButton.current?.focus());
  }

  function returnToSettingsHome() {
    setSettingsSection("home");
    window.requestAnimationFrame(() => {
      const section = settingsReturnFocus.current;
      if (section) settingsMenu.current?.querySelector<HTMLButtonElement>(`[data-settings-category="${section}"]`)?.focus();
    });
  }

  function toggleSettingsMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      window.requestAnimationFrame(() => settingsMenuButton.current?.focus());
      return;
    }
    setSettingsSection("home");
    setMenuOpen(true);
  }

  function openSettingsLanding() {
    setSettingsLandingOpen(true);
    window.requestAnimationFrame(() => settingsLandingCloseButton.current?.focus());
  }

  function closeSettingsLanding() {
    setSettingsLandingOpen(false);
    window.requestAnimationFrame(() => settingsLandingTrigger.current?.focus());
  }

  function handleSettingsLandingKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettingsLanding();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),details>summary'))
      .filter((element) => element.matches("summary") || !element.closest("details:not([open])"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (event.currentTarget.ownerDocument.activeElement === first || !event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (event.currentTarget.ownerDocument.activeElement === last || !event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleSettingsMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (settingsSection !== "home") {
      returnToSettingsHome();
      return;
    }
    setMenuOpen(false);
    window.requestAnimationFrame(() => settingsMenuButton.current?.focus());
  }

  function requestMenuRefresh() {
    setMenuRefreshState({ state: "refreshing", completedAt: null });
    dashboardFrame.current?.contentWindow?.postMessage({ type: "folio-refresh-all" }, window.location.origin);
  }

  function relativeRefreshAge(completedAt: number | null) {
    if (!completedAt) return "";
    const elapsed = Math.max(0, Date.now() - completedAt);
    if (elapsed < 60_000) return "Just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
    return new Date(completedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function collectLayoutDiagnostics() {
    const visual = window.visualViewport;
    const host = dashboardHost.current?.getBoundingClientRect();
    const footer = mobileTabs.current?.getBoundingClientRect();
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;inset:auto 0 0;height:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;";
    document.body.appendChild(probe);
    const safeBottom = probe.getBoundingClientRect().height;
    probe.remove();
    const topProbe = document.createElement("div");
    topProbe.style.cssText = "position:fixed;inset:0 0 auto;height:0;padding-top:env(safe-area-inset-top);visibility:hidden;pointer-events:none;";
    document.body.appendChild(topProbe);
    const safeTop = topProbe.getBoundingClientRect().height;
    topProbe.remove();
    const footerStyle = mobileTabs.current ? getComputedStyle(mobileTabs.current) : null;
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const rect = (name: string, value?: DOMRect) => `${name}: ${value ? `${Math.round(value.top)},${Math.round(value.bottom)} h${Math.round(value.height)}` : "unavailable"}`;
    const htmlStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const cssProbe = (unit: string) => {
      const element = document.createElement("div");
      element.style.cssText = `position:fixed;left:-9999px;top:0;width:1px;height:100${unit};visibility:hidden;pointer-events:none;`;
      document.body.appendChild(element);
      const height = Math.round(element.getBoundingClientRect().height);
      element.remove();
      return height;
    };
    const viewportMetas = Array.from(document.querySelectorAll('meta[name="viewport"]')).map((meta) => meta.getAttribute("content") || "").join(" | ") || "none";
    const appleMeta = (name: string) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || "missing";
    let parentViewport = "cross-origin/unreadable";
    try {
      parentViewport = `inner ${window.parent.innerWidth} × ${window.parent.innerHeight}; client ${window.parent.document.documentElement.clientWidth} × ${window.parent.document.documentElement.clientHeight}`;
    } catch { /* parent may be cross-origin */ }
    const frameElement = window.frameElement;
    return [
      "layout diagnostics: 2",
      `top window: ${window.top === window}`,
      `frame element: ${frameElement ? `${frameElement.tagName} ${rect("rect", frameElement.getBoundingClientRect())}` : "none"}`,
      `parent viewport: ${parentViewport}`,
      `viewport meta: ${document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "missing"}`,
      `all viewport metas: ${viewportMetas}`,
      `apple metas: capable=${appleMeta("apple-mobile-web-app-capable")}; status=${appleMeta("apple-mobile-web-app-status-bar-style")}`,
      `standalone: ${standalone}`,
      `screen: ${screen.width} × ${screen.height}`,
      `window: inner ${window.innerWidth} × ${window.innerHeight}; outer ${window.outerWidth} × ${window.outerHeight}`,
      `visual viewport: ${visual ? `${Math.round(visual.width)} × ${Math.round(visual.height)} at ${Math.round(visual.offsetLeft)},${Math.round(visual.offsetTop)} scale ${visual.scale}` : "unavailable"}`,
      `document: client ${document.documentElement.clientWidth} × ${document.documentElement.clientHeight}; scroll ${document.documentElement.scrollWidth} × ${document.documentElement.scrollHeight}`,
      rect("host", host), rect("footer", footer),
      `footer style: bottom ${footerStyle?.bottom || "unavailable"}; padding-bottom ${footerStyle?.paddingBottom || "unavailable"}`,
      `safe-area insets: top ${Math.round(safeTop)}; bottom ${Math.round(safeBottom)}`,
      `html: ${rect("rect", document.documentElement.getBoundingClientRect())}; position ${htmlStyle.position}; height ${htmlStyle.height}; overflow ${htmlStyle.overflow}; transform ${htmlStyle.transform}`,
      `body: ${rect("rect", document.body.getBoundingClientRect())}; position ${bodyStyle.position}; height ${bodyStyle.height}; overflow ${bodyStyle.overflow}; transform ${bodyStyle.transform}`,
      `viewport units px: vh ${cssProbe("vh")}; svh ${cssProbe("svh")}; lvh ${cssProbe("lvh")}; dvh ${cssProbe("dvh")}`,
    ].join("\n");
  }

  async function copyLayoutDiagnostics() {
    if (!layoutDiagnostics) return;
    try { await navigator.clipboard.writeText(layoutDiagnostics); setLayoutCopied(true); } catch { setLayoutCopied(false); }
  }

  function sendDashboardPwaMode() {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const mobile = window.matchMedia?.("(max-width: 899px)").matches === true && navigator.maxTouchPoints > 0;
    dashboardFrame.current?.contentWindow?.postMessage({ type: "folio-pwa-mode", standalone, mobile }, window.location.origin);
  }

  function sendDashboardEmbeddedLayout() {
    const embeddedShellEnabled = folio2NavigationEnabled || mobileShell.enabled;
    const tabs = mobileTabs.current;
    const tabsRect = tabs && !tabs.hidden ? tabs.getBoundingClientRect() : null;
    const bottomObstruction = embeddedShellEnabled && tabsRect
      ? Math.max(0, Math.ceil(window.innerHeight - tabsRect.top))
      : undefined;
    const header = dashboardHost.current?.querySelector<HTMLElement>(".dashboard-mobile-header");
    const segments = dashboardHost.current?.querySelector<HTMLElement>(".dashboard-folio2-segments");
    const measuredChromeBottoms = [
      segments && !segments.hidden ? segments : null,
      header,
      dashboardHost.current?.querySelector<HTMLElement>(".dashboard-settings-entry"),
      dashboardHost.current?.querySelector<HTMLElement>(".dashboard-alert-button"),
      dashboardHost.current?.querySelector<HTMLElement>(".ask-folio-launcher"),
    ].flatMap((element) => {
      if (!element || element.hidden) return [];
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return [];
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return [];
      return [rect.bottom];
    });
    const topEdge = measuredChromeBottoms.length ? Math.max(...measuredChromeBottoms) : undefined;
    const updateBanner = updateBannerRef.current;
    if (updateBanner) {
      const updateTop = `${Math.max(0, Math.ceil(topEdge || 0))}px`;
      const updateHeight = `${Math.max(0, Math.ceil(updateBanner.getBoundingClientRect().height))}px`;
      dashboardHost.current?.style.setProperty("--folio-update-top", updateTop);
      dashboardHost.current?.style.setProperty("--folio-update-height", updateHeight);
      updateBanner.style.setProperty("--folio-update-top", updateTop);
      updateBanner.style.setProperty("--folio-update-height", updateHeight);
    }
    const bannerBottom = updateRequired && updateBanner ? updateBanner.getBoundingClientRect().bottom : 0;
    const glassClearance = dashboardHost.current
      ? Number.parseFloat(getComputedStyle(dashboardHost.current).getPropertyValue("--folio-shell-glass-clearance")) || 0
      : 0;
    const iframeTop = updateRequired ? dashboardFrame.current?.getBoundingClientRect?.().top || 0 : 0;
    const obstructionEdge = updateRequired
      ? Math.max(topEdge || 0, bannerBottom) - iframeTop
      : segments && !segments.hidden ? topEdge : header?.getBoundingClientRect().bottom ?? topEdge;
    const topObstruction = embeddedShellEnabled && folio2NavigationEnabled && topEdge !== undefined
      ? Math.max(0, Math.ceil(obstructionEdge + glassClearance))
      : undefined;
    dashboardFrame.current?.contentWindow?.postMessage(
      { type: "folio-embedded-guided-mobile", enabled: embeddedShellEnabled, ...(bottomObstruction ? { bottomObstruction } : {}), ...(topObstruction ? { topObstruction } : {}) },
      window.location.origin,
    );
  }

  function sendDashboardPreferences() {
    const cachedTheme = bootTheme();
    const hasUserScopedBootstrap = cachedTheme?.hasCachedPreference === true && cachedTheme.userId === session?.user.id;
    if ((!preferencesLoaded || preferencesUserId !== session?.user.id) && !hasUserScopedBootstrap) return;
    dashboardFrame.current?.contentWindow?.postMessage(
      {
        type: "folio-preferences",
        themeColor: preferences.themeColor,
        themeMode: preferences.themeMode,
        dismissedAlertKeys: preferences.dismissedAlertKeys,
        dismissedInsightKeys: preferences.dismissedInsightKeys,
        homeNotificationUserId: session?.user.id,
        homeNotificationDispositionsReady: Boolean(session?.user.id && homeNotificationDispositionsReadyFor === session.user.id),
        ...(session?.user.id && homeNotificationDispositionsReadyFor === session.user.id ? { homeNotificationDispositions } : {}),
        ...(folio2NavigationEnabled ? { folio2WidgetOrder: preferences.folio2WidgetOrder } : {}),
      },
      window.location.origin,
    );
  }

  if (config === "loading" || callbackPending) {
    return <main className="center-state"><img className="folio-mark" src="/brand/folio-icon.svg" alt="Folio" /><p>{callbackPending ? "Finishing secure sign-in…" : "Opening Folio…"}</p></main>;
  }

  if (config === "missing") {
    return <main className="center-state folio-startup-error"><img className="folio-mark" src="/brand/folio-icon.svg" alt="Folio" /><h1>Folio couldn’t finish opening</h1><p role="status">{authMessage || "The data connection is not available in this deployment."}</p><div className="folio-startup-actions"><button type="button" onClick={() => { setAuthMessage(""); setConfig("loading"); setAuthBootRetry((attempt) => attempt + 1); }}>Try again</button>{authBootHostingReauth&&<a className="folio-startup-signin" href="/signin-with-chatgpt?return_to=%2F">Sign in with ChatGPT</a>}{authBootSupportRef&&<button type="button" onClick={() => { void (async()=>{try{await navigator.clipboard.writeText(authBootReport);setAuthBootReportCopied(true);}catch{setAuthBootReportCopied(false);}})(); }}>{authBootReportCopied ? "Copied" : "Copy support report"}</button>}</div><p className="auth-message">If you’re still offline, reconnect and try again. Folio keeps your saved sign-in session.</p>{authBootSupportRef&&<details><summary>Support reference: {authBootSupportRef}</summary><pre>{authBootReport}</pre></details>}</main>;
  }

  if (session && (!preferencesLoaded || preferencesUserId !== session.user.id)) {
    return <main className="center-state"><img className="folio-mark" src="/brand/folio-icon.svg" alt="Folio" /><p>Opening Folio…</p></main>;
  }

  if (!session || authMode === "set-password") {
    const passwordLogin = authMode === "password";
    const passwordReset = authMode === "request-reset";
    const passwordUpdate = authMode === "set-password";
    return <main className="auth-page">
      <section className="auth-card">
        <img className="auth-logo" src="/brand/folio-logo-dark.svg" alt="Folio" />
        <p className="eyebrow">See clearly. Act confidently. Grow steadily.</p>
        <h1>{passwordUpdate ? "Choose a password" : passwordReset ? "Set or reset password" : authMode === "magic" ? "Email link sign-in" : "Welcome to Folio"}</h1>
        <p className="muted">{passwordUpdate ? "Use at least 8 characters." : passwordReset ? "We’ll send one secure email to set your password." : "Use the email connected to your household."}</p>
        {!passwordUpdate && !passwordReset && <><button className="auth-passkey" type="button" onClick={() => void signInWithPasskey()} disabled={authBusy}><Fingerprint size={20} /> {authBusy ? "Waiting for Face ID…" : "Sign in with Face ID"}</button><div className="auth-divider"><span>or</span></div></>}
        {passwordUpdate ? <form onSubmit={updatePassword}>
          <label htmlFor="new-password">New password</label>
          <input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required />
          <label htmlFor="confirm-password">Confirm password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required />
          <button type="submit" disabled={authBusy}>{authBusy ? "Saving…" : "Save password"}</button>
        </form> : <form onSubmit={passwordLogin ? signInWithPassword : passwordReset ? requestPasswordReset : sendMagicLink}>
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required />
          {passwordLogin && <><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></>}
          <button type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : passwordLogin ? "Sign in" : passwordReset ? "Send password setup email" : "Send sign-in link"}</button>
        </form>}
        {!passwordUpdate && <div className="auth-options">
          {passwordLogin ? <>
            <button type="button" onClick={() => showAuthMode("request-reset")}>Set or reset password</button>
            <button type="button" onClick={() => showAuthMode("magic")}>Use an email sign-in link</button>
          </> : <button type="button" onClick={() => showAuthMode("password")}>Back to password sign-in</button>}
        </div>}
        {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
        <p className="security-note"><ShieldCheck size={17} /> Plaid credentials never pass through Folio.</p>
      </section>
    </main>;
  }

  async function copyStartupDiagnostics() {
    setStartupDiagnosticsStatus("Collecting startup details…");
    const frame=dashboardFrame.current;
    let framePath="not-created",frameAccess="no-frame",frameReadyState="unknown",dashboardRoot: boolean | null=null,frameReady: boolean | null=null;
    if(frame){
      try{const requested=new URL(frame.getAttribute("src")||"",window.location.origin);framePath=requested.origin===window.location.origin?requested.pathname:"other";}catch{framePath="other";}
      try{
        const child=frame.contentWindow;
        if(child&&child.location.origin===window.location.origin){
          frameAccess="same-origin";
          const childDocument=frame.contentDocument;
          frameReadyState=childDocument?.readyState||"unknown";
          dashboardRoot=Boolean(childDocument?.getElementById("folio-dashboard-production"));
          frameReady=Boolean((child as Window&{__folioDashboardAppReady?:boolean}).__folioDashboardAppReady||childStartupMilestones.current.some(item=>item.stage==="app_ready"));
        }else frameAccess="blocked";
      }catch{frameAccess="blocked";}
    }
    const serviceWorkerController=navigator.serviceWorker?.controller;
    let workerScript="unknown";
    if(serviceWorkerController){try{const script=new URL(serviceWorkerController.scriptURL);workerScript=script.origin===window.location.origin&&script.pathname==="/sw.js"?"/sw.js":"other";}catch{workerScript="other";}}
    const cacheResults:{dashboard:"present"|"missing"|"unavailable";assets:Record<string,"present"|"missing"|"unavailable">}={dashboard:"unavailable",assets:{}};
    const inspectCaches=async()=>{
      if(!("caches"in window))return;
      try{const shell=await caches.open("folio-shell-v3"),dashboardCache=await shell.match(new URL("/dashboard",window.location.origin).href)||await shell.match(new URL("/dashboard.html",window.location.origin).href);cacheResults.dashboard=dashboardCache?"present":"missing";}catch{cacheResults.dashboard="unavailable";}
      try{const assets=await caches.open("folio-assets-v2");await Promise.all(STARTUP_DIAGNOSTIC_RESOURCES.map(async asset=>{try{cacheResults.assets[asset]=await assets.match(new URL(`/${asset}`,window.location.origin).href)?"present":"missing";}catch{cacheResults.assets[asset]="unavailable";}}));}catch{for(const asset of STARTUP_DIAGNOSTIC_RESOURCES)cacheResults.assets[asset]="unavailable";}
    };
    await Promise.race([inspectCaches(),new Promise<void>(resolve=>window.setTimeout(resolve,1200))]);
    const report=formatStartupDiagnostics({
      timings:(window as StartupWindow).__folioStartupTimings,
      frame:{path:framePath,load:dashboardFrameLoad,access:frameAccess,readyState:frameReadyState,root:dashboardRoot,appReady:frameReady},
      serviceWorker:{controlled:Boolean(serviceWorkerController),script:workerScript},
      cache:cacheResults,
      childMilestones:childStartupMilestones.current,
    });
    setStartupDiagnostics(report);
    try{await navigator.clipboard.writeText(report);setStartupDiagnosticsStatus("Diagnostics copied. Share the report with Folio support.");}
    catch{setStartupDiagnosticsStatus("Diagnostics are ready below. Select the report and copy it to share.");}
  }

  const resolvedAppearance = preferences.themeMode === "system"
    ? (systemDark ? "dark" : "light")
    : preferences.themeMode === "time"
      ? (timeDark ? "dark" : "light")
      : preferences.themeMode;
  const passkeyStatusLabel = passkeyStatus === "on" ? "On" : passkeyStatus === "off" ? "Not set up" : passkeyStatus === "checking" ? "Checking" : "Unavailable";
  const refreshAge = relativeRefreshAge(menuRefreshState.completedAt);
  const refreshStatusLabel = menuRefreshState.state === "refreshing" ? "Updating saved data…"
    : menuRefreshState.state === "background" ? "Updating saved data…"
    : menuRefreshState.state === "success" ? refreshAge
      : menuRefreshState.state === "partial" ? "Needs attention"
        : menuRefreshState.state === "error" ? "Refresh failed" : "";
  const folio2Navigation = folio2NavigationSpec(folio2Route);
  const folio2Icons = { home: Home, activity: ChartNoAxesCombined, transactions: ReceiptText, accounts: Landmark, plan: WalletCards };

  return <main ref={dashboardHost} className={`dashboard-host appearance-${resolvedAppearance}${mobileShell.enabled ? " guided-mobile-shell" : ""}${folio2NavigationEnabled ? " folio2-navigation-enabled" : ""}${folio2NavigationEnabled && updateRequired ? " folio2-update-visible" : ""}${folio2NavigationEnabled && (folio2Route.root === "activity" || folio2Route.root === "accounts" || folio2Route.root === "plan") && mobileShell.page !== "rental" ? " folio2-has-segments" : ""}`} style={{ "--accent": preferences.themeColor } as CSSProperties}>
    {updateRequired && <div ref={updateBannerRef} className="folio-app-update" role="status" aria-live="polite"><span>{updatePending ? "Folio is updating…" : "Update available"}</span><button type="button" disabled={updatePending} onClick={() => void updateNowRef.current()}>{updatePending ? "Updating…" : "Update"}</button></div>}
    <iframe
      key={dashboardFrameKey}
      ref={dashboardFrame}
      src={folioDashboardPath(folio2NavigationEnabled, dashboardFrameKey)}
      title="Folio finance dashboard"
      onLoad={() => {
        folio2FrameRoutePending.current = true;
        setDashboardFrameLoad("loaded");
        markStartup("dashboard_iframe_loaded");
        try {
          const frameDocument = dashboardFrame.current?.contentDocument;
          frameDocument?.addEventListener("pointerdown", () => { lastUserActivityAt.current = Date.now(); }, { passive: true });
          frameDocument?.addEventListener("keydown", () => { lastUserActivityAt.current = Date.now(); }, { passive: true });
          frameDocument?.addEventListener("input", () => { lastUserActivityAt.current = Date.now(); }, { passive: true });
          frameDocument?.addEventListener("input", trackFieldEdit, true);
          frameDocument?.addEventListener("change", trackFieldEdit, true);
          frameDocument?.addEventListener("click", markEditAction, true);
          frameDocument?.addEventListener("submit", markFormSubmit, true);
          frameDocument?.addEventListener("reset", clearFormReset, true);
        } catch {}
        const frameWindow=dashboardFrame.current?.contentWindow;
        if (!signingOutRef.current) frameWindow?.postMessage(
          { type: "folio-session", token: session.access_token, userId: session.user.id },
          window.location.origin,
        );
        sendDashboardPwaMode();
        sendDashboardEmbeddedLayout();
        sendDashboardPreferences();
        frameWindow?.postMessage({type:"folio-host-ready-query"},window.location.origin);
      }}
      onError={() => setDashboardFrameLoad("error")}
    />
    {!dashboardAppReady && <section className="dashboard-boot-overlay" role="status" aria-live="polite">
      {dashboardBootStalled ? <div className="dashboard-boot-recovery">
        <img src="/brand/folio-icon.svg" alt="" />
        <h1>Folio couldn’t finish starting.</h1>
        <p>Your saved financial data is still safe. Try again when your connection improves.</p>
        <button className="dashboard-boot-recovery-button" type="button" onClick={() => { setDashboardBootStalled(false); setDashboardFrameLoad("pending"); setStartupDiagnostics(""); setStartupDiagnosticsStatus(""); childStartupMilestones.current=[]; setDashboardFrameKey((key) => nextDashboardFrameKey(key)); }}>Try again</button>
        <button className="dashboard-diagnostics-button" type="button" onClick={copyStartupDiagnostics}>Copy startup diagnostics</button>
        {startupDiagnosticsStatus&&<p className="dashboard-diagnostics-status" role="status">{startupDiagnosticsStatus}</p>}
        <details className="dashboard-diagnostics-details"><summary>View startup diagnostics</summary><pre>{startupDiagnostics||"Select Copy startup diagnostics to generate a report."}</pre></details>
      </div> : <div className="dashboard-boot-home">
        <span className="visually-hidden">Restoring your Home screen…</span>
        <div className="dashboard-boot-heading" aria-hidden="true">
          <p className="dashboard-boot-eyebrow">TODAY</p>
          <h1>Your money, today.</h1>
        </div>
        <div className="dashboard-boot-freshness" aria-hidden="true"><span>Restoring your latest household snapshot…</span><i className="dashboard-boot-shimmer dashboard-boot-refresh-mark" /></div>
        <div className="dashboard-boot-readouts" aria-hidden="true">
          <div className="dashboard-boot-readout"><span>Projected low</span><i className="dashboard-boot-shimmer dashboard-boot-value" /><i className="dashboard-boot-shimmer dashboard-boot-detail" /></div>
          <div className="dashboard-boot-readout"><span>Budget remaining</span><i className="dashboard-boot-shimmer dashboard-boot-value" /><i className="dashboard-boot-shimmer dashboard-boot-detail" /></div>
        </div>
        <div className="dashboard-boot-sections" aria-hidden="true">
          <section className="dashboard-boot-priority">
            <p className="dashboard-boot-eyebrow">CHECKING FOR CHANGES</p>
            <i className="dashboard-boot-shimmer dashboard-boot-priority-title" />
            <i className="dashboard-boot-shimmer dashboard-boot-line" />
            <i className="dashboard-boot-shimmer dashboard-boot-line dashboard-boot-line-short" />
            <i className="dashboard-boot-shimmer dashboard-boot-action" />
          </section>
          <section className="dashboard-boot-upcoming">
            <div className="dashboard-boot-section-heading"><h2>Coming up</h2><span>Next 7 days</span></div>
            {[0, 1].map((row) => <div className="dashboard-boot-bill" key={row}><span><i className="dashboard-boot-shimmer dashboard-boot-line" /><i className="dashboard-boot-shimmer dashboard-boot-bill-detail" /></span><i className="dashboard-boot-shimmer dashboard-boot-amount" /></div>)}
            <i className="dashboard-boot-shimmer dashboard-boot-link" />
          </section>
        </div>
        <div className="dashboard-boot-weekly" aria-hidden="true"><span><i className="dashboard-boot-shimmer dashboard-boot-weekly-title" /><i className="dashboard-boot-shimmer dashboard-boot-weekly-detail" /></span><i className="dashboard-boot-shimmer dashboard-boot-action" /></div>
        <div className="dashboard-boot-footer" aria-hidden="true"><i className="dashboard-boot-shimmer dashboard-boot-link" /><i className="dashboard-boot-shimmer dashboard-boot-link" /></div>
      </div>}
    </section>}
    <header className="dashboard-mobile-header" hidden={mobileShell.modal || Boolean(layoutDiagnostics)} inert={mobileShell.modal || Boolean(layoutDiagnostics)}>
    <span className="dashboard-screen-title">{mobileShell.title}</span>
    <div className="dashboard-header-left-actions">
      {folio2NavigationEnabled && <button ref={settingsLandingTrigger} className="dashboard-settings-entry" type="button" onClick={openSettingsLanding} aria-label="Open Settings" aria-haspopup="dialog" aria-expanded={settingsLandingOpen}>
        <svg className="dashboard-settings-mark" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 13h9" /></svg>
      </button>}
      {!folio2NavigationEnabled && <button
        ref={settingsMenuButton}
        className="dashboard-menu-button"
        type="button"
        onClick={toggleSettingsMenu}
        aria-label={menuOpen ? "Close global menu" : "Open global menu"}
        aria-expanded={menuOpen}
        aria-controls="folio-account-menu"
      >{menuOpen ? <X size={19} /> : <Menu size={20} />}</button>}
    </div>
    <button
      className="dashboard-alert-button"
      type="button"
      onClick={() => sendDashboardCommand({ type: "folio-toggle-alerts" })}
      aria-label={alertsOpen ? "Close financial alerts" : `Open financial alerts${alertCount ? ` (${alertCount})` : ""}`}
      aria-expanded={alertsOpen}
    >
      {alertsOpen ? <X size={19} /> : <Bell size={20} />}
      {alertCount > 0 && <span aria-hidden="true">{alertCount > 99 ? "99+" : alertCount}</span>}
    </button>
    </header>
    {folio2NavigationEnabled && (folio2Route.root === "activity" || folio2Route.root === "accounts" || folio2Route.root === "plan") && mobileShell.page !== "rental" && <nav className="dashboard-folio2-segments" aria-label={`${folio2Route.root === "activity" ? "Activity" : folio2Route.root === "accounts" ? "Accounts" : "Plan"} sections`} hidden={mobileShell.modal || Boolean(layoutDiagnostics)}>
      {folio2Navigation.segments.map(({ segment, label, selected }) => <button key={segment} type="button" aria-pressed={selected} onClick={() => openFolio2Route(routeForFolio2Segment(segment))}>{label}</button>)}
    </nav>}
    {settingsLandingOpen && folio2NavigationEnabled && <div className="dashboard-settings-layer" onMouseDown={closeSettingsLanding}>
      <section className="dashboard-account-menu dashboard-settings-menu" role="dialog" aria-modal="true" aria-labelledby="folio-settings-landing-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleSettingsLandingKeyDown}>
        <div className="dashboard-settings-landing-heading"><div><h2 id="folio-settings-landing-title">Settings</h2><p>Make Folio work the way you want.</p></div><button ref={settingsLandingCloseButton} type="button" aria-label="Close Settings" onClick={closeSettingsLanding}><X size={19} aria-hidden="true" /></button></div>
        <details className="dashboard-settings-group">
          <summary><Palette size={18} aria-hidden="true" /><span><strong>Personalize</strong><small>Appearance, navigation, and layout</small></span><ChevronDown size={17} aria-hidden="true" /></summary>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);sendDashboardCommand({type:"folio-open-theme-settings"});}}><Palette size={18} aria-hidden="true" /><span className="dashboard-menu-label">Appearance</span><ChevronRight size={17} aria-hidden="true" /></button>
          <button className="dashboard-menu-row" type="button" onClick={openTabOrderSettings}><ListOrdered size={18} aria-hidden="true" /><span className="dashboard-menu-label">Customize tab order</span><ChevronRight size={17} aria-hidden="true" /></button>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);sendDashboardCommand({type:"folio-open-reorder-widgets"});}}><LayoutDashboard size={18} aria-hidden="true" /><span className="dashboard-menu-label">Reorder widgets</span><ChevronRight size={17} aria-hidden="true" /></button>
        </details>
        <details className="dashboard-settings-group" open>
          <summary><Sparkles size={18} aria-hidden="true" /><span><strong>Folio Assistant</strong><small>Intelligence, recommendations, automatic actions</small></span><ChevronDown size={17} aria-hidden="true" /></summary>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);setAssistantSettingsInitialScreen("overview");setAssistantSettingsOpen(true);}}><Sparkles size={18} aria-hidden="true" /><span className="dashboard-menu-label">Financial automation &amp; permissions</span><ChevronRight size={17} aria-hidden="true" /></button>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);setAssistantSettingsInitialScreen("history");setAssistantSettingsOpen(true);}}><Settings size={18} aria-hidden="true" /><span className="dashboard-menu-label">Activity &amp; action history</span><ChevronRight size={17} aria-hidden="true" /></button>
        </details>
        <details className="dashboard-settings-group">
          <summary><Bell size={18} aria-hidden="true" /><span><strong>Notifications &amp; rules</strong><small>Alerts, categorization, and refunds</small></span><ChevronDown size={17} aria-hidden="true" /></summary>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);setNotificationSettingsOpen(true);}}><Bell size={18} aria-hidden="true" /><span className="dashboard-menu-label">Notifications</span><ChevronRight size={17} aria-hidden="true" /></button>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);sendDashboardCommand({type:"folio-open-refund-settings",returnTo:"settings"});}}><Settings size={18} aria-hidden="true" /><span className="dashboard-menu-label">Transaction rules &amp; refund preference</span><ChevronRight size={17} aria-hidden="true" /></button>
        </details>
        <details className="dashboard-settings-group">
          <summary><Landmark size={18} aria-hidden="true" /><span><strong>Data &amp; connections</strong><small>Connected accounts and data refresh</small></span><ChevronDown size={17} aria-hidden="true" /></summary>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);sendDashboardCommand({type:"folio-open-page",page:"accounts"});}}><Link2 size={18} aria-hidden="true" /><span className="dashboard-menu-label">Connected accounts</span><ChevronRight size={17} aria-hidden="true" /></button>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);requestMenuRefresh();}}><RefreshCw size={18} aria-hidden="true" /><span className="dashboard-menu-label">Refresh data</span>{refreshStatusLabel&&<span className={`dashboard-menu-status dashboard-menu-refresh-status is-${menuRefreshState.state}`}>{refreshStatusLabel}</span>}<ChevronRight size={17} aria-hidden="true" /></button>
        </details>
        <details className="dashboard-settings-group">
          <summary><ShieldCheck size={18} aria-hidden="true" /><span><strong>Security &amp; advanced</strong><small>Sign-in, diagnostics, and controls</small></span><ChevronDown size={17} aria-hidden="true" /></summary>
          <button className="dashboard-menu-row" type="button" disabled={authBusy} onClick={() => {setSettingsLandingOpen(false);void registerPasskey();}}><Fingerprint size={18} aria-hidden="true" /><span className="dashboard-menu-label">Face ID/passkeys</span><span className={`dashboard-menu-status faceid-${passkeyStatus}`}>{passkeyStatusLabel}</span></button>
          <button className="dashboard-menu-row" type="button" onClick={() => {setSettingsLandingOpen(false);setLayoutCopied(false);setLayoutDiagnostics(collectLayoutDiagnostics());}}><ScanEye size={18} aria-hidden="true" /><span className="dashboard-menu-label">Advanced diagnostics</span><ChevronRight size={17} aria-hidden="true" /></button>
          <button className="dashboard-menu-row dashboard-menu-signout" type="button" onClick={async () => {setSettingsLandingOpen(false);signingOutRef.current=true;clearUserEventDetailCache(session.user.id);await clearDashboardTransactionReplica(session.user.id);await disconnectPushDevice(session.access_token).catch(()=>{});const result=await client?.auth.signOut();if(result?.error){signingOutRef.current=false;setAccountMessage('Could not sign out. Please try again.');}}}><LogOut size={18} aria-hidden="true" /><span className="dashboard-menu-label">Sign out</span><span className="dashboard-menu-trailing-spacer" aria-hidden="true" /></button>
        </details>
        <button className="dashboard-menu-row dashboard-settings-rental" type="button" onClick={() => {setSettingsLandingOpen(false);sendDashboardCommand({type:"folio-open-page",page:"rental"});}}><HousePlus size={18} aria-hidden="true" /><span className="dashboard-menu-label">Rental P&amp;L</span><ChevronRight size={17} aria-hidden="true" /></button>
      </section>
    </div>}
    <AskFolioPanel folio2={folio2NavigationEnabled} accessToken={session.access_token} userId={session.user.id} memories={preferences.askFolioMemories} initialMessageId={assistantMessageId} onAssistantMessageHandled={assistantMessageHandled} onOpenEvent={(eventId)=>{const url=new URL(location.href);url.searchParams.set('folio_event',eventId);history.replaceState({},'',url);setNotificationEventId(eventId);}} onOpenTransaction={(transactionId)=>sendDashboardCommand({type:'folio-open-transaction',transaction_id:transactionId})} onSaveMemory={saveAskFolioMemory} onAdoptCanonicalMemories={adoptCanonicalAskFolioMemories} onOpenGoal={(goalId,savingsActivityId)=>{sendDashboardCommand({type:'folio-open-goal',goal_id:goalId,savings_activity_id:savingsActivityId});}} />
    <FolioAlertsSheet key={`alerts:${session.user.id}`} open={folio2NavigationEnabled && alertsOpen} rows={folioAlertRowsOwner===session.user.id?folioAlertRows:[]} token={session.access_token} userId={session.user.id} onClose={()=>{setAlertsOpen(false);dashboardFrame.current?.contentWindow?.postMessage({type:"folio-close-alerts"},window.location.origin);}} onChanged={()=>dashboardFrame.current?.contentWindow?.postMessage({type:"folio-notifications-changed"},window.location.origin)} onOpenSource={(row)=>{if(row.transactionId||row.refundTransactionId)sendDashboardCommand({type:"folio-open-transaction",transaction_id:String(row.transactionId||row.refundTransactionId)});else if(row.goalId)sendDashboardCommand({type:"folio-open-goal",goal_id:row.goalId});else if(row.planId)dashboardFrame.current?.contentWindow?.postMessage({type:"folio-alert-open-plan",plan_id:row.planId},window.location.origin);else if(row.uncategorizedTransactionIds?.length)dashboardFrame.current?.contentWindow?.postMessage({type:"folio-open-uncategorized",transaction_ids:row.uncategorizedTransactionIds},window.location.origin);else if(row.page)sendDashboardCommand({type:"folio-open-page",page:row.page});}} />
    <FolioFilterSheet key={`filters:${session.user.id}`} open={folio2NavigationEnabled&&folioFilterOpen&&folioFilterOwner===session.user.id} request={folioFilterOwner===session.user.id?folioFilterRequest:null} onClose={()=>{setFolioFilterOpen(false);dashboardFrame.current?.contentWindow?.postMessage({type:"folio-transaction-filter-dismissed",user_id:session.user.id},window.location.origin);}} onApply={draft=>{dashboardFrame.current?.contentWindow?.postMessage({type:"folio-apply-transaction-filter-selection",user_id:session.user.id,request:draft},window.location.origin);setFolioFilterOpen(false);}} />
    {mobileShell.enabled && <nav ref={mobileTabs} className="dashboard-mobile-tabs" aria-label="Finance sections" hidden={mobileShell.modal || (alertsOpen && !folio2NavigationEnabled)} inert={Boolean(layoutDiagnostics)}>
      {folio2NavigationEnabled ? preferences.folio2TabOrder.flatMap((root)=>{const item=folio2Navigation.roots.find((entry)=>entry.root===root);return item?[item]:[]}).map(({ root, label }) => {
        const Icon = folio2Icons[root];
        const rememberedSegment = root === "activity" ? folio2SegmentMemory.activity : root === "accounts" ? folio2SegmentMemory.accounts : root === "plan" ? folio2SegmentMemory.plan : null;
        return <button key={root} type="button" aria-current={isFolio2TabSelected(folio2Route, mobileShell.page, root) ? "page" : undefined} onClick={() => openFolio2Route(routeForFolio2RootSelection(root, folio2Route, mobileShell.page, rememberedSegment))}>
          <Icon aria-hidden="true" /><span>{label}</span>
        </button>;
      }) : normalizeMobileTabOrder(preferences.mobileTabOrder).map((page) => {
        const { label, icon: Icon } = MOBILE_NAV.find((item) => item.page === page)!;
        return <button key={page} type="button" aria-current={mobileShell.page === page ? "page" : undefined} onClick={() => sendDashboardCommand({ type: "folio-open-page", page })}>
          <Icon aria-hidden="true" /><span>{label}</span>
        </button>;
      })}
    </nav>}
    {menuOpen && !folio2NavigationEnabled && <div className="dashboard-menu-layer" onMouseDown={() => setMenuOpen(false)}>
      <section ref={settingsMenu} id="folio-account-menu" className="dashboard-account-menu" role="menu" aria-labelledby="folio-menu-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleSettingsMenuKeyDown}>
        {settingsSection === "home" ? <>
          <div className="dashboard-menu-heading"><h2 id="folio-menu-title">Folio menu</h2></div>
          {folio2NavigationEnabled && <>
            <button ref={settingsFirstRow} className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);sendDashboardCommand({type:'folio-open-theme-settings'});}}><Palette size={18} aria-hidden="true"/><span className="dashboard-menu-label">Appearance</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={openTabOrderSettings}><ListOrdered size={18} aria-hidden="true"/><span className="dashboard-menu-label">Customize tab order</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);sendDashboardCommand({type:'folio-open-reorder-widgets'});}}><LayoutDashboard size={18} aria-hidden="true"/><span className="dashboard-menu-label">Reorder widgets</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);setAssistantSettingsInitialScreen('overview');setAssistantSettingsOpen(true);}}><Sparkles size={18} aria-hidden="true"/><span className="dashboard-menu-label">Financial automation &amp; permissions</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);setAssistantSettingsInitialScreen('history');setAssistantSettingsOpen(true);}}><Settings size={18} aria-hidden="true"/><span className="dashboard-menu-label">Activity/history</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);setNotificationSettingsOpen(true);}}><Bell size={18} aria-hidden="true"/><span className="dashboard-menu-label">Notifications</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);sendDashboardCommand({type:'folio-open-refund-settings',returnTo:'settings'});}}><Settings size={18} aria-hidden="true"/><span className="dashboard-menu-label">Transaction rules &amp; refund preference</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);sendDashboardCommand({type:'folio-open-page',page:'accounts'});}}><Link2 size={18} aria-hidden="true"/><span className="dashboard-menu-label">Connected accounts</span><ChevronRight size={17} aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={requestMenuRefresh} aria-busy={menuRefreshState.state==='refreshing'}><RefreshCw className={menuRefreshState.state==='refreshing'?'dashboard-menu-refresh-spin':undefined} size={18} aria-hidden="true"/><span className="dashboard-menu-label">Refresh data</span>{refreshStatusLabel&&<span className={`dashboard-menu-status dashboard-menu-refresh-status is-${menuRefreshState.state}`} aria-live="polite">{refreshStatusLabel}</span>}<span className="dashboard-menu-trailing-spacer" aria-hidden="true"/></button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>void registerPasskey()} disabled={authBusy}><Fingerprint size={18} aria-hidden="true"/><span className="dashboard-menu-label">Face ID/passkeys</span><span className={`dashboard-menu-status faceid-${passkeyStatus}`} aria-live="polite">{passkeyStatusLabel}</span></button>
            <div className="dashboard-menu-message">Account sign-in<br/><span>{session.user.email||'Signed in to Folio'}</span></div>
            {accountMessage&&<p className="dashboard-menu-message" role="status">{accountMessage}</p>}
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={()=>{setMenuOpen(false);setLayoutCopied(false);setLayoutDiagnostics(collectLayoutDiagnostics());}}><ScanEye size={18} aria-hidden="true"/><span className="dashboard-menu-label">Advanced diagnostics</span><ChevronRight size={17} aria-hidden="true"/></button>
          </>}
          {!folio2NavigationEnabled && <div className="dashboard-menu-home">
            {SETTINGS_CATEGORIES.map(({ section, label, icon: Icon }, index) => <button
              key={section}
              ref={index === 0 ? settingsFirstRow : undefined}
              className="dashboard-menu-row dashboard-menu-category"
              data-settings-category={section}
              type="button"
              role="menuitem"
              onClick={() => openSettingsSection(section)}
            >
              <Icon size={18} aria-hidden="true" /><span className="dashboard-menu-label">{label}</span><ChevronRight size={17} aria-hidden="true" />
            </button>)}
          </div>}
          <div className="dashboard-menu-divider" />
          <button className="dashboard-menu-row dashboard-menu-signout" type="button" role="menuitem" onClick={async () => {signingOutRef.current=true;clearUserEventDetailCache(session.user.id);await clearDashboardTransactionReplica(session.user.id);await disconnectPushDevice(session.access_token).catch(()=>{});const result=await client?.auth.signOut();if(result?.error){signingOutRef.current=false;setAccountMessage('Could not sign out. Please try again.');}}}>
            <LogOut size={18} aria-hidden="true" /><span className="dashboard-menu-label">Sign out</span><span className="dashboard-menu-trailing-spacer" aria-hidden="true" />
          </button>
        </> : <>
          <div className="dashboard-menu-subheading">
            <button ref={settingsBackButton} className="dashboard-menu-back" type="button" role="menuitem" onClick={returnToSettingsHome} aria-label="Back to Settings">
              <ChevronLeft size={17} aria-hidden="true" /><span>Settings</span>
            </button>
            <h2 id="folio-settings-title">{SETTINGS_SECTION_TITLES[settingsSection]}</h2>
          </div>
          {settingsSection === "personalize" && <>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => sendDashboardCommand({ type: "folio-open-theme-settings" })}>
              <Palette size={18} aria-hidden="true" /><span className="dashboard-menu-label">Appearance</span><ChevronRight size={17} aria-hidden="true" />
            </button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={openTabOrderSettings}>
              <ListOrdered size={18} aria-hidden="true" /><span className="dashboard-menu-label">Customize tab order</span><ChevronRight size={17} aria-hidden="true" />
            </button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => sendDashboardCommand({ type: "folio-open-reorder-widgets" })}>
              <LayoutDashboard size={18} aria-hidden="true" /><span className="dashboard-menu-label">Reorder widgets</span><ChevronRight size={17} aria-hidden="true" />
            </button>
          </>}
          {settingsSection === "folio" && <>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => {setMenuOpen(false);setAssistantSettingsInitialScreen('overview');setAssistantSettingsOpen(true);}}>
              <Sparkles size={18} aria-hidden="true" /><span className="dashboard-menu-label">Financial automation &amp; permissions</span><ChevronRight size={17} aria-hidden="true" />
            </button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => {setMenuOpen(false);setNotificationSettingsOpen(true);}}>
              <Bell size={18} aria-hidden="true" /><span className="dashboard-menu-label">Notifications</span><ChevronRight size={17} aria-hidden="true" />
            </button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => sendDashboardCommand({ type: "folio-open-rules" })}>
              <Settings size={18} aria-hidden="true" /><span className="dashboard-menu-label">Transaction rules</span><ChevronRight size={17} aria-hidden="true" />
            </button>
          </>}
          {settingsSection === "data" && <>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => sendDashboardCommand({ type: "folio-open-page", page: "accounts" })}>
              <Link2 size={18} aria-hidden="true" /><span className="dashboard-menu-label">Connected accounts</span><ChevronRight size={17} aria-hidden="true" />
            </button>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={requestMenuRefresh} aria-busy={menuRefreshState.state === "refreshing"}>
              <RefreshCw className={menuRefreshState.state === "refreshing" ? "dashboard-menu-refresh-spin" : undefined} size={18} aria-hidden="true" />
              <span className="dashboard-menu-label">Refresh data</span>
              {refreshStatusLabel && <span className={`dashboard-menu-status dashboard-menu-refresh-status is-${menuRefreshState.state}`} aria-live="polite">{refreshStatusLabel}</span>}
              <span className="dashboard-menu-trailing-spacer" aria-hidden="true" />
            </button>
          </>}
          {settingsSection === "security" && <>
            <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => void registerPasskey()} disabled={authBusy} aria-label={`Face ID: ${passkeyStatusLabel}. Set up Face ID`}>
              <Fingerprint size={18} aria-hidden="true" /><span className="dashboard-menu-label">Face ID</span>
              <span className={`dashboard-menu-status faceid-${passkeyStatus}`} aria-live="polite">{passkeyStatusLabel}</span><span className="dashboard-menu-trailing-spacer" aria-hidden="true" />
            </button>
            {folio2NavigationEnabled&&<><p className="dashboard-menu-message">Account sign-in<br/><span>{session.user.email||'Signed in to Folio'}</span></p><button className="dashboard-menu-row dashboard-menu-signout" type="button" role="menuitem" onClick={()=>void signOutFromSettings()}><LogOut size={18} aria-hidden="true"/><span className="dashboard-menu-label">Sign out</span><span className="dashboard-menu-trailing-spacer" aria-hidden="true"/></button></>}
            {accountMessage && <p className="dashboard-menu-message" role="status">{accountMessage}</p>}
          </>}
          {settingsSection === "advanced" && <button className="dashboard-menu-row" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setLayoutCopied(false); setLayoutDiagnostics(collectLayoutDiagnostics()); }}>
            <ScanEye size={18} aria-hidden="true" /><span className="dashboard-menu-label">Layout diagnostics</span><ChevronRight size={17} aria-hidden="true" />
          </button>}
        </>}
      </section>
    </div>}
    {agentAction && <FolioAgentActionSheet token={session.access_token} request={agentAction} onClose={()=>setAgentAction(null)} onDone={notifyAgentChanged}/>}
    {assistantSettingsOpen && <FolioAssistantSettings token={session.access_token} initialScreen={assistantSettingsInitialScreen} folio2={folio2NavigationEnabled} onClose={()=>setAssistantSettingsOpen(false)} onChanged={()=>notifyAgentChanged(true)} onReview={(target)=>{setAssistantSettingsOpen(false);if(target.event_id)setAgentAction(target);else if(target.section==='refund-settings')sendDashboardCommand({type:folio2NavigationEnabled?'folio-open-refund-settings':'folio-open-rules',returnTo:'assistant'});else if(typeof target.transaction_id==='string')sendDashboardCommand({type:'folio-open-transaction',transaction_id:target.transaction_id});else if(typeof target.page==='string')sendDashboardCommand({type:'folio-open-page',page:target.page});}}/>}
    {notificationSettingsOpen && <FolioNotificationSettings key={session.user.id} token={session.access_token} userId={session.user.id} onClose={()=>setNotificationSettingsOpen(false)} onChanged={()=>{dashboardFrame.current?.contentWindow?.postMessage({type:'folio-notifications-changed'},location.origin);}} onOpenTransaction={(transactionId)=>{setNotificationSettingsOpen(false);sendDashboardCommand({type:'folio-open-transaction',transaction_id:transactionId});}}/>}
    {notificationEventId && <FolioEventDetail key={notificationEventId} token={session.access_token} userId={session.user.id} eventId={notificationEventId} onClose={closeNotificationEvent} onReview={(target)=>{closeNotificationEvent();if(target.goal_id)sendDashboardCommand({type:'folio-open-goal',goal_id:target.goal_id,savings_activity_id:target.savings_activity_id});else if(target.page==='autonomy'){setAssistantSettingsInitialScreen('overview');setAssistantSettingsOpen(true);}else sendDashboardCommand({type:'folio-open-page',page:target.page});}} onAction={(request)=>{closeNotificationEvent();setAgentAction(request);}}/>}
    {tabOrderOpen && <div className="dashboard-tab-order-layer" onMouseDown={() => !tabOrderSaving && closeTabOrderSettings()}>
      <section className="dashboard-tab-order-dialog" role="dialog" aria-modal="true" aria-labelledby="tab-order-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dashboard-tab-order-head"><div><span className="dashboard-menu-eyebrow">Settings</span><h2 id="tab-order-title">Bottom tab order</h2></div><button type="button" onClick={closeTabOrderSettings} disabled={tabOrderSaving} aria-label="Close tab order settings"><X size={20} /></button></div>
        <p>Choose the order that works best for you. Every tab stays available.</p>
        <ol className="dashboard-tab-order-list">
          {tabOrderDraft.map((page, index) => {
            const item = MOBILE_NAV.find((candidate) => candidate.page === page)!;
            const Icon = item.icon;
            const label=tabOrderFolio2?(page==='spending'?'Activity':page==='planning'?'Plan':item.label):item.label;
            return <li key={page}><span className="dashboard-tab-order-label"><Icon size={18} aria-hidden="true" />{label}</span><span className="dashboard-tab-order-actions"><button type="button" onClick={() => moveMobileTab(page, -1)} disabled={index === 0 || tabOrderSaving} aria-label={`Move ${label} earlier`}><ChevronUp size={19} /></button><button type="button" onClick={() => moveMobileTab(page, 1)} disabled={index === tabOrderDraft.length - 1 || tabOrderSaving} aria-label={`Move ${label} later`}><ChevronDown size={19} /></button></span></li>;
          })}
        </ol>
        {tabOrderError && <p className="dashboard-tab-order-error" role="alert">{tabOrderError}</p>}
        <div className="dashboard-tab-order-footer"><button type="button" onClick={() => setTabOrderDraft(tabOrderFolio2?["home","spending","transactions","accounts","planning"]:DEFAULT_MOBILE_TAB_ORDER)} disabled={tabOrderSaving}>Reset</button><button className="dashboard-tab-order-save" type="button" onClick={() => void saveMobileTabOrder()} disabled={tabOrderSaving}>{tabOrderSaving ? "Saving…" : "Save order"}</button></div>
      </section>
    </div>}
    {layoutDiagnostics && <section className="dashboard-layout-diagnostics" role="dialog" aria-modal="true" aria-labelledby="layout-diagnostics-title">
      <div>
        <div className="dashboard-layout-diagnostics-head"><h2 id="layout-diagnostics-title">Layout diagnostics</h2><button type="button" onClick={() => setLayoutDiagnostics(null)} aria-label="Close layout diagnostics"><X size={20} /></button></div>
        <p>Share this only if you want help measuring the screen layout. It contains device viewport geometry, not financial data.</p>
        <pre>{layoutDiagnostics}</pre>
        <div className="dashboard-layout-diagnostics-actions"><button type="button" onClick={() => { setLayoutCopied(false); setLayoutDiagnostics(collectLayoutDiagnostics()); }}>Refresh</button><button type="button" onClick={() => void copyLayoutDiagnostics()}>{layoutCopied ? "Copied" : "Copy"}</button></div>
      </div>
    </section>}
  </main>;
}
