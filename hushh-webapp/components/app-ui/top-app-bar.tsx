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

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Code2,
  type LucideIcon,
  Loader2,
  LogOut,
  MoreHorizontal,
  Trash2,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
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
import { resolveDeleteAccountAuth } from "@/lib/flows/delete-account";
import { AccountService } from "@/lib/services/account-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";
import { DebateTaskCenter } from "@/components/app-ui/debate-task-center";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { resolveTopShellMetrics } from "@/components/app-ui/top-shell-metrics";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import type { Persona } from "@/lib/services/ria-service";
import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/* ── Re-exports (backward compat) ─────────────────────────────────── */
export {
  resolveTopShellHeight,
  resolveTopShellMetrics,
  shouldHideTopShell,
  shouldShowKaiTabsInTopShell,
  type TopShellMetrics,
} from "@/components/app-ui/top-shell-metrics";

/* ── Constants ─────────────────────────────────────────────────────── */
export const TOP_SHELL_ICON_BUTTON_CLASSNAME =
  "relative grid h-10 w-10 place-items-center rounded-full border border-border/60 bg-background/70 shadow-sm backdrop-blur-sm transition-colors hover:bg-muted/50 active:bg-muted/80";

/* ── Stubs (kept for import stability) ─────────────────────────────── */
export function TopBarBackground() { return null; }
export function StatusBarBlur() { return null; }
export function TopAppBarSpacer() { return null; }

/* ── Helpers ───────────────────────────────────────────────────────── */
function getTopBarTitle(
  pathname: string,
  activePersona: "investor" | "ria"
): {
  label: string;
  icon?: LucideIcon;
  interactive: boolean;
} | null {
  if (pathname === ROUTES.KAI_ONBOARDING || pathname.startsWith(`${ROUTES.KAI_ONBOARDING}/`)) {
    return { label: "Get started", interactive: false as const };
  }

  if (pathname === ROUTES.RIA_ONBOARDING || pathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`)) {
    return { label: "Set up RIA", interactive: false as const };
  }

  if (pathname === ROUTES.DEVELOPERS) {
    return { label: "Developers", icon: Code2, interactive: false as const };
  }

  const isPersonaShellRoute =
    pathname.startsWith(ROUTES.KAI_HOME) ||
    pathname.startsWith(ROUTES.RIA_HOME) ||
    pathname.startsWith(ROUTES.MARKETPLACE) ||
    pathname.startsWith(ROUTES.CONSENTS) ||
    pathname.startsWith(ROUTES.PROFILE);

  if (isPersonaShellRoute) {
    return activePersona === "ria"
      ? { label: "RIA", icon: BriefcaseBusiness, interactive: true as const }
      : { label: "Investor", icon: UserRound, interactive: true as const };
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

/* ── TopAppBar ─────────────────────────────────────────────────────── */
interface TopAppBarProps {
  className?: string;
}

export function TopAppBar({ className }: TopAppBarProps) {
  const router = useRouter();
  const { isVaultUnlocked } = useVault();
  const {
    activePersona,
    riaCapability,
    riaEntryRoute,
    switchPersona,
  } = usePersonaState();
  const pathname = usePathname();
  const lastKaiPath = useKaiSession((s) => s.lastKaiPath);
  const lastRiaPath = useKaiSession((s) => s.lastRiaPath);
  const topShellMetrics = useMemo(() => resolveTopShellMetrics(pathname), [pathname]);
  const topShellBreadcrumb = useMemo(() => resolveTopShellBreadcrumb(pathname), [pathname]);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const showOnboardingActions = chromeState.useOnboardingChrome;
  const hideChrome = !topShellMetrics.shellVisible;
  const centerTitle = useMemo(
    () => getTopBarTitle(pathname, activePersona),
    [activePersona, pathname]
  );
  const showKaiTabs = topShellMetrics.hasTabs;
  const [switchingPersona, setSwitchingPersona] = useState<Persona | null>(null);

  useEffect(() => {
    router.prefetch(lastKaiPath || ROUTES.KAI_HOME);
    router.prefetch(lastRiaPath || riaEntryRoute);
  }, [lastKaiPath, lastRiaPath, riaEntryRoute, router]);

  const handlePersonaSelect = useCallback(
    async (target: Persona) => {
      const nextRoute = routeForPersona({
        persona: target,
        lastKaiPath,
        lastRiaPath,
        riaEntryRoute,
      });

      if (target === activePersona) {
        return;
      }

      if (target === "ria" && riaCapability !== "switch") {
        setSwitchingPersona(target);
        router.push(nextRoute);
        return;
      }

      setSwitchingPersona(target);
      try {
        await switchPersona(target);
        router.push(nextRoute);
      } catch (error) {
        console.error("[TopAppBar] Failed to switch persona:", error);
        toast.error("Couldn't switch roles right now. Please retry.");
      } finally {
        setSwitchingPersona(null);
      }
    },
    [activePersona, lastKaiPath, lastRiaPath, riaCapability, riaEntryRoute, router, switchPersona]
  );

  // Subscribe to scroll-direction store so top glass height follows tabs visibility.
  const { progress: tabsScrollHideProgress } = useKaiBottomChromeVisibility(showKaiTabs);

  const topGlassHeight = useMemo(
    () =>
      showKaiTabs
        ? `calc(var(--top-inset) + var(--top-systembar-row-gap, 0px) + var(--top-bar-h) + ((1 - ${tabsScrollHideProgress}) * var(--top-tabs-h)) + var(--top-subnav-total) + var(--top-fade-active))`
        : "var(--top-shell-visual-height)",
    [showKaiTabs, tabsScrollHideProgress]
  );

  const topGlassStyle = useMemo<React.CSSProperties>(
    () => ({
      "--app-bar-glass-bg-light": "rgba(255, 255, 255, 0.52)",
      "--app-bar-glass-bg-dark": "rgba(12, 15, 21, 0.58)",
      "--app-bar-glass-blur": "6px",
      "--app-bar-shadow": "none",
      "--app-bar-mask-overscan": "26px",
    } as React.CSSProperties),
    []
  );

  if (hideChrome) return null;

  return (
    <div
      className={cn("fixed inset-x-0 top-0 z-50 pointer-events-none", className)}
    >
      <div
        className="pointer-events-none relative w-full overflow-visible"
        style={{ height: "var(--top-shell-reserved-height)" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 overflow-visible"
          style={{ height: topGlassHeight }}
        >
          <div className="h-full w-full bar-glass bar-glass-top" style={topGlassStyle} />
        </div>

        <div className="pointer-events-none relative mx-auto flex h-full w-full max-w-[540px] flex-col justify-end px-4 sm:px-6">
          <div
            data-testid="top-app-bar-row"
            className="pointer-events-none relative h-[var(--top-bar-h)] w-full shrink-0"
          >
            <div className="pointer-events-none grid h-full w-full grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
              <div className="pointer-events-auto flex h-11 w-11 items-center justify-center">
                {topShellBreadcrumb ? (
                  <button
                    type="button"
                    className={TOP_SHELL_ICON_BUTTON_CLASSNAME}
                    aria-label="Go back"
                    onClick={() => {
                      if (typeof window !== "undefined" && window.history.length > 1) {
                        router.back();
                        return;
                      }
                      router.push(topShellBreadcrumb.backHref);
                    }}
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                ) : (
                  <div className="h-11 w-11" aria-hidden />
                )}
              </div>

              <div className="pointer-events-none flex min-w-0 items-center justify-center">
                {centerTitle ? (
                  centerTitle.interactive ? (
                    <div className="pointer-events-auto inline-flex min-w-0 max-w-full items-center justify-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          data-tour-id="nav-role-switch"
                          className="group relative inline-flex min-w-0 max-w-full flex-none items-center justify-center gap-2 overflow-hidden rounded-full px-3 py-1.5 text-base font-semibold tracking-tight text-foreground transition-colors hover:bg-muted/40 sm:text-lg"
                          aria-label="Switch role"
                        >
                          <span className="relative z-10 inline-flex min-w-0 max-w-full items-center gap-2">
                            <Icon
                              icon={switchingPersona ? Loader2 : centerTitle.icon!}
                              size="sm"
                              className={cn(
                                "shrink-0 text-current",
                                switchingPersona ? "animate-spin" : ""
                              )}
                            />
                            <span className="truncate">
                              {switchingPersona
                                ? `Switching to ${switchingPersona === "ria" ? "RIA" : "Investor"}`
                                : centerTitle.label}
                            </span>
                            <ChevronDown className="h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current" />
                          </span>
                          <MaterialRipple variant="none" effect="fade" className="z-0" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="center" className="min-w-[200px]">
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
                            <span>{riaCapability === "switch" ? "RIA" : "Set up RIA"}</span>
                          </div>
                          {switchingPersona === "ria" ? (
                            <Loader2 className="ml-auto h-4 w-4 animate-spin text-current" />
                          ) : activePersona === "ria" ? (
                            <Check className="ml-auto h-4 w-4 text-current" />
                          ) : null}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  ) : (
                    <div className="inline-flex min-w-0 max-w-full items-center justify-center gap-2 rounded-full px-3 py-1.5 text-base font-semibold tracking-tight text-foreground sm:text-lg">
                      {centerTitle.icon ? (
                        <Icon icon={centerTitle.icon} size="sm" className="shrink-0 text-current" />
                      ) : null}
                      <span className="truncate">{centerTitle.label}</span>
                    </div>
                  )
                ) : null}
              </div>

              <div className="pointer-events-auto flex h-11 w-11 items-center justify-center">
                {showOnboardingActions ? (
                  <OnboardingRouteActions />
                ) : isVaultUnlocked ? (
                  <DebateTaskCenter triggerClassName={TOP_SHELL_ICON_BUTTON_CLASSNAME} />
                ) : topShellBreadcrumb ? (
                  <button
                    type="button"
                    className={TOP_SHELL_ICON_BUTTON_CLASSNAME}
                    aria-label="Notifications unavailable until your vault is unlocked"
                    disabled
                  >
                    <Bell className="h-5 w-5 opacity-65" />
                  </button>
                ) : (
                  <div className="h-11 w-11" aria-hidden />
                )}
              </div>
            </div>
          </div>

          {topShellBreadcrumb ? (
            <div
              className="pointer-events-none relative mt-[var(--top-subnav-gap)] h-[var(--top-subnav-h)] w-full shrink-0"
              data-testid="top-app-bar-breadcrumb-row"
            >
              <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center px-3">
                <div className="pointer-events-auto min-w-0 max-w-full rounded-full border border-border/45 bg-background/45 px-3 py-1 shadow-[0_1px_0_rgba(255,255,255,0.18)_inset] backdrop-blur-sm">
                  <Breadcrumb>
                    <BreadcrumbList className="flex flex-nowrap items-center gap-1 overflow-hidden whitespace-nowrap">
                      {topShellBreadcrumb.items.map((item, index) => {
                        const isLast = index === topShellBreadcrumb.items.length - 1;
                        return (
                          <Fragment key={`${item.label}-${index}`}>
                            <BreadcrumbItem className="min-w-0">
                              {isLast ? (
                                <BreadcrumbPage className="truncate text-[11px] font-medium text-foreground/85 sm:text-xs">
                                  {item.label}
                                </BreadcrumbPage>
                              ) : item.href ? (
                                <BreadcrumbLink asChild>
                                  <Link
                                    href={item.href}
                                    className="truncate text-[11px] text-muted-foreground transition-colors hover:text-foreground sm:text-xs"
                                  >
                                    {item.label}
                                  </Link>
                                </BreadcrumbLink>
                              ) : (
                                <span className="truncate text-[11px] text-muted-foreground sm:text-xs">
                                  {item.label}
                                </span>
                              )}
                            </BreadcrumbItem>
                            {!isLast ? (
                              <BreadcrumbSeparator className="text-muted-foreground/70 [&>svg]:size-3" />
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="none"
            effect="fade"
            size="icon"
            className="h-9 w-9 rounded-full"
            aria-label="Account actions"
          >
            <MoreHorizontal className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void handleSignOut()}>
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setDeleteConfirmOpen(true)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="h-4 w-4" />
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
