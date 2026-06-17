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
import { ThemeToggleCompact } from "@/components/theme-toggle";
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

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const navOptions = useMemo<SegmentedPillOption[]>(() =>
    (activePersona === "ria" ? [
      { value: "home", label: "Home", icon: House },
      { value: "clients", label: "Clients", icon: Users },
      { value: "picks", label: "Picks", icon: FileSpreadsheet },
      { value: "connect", label: "Connect", icon: Compass },
      { value: "profile", label: "Profile", icon: CircleUserRound, badge: pendingConsents > 0 ? pendingConsents : undefined },
    ] : [
      { value: "market", label: "Market", icon: ChartNoAxesColumnIncreasing },
      { value: "dashboard", label: "Portfolio", icon: BriefcaseBusiness },
      { value: "analysis", label: "Analysis", icon: ChartNoAxesCombined },
      { value: "connect", label: "Connect", icon: Network },
      { value: "profile", label: "Profile", icon: UserRound, badge: pendingConsents > 0 ? pendingConsents : undefined },
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
    switch (value) {
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

  if ((isAuthenticated && chromeState.hideBottomNav) || agentPopover?.expanded) return null;

  return (
    <nav className={cn("fixed inset-x-0 flex justify-center px-4 transition-all duration-300", isVaultUnlocked ? "z-[120]" : "z-[505]", isScrolled && "opacity-90 scale-[0.98]")} style={{ bottom: "calc(max(var(--app-safe-area-bottom-effective), 0.625rem))", "--bottom-chrome-progress": String(hideBottomChromeProgress) } as CSSProperties}>
      <div className="w-full max-w-[560px]">
        <SegmentedPill
          ref={pillRef}
          // Cast to any to bypass strict type check if the UI library definition is outdated
          size={(isScrolled ? "xs" : "compact") as any}
          layout="stacked"
          value={activeNav}
          options={navOptions}
          onValueChange={navigateTo}
          className="kai-bottom-nav-pill shadow-2xl"
        />
      </div>
    </nav>
  );
};