// components/navbar.tsx
// Bottom pill navigation + onboarding theme control.

"use client";

import React, { useEffect, useMemo, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import {
  Compass as PhosphorCompass,
  MagnifyingGlass,
  SquaresFour,
  type IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";
import {
  BriefcaseBusiness,
  ChartSpline,
  ChartCandlestick,
  CircleUserRound,
  Database,
  FileSpreadsheet,
  FolderSearch,
  Mail,
  MapPin,
  Newspaper,
  ShieldCheck,
  Store,
  Users,
  WalletCards,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { useFeedUnreadCount } from "@/lib/feed/use-feed-unread-count";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { SegmentedPill, type SegmentedPillOption } from "@/lib/morphy-ux/ui";
import { KAI_MARKET_PATH, ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { useVault } from "@/lib/vault/vault-context";
import {
  normalizeBottomNavPathname,
  resolveBottomNavActiveKey,
  resolveBottomNavAction,
  resolveBottomNavigationScope,
  resolveBottomNavOptionKeys,
  resolveBottomNavSpecialistOptionKeys,
  type AppBottomNavKey,
} from "@/lib/navigation/app-bottom-nav";
import { resolveAgentNavigationContextForPath } from "@/lib/navigation/agent-sections";
import { openKaiCommandBar } from "@/lib/navigation/kai-command-bar-events";
import { useInteractionIntents } from "@/lib/interaction/interaction-intent-coordinator";

function FilledSquaresFourIcon(props: PhosphorIconProps) {
  return <SquaresFour {...props} weight="fill" />;
}

function FilledCompassIcon(props: PhosphorIconProps) {
  return <PhosphorCompass {...props} weight="fill" />;
}

function FilledMagnifyingGlassIcon(props: PhosphorIconProps) {
  return <MagnifyingGlass {...props} weight="fill" />;
}

const BOTTOM_NAV_OPTION_META: Record<
  AppBottomNavKey,
  Omit<SegmentedPillOption, "badge">
> = {
  dashboard: {
    value: "dashboard",
    label: "One",
    icon: SquaresFour,
    activeIcon: FilledSquaresFourIcon,
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
    icon: PhosphorCompass,
    activeIcon: FilledCompassIcon,
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
    label: "KYC",
    icon: ShieldCheck,
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
  feed: {
    value: "feed",
    label: "Feed",
    icon: Newspaper,
    dataTourId: "nav-one-feed",
  },
  pkm: {
    value: "pkm",
    label: "Memory",
    icon: FolderSearch,
    dataTourId: "nav-one-pkm",
  },
  marketplace: {
    value: "marketplace",
    label: "Market",
    icon: Store,
    dataTourId: "nav-one-marketplace",
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
    icon: MagnifyingGlass,
    activeIcon: FilledMagnifyingGlassIcon,
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
  feedUnreadCount: number,
): SegmentedPillOption {
  const option = BOTTOM_NAV_OPTION_META[key];
  // Feed is the single notification home in the persistent navigation. Its
  // live "Needs you" section includes pending consent requests, while its
  // chronological section owns unread Feed events. Consent is not currently a
  // feed_events writer, so these are disjoint counts.
  let badge: number | undefined;
  if (key === "feed") {
    const feedNotificationCount = pendingConsents + feedUnreadCount;
    if (feedNotificationCount > 0) {
      badge = feedNotificationCount;
    }
  }
  return { ...option, badge };
}

export const Navbar = ({
  shellNavigationHidden = false,
  layout = "fixed",
}: {
  /** Route-derived shell state; keeps route chrome out of individual pages. */
  shellNavigationHidden?: boolean;
  /** AppBottomShell owns positioning and motion for the persistent slot. */
  layout?: "fixed" | "slot";
}) => {
  const pathname = usePathname();
  const interactionIntents = useInteractionIntents();
  const { isAuthenticated } = useAuth();
  const { isVaultUnlocked } = useVault();
  const agentPopover = useOptionalAgentPopover();
  // Hoisted above the two badge hooks so it can gate them. It depends only on
  // `pathname`, so this is a pure reorder.
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const useOnboardingChrome = chromeState.useOnboardingChrome;
  // THE NAV IS HIDDEN ON EVERY SETUP SURFACE, SO ITS BADGES MUST NOT FETCH.
  //
  // `useSessionChromeSuppression` hides the chrome by setting a DOM attribute;
  // every component under it stays mounted and every request still goes out. On a
  // brand-new person's first paint that put `/api/consent/center/summary` and
  // `/api/one/feed/unread-count` into a pool of four connections alongside the
  // calls the setup gate actually needs -- and the summary was measured at
  // 125,614 ms. Two badges nobody could see were a material share of why the
  // front door did not open.
  // Two conditions, and the second is the one that actually fires during the
  // post-login window: the route says "setup surface", and the shell says "I am
  // still deciding". The URL lags the rendered surface across the redirect, so
  // the route check alone measured NO effect on the fan-out it was written for.
  const chromeSuppressed = useSessionChromeSuppressed();
  const badgesAreVisible = !useOnboardingChrome && !chromeSuppressed;
  const pendingConsents = useConsentPendingSummaryCount({ enabled: badgesAreVisible });
  const feedUnreadCount = useFeedUnreadCount({ enabled: badgesAreVisible });
  const pillRef = React.useRef<HTMLDivElement | null>(null);
  const bottomChromeVarsRef = React.useRef({
    fixedUi: "",
    routeGroupWidth: "",
  });

  const busyOperations = useKaiSession((s) => s.busyOperations);
  const setAgentNavigationContext = useKaiSession(
    (s) => s.setAgentNavigationContext,
  );
  const normalizedPathname = normalizeBottomNavPathname(pathname);

  useEffect(() => {
    if (!pathname) return;
    const agentContext = resolveAgentNavigationContextForPath(pathname);
    if (agentContext) {
      setAgentNavigationContext(agentContext);
    }
    if (
      pathname.startsWith(KAI_MARKET_PATH) ||
      pathname.startsWith(ROUTES.LEGACY_KAI_HOME)
    ) {
      useKaiSession.getState().setLastKaiPath(pathname);
      return;
    }
    if (pathname.startsWith("/ria")) {
      // Never record the onboarding wizard as the RIA entry path — otherwise an
      // established advisor who opens onboarding once (e.g. via profile "Edit
      // licence") gets sent back into the wizard on every later RIA open,
      // overriding the correct riaEntryRoute (switch → RIA_PROFILE) and causing the
      // onboarding→profile flash.
      const isOnboardingRoute =
        pathname === ROUTES.RIA_ONBOARDING ||
        pathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`);
      if (!isOnboardingRoute) {
        useKaiSession.getState().setLastRiaPath(pathname);
      }
    }
  }, [pathname, setAgentNavigationContext]);
  const agentWindowOpen =
    agentPopover?.expanded || agentPopover?.motionState === "opening";
  const portfolioImportSurfaceActive = Boolean(
    busyOperations["portfolio_import_surface"],
  );
  const hideNavbar =
    agentWindowOpen ||
    portfolioImportSurfaceActive ||
    pathname?.startsWith(ROUTES.PHONE_MANDATE) ||
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.RESEARCH ||
    Boolean(pathname?.startsWith(`${ROUTES.RESEARCH}/`)) ||
    pathname === ROUTES.BLOG ||
    Boolean(pathname?.startsWith(`${ROUTES.BLOG}/`));

  const bottomNavScope = useMemo(
    () => resolveBottomNavigationScope(normalizedPathname, null),
    [normalizedPathname],
  );

  const navOptions = useMemo<SegmentedPillOption[]>(() => {
    const keys = resolveBottomNavOptionKeys(normalizedPathname, bottomNavScope);
    return keys.map((key) =>
      navOptionForKey(key, pendingConsents ?? 0, feedUnreadCount ?? 0),
    );
  }, [normalizedPathname, bottomNavScope, pendingConsents, feedUnreadCount]);

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

    // When the bottom nav is genuinely gone for this context (unauthenticated,
    // onboarding chrome, no nav options, or explicitly hidden by the shell), 
    // collapse the reserved height to 0.
    if (
      !isAuthenticated ||
      useOnboardingChrome ||
      navOptions.length === 0 ||
      shellNavigationHidden ||
      hideNavbar
    ) {
      setBottomChromeVars("0px", "58px");
      return;
    }

    const el = pillRef.current;
    if (!el) {
      // The navbar is temporarily unmounted (e.g. the agent window is open, which
      // also hides the agent bar that consumes --app-bottom-fixed-ui). Do NOT
      // zero the reserved height here: when the agent window closes the navbar
      // remounts but this effect's other deps are unchanged, so it would not
      // re-measure and the stale 0px would collapse the agent bar onto the nav.
      // Preserve the last measured value until a real measurement runs.
      return;
    }

    const BOTTOM_GAP_PX = 4;

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
    // `agentWindowOpen` is included so the pill is re-measured when the navbar
    // remounts after the agent window closes (otherwise --app-bottom-fixed-ui
    // stays stale and the agent bar overlaps the nav).
  }, [
    agentWindowOpen,
    isAuthenticated,
    navOptions.length,
    useOnboardingChrome,
    hideNavbar,
    shellNavigationHidden,
  ]);

  const bottomNavWidth =
    navOptions.length > 0
      ? "min(calc(100vw - 1.5rem), var(--app-bottom-shell-max-width))"
      : "0px";
  const routeActiveNav = resolveBottomNavActiveKey(
    normalizedPathname,
    bottomNavScope,
  );
  const optimisticNav = useMemo(() => {
    const pendingTarget = [...interactionIntents]
      .reverse()
      .find(
        (intent) =>
          intent.kind === "navigation" &&
          (intent.status === "accepted" || intent.status === "committing") &&
          intent.target,
      )?.target;
    if (!pendingTarget) return null;
    return (
      navOptions.find((option) => {
        const action = resolveBottomNavAction(
          option.value as AppBottomNavKey,
          resolveBottomNavSpecialistOptionKeys(bottomNavScope).includes(
            option.value as AppBottomNavKey,
          )
            ? bottomNavScope
            : "one",
        );
        return action.type === "route" && action.href === pendingTarget;
      })?.value ?? null
    );
  }, [bottomNavScope, interactionIntents, navOptions]);
  const activeNav = (optimisticNav ?? routeActiveNav) as AppBottomNavKey;

  if (shellNavigationHidden || hideNavbar) {
    return null;
  }

  if (useOnboardingChrome) {
    return null;
  }

  if (!isAuthenticated) {
    // On the signed-out onboarding flow the theme control is infused INSIDE the
    // agent bar (see agent-bar.tsx), so no separate top/bottom toggle renders
    // here. Keeping the hero completely clean.
    return null;
  }

  if (navOptions.length === 0) {
    return null;
  }

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

    const key = value as AppBottomNavKey;
    const action = resolveBottomNavAction(
      key,
      resolveBottomNavSpecialistOptionKeys(bottomNavScope).includes(key)
        ? bottomNavScope
        : "one",
    );
    if (action.type === "command") {
      openKaiCommandBar();
      return;
    }
    if (action.type === "route") {
      const nextAgentContext = resolveAgentNavigationContextForPath(
        action.href,
      );
      if (nextAgentContext) {
        setAgentNavigationContext(nextAgentContext);
      }
      requestInternalAppNavigation({
        href: action.href,
        scroll: false,
        source: "tap",
      });
    }
  };

  return (
    <nav
      data-app-bottom-nav
      data-ui-role="bottom-tab-bar"
      data-ambient-chrome-ignore
      className={cn(
        layout === "slot"
          ? "flex w-full justify-center"
          : "fixed inset-x-0 flex justify-center px-4 transform-gpu",
        layout === "fixed" && (isVaultUnlocked ? "z-[120]" : "z-[505]"),
        // No breakpoint gate here. The bottom pill IS the primary navigation on
        // every viewport — there is no desktop/sidebar nav that takes over at
        // `lg`, so hiding it above 1024px leaves signed-in users with no way to
        // reach One / Connect / Feed / Search at all.
        "pointer-events-none",
      )}
      style={
        layout === "fixed"
          ? ({
              bottom:
                "calc(max(var(--app-safe-area-bottom-effective), 0.625rem) + var(--app-bottom-chrome-lift, 0px))",
            } as CSSProperties)
          : undefined
      }
    >
      <div
        data-testid="app-bottom-nav-frame"
        className="pointer-events-none mx-auto flex w-full justify-center"
        style={{
          maxWidth:
            "min(calc(100vw - 1.5rem), var(--app-bottom-shell-max-width))",
        }}
      >
        <div
          className={cn(
            "relative flex items-stretch justify-center gap-2",
            "pointer-events-none",
          )}
          style={{ maxWidth: "calc(100vw - 2rem)" }}
          ref={pillRef}
        >
          <div
            className="min-w-0 pointer-events-auto"
            style={{ width: bottomNavWidth }}
          >
            <SegmentedPill
              size="default"
              layout="stacked"
              hitArea="segment"
              value={activeNav}
              options={navOptions}
              onValueChange={navigateTo}
              ariaLabel="Route navigation"
              className={cn(
                "kai-bottom-nav-pill relative z-10 w-full chrome-bottom-foreground",
                "[&_[aria-checked=true]]:text-[color:var(--app-accent)] [&_[aria-checked=true]]:font-medium",
                "[&_[data-segment-indicator]]:bg-transparent [&_[data-segment-indicator]]:shadow-none [&_[data-segment-indicator]]:backdrop-blur-none",
              )}
            />
          </div>
        </div>
      </div>
    </nav>
  );
};
