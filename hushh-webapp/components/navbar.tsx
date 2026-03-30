// components/navbar.tsx
// Bottom pill navigation + onboarding theme control.

"use client";

import React, { useEffect, useMemo, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  FileSpreadsheet,
  LayoutDashboard,
  LineChart,
  Store,
  User,
  Users,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/theme-toggle";
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

type InvestorNavKey = "dashboard" | "market" | "analysis" | "profile";
type RiaNavKey = "home" | "clients" | "picks" | "profile";
type NavKey = InvestorNavKey | RiaNavKey;

export const Navbar = () => {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { isVaultUnlocked } = useVault();
  const { activePersona, primaryNavPersona } = usePersonaState();
  const pendingConsents = useConsentPendingSummaryCount();
  const pillRef = React.useRef<HTMLDivElement | null>(null);
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const useOnboardingChrome = chromeState.useOnboardingChrome;
  const preserveBottomChrome = Boolean(
    pathname?.startsWith("/ria") || pathname?.startsWith("/marketplace")
  );
  const allowScrollHide = isAuthenticated && !useOnboardingChrome && !preserveBottomChrome;
  const { hidden: hideBottomChrome, progress: hideBottomChromeProgress } = useKaiBottomChromeVisibility(allowScrollHide);

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
  const hideNavbar =
    pathname?.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    pathname === ROUTES.DEVELOPERS;

  const navOptions = useMemo<SegmentedPillOption[]>(
    () =>
      activePersona === "ria"
        ? [
            {
              value: "home",
              label: "Home",
              icon: BriefcaseBusiness,
              dataTourId: "nav-ria-home",
            },
            {
              value: "clients",
              label: "Clients",
              icon: Users,
              dataTourId: "nav-ria-clients",
            },
            {
              value: "picks",
              label: "Picks",
              icon: FileSpreadsheet,
              dataTourId: "nav-ria-picks",
            },
            {
              value: "profile",
              label: "Profile",
              icon: User,
              badge: pendingConsents > 0 ? pendingConsents : undefined,
              dataTourId: "nav-profile",
            },
          ]
        : [
            {
              value: "dashboard",
              label: "Portfolio",
              icon: LayoutDashboard,
              dataTourId: "nav-portfolio",
            },
            {
              value: "market",
              label: "Market",
              icon: Store,
              dataTourId: "nav-market",
            },
            {
              value: "analysis",
              label: "Analysis",
              icon: LineChart,
              dataTourId: "nav-analysis",
            },
            {
              value: "profile",
              label: "Profile",
              icon: User,
              badge: pendingConsents > 0 ? pendingConsents : undefined,
              dataTourId: "nav-profile",
            },
          ],
    [activePersona, pendingConsents]
  );

  if (hideNavbar) {
    return null;
  }

  if (!isAuthenticated || useOnboardingChrome) {
    return (
      <nav
        className="fixed left-0 right-0 z-50 flex justify-center px-4 pointer-events-none"
        style={{
          bottom:
            "calc(max(var(--app-safe-area-bottom-effective), 0.5rem) + var(--app-bottom-chrome-lift, 0px))",
        }}
      >
        <div ref={pillRef} className="pointer-events-auto">
          <ThemeToggle className="bg-white/85 dark:bg-black/85" />
        </div>
      </nav>
    );
  }

  const normalizedPathname = pathname?.replace(/\/$/, "") || "";
  const activeNav: NavKey = normalizedPathname.startsWith(ROUTES.PROFILE)
    ? "profile"
    : normalizedPathname.startsWith(ROUTES.CONSENTS)
    ? primaryNavPersona === "ria"
      ? "home"
      : "market"
    : activePersona === "ria"
    ? activeRiaRouteTabFromPath(normalizedPathname)
    : activeKaiRouteTabFromPath(normalizedPathname);

  const navigateTo = (value: string) => {
    if (busyOperations["portfolio_save"]) {
      toast.info("Saving to vault. Please wait until encryption completes.");
      return;
    }

    const reviewDirty = Boolean(
      busyOperations["portfolio_review_active"] && busyOperations["portfolio_review_dirty"]
    );
    if (
      reviewDirty &&
      !window.confirm("You have unsaved portfolio changes. Leaving now will discard them.")
    ) {
      return;
    }

    switch (value as NavKey) {
      case "market":
        router.push(ROUTES.KAI_HOME);
        return;
      case "dashboard":
        router.push(ROUTES.KAI_DASHBOARD);
        return;
      case "analysis":
        router.push(`${ROUTES.KAI_ANALYSIS}?tab=history`);
        return;
      case "home":
        router.push(ROUTES.RIA_HOME);
        return;
      case "clients":
        router.push(ROUTES.RIA_CLIENTS);
        return;
      case "picks":
        router.push(ROUTES.RIA_PICKS);
        return;
      case "profile":
        router.push(ROUTES.PROFILE);
        return;
      default:
        return;
    }
  };

  return (
    <nav
      className={cn(
        "fixed inset-x-0 flex justify-center px-4 transform-gpu",
        isVaultUnlocked ? "z-[120]" : "z-[505]",
        "pointer-events-none"
      )}
      style={
        {
          bottom:
            "calc(max(var(--app-safe-area-bottom-effective), 0.75rem) + var(--app-bottom-chrome-lift, 0px))",
          transform:
            "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)",
          "--bottom-chrome-progress": String(hideBottomChromeProgress),
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "relative w-full max-w-[480px]",
          "pointer-events-none",
          hideBottomChrome && "pointer-events-none"
        )}
      >
        <SegmentedPill
          ref={pillRef}
          size="compact"
          layout="stacked"
          hitArea="segment"
          value={activeNav}
          options={navOptions}
          onValueChange={navigateTo}
          ariaLabel="Main navigation"
          className={cn(
            "relative z-10 w-full chrome-bottom-foreground",
            !isVaultUnlocked &&
              "!border-border/80 !bg-background/92 !backdrop-blur-none shadow-[0_10px_22px_rgba(15,23,42,0.08)] dark:!bg-background/94"
          )}
        />
      </div>
    </nav>
  );
};
