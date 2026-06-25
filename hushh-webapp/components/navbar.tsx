// components/navbar.tsx
// Bottom pill navigation + onboarding theme control.

"use client";

import React, { useEffect, useMemo, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  ChartSpline,
  ChartCandlestick,
  CircleUserRound,
  Compass,
  Database,
  FileSpreadsheet,
  FolderSearch,
  LayoutDashboard,
  Mail,
  MailCheck,
  MapPin,
  Search as SearchIcon,
  ShieldCheck,
  Users,
  WalletCards,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { ThemeToggleLean } from "@/components/theme-toggle";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import {
  Icon,
  SegmentedPill,
  type SegmentedPillOption,
} from "@/lib/morphy-ux/ui";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useVault } from "@/lib/vault/vault-context";
import {
  normalizeBottomNavPathname,
  resolveBottomNavActiveKey,
  resolveBottomNavAction,
  resolveBottomNavigationScope,
  resolveBottomNavOptionKeys,
  type AppBottomNavScope,
  type AppBottomNavKey,
} from "@/lib/navigation/app-bottom-nav";
import {
  openKaiCommandBar,
  toggleKaiCommandBar,
} from "@/lib/navigation/kai-command-bar-events";

const BOTTOM_NAV_MAX_SLOT_COUNT = 5;
const BOTTOM_NAV_SLOT_WIDTH_REM = 5.4;
const BOTTOM_NAV_SEARCH_BUBBLE_WIDTH = "70px";
const BOTTOM_NAV_EMPTY_GROUP_WIDTH = "58px";

function resolveBottomNavMaxWidth(count: number): string {
  const slotCount = Math.min(Math.max(count, 1), BOTTOM_NAV_MAX_SLOT_COUNT);
  return `${slotCount * BOTTOM_NAV_SLOT_WIDTH_REM}rem`;
}

const BOTTOM_NAV_OPTION_META: Record<
  AppBottomNavKey,
  Omit<SegmentedPillOption, "badge">
> = {
  dashboard: {
    value: "dashboard",
    label: "One",
    icon: LayoutDashboard,
    dataTourId: "nav-one-dashboard",
  },
  finance: {
    value: "finance",
    label: "Market",
    icon: ChartCandlestick,
    dataTourId: "nav-market",
  },
  portfolio: {
    value: "portfolio",
    label: "Portfolio",
    icon: WalletCards,
    dataTourId: "nav-portfolio",
  },
  analysis: {
    value: "analysis",
    label: "Analysis",
    icon: ChartSpline,
    dataTourId: "nav-analysis",
  },
  connect: {
    value: "connect",
    label: "Connect",
    icon: Compass,
    dataTourId: "nav-connect",
  },
  "ria-home": {
    value: "ria-home",
    label: "RIA",
    icon: BriefcaseBusiness,
    dataTourId: "nav-ria-home",
  },
  clients: {
    value: "clients",
    label: "Clients",
    icon: Users,
    dataTourId: "nav-ria-clients",
  },
  picks: {
    value: "picks",
    label: "Picks",
    icon: FileSpreadsheet,
    dataTourId: "nav-ria-picks",
  },
  gmail: {
    value: "gmail",
    label: "Gmail",
    icon: Mail,
    dataTourId: "nav-one-gmail",
  },
  email: {
    value: "email",
    label: "Email",
    icon: MailCheck,
    dataTourId: "nav-one-email",
  },
  location: {
    value: "location",
    label: "Location",
    icon: MapPin,
    dataTourId: "nav-one-location",
  },
  guardian: {
    value: "guardian",
    label: "Consent",
    icon: ShieldCheck,
    dataTourId: "nav-one-consent",
  },
  pkm: {
    value: "pkm",
    label: "PKM",
    icon: FolderSearch,
    dataTourId: "nav-one-pkm",
  },
  connected: {
    value: "connected",
    label: "Systems",
    icon: Database,
    dataTourId: "nav-one-systems",
  },
  search: {
    value: "search",
    label: "Search",
    dataTourId: "nav-search",
  },
  profile: {
    value: "profile",
    label: "Profile",
    icon: CircleUserRound,
    dataTourId: "nav-profile",
  },
};

function navOptionForKey(
  key: AppBottomNavKey,
  pendingConsents: number,
): SegmentedPillOption {
  const option = BOTTOM_NAV_OPTION_META[key];
  return {
    ...option,
    badge:
      (key === "guardian" || key === "profile") && pendingConsents > 0
        ? pendingConsents
        : undefined,
  };
}

export const Navbar = () => {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { isVaultUnlocked } = useVault();
  const agentPopover = useOptionalAgentPopover();
  const { activePersona } = usePersonaState();
  const pendingConsents = useConsentPendingSummaryCount();
  const pillRef = React.useRef<HTMLDivElement | null>(null);
  const bottomChromeVarsRef = React.useRef({
    fixedUi: "",
    routeGroupWidth: "",
  });
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const useOnboardingChrome = chromeState.useOnboardingChrome;
  // The bottom pill + search bubble scroll-hide in reverse of the top app bar:
  // on scroll-down they translate off the bottom edge (max main-body viewing),
  // on scroll-up they slide back in. Driven by the same shared visibility store
  // as the top bar and the bottom fade glass so all chrome stays in lockstep.
  // Disabled while onboarding chrome is active (that flow owns its own chrome).
  const allowScrollHide = !useOnboardingChrome;
  const { hidden: hideBottomChrome, progress: hideBottomChromeProgress } =
    useKaiBottomChromeVisibility(allowScrollHide);

  const busyOperations = useKaiSession((s) => s.busyOperations);
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  const navigationScope = useMemo<AppBottomNavScope>(() => {
    return resolveBottomNavigationScope(normalizedPathname, activePersona);
  }, [activePersona, normalizedPathname]);

  useEffect(() => {
    if (!pathname) return;
    if (
      pathname.startsWith(ROUTES.KAI_HOME) ||
      pathname.startsWith(ROUTES.LEGACY_KAI_HOME)
    ) {
      useKaiSession.getState().setLastKaiPath(pathname);
      return;
    }
    if (pathname.startsWith("/ria")) {
      useKaiSession.getState().setLastRiaPath(pathname);
    }
  }, [pathname]);
  const agentWindowOpen =
    agentPopover?.expanded || agentPopover?.motionState === "opening";
  const portfolioImportSurfaceActive = Boolean(
    busyOperations["portfolio_import_surface"],
  );
  const hideNavbar =
    agentWindowOpen ||
    portfolioImportSurfaceActive ||
    pathname?.startsWith(ROUTES.PHONE_MANDATE) ||
    pathname?.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    pathname === ROUTES.DEVELOPERS;

  const navOptions = useMemo<SegmentedPillOption[]>(() => {
    const keys = resolveBottomNavOptionKeys(
      normalizedPathname,
      navigationScope,
    );
    return keys.map((key) => navOptionForKey(key, pendingConsents));
  }, [navigationScope, normalizedPathname, pendingConsents]);

  React.useLayoutEffect(() => {
    const root = document.documentElement;
    const setBottomChromeVars = (fixedUi: string, routeGroupWidth: string) => {
      const previous = bottomChromeVarsRef.current;
      if (previous.fixedUi !== fixedUi) {
        root.style.setProperty("--app-bottom-fixed-ui", fixedUi);
        previous.fixedUi = fixedUi;
      }
      if (previous.routeGroupWidth !== routeGroupWidth) {
        root.style.setProperty(
          "--app-bottom-route-group-width",
          routeGroupWidth,
        );
        previous.routeGroupWidth = routeGroupWidth;
      }
    };

    if (!isAuthenticated || useOnboardingChrome || navOptions.length === 0) {
      setBottomChromeVars("0px", "58px");
      return;
    }

    const el = pillRef.current;
    if (!el) {
      setBottomChromeVars("0px", "58px");
      return;
    }

    const BOTTOM_GAP_PX = 14;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const height = Math.max(0, rect.height);
      const px = Math.round(height + BOTTOM_GAP_PX);
      setBottomChromeVars(`${px}px`, `${Math.round(rect.width)}px`);
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
  }, [isAuthenticated, navOptions.length, useOnboardingChrome]);

  const bottomNavMaxWidth =
    navOptions.length > 0 ? resolveBottomNavMaxWidth(navOptions.length) : "0px";
  const bottomNavWidth =
    navOptions.length > 0
      ? `min(calc(100vw - 6rem), ${bottomNavMaxWidth})`
      : "0px";
  const bottomNavGroupWidth =
    navOptions.length > 0
      ? `min(calc(100vw - 2rem), calc(${bottomNavMaxWidth} + ${BOTTOM_NAV_SEARCH_BUBBLE_WIDTH}))`
      : BOTTOM_NAV_EMPTY_GROUP_WIDTH;

  if (hideNavbar) {
    return null;
  }

  if (useOnboardingChrome) {
    return null;
  }

  if (!isAuthenticated) {
    return (
      <nav
        className="fixed right-0 top-0 z-50 flex justify-end px-4 pointer-events-none"
        style={{
          top: "calc(max(var(--app-safe-area-top-effective), 0.5rem))",
        }}
      >
        <div ref={pillRef} className="pointer-events-auto">
          <ThemeToggleLean className="w-[162px] sm:w-[240px]" />
        </div>
      </nav>
    );
  }

  if (navOptions.length === 0) {
    return null;
  }

  const activeNav = resolveBottomNavActiveKey(
    normalizedPathname,
    navigationScope,
  );

  const navigateTo = (value: string) => {
    if (busyOperations["portfolio_save"]) {
      toast.info("Saving to vault. Please wait until encryption completes.");
      return;
    }

    const reviewDirty = Boolean(
      busyOperations["portfolio_review_active"] &&
      busyOperations["portfolio_review_dirty"],
    );
    if (
      reviewDirty &&
      !window.confirm(
        "You have unsaved portfolio changes. Leaving now will discard them.",
      )
    ) {
      return;
    }

    const action = resolveBottomNavAction(
      value as AppBottomNavKey,
      navigationScope,
    );
    if (action.type === "command") {
      openKaiCommandBar();
      return;
    }
    if (action.type === "route") router.push(action.href);
  };

  return (
    <nav
      className={cn(
        "fixed inset-x-0 flex justify-center px-4 transform-gpu",
        isVaultUnlocked ? "z-[120]" : "z-[505]",
        "pointer-events-none",
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
          "relative flex items-end justify-center gap-2",
          "pointer-events-none",
          hideBottomChrome && "pointer-events-none",
        )}
        style={{ width: bottomNavGroupWidth }}
        ref={pillRef}
      >
        <div
          className="min-w-0 pointer-events-auto"
          style={{ width: bottomNavWidth }}
        >
          <SegmentedPill
            size="compact"
            layout="stacked"
            hitArea="segment"
            value={activeNav}
            options={navOptions}
            onValueChange={navigateTo}
            ariaLabel="Route navigation"
            className={cn(
              "kai-bottom-nav-pill relative z-10 w-full chrome-bottom-foreground",
              // Lean flat track matching the search button + top app bar
              // (ShellActionSurface): soft translucent surface, no shadow/blur.
              "bg-black/[0.05] shadow-none backdrop-blur-none dark:bg-white/[0.07]",
              "[&_[aria-checked=true]]:text-primary [&_[data-segment-indicator]]:bg-primary/10 [&_[data-segment-indicator]]:shadow-sm",
            )}
          />
        </div>
        <button
          type="button"
          aria-label="Search"
          className={cn(
            "pointer-events-auto relative z-20 inline-flex h-[58px] w-[58px] shrink-0 items-center justify-center overflow-hidden rounded-full",
            // Flat surface matching the top app bar controls (ShellActionSurface):
            // soft translucent track, no border/shadow/blur, symmetric in light + dark.
            "bg-black/[0.05] text-[#1d1d1f] dark:bg-white/[0.07] dark:text-[#f5f5f7]",
            "transition-[color,transform,background-color] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)]",
            "hover:bg-black/[0.08] hover:text-primary dark:hover:bg-white/[0.1] active:scale-90 chrome-bottom-foreground",
          )}
          onClick={() => {
            if (busyOperations["portfolio_save"]) {
              toast.info(
                "Saving to vault. Please wait until encryption completes.",
              );
              return;
            }
            toggleKaiCommandBar();
          }}
        >
          <Icon icon={SearchIcon} size="md" className="shrink-0" />
        </button>
      </div>
    </nav>
  );
};
