"use client";

/**
 * Unified Top Shell
 *
 * Single fixed component that owns the entire top chrome:
 *   1. Capacitor safe-area inset (notch / Dynamic Island)
 *   2. Header row  –  actor title · actions
 *   3. Optional route-owned contextual tab row
 *
 * One continuous frosted-glass backdrop + mask-image fade covers the
 * signed-in shell so page content scrolls seamlessly underneath.
 *
 * All sizing uses CSS custom properties from globals.css
 * (--top-inset, --top-bar-h, --top-tabs-total, --top-glass-h, etc.)
 * so the layout works identically on web and native with zero
 * Capacitor.isNativePlatform() checks — env(safe-area-inset-top)
 * evaluates correctly in both environments.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  FileCheck2,
  FolderSearch,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Loader2,
  LogOut,
  Mail,
  MoreHorizontal,
  Shield,
  Trash2,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  APP_SHELL_FRAME_CLASSNAME,
  APP_SHELL_FRAME_STYLE,
} from "@/components/app-ui/app-page-shell";
import { Icon } from "@/lib/morphy-ux/ui";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { useVault } from "@/lib/vault/vault-context";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import {
  DELETE_ACCOUNT_DIALOG_DESCRIPTION,
  DELETE_ACCOUNT_DIALOG_TITLE,
  executeVerifiedAccountDeletion,
  resolveDeleteAccountAuth,
} from "@/lib/flows/delete-account";
import { VaultService } from "@/lib/services/vault-service";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import {
  KAI_MARKET_PATH,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";

import { getAgentSection } from "@/lib/navigation/agent-sections";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { TopShellRouteModel } from "@/components/app-ui/top-shell-metrics";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import { AmbientChromeMask } from "@/components/app-ui/ambient-chrome-mask";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import type { Persona } from "@/lib/services/ria-service";
import {
  resolveTopShellBreadcrumb,
  type TopShellBreadcrumbConfig,
  type TopShellBreadcrumbItem,
} from "@/lib/navigation/top-shell-breadcrumbs";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  ShellActionSurface,
  SHELL_ICON_BUTTON_CLASSNAME,
  SHELL_PILL_TRIGGER_CLASSNAME,
} from "@/components/app-ui/shell-action-surface";
import { trackEvent } from "@/lib/observability/client";
import {
  resolveGrowthEntrySurface,
  trackGrowthFunnelStepCompleted,
} from "@/lib/observability/growth";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import {
  resolveInitialTopChromeProgress,
  resolveTopChromeScrollProgress,
} from "@/lib/navigation/top-chrome-scroll-progress";

/* ── Re-exports (backward compat) ─────────────────────────────────── */
export {
  resolveTopShellHeight,
  resolveTopShellMetrics,
  shouldHideTopShell,
  shouldShowKaiTabsInTopShell,
  type TopShellMetrics,
} from "@/components/app-ui/top-shell-metrics";

/* ── Constants ─────────────────────────────────────────────────────── */
export const TOP_SHELL_ICON_BUTTON_CLASSNAME = SHELL_ICON_BUTTON_CLASSNAME;
const TOP_SHELL_TITLE_PILL_CLASSNAME = SHELL_PILL_TRIGGER_CLASSNAME;

/* ── Stubs (kept for import stability) ─────────────────────────────── */
export function TopBarBackground() {
  return null;
}
export function StatusBarBlur() {
  return null;
}
export function TopAppBarSpacer() {
  return null;
}

/* ── Helpers ───────────────────────────────────────────────────────── */
function getTopBarTitle(
  pathname: string,
  primaryHeaderOutOfView: boolean = false,
): {
  label: string;
  icon?: LucideIcon;
  interactive: boolean;
} | null {
  if (
    pathname === ROUTES.ONE_SETUP ||
    pathname.startsWith(`${ROUTES.ONE_SETUP}/`)
  ) {
    return null;
  }

  if (
    pathname === ROUTES.RIA_ONBOARDING ||
    pathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`)
  ) {
    return null;
  }

  const isRiaShellRoute =
    pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`);
  if (isRiaShellRoute) {
    return null;
  }

  if (primaryHeaderOutOfView) {
    const scrolledRouteTitle = getScrolledRouteTitle(pathname);
    if (scrolledRouteTitle) {
      return scrolledRouteTitle;
    }
  }

  if (primaryHeaderOutOfView) {
    if (
      pathname === KAI_MARKET_PATH ||
      pathname === ROUTES.LEGACY_KAI_HOME ||
      pathname === ROUTES.MARKETPLACE
    ) {
      return null;
    }
  }

  const isPersonaShellRoute =
    pathname === KAI_MARKET_PATH ||
    pathname.startsWith(`${KAI_MARKET_PATH}/`) ||
    pathname.startsWith(ROUTES.LEGACY_KAI_HOME) ||
    pathname.startsWith(ROUTES.MARKETPLACE) ||
    pathname.startsWith(ROUTES.CONSENTS) ||
    pathname.startsWith(ROUTES.LEGACY_CONSENTS);

  if (isPersonaShellRoute) {
    return null;
  }
  return null;
}

function isProfileTopBarRoute(pathname: string): boolean {
  const normalized = normalizeTopBarPathname(pathname);
  return (
    normalized === ROUTES.PROFILE || normalized.startsWith(`${ROUTES.PROFILE}/`)
  );
}

function isPersonaSwitchTopBarRoute(pathname: string): boolean {
  const normalized = normalizeTopBarPathname(pathname);
  return (
    normalized === KAI_MARKET_PATH ||
    normalized.startsWith(`${KAI_MARKET_PATH}/`)
  );
}

function normalizeTopBarPathname(pathname: string): string {
  const base = pathname.split(/[?#]/, 1)[0]?.trim() || "/";
  if (base === "/") return base;
  const withSlash = base.startsWith("/") ? base : `/${base}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function roleSwitcherLabel(activePersona: Persona): string {
  return activePersona === "ria" ? "RIA" : "Investor";
}

function roleSwitcherIcon(activePersona: Persona): LucideIcon {
  return activePersona === "ria" ? BriefcaseBusiness : UserRound;
}

function resolveCommonRouteBreadcrumb(
  pathname: string,
  lastAgentSectionId: string | null,
): TopShellBreadcrumbConfig | null {
  const section = getAgentSection(lastAgentSectionId);
  const backHref = section?.href ?? ROUTES.ONE_HOME;
  const parentLabel = section?.label ?? "Agents";

  if (pathname === ROUTES.PROFILE) {
    return {
      backHref,
      width: "profile",
      align: "center",
      items: [{ label: parentLabel, href: backHref }, { label: "Profile" }],
    };
  }

  if (pathname === ROUTES.MARKETPLACE) {
    return {
      backHref,
      width: "profile",
      align: "center",
      items: [{ label: parentLabel, href: backHref }, { label: "Connect" }],
    };
  }

  return null;
}

function getScrolledRouteTitle(pathname: string): {
  label: string;
  icon?: LucideIcon;
  interactive: boolean;
} | null {
  if (pathname === ROUTES.DEVELOPERS) {
    return { label: "Developers", icon: Code2, interactive: false as const };
  }
  if (pathname === ROUTES.HOME || pathname === ROUTES.ONE_HOME) {
    return {
      label: "Agents",
      icon: LayoutDashboard,
      interactive: false as const,
    };
  }
  if (isProfileTopBarRoute(pathname)) {
    return {
      label: "Profile",
      icon: UserRound,
      interactive: true as const,
    };
  }
  if (pathname === ROUTES.GMAIL) {
    return { label: "Gmail receipts", icon: Mail, interactive: false as const };
  }
  if (pathname === ROUTES.PKM) {
    return {
      label: "Memory",
      icon: FolderSearch,
      interactive: false as const,
    };
  }
  if (pathname === ROUTES.CONNECTED_SYSTEMS) {
    return {
      label: "Connected Systems",
      icon: Database,
      interactive: false as const,
    };
  }
  if (pathname === ROUTES.CONSENTS || pathname === ROUTES.LEGACY_CONSENTS) {
    return {
      label: "Access & sharing",
      icon: Shield,
      interactive: false as const,
    };
  }
  if (pathname === ROUTES.ONE_KYC) {
    return { label: "KYC", icon: FileCheck2, interactive: false as const };
  }
  if (pathname === ROUTES.KAI_ANALYSIS) {
    return {
      label: "Analysis",
      icon: ChartNoAxesCombined,
      interactive: false as const,
    };
  }
  return null;
}

function routeForPersona(params: {
  persona: Persona;
  lastKaiPath: string;
  lastRiaPath: string;
  riaEntryRoute: string;
}) {
  if (params.persona !== "ria") {
    return params.lastKaiPath || ROUTES.KAI_HOME;
  }
  // Defensive: never re-enter the onboarding wizard from a stale lastRiaPath —
  // let riaEntryRoute (switch → RIA_HOME, else onboarding) decide. Pairs with the
  // navbar guard that stops recording /ria/onboarding as lastRiaPath.
  const lastRiaPath =
    params.lastRiaPath === ROUTES.RIA_ONBOARDING ||
    params.lastRiaPath.startsWith(`${ROUTES.RIA_ONBOARDING}/`)
      ? ""
      : params.lastRiaPath;
  return lastRiaPath || params.riaEntryRoute;
}

function readTopShellReservedHeight(): number {
  if (typeof window === "undefined") return 0;
  // Route shell variables intentionally contain `calc(...)` expressions. A
  // custom property preserves that expression verbatim, so `parseFloat` would
  // return NaN on device and make the compact-tab threshold fall through to
  // zero. Measure the resolved fixed shell instead: it includes the actual
  // iOS safe area and the active tab row.
  const shell = document.querySelector<HTMLElement>(
    '[data-testid="app-top-shell-layout"]',
  );
  const measuredHeight = shell?.getBoundingClientRect().height ?? 0;
  return Number.isFinite(measuredHeight) && measuredHeight > 0
    ? measuredHeight
    : 0;
}

function isPrimaryHeaderOutOfView(header: HTMLElement | null): boolean {
  if (!header) return false;
  return header.getBoundingClientRect().bottom <= readTopShellReservedHeight();
}

/* ── TopShellBreadcrumbTrail ───────────────────────────────────────── */
/**
 * Renders the resolved breadcrumb items as a compact, tappable trail beside the
 * back arrow once the user is inside an inner/subagent route (e.g.
 * `Kai › Analysis › AAPL run`). Ancestor crumbs navigate back to their level;
 * the last crumb is the current, non-interactive location. The back arrow still
 * owns single-step back; this trail is the multi-level "go back and forth"
 * affordance. Uses currentColor so it tracks the ambient top-surface tone.
 */
function TopShellBreadcrumbTrail({ items }: { items: TopShellBreadcrumbItem[] }) {
  if (!items.length) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="top-app-bar-breadcrumb-trail"
      className="top-shell-ambient-ink pointer-events-auto flex min-w-0 items-center gap-1 text-[15px] font-medium text-current"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span
            key={`${item.label}-${index}`}
            className="flex min-w-0 items-center gap-1"
          >
            {index > 0 ? (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 opacity-40"
                aria-hidden
              />
            ) : null}
            {item.href && !isLast ? (
              <button
                type="button"
                className="max-w-[9rem] shrink-0 truncate opacity-65 transition-opacity hover:opacity-100"
                onClick={() =>
                  requestInternalAppNavigation({
                    href: item.href!,
                    scroll: false,
                    source: "tap",
                    transitionMode: "full",
                  })
                }
              >
                {item.label}
              </button>
            ) : (
              <span
                className={cn(
                  "min-w-0 truncate",
                  isLast ? "font-semibold" : "opacity-65",
                )}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* ── AppTopShell ───────────────────────────────────────────────────── */
export interface AppTopShellProps {
  className?: string;
  model: TopShellRouteModel;
}

export function AppTopShell({ className, model }: AppTopShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, user } = useAuth();
  const effectiveAvatarUrl = useEffectiveAvatarUrl();
  const { isVaultUnlocked } = useVault();
  const { activePersona, riaCapability, riaEntryRoute, switchPersona } =
    usePersonaState();
  const pathname = usePathname();
  const normalizedPathname = useMemo(
    () =>
      model.mode === "hidden"
        ? normalizeTopBarPathname(pathname)
        : model.navigation.pathname,
    [model, pathname],
  );
  const lastAgentSectionId = useKaiSession((s) => s.lastAgentSectionId);
  const lastKaiPath = useKaiSession((s) => s.lastKaiPath);
  const lastRiaPath = useKaiSession((s) => s.lastRiaPath);
  const topShellBreadcrumb = useMemo(() => {
    // Once onboarding is dismissed, back-navigation from any product/agent
    // surface must never retrace into the setup funnel. Re-read on every
    // navigation (pathname change) so a freshly-resolved user is honored.
    const setupDismissed = Boolean(
      user?.uid &&
        (OneSetupCompletionHintService.isResolved(user.uid) ||
          PreVaultUserStateService.getCachedBootstrapState(user.uid)
            ?.setupCompleted === true),
    );
    return (
      resolveTopShellBreadcrumb(normalizedPathname, searchParams, {
        setupDismissed,
      }) ?? resolveCommonRouteBreadcrumb(normalizedPathname, lastAgentSectionId)
    );
  }, [lastAgentSectionId, normalizedPathname, searchParams, user?.uid]);
  const chromeState = useMemo(
    () => getKaiChromeState(normalizedPathname),
    [normalizedPathname],
  );
  const showOnboardingActions = chromeState.useOnboardingChrome;
  const hideChrome = model.mode === "hidden";
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [vaultUnlockOpen, setVaultUnlockOpen] = useState(false);

  const [primaryHeaderOutOfView, setPrimaryHeaderOutOfView] = useState(false);
  const [topChromeFullyCollapsed, setTopChromeFullyCollapsed] =
    useState(false);
  // A route-owned tab row stays as the compact navigation anchor once the
  // shared top row has fully collapsed. The page heading still independently
  // owns title handoff, but it must not prevent an upward gesture from
  // restoring back, activity, and profile actions while mid-page.
  const tabsOnlyChrome =
    model.mode === "bar-with-tabs" && topChromeFullyCollapsed;

  useEffect(() => {
    if (typeof window === "undefined") return;

    let scrollRoot = document.querySelector<HTMLElement>(
      '[data-app-scroll-root="true"]',
    );
    let header = document.querySelector<HTMLElement>(
      '[data-slot="page-header"][data-page-primary="true"]',
    );
    let attachedScrollRoot: HTMLElement | null = null;
    let pageObserver: MutationObserver | null = null;
    let refreshFrame: number | null = null;
    let retryTimer = 0;
    let lastScrollY: number | null = null;
    let topChromeProgress = 0;

    const updateHeaderVisibility = () => {
      const scrollY = scrollRoot?.scrollTop ?? window.scrollY ?? 0;
      topChromeProgress =
        lastScrollY === null
          ? resolveInitialTopChromeProgress(scrollY)
          : resolveTopChromeScrollProgress({
              progress: topChromeProgress,
              previousY: lastScrollY,
              nextY: scrollY,
            });
      lastScrollY = scrollY;
      const rowHeight =
        document
          .querySelector<HTMLElement>('[data-testid="top-app-bar-row"]')
          ?.getBoundingClientRect().height ?? 0;
      const root = document.documentElement;
      root.style.setProperty(
        "--top-chrome-progress",
        String(topChromeProgress),
      );
      root.style.setProperty(
        "--top-chrome-collapse-px",
        `${Math.max(0, rowHeight * topChromeProgress)}px`,
      );
      const fullyCollapsed = topChromeProgress >= 0.999;
      setTopChromeFullyCollapsed((current) =>
        current === fullyCollapsed ? current : fullyCollapsed,
      );
      const outOfView = isPrimaryHeaderOutOfView(header);
      setPrimaryHeaderOutOfView((current) =>
        current === outOfView ? current : outOfView,
      );
    };

    const detachListeners = () => {
      attachedScrollRoot?.removeEventListener("scroll", updateHeaderVisibility);
      window.removeEventListener("scroll", updateHeaderVisibility);
      window.removeEventListener("resize", updateHeaderVisibility);
      attachedScrollRoot = null;
    };

    const refreshHeader = () => {
      header = document.querySelector<HTMLElement>(
        '[data-slot="page-header"][data-page-primary="true"]',
      );
      updateHeaderVisibility();
    };

    const scheduleHeaderRefresh = () => {
      if (refreshFrame !== null) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        refreshHeader();
      });
    };

    const attach = () => {
      detachListeners();

      scrollRoot = document.querySelector<HTMLElement>(
        '[data-app-scroll-root="true"]',
      );
      lastScrollY = null;
      refreshHeader();
      attachedScrollRoot = scrollRoot;
      attachedScrollRoot?.addEventListener("scroll", updateHeaderVisibility, {
        passive: true,
      });
      window.addEventListener("scroll", updateHeaderVisibility, {
        passive: true,
      });
      window.addEventListener("resize", updateHeaderVisibility);

      if (!header && !retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          attach();
        }, 150);
      }

      pageObserver?.disconnect();
      pageObserver = new MutationObserver(scheduleHeaderRefresh);
      pageObserver.observe(scrollRoot ?? document.body, {
        childList: true,
        subtree: true,
      });
    };

    attach();

    return () => {
      detachListeners();
      pageObserver?.disconnect();
      if (refreshFrame !== null) {
        window.cancelAnimationFrame(refreshFrame);
      }
      window.clearTimeout(retryTimer);
      document.documentElement.style.setProperty("--top-chrome-progress", "0");
      document.documentElement.style.setProperty(
        "--top-chrome-collapse-px",
        "0px",
      );
    };
  }, [model.mode, pathname]);

  useEffect(() => {
    let cancelled = false;

    async function loadVaultAvailability() {
      if (!isAuthenticated || !user?.uid) {
        setHasVault(null);
        return;
      }

      if (isVaultUnlocked) {
        setHasVault(true);
        return;
      }

      // The top app bar mounts on nearly every page, so read the shared
      // vault-presence cache synchronously first to avoid a per-route refetch
      // while locked. Only hit the network on a cold cache.
      const cachedPresence = VaultService.peekVaultPresence(user.uid);
      if (cachedPresence !== null) {
        setHasVault(cachedPresence);
        return;
      }

      try {
        const exists = await VaultService.checkVault(user.uid);
        if (!cancelled) {
          setHasVault(exists);
        }
      } catch (error) {
        console.warn(
          "[TopAppBar] Failed to resolve vault availability:",
          error,
        );
        if (!cancelled) {
          setHasVault(null);
        }
      }
    }

    void loadVaultAvailability();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isVaultUnlocked, user?.uid]);

  const centerTitle = useMemo(
    () => getTopBarTitle(normalizedPathname, primaryHeaderOutOfView),
    [normalizedPathname, primaryHeaderOutOfView],
  );
  const breadcrumbTrailItems = useMemo(() => {
    const raw = topShellBreadcrumb?.items ?? [];
    // Inner/"subagent" routes read as "Kai > Analysis", not
    // "One > Kai > Analysis": drop the app-root crumb from the visible trail.
    return raw.length > 0 && raw[0]?.label === "One" ? raw.slice(1) : raw;
  }, [topShellBreadcrumb]);
  const hasBreadcrumbTrail = !centerTitle && breadcrumbTrailItems.length > 0;
  const canShowPersonaSwitcher = useMemo(
    () => isPersonaSwitchTopBarRoute(normalizedPathname),
    [normalizedPathname],
  );
  const showVaultUnlockAction =
    isAuthenticated && hasVault === true && !isVaultUnlocked;
  const showOneHomeBrand =
    model.mode !== "hidden" && model.brand === "one" && !showOnboardingActions;
  const handleTopShellBack = useCallback(() => {
    navigateTopShellBack({
      router,
      pathname: normalizedPathname,
      searchParams,
      breadcrumb: topShellBreadcrumb,
    });
  }, [normalizedPathname, router, searchParams, topShellBreadcrumb]);

  // The avatar opens Profile from EVERY signed-in screen, so tag the current
  // route as the `?from` origin. The shared top-bar back control then retraces
  // to wherever the user opened Profile from instead of always dropping them on
  // the One dashboard — the profile "back goes to dashboard" glitch. We strip
  // any inherited `from` (no nesting) and never tag Profile as its own origin.
  const profileOpenHref = useMemo(() => {
    const base = normalizeInternalRouteHref(normalizedPathname);
    if (
      !base ||
      base === ROUTES.PROFILE ||
      base.startsWith(`${ROUTES.PROFILE}/`)
    ) {
      return ROUTES.PROFILE;
    }
    const query = new URLSearchParams(searchParams?.toString?.() ?? "");
    query.delete("from");
    const queryString = query.toString();
    const origin = queryString ? `${base}?${queryString}` : base;
    return buildProfileRoute({
      searchParams: new URLSearchParams({ from: origin }),
    });
  }, [normalizedPathname, searchParams]);

  const [switchingPersona, setSwitchingPersona] = useState<Persona | null>(
    null,
  );

  const handlePersonaSelect = useCallback(
    async (target: Persona) => {
      const nextRoute = routeForPersona({
        persona: target,
        lastKaiPath,
        lastRiaPath,
        riaEntryRoute,
      });
      const nextPathname = nextRoute.split("?")[0] || nextRoute;
      const trackRiaExistingSessionEntry = () => {
        const entrySurface = resolveGrowthEntrySurface(nextPathname);
        trackGrowthFunnelStepCompleted({
          journey: "ria",
          step: "entered",
          entrySurface,
          authMethod: "existing_session",
          dedupeKey: "growth:ria:entered:persona_switch",
          dedupeWindowMs: 5_000,
        });
        trackGrowthFunnelStepCompleted({
          journey: "ria",
          step: "auth_completed",
          entrySurface,
          authMethod: "existing_session",
          dedupeKey: "growth:ria:auth_completed:persona_switch",
          dedupeWindowMs: 5_000,
        });
      };

      if (target === activePersona) {
        if (pathname === ROUTES.RIA_ONBOARDING && target === "investor") {
          router.push(nextRoute);
        }
        return;
      }

      if (target === "ria" && riaCapability !== "switch") {
        setSwitchingPersona(target);
        trackRiaExistingSessionEntry();
        router.push(nextRoute);
        return;
      }

      setSwitchingPersona(target);
      try {
        await switchPersona(target);
        trackEvent("persona_switched", {
          action: target,
          result: "success",
        });
        if (target === "ria") {
          trackRiaExistingSessionEntry();
        }
        router.push(nextRoute);
      } catch (error) {
        console.error("[TopAppBar] Failed to switch persona:", error);
        trackEvent("persona_switched", {
          action: target,
          result: "error",
        });
        toast.error("Couldn't switch roles right now. Please retry.");
      } finally {
        setSwitchingPersona(null);
      }
    },
    [
      activePersona,
      lastKaiPath,
      lastRiaPath,
      pathname,
      riaCapability,
      riaEntryRoute,
      router,
      switchPersona,
    ],
  );

  if (hideChrome) return null;

  return (
    <div
      data-app-top-bar
      data-top-app-bar-tabs-only={tabsOnlyChrome || undefined}
      data-ambient-chrome-ignore
      className={cn(
        "ambient-chrome-top-foreground fixed inset-x-0 top-0 pointer-events-none",
        // While the vault unlock gate is showing, ride ABOVE the dialog overlay
        // scrim (z-[499]) so the top navbar stays sharp instead of being blurred
        // by the vault backdrop. Otherwise keep the normal top-chrome layer.
        showVaultUnlockAction ? "z-[505]" : "z-50",
        className,
      )}
    >
      <div
        data-testid="app-top-shell-layout"
        className="pointer-events-none relative w-full overflow-visible"
        style={{
          minHeight: tabsOnlyChrome
            ? "calc(var(--top-inset) + var(--top-tabs-h))"
            : "var(--top-shell-reserved-height)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 overflow-visible"
          style={{
            height:
              model.mode === "bar" || model.mode === "bar-with-tabs"
                ? "calc(var(--top-shell-visual-height) - var(--top-chrome-collapse-px, 0px))"
                : "var(--top-shell-visual-height)",
          }}
        >
          <AmbientChromeMask
            edge="top"
            className={cn(
              "h-full w-full",
              model.mode === "bar-with-tabs" &&
                "ambient-chrome-mask--top-with-tabs",
            )}
          />
        </div>

        <div
          className={cn(
            APP_SHELL_FRAME_CLASSNAME,
            "pointer-events-none relative flex w-full flex-col",
          )}
          style={{ ...APP_SHELL_FRAME_STYLE, maxWidth: "80rem" }}
        >
          <div
            data-testid="top-app-bar-header"
            className="pointer-events-none relative w-full shrink-0 overflow-hidden transform-gpu transition-[max-height,opacity,transform,padding] duration-200 ease-out will-change-transform"
            style={{
              maxHeight: tabsOnlyChrome
                ? "0px"
                : "calc(var(--top-inset) + var(--top-systembar-row-gap) + var(--top-bar-h) - var(--top-chrome-collapse-px, 0px))",
              paddingTop: tabsOnlyChrome
                ? "0px"
                : "calc(var(--top-inset) + var(--top-systembar-row-gap))",
              opacity: tabsOnlyChrome
                ? 0
                : "calc(1 - var(--top-chrome-progress, 0))",
              transform: tabsOnlyChrome
                ? "translate3d(0, -0.5rem, 0)"
                : "translate3d(0, 0, 0)",
            }}
          >
            <div
              data-testid="top-app-bar-row"
              className="pointer-events-none relative h-[var(--top-bar-h)] w-full shrink-0"
            >
              <div
                data-testid="top-app-bar-breadcrumb-row"
                className="pointer-events-none flex h-full w-full items-center gap-3 sm:gap-4"
              >
                <div
                  data-testid="top-app-bar-nav-slot"
                  className="pointer-events-none flex h-full shrink-0 items-center justify-start"
                  style={{
                    // Collapse the fixed side gutter to the back button's width
                    // when a breadcrumb trail is showing, so the trail sits
                    // right beside the back arrow instead of centered.
                    width: hasBreadcrumbTrail ? "auto" : "var(--top-bar-side-w)",
                  }}
                >
                  {topShellBreadcrumb && !topShellBreadcrumb.hideBack ? (
                    <div className="pointer-events-auto flex h-11 w-11 items-center justify-center">
                      <ShellActionSurface
                        variant="icon"
                        aria-label="Go back"
                        onClick={handleTopShellBack}
                      >
                        <ArrowLeft className="h-5 w-5" />
                      </ShellActionSurface>
                    </div>
                  ) : showOneHomeBrand ? (
                    <div
                      data-testid="top-app-bar-one-brand"
                      aria-label="One."
                      className="top-shell-ambient-ink pointer-events-none flex h-11 min-w-[92px] items-center justify-start gap-2 overflow-visible text-current"
                    >
                      <span
                        aria-hidden
                        className="flex h-7 w-7 shrink-0 items-center justify-center overflow-visible text-[23px] leading-none"
                        style={{
                          fontFamily:
                            '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", emoji',
                        }}
                      >
                        🤫
                      </span>
                      <span
                        aria-hidden
                        className="whitespace-nowrap text-[20px] font-semibold leading-none tracking-[-0.035em] text-current"
                      >
                        One
                        <span
                          className="text-transparent"
                          style={{
                            backgroundImage:
                              "linear-gradient(120deg, var(--app-accent-hero-from), var(--app-accent-hero-mid), var(--app-accent-hero-to))",
                            backgroundClip: "text",
                            WebkitBackgroundClip: "text",
                          }}
                        >
                          .
                        </span>
                      </span>
                    </div>
                  ) : (
                    <div className="h-10 w-10" aria-hidden />
                  )}
                </div>

                {/* Title sits in the normal flex flow. The right cluster remains
                  intentionally compact; `flex-1 min-w-0` lets the title truncate
                  before it can collide with the account action. */}
                <div
                  className={cn(
                    "pointer-events-none flex min-w-0 flex-1 items-center",
                    showOnboardingActions || hasBreadcrumbTrail
                      ? "justify-start"
                      : "justify-center",
                  )}
                >
                  {hasBreadcrumbTrail ? (
                    <TopShellBreadcrumbTrail items={breadcrumbTrailItems} />
                  ) : centerTitle ? (
                    centerTitle.interactive && canShowPersonaSwitcher ? (
                      <div className="pointer-events-auto inline-flex min-w-0 max-w-full items-center justify-center">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <ShellActionSurface
                              variant="pill"
                              data-tour-id="nav-role-switch"
                              data-testid="top-app-bar-title"
                              aria-label="Switch role"
                            >
                              <Icon
                                icon={
                                  switchingPersona
                                    ? Loader2
                                    : roleSwitcherIcon(activePersona)
                                }
                                size="sm"
                                className={cn(
                                  "shrink-0 text-current",
                                  switchingPersona ? "animate-spin" : "",
                                )}
                              />
                              <span className="truncate">
                                {switchingPersona
                                  ? `Switching to ${switchingPersona === "ria" ? "RIA" : "Investor"}`
                                  : roleSwitcherLabel(activePersona)}
                              </span>
                              {!switchingPersona && (
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                    activePersona === "ria"
                                      ? "bg-amber-500"
                                      : "bg-emerald-500",
                                  )}
                                  aria-label={`Active role: ${activePersona === "ria" ? "RIA" : "Investor"}`}
                                />
                              )}
                              <ChevronDown className="h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current" />
                            </ShellActionSurface>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="center"
                            className="min-w-[200px]"
                          >
                            <DropdownMenuItem
                              onClick={() =>
                                void handlePersonaSelect("investor")
                              }
                              disabled={switchingPersona !== null}
                              className="group"
                            >
                              <div className="relative z-10 flex min-w-0 items-center gap-2 text-current">
                                <UserRound className="h-4 w-4 text-current" />
                                <span>Investor</span>
                              </div>
                              {activePersona === "investor" ? (
                                <Check className="ml-auto h-4 w-4 text-current" />
                              ) : null}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void handlePersonaSelect("ria")}
                              disabled={switchingPersona !== null}
                              className="group"
                            >
                              <div className="relative z-10 flex min-w-0 items-center gap-2 text-current">
                                <BriefcaseBusiness className="h-4 w-4 text-current" />
                                <span>
                                  {riaCapability === "switch"
                                    ? "RIA"
                                    : "Set up RIA"}
                                </span>
                              </div>
                              {switchingPersona === "ria" ? (
                                <Loader2
                                  className="ml-auto h-4 w-4 animate-spin text-current"
                                  aria-hidden="true"
                                />
                              ) : activePersona === "ria" ? (
                                <Check className="ml-auto h-4 w-4 text-current" />
                              ) : null}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ) : (
                      <div
                        data-testid="top-app-bar-title"
                        className={cn(
                          TOP_SHELL_TITLE_PILL_CLASSNAME,
                          "top-shell-ambient-ink",
                          "pointer-events-auto",
                        )}
                      >
                        {centerTitle.icon ? (
                          <Icon
                            icon={centerTitle.icon}
                            size="sm"
                            className="shrink-0 text-current"
                          />
                        ) : null}
                        <span className="truncate">{centerTitle.label}</span>
                      </div>
                    )
                  ) : null}
                </div>

                <div
                  className="pointer-events-none flex h-full shrink-0 items-center justify-end"
                  style={{ minWidth: "var(--top-bar-side-w)" }}
                >
                  <div
                    data-testid="top-app-bar-actions"
                    className={cn(
                      "pointer-events-auto flex flex-nowrap items-center justify-end pr-[env(safe-area-inset-right)]",
                      "gap-1.5 sm:gap-2",
                    )}
                  >
                    {!isAuthenticated ? null : showOnboardingActions ? (
                      <OnboardingRouteActions />
                    ) : (
                      <>
                        {showVaultUnlockAction ? (
                          <ShellActionSurface
                            variant="icon"
                            aria-label="Unlock vault"
                            onClick={() => setVaultUnlockOpen(true)}
                          >
                            <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                          </ShellActionSurface>
                        ) : null}

                        <ShellActionSurface
                          variant="icon"
                          aria-label="Open Profile"
                          onClick={() =>
                            requestInternalAppNavigation({
                              href: profileOpenHref,
                              scroll: false,
                              source: "tap",
                              transitionMode: "full",
                            })
                          }
                          className="p-0"
                        >
                          <Avatar className="h-9 w-9">
                            {effectiveAvatarUrl ? (

                              <AvatarImage src={effectiveAvatarUrl} alt="" />
                            ) : null}
                            <AvatarFallback className="bg-transparent text-current">
                              {user?.displayName ? (
                                user.displayName
                                  .split(" ")
                                  .map((part) => part[0])
                                  .join("")
                                  .slice(0, 2)
                                  .toUpperCase()
                              ) : (
                                <UserRound className="h-5 w-5" />
                              )}
                            </AvatarFallback>
                          </Avatar>
                        </ShellActionSurface>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          {model.mode === "bar-with-tabs" ? (
            <div
              data-testid="top-app-bar-tabs"
              className="pointer-events-auto relative w-full shrink-0 transition-[height,padding] duration-200 ease-out"
              style={{
                height: tabsOnlyChrome
                  ? "calc(var(--top-inset) + var(--top-tabs-h))"
                  : "var(--top-tabs-h)",
                paddingTop: tabsOnlyChrome ? "var(--top-inset)" : "0px",
              }}
            >
              <TopShellTabs tabSet={model.tabs} />
            </div>
          ) : null}
        </div>
      </div>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {switchingPersona
          ? `Switching to ${switchingPersona === "ria" ? "RIA" : "Investor"}`
          : ""}
      </span>
      {user && hasVault === true ? (
        <VaultUnlockDialog
          user={user}
          open={vaultUnlockOpen}
          onOpenChange={setVaultUnlockOpen}
          title="Unlock vault"
          description="Unlock your vault to use secure memory and background activity."
          onSuccess={() => {
            setVaultUnlockOpen(false);
            setHasVault(true);
            toast.success("Vault unlocked.");
          }}
        />
      ) : null}
    </div>
  );
}

/* ── OnboardingRouteActions ────────────────────────────────────────── */
function OnboardingRouteActions() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [vaultUnlockOpen, setVaultUnlockOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleSignOut() {
    try {
      await signOut();
      router.push(ROUTES.HOME);
    } catch (error) {
      console.error("[TopAppBar] Failed to sign out:", error);
      toast.error("Couldn't sign out. Please retry.");
    }
  }

  async function requestDeleteAccount() {
    if (!user?.uid) return;

    try {
      const resolution = await resolveDeleteAccountAuth({
        userId: user.uid,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });

      if (resolution.kind === "needs_unlock") {
        setVaultUnlockOpen(true);
        return;
      }
    } catch (error) {
      console.error("[TopAppBar] Failed to prepare account deletion:", error);
      morphyToast.error("Failed to delete account. Please try again.");
      return;
    }

    setDeleteConfirmOpen(true);
  }

  async function handleDeleteAccount() {
    if (!user?.uid) return;

    setIsDeleting(true);
    try {
      const resolution = await resolveDeleteAccountAuth({
        userId: user.uid,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });

      if (resolution.kind === "needs_unlock") {
        setDeleteConfirmOpen(false);
        setVaultUnlockOpen(true);
        return;
      }

      await morphyToast
        .promise(
          executeVerifiedAccountDeletion({
            userId: user.uid,
            vaultOwnerToken: resolution.token,
          }),
          {
            loading: "Deleting your account...",
            success: "Account deleted.",
            error: "Failed to delete account. Please try again.",
            variant: "destructive",
          },
        )
        .unwrap();

      await signOut({ skipFcmCleanup: true });
      router.replace(ROUTES.HOME);
    } catch (error) {
      console.error("[TopAppBar] Failed to delete account:", error);
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ShellActionSurface variant="icon" aria-label="Account actions">
            <MoreHorizontal className="h-5 w-5 text-current" />
          </ShellActionSurface>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void handleSignOut()}>
            <LogOut className="h-4 w-4 text-current" />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void requestDeleteAccount()}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="h-4 w-4 text-current" />
            Delete account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultUnlockOpen}
          onOpenChange={setVaultUnlockOpen}
          title="Unlock Vault to Delete Account"
          description="Unlock your vault to confirm deletion. This is permanent and removes all encrypted records."
          onSuccess={() => {
            setVaultUnlockOpen(false);
            window.setTimeout(() => void requestDeleteAccount(), 300);
          }}
        />
      ) : null}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{DELETE_ACCOUNT_DIALOG_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>
              {DELETE_ACCOUNT_DIALOG_DESCRIPTION}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!isDeleting) void handleDeleteAccount();
              }}
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Yes, delete my account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
