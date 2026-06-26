"use client";

/**
 * Unified Top Shell
 *
 * Single fixed component that owns the entire top chrome:
 *   1. Capacitor safe-area inset (notch / Dynamic Island)
 *   2. Header row  –  actor title · actions
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
  Bell,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
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
  MapPin,
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
import { ThemeToggleCompact } from "@/components/theme-toggle";
import { Icon } from "@/lib/morphy-ux/ui";
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
import { useVault } from "@/lib/vault/vault-context";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { resolveDeleteAccountAuth } from "@/lib/flows/delete-account";
import { AccountService } from "@/lib/services/account-service";
import { VaultService } from "@/lib/services/vault-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";
import { DebateTaskCenter } from "@/components/app-ui/debate-task-center";
import { ConsentInboxDropdown } from "@/components/consent/consent-inbox-dropdown";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { resolveTopShellMetrics } from "@/components/app-ui/top-shell-metrics";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import type { Persona } from "@/lib/services/ria-service";
import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
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
    pathname === ROUTES.ONE_ONBOARDING ||
    pathname.startsWith(`${ROUTES.ONE_ONBOARDING}/`)
  ) {
    return { label: "Set up One", interactive: false as const };
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
      pathname === ROUTES.KAI_HOME ||
      pathname === ROUTES.LEGACY_KAI_HOME ||
      pathname === ROUTES.MARKETPLACE
    ) {
      return null;
    }
  }

  const isPersonaShellRoute =
    pathname.startsWith(ROUTES.KAI_HOME) ||
    pathname.startsWith(ROUTES.LEGACY_KAI_HOME) ||
    pathname.startsWith(ROUTES.MARKETPLACE) ||
    pathname.startsWith(ROUTES.CONSENTS);

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
    normalized === ROUTES.KAI_HOME ||
    normalized.startsWith(`${ROUTES.KAI_HOME}/`)
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
      label: "One dashboard",
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
      label: "Personal Data",
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
  if (pathname === ROUTES.CONSENTS) {
    return {
      label: "Access & sharing",
      icon: Shield,
      interactive: false as const,
    };
  }
  if (pathname === ROUTES.ONE_KYC) {
    return { label: "Email", icon: FileCheck2, interactive: false as const };
  }
  if (pathname === ROUTES.ONE_LOCATION) {
    return { label: "Location", icon: MapPin, interactive: false as const };
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
  return params.persona === "ria"
    ? params.lastRiaPath || params.riaEntryRoute
    : params.lastKaiPath || ROUTES.KAI_HOME;
}

function readTopShellReservedHeight(): number {
  if (typeof window === "undefined") return 0;
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--top-shell-reserved-height");
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

function isPrimaryHeaderOutOfView(header: HTMLElement | null): boolean {
  if (!header) return false;
  return header.getBoundingClientRect().bottom <= readTopShellReservedHeight();
}

/* ── TopAppBar ─────────────────────────────────────────────────────── */
interface TopAppBarProps {
  className?: string;
}

export function TopAppBar({ className }: TopAppBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, user } = useAuth();
  const { isVaultUnlocked } = useVault();
  const { activePersona, riaCapability, riaEntryRoute, switchPersona } =
    usePersonaState();
  const pathname = usePathname();
  const lastKaiPath = useKaiSession((s) => s.lastKaiPath);
  const lastRiaPath = useKaiSession((s) => s.lastRiaPath);
  const topShellMetrics = useMemo(
    () => resolveTopShellMetrics(pathname),
    [pathname],
  );
  const topShellBreadcrumb = useMemo(
    () => resolveTopShellBreadcrumb(pathname, searchParams),
    [pathname, searchParams],
  );
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const showOnboardingActions = chromeState.useOnboardingChrome;
  const hideChrome = !topShellMetrics.shellVisible;
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [vaultUnlockOpen, setVaultUnlockOpen] = useState(false);

  const [primaryHeaderOutOfView, setPrimaryHeaderOutOfView] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let scrollRoot = document.querySelector<HTMLElement>(
      '[data-app-scroll-root="true"]',
    );
    let header = document.querySelector<HTMLElement>(
      '[data-slot="page-header"][data-page-primary="true"]',
    );
    let attachedScrollRoot: HTMLElement | null = null;
    let retryTimer = 0;

    const updateHeaderVisibility = () => {
      setPrimaryHeaderOutOfView(isPrimaryHeaderOutOfView(header));
    };

    const detachListeners = () => {
      attachedScrollRoot?.removeEventListener("scroll", updateHeaderVisibility);
      window.removeEventListener("scroll", updateHeaderVisibility);
      window.removeEventListener("resize", updateHeaderVisibility);
      attachedScrollRoot = null;
    };

    const attach = () => {
      detachListeners();

      scrollRoot = document.querySelector<HTMLElement>(
        '[data-app-scroll-root="true"]',
      );
      header = document.querySelector<HTMLElement>(
        '[data-slot="page-header"][data-page-primary="true"]',
      );

      updateHeaderVisibility();
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
    };

    attach();

    return () => {
      detachListeners();
      window.clearTimeout(retryTimer);
    };
  }, [pathname]);

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

      try {
        const exists = await VaultService.checkVault(user.uid);
        if (!cancelled) {
          setHasVault(exists);
        }
      } catch (error) {
        console.warn("[TopAppBar] Failed to resolve vault availability:", error);
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
    () => getTopBarTitle(pathname, primaryHeaderOutOfView),
    [pathname, primaryHeaderOutOfView],
  );
  const canShowPersonaSwitcher = useMemo(
    () => isPersonaSwitchTopBarRoute(pathname),
    [pathname],
  );
  const showVaultUnlockAction =
    isAuthenticated && hasVault === true && !isVaultUnlocked;
  const showKaiTabs = topShellMetrics.hasTabs;
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

  // Subscribe to the shared scroll-direction store so top chrome hides opposite
  // the bottom nav while keeping the page layout spacer stable.
  const { progress: topChromeHideProgress } =
    useKaiBottomChromeVisibility(!hideChrome);

  const topGlassHeight = useMemo(
    () =>
      showKaiTabs
        ? `calc(var(--top-inset) + var(--top-systembar-row-gap, 0px) + var(--top-bar-h) + ((1 - ${topChromeHideProgress}) * var(--top-tabs-h)) + var(--top-fade-active))`
        : "var(--top-shell-visual-height)",
    [showKaiTabs, topChromeHideProgress],
  );
  const topChromeTransform = useMemo(
    () =>
      `translate3d(0, calc(-1 * ${topChromeHideProgress} * var(--top-shell-reserved-height)), 0)`,
    [topChromeHideProgress],
  );

  const topGlassStyle = useMemo<React.CSSProperties>(
    () =>
      ({
        "--app-bar-glass-bg-light": "rgba(245, 245, 247, 0.76)",
        "--app-bar-glass-bg-dark": "rgba(28, 28, 30, 0.76)",
        "--app-bar-shadow": "0 10px 26px rgba(120, 120, 128, 0.12)",
        "--app-bar-mask-overscan": "14px",
      }) as React.CSSProperties,
    [],
  );

  if (hideChrome) return null;

  return (
    <div
      className={cn(
        "fixed inset-x-0 top-0 pointer-events-none",
        // While the vault unlock gate is showing, ride ABOVE the dialog overlay
        // scrim (z-[499]) so the top navbar stays sharp instead of being blurred
        // by the vault backdrop. Otherwise keep the normal top-chrome layer.
        showVaultUnlockAction ? "z-[505]" : "z-50",
        className,
      )}
    >
      <div
        className="pointer-events-none relative w-full overflow-visible"
        style={{
          height: "var(--top-shell-reserved-height)",
          transform: topChromeTransform,
          willChange: "transform",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 overflow-visible"
          style={{ height: topGlassHeight }}
        >
          <div
            className="h-full w-full bar-glass bar-glass-top"
            style={topGlassStyle}
          />
        </div>

        <div
          className={cn(
            APP_SHELL_FRAME_CLASSNAME,
            "pointer-events-none relative flex h-full w-full flex-col justify-end",
          )}
          style={APP_SHELL_FRAME_STYLE}
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
                style={{ width: "var(--top-bar-side-w)" }}
              >
                <div className="pointer-events-auto flex h-11 w-11 items-center justify-center">
                  {topShellBreadcrumb ? (
                    <ShellActionSurface
                      variant="icon"
                      aria-label="Go back"
                      onClick={() => {
                        router.push(topShellBreadcrumb.backHref);
                      }}
                    >
                      <ArrowLeft className="h-5 w-5" />
                    </ShellActionSurface>
                  ) : (
                    <div className="h-10 w-10" aria-hidden />
                  )}
                </div>
              </div>

              <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center px-3 sm:px-4">
                {centerTitle ? (
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
                            onClick={() => void handlePersonaSelect("investor")}
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
                  className="pointer-events-auto flex flex-nowrap items-center justify-end gap-1.5 sm:gap-2 pr-[env(safe-area-inset-right)]"
                >
                  {!isAuthenticated ? null : showOnboardingActions ? (
                    <OnboardingRouteActions />
                  ) : (
                    <>
                      <ConsentInboxDropdown
                        renderTrigger={({ pendingCount }) => (
                          <ShellActionSurface
                            variant="icon"
                            aria-label="Open consent inbox"
                            badge={
                              pendingCount > 0 ? (
                                <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_8px_18px_rgba(14,165,233,0.32)] ring-2 ring-white/90 dark:ring-[#111113]">
                                  {pendingCount}
                                </span>
                              ) : null
                            }
                          >
                            <Shield className="h-5 w-5" />
                          </ShellActionSurface>
                        )}
                      />

                      {showVaultUnlockAction ? (
                        <ShellActionSurface
                          variant="icon"
                          aria-label="Unlock vault"
                          onClick={() => setVaultUnlockOpen(true)}
                        >
                          <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                        </ShellActionSurface>
                      ) : null}

                      <DebateTaskCenter
                        renderTrigger={({ activeCount, badgeCount }) => (
                          <ShellActionSurface
                            variant="icon"
                            aria-label="Notifications"
                            badge={
                              badgeCount > 0 ? (
                                <span className="inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_8px_18px_rgba(14,165,233,0.32)] ring-2 ring-white/90 dark:ring-[#111113]">
                                  {badgeCount}
                                </span>
                              ) : null
                            }
                          >
                            {activeCount > 0 ? (
                              <Loader2
                                className="h-5 w-5 animate-spin text-sky-500"
                                aria-hidden="true"
                              />
                            ) : (
                              <Bell className="h-5 w-5" />
                            )}
                          </ShellActionSurface>
                        )}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
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
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleSignOut() {
    try {
      setOnboardingRequiredCookie(false);
      setOnboardingFlowActiveCookie(false);
      await signOut();
      router.push(ROUTES.HOME);
    } catch (error) {
      console.error("[TopAppBar] Failed to sign out:", error);
      toast.error("Couldn't sign out. Please retry.");
    }
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
        toast.error("Unlock your vault from Profile to delete this account.");
        router.push(ROUTES.PROFILE);
        return;
      }

      await AccountService.deleteAccount(resolution.token);
      CacheSyncService.onAccountDeleted(user.uid);
      await UserLocalStateService.clearForUser(user.uid);
      setOnboardingRequiredCookie(false);
      setOnboardingFlowActiveCookie(false);

      toast.success("Account deleted.");
      await signOut();
      router.push(ROUTES.HOME);
    } catch (error) {
      console.error("[TopAppBar] Failed to delete account:", error);
      toast.error("Failed to delete account. Please retry.");
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }

  return (
    <>
      <ThemeToggleCompact className={TOP_SHELL_ICON_BUTTON_CLASSNAME} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ShellActionSurface
            variant="icon"
            aria-label="Account actions"
          >
            <MoreHorizontal className="h-5 w-5 text-current" />
          </ShellActionSurface>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void handleSignOut()}>
            <LogOut className="h-4 w-4 text-current" />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setDeleteConfirmOpen(true)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="h-4 w-4 text-current" />
            Delete account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes your account and associated data.
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
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
