"use client";

import { useCallback, useMemo, useState } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  APP_SHELL_FRAME_CLASSNAME,
  APP_SHELL_FRAME_STYLE,
} from "@/components/app-ui/app-page-shell";
import { Button } from "@/lib/morphy-ux/button";
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
  SHELL_PILL_TRIGGER_CLASSNAME,
} from "@/components/app-ui/shell-action-surface";
import { trackEvent, type ObservabilityEventName, type EventPayloadFor } from "@/lib/observability/client";

/* ── Helpers ───────────────────────────────────────────────────────── */
function getTopBarTitle(
  pathname: string,
  activePersona: "investor" | "ria",
): {
  label: string;
  icon?: LucideIcon;
  interactive: boolean;
} | null {
  if (pathname.startsWith(ROUTES.KAI_ONBOARDING)) {
    return { label: "Get started", interactive: false };
  }
  if (pathname.startsWith(ROUTES.RIA_ONBOARDING)) {
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

function routeForPersona(params: {
  persona: Persona;
  lastKaiPath: string;
  lastRiaPath: string;
  riaEntryRoute: string;
}) {
  return params.persona === "ria"
    ? params.lastRiaPath || params.riaEntryRoute || ROUTES.RIA_HOME
    : params.lastKaiPath || ROUTES.KAI_HOME;
}

/* ── TopAppBar ─────────────────────────────────────────────────────── */
interface TopAppBarProps {
  className?: string;
}

export function TopAppBar({ className }: TopAppBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isVaultUnlocked } = useVault();
  const { activePersona, riaCapability, riaEntryRoute, switchPersona } = usePersonaState();
  const pathname = usePathname();

  const lastKaiPath = useKaiSession((s) => s.lastKaiPath);
  const lastRiaPath = useKaiSession((s) => s.lastRiaPath);

  const topShellMetrics = useMemo(() => resolveTopShellMetrics(pathname), [pathname]);
  const topShellBreadcrumb = useMemo(() => resolveTopShellBreadcrumb(pathname, searchParams), [pathname, searchParams]);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);

  const showOnboardingActions = chromeState.useOnboardingChrome;
  const hideChrome = !topShellMetrics.shellVisible;
  const centerTitle = useMemo(() => getTopBarTitle(pathname, activePersona), [activePersona, pathname]);
  const showKaiTabs = topShellMetrics.hasTabs;

  const [switchingPersona, setSwitchingPersona] = useState<Persona | null>(null);

  const handlePersonaSelect = useCallback(
    async (target: Persona) => {
      if (target === activePersona) return;

      const isSetup = target === "ria" && riaCapability !== "switch";
      const nextRoute = routeForPersona({
        persona: target,
        lastKaiPath,
        lastRiaPath,
        riaEntryRoute,
      });

      setSwitchingPersona(target);

      try {
        if (!isSetup) {
          await switchPersona(target);
        }

        // Logic Fix: Explicitly resolve event and payload type
        const eventName = (isSetup ? "ria_setup_started" : "persona_switched") as ObservabilityEventName;

        // Assert the payload to EventPayloadFor<any> to resolve the property check error
        const payload = {
          action: isSetup ? "setup" : "switch",
          target,
          from: activePersona,
          result: "success",
        } as EventPayloadFor<typeof eventName>;

        trackEvent(eventName, payload);

        router.push(nextRoute);
      } catch (error) {
        console.error("[Hushh] Failed to switch persona:", error);
        toast.error("Couldn't switch roles right now. Please retry.");
      } finally {
        setSwitchingPersona(null);
      }
    },
    [activePersona, lastKaiPath, lastRiaPath, riaCapability, riaEntryRoute, router, switchPersona]
  );

  const { progress: tabsScrollHideProgress } = useKaiBottomChromeVisibility(showKaiTabs);

  const topGlassStyle = useMemo<React.CSSProperties>(() => ({
    "--top-glass-dynamic-h": showKaiTabs
      ? `calc(var(--top-inset) + var(--top-bar-h) + ((1 - ${tabsScrollHideProgress}) * var(--top-tabs-h)) + var(--top-fade-active))`
      : "var(--top-shell-visual-height)",
    "--app-bar-glass-bg-light": "rgba(245, 245, 247, 0.76)",
    "--app-bar-glass-bg-dark": "rgba(28, 28, 30, 0.76)",
    "--app-bar-glass-blur": "6px",
  } as React.CSSProperties), [showKaiTabs, tabsScrollHideProgress]);

  if (hideChrome) return null;

  return (
    <div className={cn("fixed inset-x-0 top-0 z-50 pointer-events-none", className)}>
      <div
        className="pointer-events-none relative w-full overflow-visible"
        style={{ height: "var(--top-shell-reserved-height)" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 transition-[height] duration-200 ease-out"
          style={{ height: "var(--top-glass-dynamic-h)", ...topGlassStyle } as React.CSSProperties}
        >
          <div className="h-full w-full bar-glass bar-glass-top" />
        </div>

        <div className={cn(APP_SHELL_FRAME_CLASSNAME, "pointer-events-none relative flex h-full w-full flex-col justify-end")} style={APP_SHELL_FRAME_STYLE}>
          <div className="pointer-events-none relative h-[var(--top-bar-h)] w-full shrink-0 flex items-center px-4">

            <div className="pointer-events-none flex h-full shrink-0 items-center justify-start" style={{ width: "var(--top-bar-side-w)" }}>
              {topShellBreadcrumb && (
                <ShellActionSurface variant="icon" className="pointer-events-auto" onClick={() => router.push(topShellBreadcrumb.backHref)}>
                  <ArrowLeft className="h-5 w-5" />
                </ShellActionSurface>
              )}
            </div>

            <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center">
              {centerTitle?.interactive ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ShellActionSurface variant="pill" className="pointer-events-auto">
                      <Icon icon={switchingPersona ? Loader2 : centerTitle.icon!} size="sm" className={cn(switchingPersona && "animate-spin")} />
                      <span className="truncate">{switchingPersona ? `Switching...` : centerTitle.label}</span>
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                    </ShellActionSurface>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="min-w-[200px]">
                    <DropdownMenuItem onClick={() => handlePersonaSelect("investor")}>
                      <UserRound className="h-4 w-4 mr-2" /> Investor {activePersona === "investor" && <Check className="ml-auto h-4 w-4" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handlePersonaSelect("ria")}>
                      <BriefcaseBusiness className="h-4 w-4 mr-2" /> {riaCapability === "switch" ? "RIA" : "Set up RIA"} {activePersona === "ria" && <Check className="ml-auto h-4 w-4" />}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : centerTitle ? (
                <div className={cn(SHELL_PILL_TRIGGER_CLASSNAME, "pointer-events-auto")}>
                  {centerTitle.icon && <Icon icon={centerTitle.icon} size="sm" className="mr-2" />}
                  <span className="truncate">{centerTitle.label}</span>
                </div>
              ) : null}
            </div>

            <div className="pointer-events-none flex h-full shrink-0 items-center justify-end" style={{ width: "var(--top-bar-side-w)" }}>
              <div className="pointer-events-auto flex items-center gap-2">
                {showOnboardingActions ? <OnboardingRouteActions /> : (
                  <>
                    <ConsentInboxDropdown renderTrigger={({ pendingCount }) => (
                      <ShellActionSurface variant="icon" badge={pendingCount > 0 ? pendingCount : undefined}><Shield className="h-5 w-5" /></ShellActionSurface>
                    )} />
                    {isVaultUnlocked ? (
                      <DebateTaskCenter renderTrigger={({ activeCount, badgeCount }) => (
                        <ShellActionSurface variant="icon" badge={badgeCount > 0 ? badgeCount : undefined}>
                          {activeCount > 0 ? <Loader2 className="h-5 w-5 animate-spin text-sky-500" /> : <Bell className="h-5 w-5" />}
                        </ShellActionSurface>
                      )} />
                    ) : (
                      <ShellActionSurface variant="icon" disabled><Bell className="h-5 w-5 opacity-40" /></ShellActionSurface>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OnboardingRouteActions() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleSignOut = async () => {
    try {
      await signOut();
      setOnboardingRequiredCookie(false);
      setOnboardingFlowActiveCookie(false);
      router.push(ROUTES.HOME);
    } catch (error) {
      console.error("[Hushh] Sign-out failed:", error);
      toast.error("Sign-out failed.");
    }
  };

  const handleDeleteAccount = async () => {
    if (!user?.uid) return;
    setIsDeleting(true);
    try {
      const res = await resolveDeleteAccountAuth({ userId: user.uid, existingVaultOwnerToken: vaultOwnerToken ?? null });
      if (res.kind === "needs_unlock") {
        toast.error("Unlock vault to delete account.");
        router.push(ROUTES.PROFILE);
        return;
      }
      await AccountService.deleteAccount(res.token);
      await UserLocalStateService.clearForUser(user.uid);
      await handleSignOut();
    } catch (error) {
      console.error("[Hushh] Delete failed:", error);
      toast.error("Account deletion failed.");
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="none" size="icon" className="h-9 w-9 rounded-full"><MoreHorizontal className="h-5 w-5" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleSignOut}><LogOut className="h-4 w-4 mr-2" /> Sign out</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDeleteConfirmOpen(true)} className="text-red-600"><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete account?</AlertDialogTitle></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); handleDeleteAccount(); }} className="bg-red-600" disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}