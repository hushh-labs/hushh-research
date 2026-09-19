"use client";

/**
 * Unified Client Providers
 *
 * Wraps all client-side providers in a single "use client" boundary
 * to ensure proper hydration and avoid server/client mismatch issues.
 *
 * Uses StepProgressProvider for step-based loading progress tracking.
 * Pages register their loading steps and the progress bar shows real progress.
 *
 * CacheProvider enables data sharing across page navigations to reduce API calls.
 */

import {
  CSSProperties,
  ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AuthProvider } from "@/lib/firebase";
import { ContactInvitationSessionProvider } from "@/components/connections/contact-invitation-session-provider";
import { VaultProvider } from "@/lib/vault/vault-context";
import { StepProgressProvider } from "@/lib/progress/step-progress-context";
import { StepProgressBar } from "@/components/app-ui/step-progress-bar";
import { CacheProvider } from "@/lib/cache/cache-context";
import { useDeepLinkReturn } from "@/lib/navigation/use-deep-link-return";
import { ConsentNotificationProvider } from "@/components/consent/notification-provider";
import { GlobalVoiceActionHandlers } from "@/components/agent/global-voice-action-handlers";
import { GlobalConsentActionHandlers } from "@/components/agent/global-consent-action-handlers";
import { ConsentSheetProvider } from "@/components/consent/consent-sheet-controller";
import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";
import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { AppTopShell } from "@/components/app-ui/top-app-bar";
import { AppEdgeBackGesture } from "@/components/app-ui/app-edge-back-gesture";
import { AppProfileEdgeGesture } from "@/components/app-ui/app-profile-edge-gesture";
import { ProfilePane } from "@/components/app-ui/profile-pane";
import { TopShellRouteSwipe } from "@/components/app-ui/top-shell-route-swipe";
import { AgentRuntimeStateProvider } from "@/lib/agent/agent-runtime-context";
import { SiriOneVoiceHandoff } from "@/components/agent/siri-one-voice-handoff";
import { SiriOneRequestHandoff } from "@/components/agent/siri-one-request-handoff";
import { SiriOneActionHandoff } from "@/components/agent/siri-one-action-handoff";
import { SiriOneEntityIndexPublisher } from "@/components/agent/siri-one-entity-index-publisher";
import { AgentVoiceEdgeGlow } from "@/components/agent/agent-voice-edge-glow";
import { OneLocationInteractionSurfaceProvider } from "@/components/one-location/onboarding/location-onboarding-interaction-surface";
import { FoundationPublicAmbient } from "@/components/app-ui/foundation-public-ambient";
import { AgentOwnerGate } from "@/components/agent/agent-owner-gate";
import { OneVoiceReadinessProvider } from "@/lib/one-voice/readiness";
import { AppBottomShell } from "@/components/app-ui/app-bottom-shell";
import { AmbientChromeController } from "@/components/app-ui/ambient-chrome-mask";
import { resolveRiaRouteTabSet } from "@/lib/navigation/top-shell-tabs";
import { Toaster } from "@/components/ui/sonner";
import { StatusBarManager } from "@/components/status-bar-manager";
import { KeyboardInsetManager } from "@/components/keyboard-inset-manager";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  beginRouteTransition,
  useRouteTransition,
} from "@/lib/morphy-ux/hooks/use-route-transition";
import { PostAuthOnboardingSyncBridge } from "@/components/onboarding/PostAuthOnboardingSyncBridge";
import { OnboardingJourneyGuard } from "@/components/onboarding/onboarding-journey-guard";
import { KaiCommandBarGlobal } from "@/components/kai/kai-command-bar-global";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { Capacitor } from "@capacitor/core";
import { ObservabilityRouteObserver } from "@/components/observability/route-observer";
import {
  resetKaiBottomChromeVisibility,
  useKaiBottomChromeProgressCssVar,
} from "@/lib/navigation/kai-bottom-chrome-visibility";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { recordDestinationEntry } from "@/lib/navigation/section-back-origin";
import { isFocusedConnectCircleTask } from "@/lib/navigation/connect-routes";
import { isFocusedLocationBottomTask } from "@/lib/navigation/location-routes";
import {
  ROUTES,
  isFoundationPublicRoute,
  isOneSetupSurfaceRoute,
  isRiaRoute,
} from "@/lib/navigation/routes";
import { useAuth } from "@/hooks/use-auth";
import { LocationBus } from "@/lib/one-location/location-bus";
import { PersonaProvider } from "@/lib/persona/persona-context";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "@/components/app-ui/signed-in-shell-content-offset";
import { NativeTestRouter } from "@/components/app-ui/native-test-router";
import { RiaSurfaceScopeSync } from "@/components/ria/ria-surface-scope-sync";
import { NativeTestBootstrap } from "@/components/app-ui/native-test-bootstrap";
import { NativeTestRouteStatus } from "@/components/app-ui/native-test-route-status";
import { InteractionRuntime } from "@/components/app-ui/interaction-runtime";
import { RenderPerfProbe } from "@/components/app-ui/render-perf-probe";
import {
  acknowledgeInternalAppNavigation,
  consumePendingInternalAppNavigation,
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";
import {
  PROFILE_PANE_OPEN_EVENT,
  PROFILE_PANE_ROOT_LOCATION,
  openProfilePane,
  clearProfilePaneQuery,
  closeProfilePane,
  resolveProfilePaneUrlState,
  type ProfilePaneLocation,
} from "@/lib/navigation/profile-pane";

interface ProvidersProps {
  children: ReactNode;
}

function readCustomVar(style: CSSProperties, key: string): string {
  const value = (style as Record<string, string | number | undefined>)[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * Give the shared position store an account, once, for the whole app.
 *
 * The store can keep a fix across a reload, but only for somebody: a
 * coordinate has to belong to an account before it can be sealed to their key.
 * That attach used to happen in two places and effectively neither. The hook
 * only attached when a caller passed a `userId` and no caller did; key
 * bootstrap needs a vault token, so it landed after the Location page had
 * already taken — and failed — its first capture. The restored fix was
 * therefore missing at exactly the moment it existed to cover: the cold start.
 *
 * Here it runs for every signed-in route, before any surface asks. Idempotent,
 * so key bootstrap's call stays harmless; and attaching null on sign-out is
 * what clears one person's position before the next person's session.
 */
function LocationBusAccountBridge() {
  const { userId } = useAuth();
  useEffect(() => {
    void LocationBus.attachUser(userId ?? null);
  }, [userId]);
  return null;
}

function AppShellFrame({ children }: ProvidersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAuthenticated, loading: authLoading, userId } = useAuth();
  const [profilePaneResume, setProfilePaneResume] = useState<{
    ownerId: string | null;
    location: ProfilePaneLocation;
  }>({
    ownerId: null,
    location: PROFILE_PANE_ROOT_LOCATION,
  });
  // Destination crossings behind the shared back contract. Recorded here
  // because this frame renders for every route, including chrome-less ones,
  // and a screen with no top bar can still be where a destination was entered
  // from. Moves within a destination store nothing.
  //
  // The query is carried deliberately: leaving `/one/location?view=people` for
  // Connect and coming back has to return to the People tab, not to a bare
  // `/one/location`, which is the right screen showing the wrong thing.
  //
  // `pathname`, not `shellPathname`: this is where the person went, not what
  // the shell substituted for an unauthenticated render.
  const search = searchParams?.toString() ?? "";
  useEffect(() => {
    const base = pathname || "/";
    recordDestinationEntry(search ? `${base}?${search}` : base);
  }, [pathname, search]);
  const isPublicKnowledgeWorkspace =
    pathname === ROUTES.WELCOME &&
    ["research", "blog", "developers"].includes(searchParams?.get("tab") ?? "");
  const shellPathname = useMemo(
    () =>
      pathname === ROUTES.HOME &&
      !isPublicKnowledgeWorkspace &&
      (authLoading || !isAuthenticated)
        ? ROUTES.LOGIN
        : pathname,
    [authLoading, isAuthenticated, isPublicKnowledgeWorkspace, pathname],
  );
  const chromeState = useMemo(
    () => getKaiChromeState(shellPathname),
    [shellPathname],
  );
  const routeLayout = useMemo(
    () => resolveAppRouteLayout(shellPathname),
    [shellPathname],
  );
  const routeLayoutMode = routeLayout.mode;
  // Chrome visibility is primarily route-owned. A small set of focused
  // Location flows still keeps the top shell while clearing bottom chrome.
  const hidesPersistentChrome = routeLayout.persistentChrome === "none";
  const locationAction = String(searchParams?.get("action") || "").trim();
  // Ask and Share pin their own Continue/Send action to the bottom edge. On a
  // compact viewport (especially WKWebView with a home-indicator inset), the
  // fixed Agent Bar and tab bar otherwise paint over that action when the
  // roster happens to end near the viewport floor. These task screens retain
  // the top breadcrumb/back affordance and exclusively own the bottom edge.
  const focusedLocationBottomTask = isFocusedLocationBottomTask(
    shellPathname,
    locationAction,
  );
  const focusedLocationChromeFlow =
    shellPathname === ROUTES.ONE_LOCATION &&
    (focusedLocationBottomTask ||
      locationAction === "sms-contacts" ||
      locationAction === "create-circle" ||
      locationAction === "circle-detail");
  const focusedConnectCircleChromeFlow =
    shellPathname === ROUTES.CONNECT &&
    isFocusedConnectCircleTask(
      searchParams?.get("tab") ?? null,
      searchParams?.get("action") ?? null,
      searchParams?.get("circleId") ?? null,
    );
  // Focused query-scoped Location flows clear the bottom command/navigation
  // stack while keeping the top shell route context.
  const bottomChromeHidden =
    hidesPersistentChrome ||
    focusedLocationBottomTask ||
    focusedConnectCircleChromeFlow;
  const effectiveHideCommandBar =
    chromeState.hideCommandBar ||
    focusedLocationChromeFlow ||
    focusedConnectCircleChromeFlow;
  const topShellRouteProfile = useMemo(() => {
    const query = searchParams?.toString() ?? "";
    return resolveTopShellRouteProfile(
      query ? `${shellPathname}?${query}` : shellPathname,
    );
  }, [searchParams, shellPathname]);
  const topShellModel = topShellRouteProfile.model;
  const routeSwipeTabSet = useMemo(() => {
    if (
      topShellModel.mode === "bar-with-tabs" &&
      (topShellModel.tabs.queryParam === null ||
        topShellModel.tabs.id === "consent")
    ) {
      return topShellModel.tabs;
    }

    const query = searchParams?.toString() ?? "";
    return resolveRiaRouteTabSet(
      query ? `${shellPathname}?${query}` : shellPathname,
    );
  }, [searchParams, shellPathname, topShellModel]);
  const topShellMetrics = useMemo(
    () => ({
      shellVisible: topShellModel.mode !== "hidden",
      hasTabs: topShellModel.mode === "bar-with-tabs",
      contentOffsetMode: topShellModel.contentOffsetMode,
    }),
    [topShellModel],
  );
  const topShellScrollResetKey =
    topShellModel.mode === "bar-with-tabs"
      ? `${shellPathname}:${topShellModel.tabs.id}:${topShellModel.tabs.activeValue}`
      : shellPathname;
  const hideGlobalChrome =
    !topShellMetrics.shellVisible || hidesPersistentChrome;
  const profilePaneEnabled =
    isAuthenticated && !authLoading && !hidesPersistentChrome;
  const profilePaneUrlState = useMemo(
    () => resolveProfilePaneUrlState(searchParams),
    [searchParams],
  );
  const profilePaneResumeLocation =
    profilePaneResume.ownerId === userId
      ? profilePaneResume.location
      : PROFILE_PANE_ROOT_LOCATION;
  const profilePaneOpen = profilePaneEnabled && profilePaneUrlState.open;
  const isFullscreenTopFlow = routeLayoutMode === "flow";
  const shouldLockFullscreenRoot = isFullscreenTopFlow || hidesPersistentChrome;
  const isFoundationRoute = isFoundationPublicRoute(pathname);
  const isPublicStandaloneRoute = isFoundationRoute && pathname !== ROUTES.HOME;
  const isCanonicalChatRoute = shellPathname === "/" && isAuthenticated;
  const signedInShellContentOffset = useMemo(
    () =>
      resolveSignedInShellContentOffset({
        shellVisible: topShellMetrics.shellVisible,
        routeLayoutMode,
        localOffset: routeLayout.pageTopLocalOffset,
      }),
    [
      routeLayout.pageTopLocalOffset,
      routeLayoutMode,
      topShellMetrics.shellVisible,
    ],
  );
  const topShellRouteStyle = useMemo(
    () =>
      ({
        ...signedInShellContentOffset.style,
        // The fixed tab row is already included in --top-shell-reserved-height.
        // Do not add a second route-body spacer: it creates an obvious blank
        // band between tabs and the primary header on every workspace.
        "--page-top-local-offset": topShellMetrics.hasTabs
          ? routeLayout.pageTopLocalOffset || "0px"
          : routeLayout.pageTopLocalOffset || "0px",
        // Derived top-shell geometry, declared at route-shell scope. It lives
        // in one exported function because CSS substitutes a custom property
        // with the values present where it is DECLARED -- so a root-only
        // definition bakes in the root's `0px` tabs and 8px fade and keeps
        // them. Anything reproducing the shell (the layout contract) reads the
        // same function rather than copying a subset.
        ...resolveTopShellGeometryStyle({ hasTabs: topShellMetrics.hasTabs }),
        "--top-ambient-tab-tail-midpoint": "8px",
        "--kai-route-content-gap": topShellMetrics.hasTabs ? "28px" : "20px",
        "--kai-route-content-gap-sm": topShellMetrics.hasTabs ? "32px" : "24px",
        "--app-top-shell-visible": topShellMetrics.shellVisible ? "1" : "0",
        "--app-top-has-tabs": topShellMetrics.hasTabs ? "1" : "0",
        "--app-top-offset-mode":
          topShellMetrics.contentOffsetMode === "fullscreen-flow"
            ? "fullscreen-flow"
            : "normal",
        "--bottom-chrome-stack-height": bottomChromeHidden
          ? "0px"
          : effectiveHideCommandBar
            ? "var(--app-bottom-shell-height, calc(var(--onboarding-agent-bar-clearance) + 1.5rem))"
            : "var(--app-bottom-shell-height, calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui)))",
        "--bottom-chrome-full-height": bottomChromeHidden
          ? "0px"
          : effectiveHideCommandBar
            ? "calc(var(--app-bottom-shell-height, calc(var(--onboarding-agent-bar-clearance) + 1.5rem)) + var(--bottom-chrome-fade-overscan))"
            : "calc(var(--app-bottom-shell-height, calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui))) + var(--bottom-chrome-fade-overscan))",
        "--bottom-chrome-search-height": bottomChromeHidden
          ? "0px"
          : effectiveHideCommandBar
            ? "calc(var(--app-bottom-inset) + var(--bottom-chrome-fade-overscan))"
            : "calc(var(--app-safe-area-bottom-effective) + var(--app-bottom-chrome-lift) + var(--kai-command-fixed-ui) + var(--bottom-chrome-fade-overscan))",
        "--bottom-chrome-visual-height": "var(--bottom-chrome-full-height)",
        "--bottom-chrome-hide-distance": "var(--app-bottom-fixed-ui)",
        // Hidden-shell routes deliberately omit the app navigation, but many
        // of them still render the fixed onboarding Agent Bar. The scroll root
        // owns the clearance for that fixed chrome so feature routes do not
        // need to guess at device safe areas or bar geometry.
        "--app-scroll-bottom-pad": bottomChromeHidden
          ? "0px"
          : isRiaRoute(pathname)
            ? "var(--bottom-chrome-stack-height)"
            : isOneSetupSurfaceRoute(pathname)
              ? "calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"
              : hideGlobalChrome || isPublicStandaloneRoute
                ? "calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"
                : "var(--bottom-chrome-stack-height)",
      }) as CSSProperties,
    [
      effectiveHideCommandBar,
      bottomChromeHidden,
      hideGlobalChrome,
      isPublicStandaloneRoute,
      routeLayout.pageTopLocalOffset,
      signedInShellContentOffset.style,
      topShellMetrics.contentOffsetMode,
      topShellMetrics.hasTabs,
      topShellMetrics.shellVisible,
      pathname,
    ],
  );
  // One controller owns the tokens for both edges. Foundation and onboarding
  // routes intentionally share it with signed-in chrome; their toggles are a
  // presentation variant, never a second material implementation.
  const ambientChromeEnabled =
    (topShellMetrics.shellVisible && !hidesPersistentChrome) ||
    isFoundationRoute ||
    chromeState.useOnboardingChrome;
  // Foundation editorial routes retain the voice-only Agent Bar, but do not
  // render a bottom navigation. Treat that as a pinned bottom-chrome posture:
  // subscribing the shared hide driver when there is no nav travel makes the
  // bar follow scroll progress and visibly bounce on research, blog, and
  // developers pages.
  const foundationVoiceOnlyChrome = isFoundationRoute && !isAuthenticated;
  // The canonical root is dual-mode: anonymous visitors get onboarding, while
  // authenticated owners get Chat plus the signed-in shell. Its command
  // palette is mounted as a global dialog even though it has no idle chrome;
  // Search therefore remains available from the first bottom-nav segment.
  const hideBottomNavigation =
    effectiveHideCommandBar || foundationVoiceOnlyChrome;
  // RIA and Foundation both use a persistent-but-pinned lower utility. Keep
  // the scroll-hide driver for ordinary signed-in navigation only.
  const pinnedBottomChrome = isRiaRoute(pathname) || foundationVoiceOnlyChrome;
  const bottomShellModel = {
    ambientEnabled:
      ambientChromeEnabled &&
      !isFullscreenTopFlow &&
      !bottomChromeHidden,
    navigationHidden: hideBottomNavigation,
    // The canonical Chat route already exposes its text composer. Keep the
    // idle voice launcher out of that route's visual hierarchy while allowing
    // an active command to remain visible and cancellable.
    agentBarHidden:
      isAuthenticated && !authLoading && pathname === ROUTES.HOME,
    hidden: bottomChromeHidden,
  };
  // Drive the bottom-chrome hide animation through a CSS variable instead of a
  // render-coupled value. Reading the continuous scroll progress in this root
  // shell re-rendered the entire provider subtree on every scroll frame, which
  // made pages like /consents appear to reload on scroll. This hook writes
  // `--bottom-chrome-progress` to the document root imperatively and returns
  // nothing, so scrolling no longer re-renders the React tree.
  // Pinned routes disable the shared hide driver (the hook's disabled branch
  // writes --bottom-chrome-progress:0). This shell renders above
  // PersonaProvider, so route state is the stable source of truth here.
  // Motion authority follows the bottom navigation, not the optional
  // decorative bottom glass. Hidden-shell and flow routes can retain the nav
  // while omitting that glass, and the persistent Agent Bar must still travel
  // with it. This matches Navbar's non-onboarding scroll-hide policy.
  useKaiBottomChromeProgressCssVar(
    !chromeState.useOnboardingChrome &&
      !pinnedBottomChrome &&
      !bottomChromeHidden,
  );
  // Add a root platform class for native-iOS specific CSS hooks.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const isNativeIOS =
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
    root.classList.toggle("native-ios", isNativeIOS);
    return () => root.classList.remove("native-ios");
  }, []);

  // The shared route envelope is the only page-transition owner. In
  // particular, onboarding must not receive a second per-element entrance
  // after the canonical exit → enter motion has settled.
  useRouteTransition();
  // Query-backed workspace tabs share one pathname, so pathname-only reset
  // leaves the next tab at the previous panel's scroll depth. The resolved
  // shell selection is the navigation key: click, swipe, history, and direct
  // query entry all reset the one shared app scroll root consistently.
  useScrollReset(topShellScrollResetKey, {
    enabled: true,
    behavior: "auto",
  });

  useEffect(() => {
    resetKaiBottomChromeVisibility();
  }, [topShellScrollResetKey]);

  useEffect(() => {
    setProfilePaneResume((current) => {
      if (current.ownerId !== userId) {
        return {
          ownerId: userId,
          location: profilePaneUrlState.open
            ? profilePaneUrlState.location
            : PROFILE_PANE_ROOT_LOCATION,
        };
      }
      return profilePaneUrlState.open
        ? { ownerId: userId, location: profilePaneUrlState.location }
        : current;
    });
  }, [profilePaneUrlState, userId]);

  useEffect(() => {
    if (authLoading || isAuthenticated || !profilePaneUrlState.open) return;
    clearProfilePaneQuery(pathname || ROUTES.ONE_HOME, searchParams);
  }, [
    authLoading,
    isAuthenticated,
    pathname,
    profilePaneUrlState.open,
    searchParams,
  ]);

  useEffect(() => {
    const handleProfilePaneOpen = () => {
      if (!profilePaneEnabled) return;
      if (profilePaneUrlState.open) return;
      openProfilePane(
        pathname || ROUTES.ONE_HOME,
        searchParams,
        profilePaneResumeLocation,
      );
    };
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, handleProfilePaneOpen);
    return () => {
      window.removeEventListener(
        PROFILE_PANE_OPEN_EVENT,
        handleProfilePaneOpen,
      );
    };
  }, [
    pathname,
    profilePaneEnabled,
    profilePaneResumeLocation,
    profilePaneUrlState.open,
    searchParams,
  ]);

  const handleProfilePaneOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (!profilePaneUrlState.open) {
        openProfilePane(
          pathname || ROUTES.ONE_HOME,
          searchParams,
          profilePaneResumeLocation,
        );
      }
      return;
    }
    closeProfilePane(pathname || ROUTES.ONE_HOME, searchParams);
  };

  useEffect(() => {
    const handleInternalNavigation = (event: Event) => {
      const customEvent = event as CustomEvent<InternalAppNavigationRequest>;
      acknowledgeInternalAppNavigation(customEvent.detail);
      const href = String(customEvent.detail?.href || "").trim();
      if (!href.startsWith("/") || href.startsWith("//")) {
        return;
      }
      const replace = Boolean(customEvent.detail?.replace);
      const scroll = customEvent.detail?.scroll ?? false;
      // Route programmatic navigations through the shared exit -> enter envelope
      // so they crossfade exactly like /one -> /one/* link clicks instead of
      // hard-cutting on exit.
      beginRouteTransition(
        href,
        () => {
          if (replace) {
            router.replace(href, { scroll });
            return;
          }
          router.push(href, { scroll });
        },
        customEvent.detail?.source ?? "programmatic",
        customEvent.detail?.transitionMode ?? "full",
      );
    };

    window.addEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      handleInternalNavigation,
    );
    const pendingNavigation = consumePendingInternalAppNavigation();
    if (pendingNavigation) {
      handleInternalNavigation(
        new CustomEvent<InternalAppNavigationRequest>(
          INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
          { detail: pendingNavigation },
        ),
      );
    }
    return () => {
      window.removeEventListener(
        INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
        handleInternalNavigation,
      );
    };
  }, [router]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const mirroredVars = [
      // Top-shell geometry is consumed by both the fixed sibling shell and
      // route content. Mirror the complete dependency chain so a tabbed route
      // never resolves a root-level `0px` tab stack for its mask or fade.
      "--top-tabs-gap",
      "--top-tabs-total",
      "--top-subnav-total",
      "--top-systembar-row-gap",
      "--top-fade-active",
      "--top-ambient-tab-tail-midpoint",
      "--top-shell-reserved-height",
      "--top-shell-visual-height",
      "--top-shell-live-height",
      "--top-shell-mask-tabs-gap",
      "--top-shell-mask-solid-height",
      "--top-shell-mask-visible-height",
      "--top-shell-h",
      "--top-glass-h",
      "--page-top-start",
      "--page-top-local-offset",
      "--app-top-mask-tail-clearance",
      "--app-top-content-offset",
      "--app-fullscreen-flow-content-offset",
      "--app-top-shell-visible",
      "--app-top-offset-mode",
      // AgentBar is an app-level fixed sibling of the route shell, not its
      // descendant. Mirror the complete bottom-chrome geometry to :root so it
      // resolves the same hide distance as the navbar and bottom glass instead
      // of falling through an unresolved sibling-only custom property.
      "--bottom-chrome-stack-height",
      "--bottom-chrome-full-height",
      "--bottom-chrome-search-height",
      "--bottom-chrome-visual-height",
      "--bottom-chrome-hide-distance",
    ];
    const previousValues = new Map<string, string>();

    mirroredVars.forEach((key) => {
      previousValues.set(key, root.style.getPropertyValue(key));
      const nextValue =
        readCustomVar(topShellRouteStyle, key) ||
        readCustomVar(signedInShellContentOffset.style, key);
      if (nextValue) {
        root.style.setProperty(key, nextValue);
      }
    });

    root.dataset.appShellOffsetMode = signedInShellContentOffset.mode;
    root.dataset.appShellRouteLayout = routeLayoutMode;
    root.dataset.appTopShellProfile = topShellRouteProfile.id;

    return () => {
      mirroredVars.forEach((key) => {
        const previous = previousValues.get(key) || "";
        if (previous) {
          root.style.setProperty(key, previous);
        } else {
          root.style.removeProperty(key);
        }
      });
      delete root.dataset.appShellOffsetMode;
      delete root.dataset.appShellRouteLayout;
      delete root.dataset.appTopShellProfile;
    };
  }, [
    routeLayoutMode,
    signedInShellContentOffset.mode,
    signedInShellContentOffset.style,
    topShellRouteProfile.id,
    topShellRouteStyle,
  ]);

  return (
    <CacheProvider>
      <PersonaProvider>
        <RiaSurfaceScopeSync />
        <VaultProvider>
          <OneLocationInteractionSurfaceProvider>
            <AgentRuntimeStateProvider>
              <OneVoiceReadinessProvider>
                <AgentOwnerGate>
                  <SiriOneVoiceHandoff />
                  <SiriOneRequestHandoff />
                  <SiriOneActionHandoff />
                  <SiriOneEntityIndexPublisher />
                  <NativeTestRouter />
                  <NativeTestBootstrap />
                  <NativeTestRouteStatus />
                  <InteractionRuntime />
                  <RenderPerfProbe />
                  <FoundationPublicAmbient />
                  {!hidesPersistentChrome ? (
                    <AmbientChromeController enabled={ambientChromeEnabled} />
                  ) : null}
                  {/* Voice chrome is hoisted ABOVE the page Suspense boundary so it
                mounts exactly once and survives client-side route transitions.
                Inside the boundary it would remount whenever a navigation
                suspends (fallback tree <-> resolved tree swap), cancelling an
                active command capture during a route switch. Both are fixed
                overlays, so position is unaffected. */}
                  {!hidesPersistentChrome ? <AgentVoiceEdgeGlow /> : null}
                  {!hidesPersistentChrome ? <AppEdgeBackGesture /> : null}
                  <AppProfileEdgeGesture enabled={profilePaneEnabled} />
                  <AppBottomShell model={bottomShellModel} />
                  <ProfilePane
                    open={profilePaneOpen}
                    onOpenChange={handleProfilePaneOpenChange}
                  />
                  {/* This bridge owns one post-unlock reconciliation for the whole
                app. Keeping it outside the route Suspense boundary prevents
                fallback/resolved remounts from launching the same sync twice. */}
                  <PostAuthOnboardingSyncBridge />
                  <LocationBusAccountBridge />
                  <ContactInvitationSessionProvider>
                    {/* Keep persistent top chrome outside the route Suspense
                        boundary. Route data may suspend during a transition,
                        but the Profile affordance and its measured animation
                        state must not remount with the fallback tree. */}
                    <div
                      className="flex flex-col flex-1 min-h-0"
                      style={topShellRouteStyle}
                      data-top-shell-profile={topShellRouteProfile.id}
                      data-app-shell-root="true"
                      data-app-shell-offset-mode={
                        signedInShellContentOffset.mode
                      }
                    >
                      {!hidesPersistentChrome && !isCanonicalChatRoute ? (
                        <AppTopShell model={topShellModel} />
                      ) : null}
                      {!hidesPersistentChrome && !effectiveHideCommandBar && !isCanonicalChatRoute ? (
                        <KaiCommandBarGlobal />
                      ) : null}
                      <Suspense
                        fallback={
                          <>
                            {/* Flex container for proper scroll behavior */}
                            <div className="flex flex-col flex-1 min-h-0">
                              <div
                                data-app-scroll-root="true"
                                data-app-scroll-mode={
                                  isCanonicalChatRoute
                                    ? "fullscreen-flow"
                                    : hideGlobalChrome
                                      ? "hidden-shell"
                                      : shouldLockFullscreenRoot
                                        ? "fullscreen-flow"
                                        : "standard"
                                }
                                className={
                                  isCanonicalChatRoute
                                    ? "flex-1 overflow-hidden relative z-10 min-h-0 flex flex-col h-full"
                                    : hideGlobalChrome
                                      ? "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none overscroll-y-contain touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--onboarding-agent-bar-clearance))] relative z-10 min-h-0"
                                      : shouldLockFullscreenRoot
                                        ? "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y relative z-10 min-h-0"
                                        : "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--app-bottom-content-clearance))] relative z-10 min-h-0"
                                }
                              >
                                {!hideGlobalChrome &&
                                !shouldLockFullscreenRoot &&
                                !isCanonicalChatRoute ? (
                                  <div
                                    data-app-shell-top-spacer="true"
                                    aria-hidden
                                  />
                                ) : null}
                                <div
                                  data-app-shell-content="true"
                                  className={
                                    isCanonicalChatRoute || shouldLockFullscreenRoot
                                      ? "min-h-0 h-full flex-1 flex flex-col"
                                      : "min-h-0"
                                  }
                                >
                                  <TopShellRouteSwipe tabSet={routeSwipeTabSet}>
                                    <OnboardingJourneyGuard>
                                      {children}
                                    </OnboardingJourneyGuard>
                                  </TopShellRouteSwipe>
                                </div>
                              </div>
                            </div>
                          </>
                        }
                      >
                        <ConsentNotificationProvider>
                          <ConsentSheetProvider>
                            {/* Flex container for proper scroll behavior */}
                            <div className="flex flex-col flex-1 min-h-0">
                              {/* Main scroll container: extends under fixed bar so content can scroll behind it; padding clears bar height */}
                              <div
                                data-app-scroll-root="true"
                                data-app-scroll-mode={
                                  isCanonicalChatRoute
                                    ? "fullscreen-flow"
                                    : hideGlobalChrome
                                      ? "hidden-shell"
                                      : shouldLockFullscreenRoot
                                        ? "fullscreen-flow"
                                        : "standard"
                                }
                                className={
                                  isCanonicalChatRoute
                                    ? "flex-1 overflow-hidden relative z-10 min-h-0 flex flex-col h-full"
                                    : hideGlobalChrome
                                      ? // Landing/onboarding flows retain a scroll tail for the fixed Agent Bar.
                                        "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none overscroll-y-contain touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--onboarding-agent-bar-clearance))] relative z-10 min-h-0"
                                      : shouldLockFullscreenRoot
                                        ? // Fullscreen flows keep chrome contract, but permit y-scroll for small devices.
                                          "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y relative z-10 min-h-0"
                                        : "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--app-bottom-content-clearance))] relative z-10 min-h-0"
                                }
                              >
                                {!hideGlobalChrome &&
                                !shouldLockFullscreenRoot &&
                                !isCanonicalChatRoute ? (
                                  <div
                                    data-app-shell-top-spacer="true"
                                    aria-hidden
                                  />
                                ) : null}
                                <div
                                  data-app-shell-content="true"
                                  className={
                                    isCanonicalChatRoute || shouldLockFullscreenRoot
                                      ? "min-h-0 h-full flex-1 flex flex-col"
                                      : "min-h-0"
                                  }
                                >
                                  <TopShellRouteSwipe tabSet={routeSwipeTabSet}>
                                    <OnboardingJourneyGuard>
                                      {children}
                                    </OnboardingJourneyGuard>
                                  </TopShellRouteSwipe>
                                </div>
                              </div>
                            </div>
                          </ConsentSheetProvider>
                        </ConsentNotificationProvider>
                      </Suspense>
                    </div>
                  </ContactInvitationSessionProvider>
                </AgentOwnerGate>
              </OneVoiceReadinessProvider>
              {/*
                Inside VaultProvider, not beside GlobalVoiceActionHandlers.
                Signing out needs only the session, so that one sits above the
                vault. Asking someone for information needs the vault key to mint
                the connector the request is encrypted to, so mounting it in the
                same place threw "useVault must be used within a VaultProvider"
                and took the whole app down with it.
              */}
              <GlobalConsentActionHandlers />
            </AgentRuntimeStateProvider>
          </OneLocationInteractionSurfaceProvider>
        </VaultProvider>
      </PersonaProvider>
    </CacheProvider>
  );
}

export function Providers({ children }: ProvidersProps) {
  // A Universal Link the OS hands back arrives as an event, not as navigation.
  // Mounted here, above the shell, so an OAuth return lands wherever the person
  // is rather than depending on which screen happened to be open.
  useDeepLinkReturn();

  return (
    <>
      <ObservabilityRouteObserver />
      <StepProgressProvider>
        <StatusBarManager />
        <KeyboardInsetManager />
        {/* Step-based progress bar at top of viewport */}
        <StepProgressBar />
        <AuthProvider>
          {/* Session-scoped voice actions ("log me out") live here rather than
              on Profile: a local handler is only offered while it is mounted,
              so a page-scoped registration would make the action depend on
              which tab happened to be open. */}
          <GlobalVoiceActionHandlers />
          {/* AppShellFrame resolves route-backed tab state through
              useSearchParams(). This boundary must be above that shared shell
              so static/native builds can pre-render every route, including
              the root Chat workspace and /one. Route-local boundaries cannot catch a hook in
              the provider that owns them. */}
          <Suspense fallback={null}>
            <AppShellFrame>{children}</AppShellFrame>
          </Suspense>
        </AuthProvider>
        <Toaster
          position="top-center"
          closeButton
          offset={{
            top: "calc(var(--top-inset, 0px) + 12px)",
          }}
          mobileOffset={{
            top: "calc(var(--top-inset, 0px) + 12px)",
            left: "1rem",
            right: "1rem",
          }}
        />
      </StepProgressProvider>
    </>
  );
}
