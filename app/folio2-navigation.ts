export type Folio2Root = "home" | "activity" | "transactions" | "accounts" | "plan";
export type Folio2Segment = "spending" | "cashflow" | "recurring" | "accounts" | "investments" | "budget" | "forecast" | "goals";
export type Folio2Route = { root: Folio2Root; segment: Folio2Segment | null };

export const FOLIO2_ROOT_TABS: Array<{ root: Folio2Root; label: string }> = [
  { root: "home", label: "Home" },
  { root: "activity", label: "Activity" },
  { root: "transactions", label: "Transactions" },
  { root: "accounts", label: "Accounts" },
  { root: "plan", label: "Plan" },
];

export const FOLIO2_SEGMENTS: Record<"activity" | "accounts" | "plan", Array<{ segment: Folio2Segment; label: string }>> = {
  activity: [
    { segment: "spending", label: "Spending" },
    { segment: "cashflow", label: "Cash Flow" },
    { segment: "recurring", label: "Recurring" },
  ],
  accounts: [
    { segment: "accounts", label: "Accounts" },
    { segment: "investments", label: "Investments" },
  ],
  plan: [
    { segment: "budget", label: "Budget" },
    { segment: "forecast", label: "Forecast" },
    { segment: "goals", label: "Goals" },
  ],
};

export const FOLIO2_DEFAULT_ROUTE: Folio2Route = { root: "home", segment: null };

export function isFolio2NavigationOptedIn(search: string): boolean {
  return new URLSearchParams(search).get("folio2") !== "0";
}

// Auth cleanup retains only explicit, noncredential application navigation.
// The default interface is Folio 2.0; an explicit folio2=0 remains a rollback route.
export function folioAuthNavigationPath(pathname: string, search: string, callback?: "sign-in" | "recovery"): string {
  const current = new URLSearchParams(search), next = new URLSearchParams();
  next.set("folio2", isFolio2NavigationOptedIn(search) ? "1" : "0");
  const event = current.get("folio_event");
  if (event && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event)) next.set("folio_event", event);
  const upgrade = current.get("folio_upgrade");
  if (!callback && upgrade && /^[a-zA-Z0-9._-]{1,80}$/.test(upgrade)) next.set("folio_upgrade", upgrade);
  if (callback) next.set("folio_auth", "1");
  if (callback === "recovery") next.set("recovery", "1");
  return pathname + (next.size ? `?${next.toString()}` : "");
}

export function routeForFolio2Root(root: Folio2Root): Folio2Route {
  if (root === "activity") return { root, segment: "spending" };
  if (root === "accounts") return { root, segment: "accounts" };
  if (root === "plan") return { root, segment: "budget" };
  return { root, segment: null };
}

export function routeForFolio2RootSelection(
  root: Folio2Root,
  current: Folio2Route,
  currentPage: string,
  rememberedSegment?: Folio2Segment | null,
): Folio2Route {
  if (current.root === root && (currentPage === "rental" || current.segment !== null)) return current;
  if (root === "activity" && rememberedSegment && FOLIO2_SEGMENTS.activity.some((item) => item.segment === rememberedSegment)) return { root, segment: rememberedSegment };
  if (root === "accounts" && rememberedSegment && FOLIO2_SEGMENTS.accounts.some((item) => item.segment === rememberedSegment)) return { root, segment: rememberedSegment };
  if (root === "plan" && rememberedSegment && FOLIO2_SEGMENTS.plan.some((item) => item.segment === rememberedSegment)) return { root, segment: rememberedSegment };
  return routeForFolio2Root(root);
}

export function routeForFolio2Segment(segment: Folio2Segment): Folio2Route {
  return { root: segment === "spending" || segment === "cashflow" || segment === "recurring" ? "activity" : segment === "accounts" || segment === "investments" ? "accounts" : "plan", segment };
}

export function isFolio2ActivitySegment(segment: Folio2Segment): segment is "spending" | "cashflow" | "recurring" {
  return segment === "spending" || segment === "cashflow" || segment === "recurring";
}

export function isFolio2PlanSegment(segment: Folio2Segment): segment is "budget" | "forecast" | "goals" {
  return segment === "budget" || segment === "forecast" || segment === "goals";
}

export function isFolio2AccountSegment(segment: Folio2Segment): segment is "accounts" | "investments" {
  return segment === "accounts" || segment === "investments";
}

// Transitional interiors deliberately map only to existing Folio pages.
export function existingPageForFolio2Route(route: Folio2Route): string {
  if (route.root === "home") return "home";
  if (route.root === "transactions") return "transactions";
  if (route.root === "accounts") return route.segment === "investments" ? "investments" : "accounts";
  if (route.root === "activity") {
    if (route.segment === "cashflow") return "folio2-cashflow";
    if (route.segment === "recurring") return "recurring";
    return "folio2-spending";
  }
  if (route.segment === "forecast" || route.segment === "goals") return "planning";
  return "budget";
}

export function existingScrollTargetForFolio2Route(route: Folio2Route): string | null {
  if (route.root === "activity" && route.segment === "spending") return '[data-panel="folio2-spending"] [data-widget="running-spend"]';
  if (route.root === "activity" && route.segment === "cashflow") return '[data-panel="folio2-cashflow"] .folio2-cashflow-chart-slot';
  if (route.root === "plan" && route.segment === "budget") return '[data-panel="budget"] .folio2-budget-view';
  if (route.root === "plan" && route.segment === "forecast") return '[data-panel="planning"] .folio-plan-forecast-head';
  if (route.root === "plan" && route.segment === "goals") return '[data-panel="planning"] .folio-goal-summary';
  return null;
}

export function routeForExistingPage(
  page: string,
  current: Folio2Route,
  memory: { activity: Folio2Segment; plan: Folio2Segment } = { activity: "spending", plan: "budget" },
  folio2Screen?: string,
): Folio2Route {
  // Rental P&L is opened from the global menu. Keep the caller selected so the
  // five-tab shell remains available without falsely selecting a root tab.
  if (page === "rental") return current;
  if (page === "home") return { root: "home", segment: null };
  if (page === "folio2-spending") return { root: "activity", segment: "spending" };
  if (page === "folio2-cashflow") return { root: "activity", segment: "cashflow" };
  if (page === "dashboard") {
    const alreadyDashboard = current.root === "home" || (current.root === "activity" && current.segment === "spending");
    return alreadyDashboard ? current : { root: "activity", segment: memory.activity };
  }
  if (page === "transactions") return { root: "transactions", segment: null };
  if (page === "accounts") return { root: "accounts", segment: folio2Screen === "investments" ? "investments" : "accounts" };
  if (page === "investments") return { root: "accounts", segment: "investments" };
  if (page === "spending") return { root: "activity", segment: "cashflow" };
  if (page === "recurring") return { root: "activity", segment: "recurring" };
  if (page === "budget") return { root: "plan", segment: "budget" };
  if (page === "planning") {
    if (folio2Screen === "forecast" || folio2Screen === "goals") return { root: "plan", segment: folio2Screen };
    return existingPageForFolio2Route(current) === page ? current : { root: "plan", segment: memory.plan };
  }
  return current;
}

export function isFolio2TabSelected(route: Folio2Route, currentPage: string, root: Folio2Root): boolean {
  return currentPage !== "rental" && route.root === root;
}

export function folio2NavigationSpec(route: Folio2Route) {
  return {
    roots: FOLIO2_ROOT_TABS.map((tab) => ({ ...tab, selected: route.root === tab.root })),
    segments: route.root === "activity" || route.root === "accounts" || route.root === "plan"
      ? FOLIO2_SEGMENTS[route.root].map((item) => ({ ...item, selected: route.segment === item.segment }))
      : [],
  };
}

export function folioDashboardPath(optedIn: boolean, retry: number): string {
  const query = new URLSearchParams();
  query.set("folio2", optedIn ? "1" : "0");
  if (retry) query.set("folio_retry", String(retry));
  return "/dashboard" + (query.size ? `?${query.toString()}` : "");
}
