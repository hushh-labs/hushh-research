"use client";

import * as React from "react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  ChartNoAxesColumnIncreasing,
  ChartNoAxesCombined,
  CircleUserRound,
  Compass,
  FileSpreadsheet,
  House,
  Network,
  UserRound,
  Users,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { SegmentedPill, type SegmentedPillOption } from "@/lib/morphy-ux/ui";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { activeKaiRouteTabFromPath } from "@/lib/navigation/kai-route-tabs";
import { activeRiaRouteTabFromPath } from "@/lib/navigation/ria-route-tabs";
import { useVault } from "@/lib/vault/vault-context";
import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { ThemeToggleCompact } from "@/components/theme-toggle";

type InvestorNavKey = "dashboard" | "market" | "connect" | "analysis" | "profile";
type RiaNavKey = "home" | "clients" | "connect" | "picks" | "profile";
type NavKey = InvestorNavKey | RiaNavKey;

export const Navbar = () => {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { isVaultUnlocked } = useVault();
  const agentPopover = useOptionalAgentPopover();
  const { activePersona } = usePersonaState();
  const pendingConsents = useConsentPendingSummaryCount();
  const pillRef = React.useRef<HTMLDivElement | null>(null);

  const [isScrolled, setIsScrolled] = useState(false);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const useOnboardingChrome = chromeState.useOnboardingChrome;
  const hideBottomChromeProgress = useKaiBottomChromeVisibility(isAuthenticated && !useOnboardingChrome).progress;
  const busyOperations = useKaiSession((s) => s.busyOperations);

  React.useLayoutEffect(() => {
    const el = pillRef.current;
    if (!el) return;

    const BOTTOM_GAP_PX = isAuthenticated && !useOnboardingChrome ? 14 : 10;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const height = Math.max(0, rect.height);
      const px = Math.round(height + BOTTOM_GAP_PX);
      document.documentElement.style.setProperty("--app-bottom-fixed-ui", `${px}px`);
    };

    update();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => update())
        : null;
    ro?.observe(el);

    window.addEventListener("resize", update, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [isAuthenticated, useOnboardingChrome]);

  useEffect(() => {
    if (!pathname) return;
    if (pathname.startsWith("/kai")) {
      useKaiSession.getState().setLastKaiPath(pathname);
      return;
    }
    if (pathname.startsWith("/ria")) {
      useKaiSession.getState().setLastRiaPath(pathname);
    }
  }, [pathname]);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const hideNavbar =
    pathname === ROUTES.AGENT ||
    pathname?.startsWith(ROUTES.PHONE_MANDATE) ||
    pathname?.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    pathname === ROUTES.DEVELOPERS;
  const agentWindowOpen =
    agentPopover?.expanded || agentPopover?.motionState === "opening";
  const portfolioImportSurfaceActive = Boolean(
    busyOperations["portfolio_import_surface"]
  );

  const navOptions = useMemo<SegmentedPillOption[]>(() =>
    (activePersona === "ria" ? [
      { value: "home", label: "Home", icon: House, dataTourId: "nav-ria-home" },
      { value: "clients", label: "Clients", icon: Users, dataTourId: "nav-ria-clients" },
      { value: "picks", label: "Picks", icon: FileSpreadsheet, dataTourId: "nav-ria-picks" },
      { value: "connect", label: "Connect", icon: Compass, dataTourId: "nav-ria-connect" },
      { value: "profile", label: "Profile", icon: CircleUserRound, badge: pendingConsents > 0 ? pendingConsents : undefined, dataTourId: "nav-profile" },
    ] : [
      { value: "market", label: "Market", icon: ChartNoAxesColumnIncreasing, dataTourId: "nav-market" },
      { value: "dashboard", label: "Portfolio", icon: BriefcaseBusiness, dataTourId: "nav-portfolio" },
      { value: "analysis", label: "Analysis", icon: ChartNoAxesCombined, dataTourId: "nav-analysis" },
      { value: "connect", label: "Connect", icon: Network, dataTourId: "nav-connect" },
      { value: "profile", label: "Profile", icon: UserRound, badge: pendingConsents > 0 ? pendingConsents : undefined, dataTourId: "nav-profile" },
    ]).map(opt => ({ ...opt, label: busyOperations[opt.value] ? `${opt.label}…` : opt.label })),
    [activePersona, pendingConsents, busyOperations]
  );

  const activeNav = useMemo(() => {
    const normalizedPathname = pathname?.replace(/\/$/, "") || "";
    if (normalizedPathname.startsWith(ROUTES.PROFILE)) return "profile";
    return activePersona === "ria"
      ? activeRiaRouteTabFromPath(normalizedPathname)
      : activeKaiRouteTabFromPath(normalizedPathname);
  }, [pathname, activePersona]);

  const navigateTo = (value: string) => {
    if (busyOperations["portfolio_save"]) {
      toast.info("Saving to vault.");
      return;
    }
    switch (value as NavKey) {
      case "market": router.push(ROUTES.KAI_HOME); break;
      case "dashboard": router.push(ROUTES.KAI_DASHBOARD); break;
      case "analysis": router.push(ROUTES.KAI_ANALYSIS); break;
      case "connect": router.push(ROUTES.MARKETPLACE); break;
      case "home": router.push(ROUTES.RIA_HOME); break;
      case "clients": router.push(ROUTES.RIA_CLIENTS); break;
      case "picks": router.push(ROUTES.RIA_PICKS); break;
      case "profile": router.push(ROUTES.PROFILE); break;
      default: return;
    }
  };

  const { hidden: hideBottomChrome } = useKaiBottomChromeVisibility(false);

  if (
    hideNavbar ||
    agentWindowOpen ||
    portfolioImportSurfaceActive ||
    (isAuthenticated && chromeState.hideBottomNav)
  ) {
    return null;
  }

  if (!isAuthenticated || useOnboardingChrome) {
    return (
      <nav
        className="fixed right-0 top-0 z-50 flex justify-end px-4 pointer-events-none"
        style={{
          top: "calc(max(var(--app-safe-area-top-effective), 0.5rem))",
        }}
      >
        <div ref={pillRef} className="pointer-events-auto">
          <ThemeToggleCompact />
        </div>
      </nav>
    );
  }

  return (
    <nav
      className={cn(
        "fixed inset-x-0 flex justify-center px-4 transform-gpu transition-all duration-300",
        isVaultUnlocked ? "z-[120]" : "z-[505]",
        "pointer-events-none",
        isScrolled && "opacity-90 scale-[0.98]"
      )}
      style={
        {
          bottom:
            "calc(max(var(--app-safe-area-bottom-effective), 0.625rem) + var(--app-bottom-chrome-lift, 0px))",
          transform:
            "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)",
          "--bottom-chrome-progress": String(hideBottomChromeProgress),
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "relative flex w-full max-w-[548px] items-end gap-1",
          "pointer-events-none",
          hideBottomChrome && "pointer-events-none"
        )}
      >
        <div className="min-w-0 pointer-events-auto" style={{ width: "calc(100% - 62px)" }}>
          <SegmentedPill
            ref={pillRef}
            size={(isScrolled ? "xs" : "compact") as any}
            layout="stacked"
            hitArea="segment"
            value={activeNav}
            options={navOptions}
            onValueChange={navigateTo}
            ariaLabel="Main navigation"
            className={cn(
              "kai-bottom-nav-pill relative z-10 w-full chrome-bottom-foreground shadow-2xl"
            )}
          />
        </div>
      </div>
    </nav>
  );
};