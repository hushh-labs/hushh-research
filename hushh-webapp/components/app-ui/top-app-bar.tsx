"use client";

/**
 * Unified Top Shell - Extended Version (700+ Line Fidelity)
 * 
 * This component manages the entire top chrome, including:
 * 1. Safe-area insets for iOS/Android/Web.
 * 2. Dynamic Title & Role Switching.
 * 3. Network Resilience & Connectivity Monitoring.
 * 4. Contextual Command Palette (Cmd+K).
 * 5. Notification & Consent Inbox Integration.
 */

import React, { useCallback, useMemo, useState, useEffect, useRef } from "react";
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
  Shield,
  Trash2,
  UserRound,
  Search,
  Command as CommandIcon,
  WifiOff,
  Zap,
  Settings,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  APP_SHELL_FRAME_CLASSNAME,
  APP_SHELL_FRAME_STYLE,
} from "@/components/app-ui/app-page-shell";

/* UI Components */
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
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
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

/* Hooks & Services */
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

/* ── Constants ─────────────────────────────────────────────────────── */
export const TOP_SHELL_ICON_BUTTON_CLASSNAME = SHELL_ICON_BUTTON_CLASSNAME;
const TOP_SHELL_TITLE_PILL_CLASSNAME = SHELL_PILL_TRIGGER_CLASSNAME;
export const APP_MEASURE_STYLES = APP_SHELL_FRAME_STYLE;

/**
 * Hook to monitor online/offline status
 */
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  return isOnline;
}

/* ── Helpers ───────────────────────────────────────────────────────── */
function getTopBarTitle(
  pathname: string,
  activePersona: "investor" | "ria",
): {
  label: string;
  icon?: LucideIcon;
  interactive: boolean;
} | null {
  if (pathname.includes(ROUTES.KAI_ONBOARDING)) {
    return { label: "Get started", interactive: false };
  }
  if (pathname.includes(ROUTES.RIA_ONBOARDING)) {
    return { label: "Set up RIA", icon: BriefcaseBusiness, interactive: true };
  }
  if (pathname === ROUTES.DEVELOPERS) {
    return { label: "Developers", icon: Code2, interactive: false };
  }

  const isRiaShellRoute = pathname.startsWith(ROUTES.RIA_HOME);
  const isPersonaShellRoute =
    pathname.startsWith(ROUTES.KAI_HOME) ||
    pathname.startsWith(ROUTES.MARKETPLACE) ||
    pathname.startsWith(ROUTES.CONSENTS) ||
    pathname.startsWith(ROUTES.PROFILE);

  if (isRiaShellRoute || isPersonaShellRoute) {
    return activePersona === "ria"
      ? { label: "RIA", icon: BriefcaseBusiness, interactive: true }
      : { label: "Investor", icon: UserRound, interactive: true };
  }
  return null;
}

/* ── Sub-Components ────────────────────────────────────────────────── */

/**
 * QuickSearch: The Cmd+K Command Palette Feature
 */
const QuickSearch = ({ isOnline }: { isOnline: boolean }) => {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  return (
    <>
      <ShellActionSurface
        variant="icon"
        className="hidden md:flex"
        onClick={() => setOpen(true)}
        aria-label="Search or Quick Action"
      >
        <Search className="h-5 w-5" />
        <kbd className="pointer-events-none absolute right-[-20px] top-[-4px] hidden select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </ShellActionSurface>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Navigation">
            <CommandItem onSelect={() => runCommand(() => router.push(ROUTES.KAI_HOME))}>
              <Zap className="mr-2 h-4 w-4" />
              <span>Dashboard</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => router.push(ROUTES.MARKETPLACE))}>
              <BriefcaseBusiness className="mr-2 h-4 w-4" />
              <span>Marketplace</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => router.push(ROUTES.PROFILE))}>
              <UserRound className="mr-2 h-4 w-4" />
              <span>My Profile</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="System">
            <CommandItem disabled={!isOnline} onSelect={() => runCommand(() => toast.info("Settings coming soon"))}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
};

/* ── Main Component ────────────────────────────────────────────────── */

export function TopAppBar({ className }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isOnline = useOnlineStatus();
  const pathname = usePathname();

  const { isVaultUnlocked } = useVault();
  const { activePersona, riaCapability, riaEntryRoute, switchPersona } = usePersonaState();
  const lastKaiPath = useKaiSession((s) => s.lastKaiPath);
  const lastRiaPath = useKaiSession((s) => s.lastRiaPath);

  const [switchingPersona, setSwitchingPersona] = useState<Persona | null>(null);

  const topShellMetrics = useMemo(() => resolveTopShellMetrics(pathname), [pathname]);
  const topShellBreadcrumb = useMemo(() => resolveTopShellBreadcrumb(pathname, searchParams), [pathname, searchParams]);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);

  const showOnboardingActions = chromeState.useOnboardingChrome;
  const hideChrome = !topShellMetrics.shellVisible;
  const centerTitle = useMemo(() => getTopBarTitle(pathname, activePersona), [activePersona, pathname]);
  const showKaiTabs = topShellMetrics.hasTabs;

  const handlePersonaSelect = useCallback(async (target: Persona) => {
    if (!isOnline) {
      toast.error("Offline: Cannot switch roles.");
      return;
    }

    const nextRoute = target === "ria"
      ? lastRiaPath || riaEntryRoute
      : lastKaiPath || ROUTES.KAI_HOME;

    if (target === activePersona) return;

    setSwitchingPersona(target);
    try {
      await switchPersona(target);
      trackEvent("persona_switched", { action: target, result: "success" });
      router.push(nextRoute);
    } catch (e) {
      toast.error("Role switch failed.");
    } finally {
      setSwitchingPersona(null);
    }
  }, [activePersona, isOnline, lastKaiPath, lastRiaPath, riaEntryRoute, router, switchPersona]);

  const { progress: tabsScrollHideProgress } = useKaiBottomChromeVisibility(showKaiTabs);

  // Height logic calculation to prevent layout shifts
  const topGlassHeight = useMemo(() => {
    const base = `var(--top-inset) + var(--top-systembar-row-gap, 0px) + var(--top-bar-h)`;
    const tabPortion = `((1 - ${tabsScrollHideProgress}) * var(--top-tabs-h))`;
    return showKaiTabs ? `calc(${base} + ${tabPortion} + var(--top-fade-active))` : "var(--top-shell-visual-height)";
  }, [showKaiTabs, tabsScrollHideProgress]);

  if (hideChrome) return null;

  return (
    <nav className={cn("fixed inset-x-0 top-0 z-50 pointer-events-none select-none", className)}>
      {/* Visual Backdrop Layer */}
      <div className="pointer-events-none relative w-full" style={{ height: "var(--top-shell-reserved-height)" }}>
        <div className="pointer-events-none absolute inset-x-0 top-0 overflow-visible transition-all duration-300 ease-in-out" style={{ height: topGlassHeight }}>
          <div className="h-full w-full bar-glass bar-glass-top shadow-sm" />
        </div>

        {/* Content Layer */}
        <div className={cn(APP_SHELL_FRAME_CLASSNAME, "pointer-events-none relative flex h-full w-full flex-col justify-end")} style={APP_SHELL_FRAME_STYLE}>
          <div className="pointer-events-none relative h-[var(--top-bar-h)] w-full shrink-0">
            <div className="pointer-events-none flex h-full w-full items-center gap-2 px-2 sm:px-4">

              {/* Left Slot: Navigation/Back */}
              <div className="flex h-full shrink-0 items-center justify-start" style={{ width: "var(--top-bar-side-w)" }}>
                <div className="pointer-events-auto">
                  {topShellBreadcrumb && (
                    <ShellActionSurface variant="icon" onClick={() => router.push(topShellBreadcrumb.backHref)}>
                      <ArrowLeft className="h-5 w-5" />
                    </ShellActionSurface>
                  )}
                </div>
              </div>

              {/* Center Slot: Dynamic Title & Status */}
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <div className="pointer-events-auto flex items-center gap-2">
                  {!isOnline && (
                    <div className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-500 ring-1 ring-red-500/20">
                      <WifiOff className="h-3 w-3" /> OFFLINE
                    </div>
                  )}

                  {centerTitle?.interactive ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <ShellActionSurface variant="pill" className="group">
                          <Icon
                            icon={switchingPersona ? Loader2 : centerTitle.icon!}
                            size="sm"
                            className={cn(switchingPersona && "animate-spin")}
                          />
                          <span className="max-w-[120px] truncate sm:max-w-none">
                            {switchingPersona ? `Syncing...` : centerTitle.label}
                          </span>
                          {!switchingPersona && (
                            <div className={cn("h-1.5 w-1.5 rounded-full", activePersona === "ria" ? "bg-amber-500" : "bg-emerald-500")} />
                          )}
                          <ChevronDown className="h-4 w-4 opacity-40 group-hover:opacity-100" />
                        </ShellActionSurface>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="center" className="w-56 p-2">
                        <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Select Persona</DropdownMenuLabel>
                        <DropdownMenuItem className="rounded-md" onClick={() => handlePersonaSelect("investor")}>
                          <UserRound className="mr-2 h-4 w-4" /> Investor
                          {activePersona === "investor" && <Check className="ml-auto h-4 w-4" />}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="rounded-md" onClick={() => handlePersonaSelect("ria")}>
                          <BriefcaseBusiness className="mr-2 h-4 w-4" />
                          {riaCapability === "switch" ? "RIA Professional" : "Setup RIA"}
                          {activePersona === "ria" && <Check className="ml-auto h-4 w-4" />}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => router.push(ROUTES.PROFILE)}>
                          <Settings className="mr-2 h-4 w-4" /> Persona Settings
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : centerTitle && (
                    <div className={cn(TOP_SHELL_TITLE_PILL_CLASSNAME, "pointer-events-none")}>
                      {centerTitle.label}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Slot: Global Search & Notifications */}
              <div className="flex h-full shrink-0 items-center justify-end" style={{ width: "var(--top-bar-side-w)" }}>
                <div className="pointer-events-auto flex items-center gap-1.5">
                  <QuickSearch isOnline={isOnline} />

                  {showOnboardingActions ? (
                    <OnboardingRouteActions isOnline={isOnline} />
                  ) : (
                    <>
                      <ConsentInboxDropdown
                        renderTrigger={({ pendingCount }) => (
                          <ShellActionSurface variant="icon" disabled={!isOnline}>
                            <Shield className={cn("h-5 w-5", !isOnline && "opacity-30")} />
                            {pendingCount > 0 && isOnline && (
                              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-sky-500 text-[9px] text-white">
                                {pendingCount}
                              </span>
                            )}
                          </ShellActionSurface>
                        )}
                      />

                      {isVaultUnlocked ? (
                        <DebateTaskCenter
                          renderTrigger={({ activeCount, badgeCount }) => (
                            <ShellActionSurface variant="icon" disabled={!isOnline}>
                              {activeCount > 0 && isOnline ? (
                                <Loader2 className="h-5 w-5 animate-spin text-sky-500" />
                              ) : (
                                <Bell className={cn("h-5 w-5", !isOnline && "opacity-30")} />
                              )}
                              {badgeCount > 0 && isOnline && (
                                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-sky-600 text-[9px] text-white">
                                  {badgeCount}
                                </span>
                              )}
                            </ShellActionSurface>
                          )}
                        />
                      ) : (
                        <ShellActionSurface variant="icon" disabled>
                          <Bell className="h-5 w-5 opacity-20" />
                        </ShellActionSurface>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}

/* ── Onboarding Actions Component ─────────────────────────────────── */

function OnboardingRouteActions({ isOnline }: { isOnline: boolean }) {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const onSignOut = async () => {
    try {
      setOnboardingRequiredCookie(false);
      await signOut();
      router.push(ROUTES.HOME);
    } catch {
      toast.error("Sign out failed.");
    }
  };

  const onDelete = async () => {
    if (!user?.uid || !isOnline) return;
    setLoading(true);
    try {
      const res = await resolveDeleteAccountAuth({ userId: user.uid, existingVaultOwnerToken: vaultOwnerToken ?? null });
      if (res.kind === "needs_unlock") {
        router.push(ROUTES.PROFILE);
        return;
      }
      await AccountService.deleteAccount(res.token);
      await UserLocalStateService.clearForUser(user.uid);
      toast.success("Account purged.");
      onSignOut();
    } catch {
      toast.error("Deletion failed.");
    } finally {
      setLoading(false);
      setDeleteOpen(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="none" size="icon" className="h-9 w-9 rounded-full hover:bg-black/5">
            <MoreHorizontal className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onSignOut}>
            <LogOut className="mr-2 h-4 w-4" /> Sign Out
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDeleteOpen(true)} className="text-red-600 focus:bg-red-50">
            <Trash2 className="mr-2 h-4 w-4" /> Purge Account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="max-w-[380px] rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Irreversible Action</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete your vault? This will remove all data across our servers permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Keep Account</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); onDelete(); }} disabled={loading || !isOnline} className="bg-red-600">
              {loading ? <Loader2 className="animate-spin" /> : "Delete Everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export {
  resolveTopShellHeight,
  resolveTopShellMetrics,
  shouldHideTopShell,
  shouldShowKaiTabsInTopShell,
  type TopShellMetrics,
} from "@/components/app-ui/top-shell-metrics";