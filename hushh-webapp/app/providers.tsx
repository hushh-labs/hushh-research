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

import { CSSProperties, ReactNode, Suspense, useEffect, useMemo } from "react";
import { AuthProvider } from "@/lib/firebase";
import { VaultProvider } from "@/lib/vault/vault-context";
import { StepProgressProvider } from "@/lib/progress/step-progress-context";
import { StepProgressBar } from "@/components/app-ui/step-progress-bar";
import { CacheProvider } from "@/lib/cache/cache-context";
import { ConsentNotificationProvider } from "@/components/consent/notification-provider";
import { ConsentSheetProvider } from "@/components/consent/consent-sheet-controller";
import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";
import {
  resolveAppRouteLayout,
  shouldSuppressPersistentChromeForRouteState,
} from "@/lib/navigation/app-route-layout";
import { AppTopShell } from "@/components/app-ui/top-app-bar";
import { AppEdgeBackGesture } from "@/components/app-ui/app-edge-back-gesture";
import { TopShellRouteSwipe } from "@/components/app-ui/top-shell-route-swipe";
import { AgentPopoverProvider } from "@/components/agent/agent-popover-provider";
import { AgentRuntimeStateProvider } from "@/lib/agent/agent-runtime-context";
import { AgentVoiceEdgeGlow } from "@/components/agent/agent-voice-edge-glow";
import { FoundationPublicAmbient } from "@/components/app-ui/foundation-public-ambient";
import { AppBottomShell } from "@/components/app-ui/app-bottom-shell";
import { AmbientChromeController } from "@/components/app-ui/ambient-chrome-mask";
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
import {
  ROUTES,
  isFoundationPublicRoute,
  isRiaRoute,
} from "@/lib/navigation/routes";
import { useAuth } from "@/hooks/use-auth";
import { PersonaProvider } from "@/lib/persona/persona-context";
import { resolveSignedInShellContentOffset } from "@/components/app-ui/signed-in-shell-content-offset";
import { NativeTestRouter } from "@/components/app-ui/native-test-router";
import { RiaSurfaceScopeSync } from "@/components/ria/ria-surface-scope-sync";
import { NativeTestBootstrap } from "@/components/app-ui/native-test-bootstrap";
import { NativeTestRouteStatus } from "@/components/app-ui/native-test-route-status";
import { InteractionRuntime } from "@/components/app-ui/interaction-runtime";
import {
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";

interface ProvidersProps {
  children: ReactNode;
}

function readCustomVar(style: CSSProperties, key: string): string {
  const value = (style as Record<string, string | number | undefined>)[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function AppShellFrame({ children }: ProvidersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAuthenticated, loading: authLoading } = useAuth();
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
  const hidesPersistentChrome =
    routeLayout.persistentChrome === "none" ||
    shouldSuppressPersistentChromeForRouteState(
      shellPathname,
      searchParams?.get("action"),
    );
  const topShellRouteProfile = useMemo(() => {
    const query = searchParams?.toString() ?? "";
    return resolveTopShellRouteProfile(
      query ? `${shellPathname}?${query}` : shellPathname,
    );
  }, [searchParams, shellPathname]);
  const topShellModel = topShellRouteProfile.model;
  const routeSwipeTabSet =
    topShellModel.mode === "bar-with-tabs" &&
    (topShellModel.tabs.queryParam === null ||
      topShellModel.tabs.id === "consent")
      ? topShellModel.tabs
      : null;
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
  const isFullscreenTopFlow = routeLayoutMode === "flow";
  const shouldLockFullscreenRoot = isFullscreenTopFlow || hidesPersistentChrome;
  const isFoundationRoute = isFoundationPublicRoute(pathname);
  const isPublicStandaloneRoute = isFoundationRoute && pathname !== ROUTES.HOME;
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
        "--top-tabs-gap": "var(--kai-route-tabs-content-gap)",
        "--top-tabs-total": topShellMetrics.hasTabs
          ? "calc(var(--top-tabs-h) + var(--top-tabs-gap))"
          : "0px",
        "--top-subnav-total": "0px",
        "--top-systembar-row-gap": "4px",
        // These derived values must be declared at the route-shell scope.
        // CSS custom-property substitution happens before inheritance, so a
        // root-only definition would keep resolving the root's `0px` tabs.
        "--top-shell-reserved-height":
          "calc(var(--top-inset) + var(--top-systembar-row-gap) + var(--top-bar-h) + var(--top-tabs-total))",
        "--top-shell-visual-height":
          "calc(var(--top-shell-reserved-height) + var(--top-fade-active))",
        "--top-shell-live-height":
          "calc(var(--top-shell-visual-height) - var(--top-chrome-collapse-px, 0px))",
        // The route-body tab gap is deliberate reading space, not a chrome
        // extension. Keep it out of the mask so dark mode cannot form a band
        // beneath the tab underline.
        "--top-shell-mask-tabs-gap": topShellMetrics.hasTabs
          ? "var(--top-tabs-gap)"
          : "0px",
        "--top-shell-mask-solid-height":
          "calc(var(--top-shell-reserved-height) - var(--top-shell-mask-tabs-gap) - var(--top-chrome-collapse-px, 0px))",
        "--top-shell-mask-visible-height":
          "calc(var(--top-shell-mask-solid-height) + var(--top-fade-active))",
        "--top-shell-h": "var(--top-shell-reserved-height)",
        "--top-glass-h": "var(--top-shell-visual-height)",
        // The mask owns the entire resolved shell plus a short,
        // context-sensitive tail. Tabs stay fully solid through their
        // underline, but the dissolve must finish before the first bounded
        // route surface so its text remains readable.
        "--top-fade-active": topShellMetrics.hasTabs ? "12px" : "14px",
        "--top-ambient-tab-tail-midpoint": "8px",
        "--top-content-pad":
          "calc(var(--top-shell-visual-height) + var(--top-subnav-total, 0px) + var(--top-content-safe-gap))",
        "--kai-route-content-gap": topShellMetrics.hasTabs ? "28px" : "20px",
        "--kai-route-content-gap-sm": topShellMetrics.hasTabs ? "32px" : "24px",
        "--app-top-shell-visible": topShellMetrics.shellVisible ? "1" : "0",
        "--app-top-has-tabs": topShellMetrics.hasTabs ? "1" : "0",
        "--app-top-offset-mode":
          topShellMetrics.contentOffsetMode === "fullscreen-flow"
            ? "fullscreen-flow"
            : "normal",
        "--bottom-chrome-stack-height": chromeState.hideCommandBar
          ? "var(--app-bottom-inset)"
          : "var(--app-bottom-shell-height, calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui)))",
        "--bottom-chrome-full-height": chromeState.hideCommandBar
          ? "calc(var(--onboarding-agent-bar-clearance) + var(--bottom-chrome-fade-overscan) + 1.5rem)"
          : "calc(var(--app-bottom-shell-height, calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui))) + var(--bottom-chrome-fade-overscan))",
        "--bottom-chrome-search-height": chromeState.hideCommandBar
          ? "calc(var(--app-bottom-inset) + var(--bottom-chrome-fade-overscan))"
          : "calc(var(--app-safe-area-bottom-effective) + var(--app-bottom-chrome-lift) + var(--kai-command-fixed-ui) + var(--bottom-chrome-fade-overscan))",
        "--bottom-chrome-visual-height": "var(--bottom-chrome-full-height)",
        "--bottom-chrome-hide-distance": "var(--app-bottom-fixed-ui)",
        // Hidden-shell routes deliberately omit the app navigation, but many
        // of them still render the fixed onboarding Agent Bar. The scroll root
        // owns the clearance for that fixed chrome so feature routes do not
        // need to guess at device safe areas or bar geometry.
        "--app-scroll-bottom-pad": hidesPersistentChrome
          ? "0px"
          : isRiaRoute(pathname)
            ? "calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"
            : hideGlobalChrome || isPublicStandaloneRoute
              ? "calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"
              : "var(--bottom-chrome-stack-height)",
      }) as CSSProperties,
    [
      chromeState.hideCommandBar,
      hideGlobalChrome,
      isPublicStandaloneRoute,
      hidesPersistentChrome,
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
  const bottomShellModel = {
    ambientEnabled:
      ambientChromeEnabled && !isFullscreenTopFlow && !hidesPersistentChrome,
    navigationHidden: chromeState.hideCommandBar,
    hidden: hidesPersistentChrome,
  };
  // Drive the bottom-chrome hide animation through a CSS variable instead of a
  // render-coupled value. Reading the continuous scroll progress in this root
  // shell re-rendered the entire provider subtree on every scroll frame, which
  // made pages like /consents appear to reload on scroll. This hook writes
  // `--bottom-chrome-progress` to the document root imperatively and returns
  // nothing, so scrolling no longer re-renders the React tree.
  // RIA sub-agent = Apple-style ALWAYS-PINNED chrome: disable the shared
  // bottom-glass hide driver on /ria/* so the glass panels stay put (the hook's
  // disabled branch writes --bottom-chrome-progress:0). Path-based gate — this
  // shell renders above PersonaProvider, so persona isn't available here.
  const riaPinnedChrome = isRiaRoute(pathname);
  // Motion authority follows the bottom navigation, not the optional
  // decorative bottom glass. Hidden-shell and flow routes can retain the nav
  // while omitting that glass, and the persistent Agent Bar must still travel
  // with it. This matches Navbar's non-onboarding scroll-hide policy.
  useKaiBottomChromeProgressCssVar(
    !chromeState.useOnboardingChrome &&
      !riaPinnedChrome &&
      !hidesPersistentChrome,
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
    const handleInternalNavigation = (event: Event) => {
      const customEvent = event as CustomEvent<InternalAppNavigationRequest>;
      const href = String(customEvent.detail?.href || "").trim();
      if (!href.startsWith("/")) {
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
          <AgentRuntimeStateProvider>
            <AgentPopoverProvider>
              <NativeTestRouter />
              <NativeTestBootstrap />
              <NativeTestRouteStatus />
              <InteractionRuntime />
              <FoundationPublicAmbient />
              {!hidesPersistentChrome ? (
                <AmbientChromeController enabled={ambientChromeEnabled} />
              ) : null}
              {/* Voice chrome is hoisted ABOVE the page Suspense boundary so it
                mounts exactly once and survives client-side route transitions.
                Inside the boundary it would remount whenever a navigation
                suspends (fallback tree <-> resolved tree swap), tearing down
                the live voice session and restarting the conversation on every
                route switch. Both are fixed overlays, so position is unaffected. */}
              {!hidesPersistentChrome ? <AgentVoiceEdgeGlow /> : null}
              {!hidesPersistentChrome ? <AppEdgeBackGesture /> : null}
              <AppBottomShell model={bottomShellModel} />
              {/* This bridge owns one post-unlock reconciliation for the whole
                app. Keeping it outside the route Suspense boundary prevents
                fallback/resolved remounts from launching the same sync twice. */}
              <PostAuthOnboardingSyncBridge />
              <Suspense
                fallback={
                  <>
                    {/* Flex container for proper scroll behavior */}
                    <div
                      className="flex flex-col flex-1 min-h-0"
                      style={topShellRouteStyle}
                      data-top-shell-profile={topShellRouteProfile.id}
                      data-app-shell-root="true"
                      data-app-shell-offset-mode={
                        signedInShellContentOffset.mode
                      }
                    >
                      {!hidesPersistentChrome ? (
                        <Suspense fallback={null}>
                          <AppTopShell model={topShellModel} />
                        </Suspense>
                      ) : null}
                      {!hidesPersistentChrome ? (
                        <Suspense fallback={null}>
                          <KaiCommandBarGlobal />
                        </Suspense>
                      ) : null}
                      <div
                        data-app-scroll-root="true"
                        data-app-scroll-mode={
                          hideGlobalChrome
                            ? "hidden-shell"
                            : shouldLockFullscreenRoot
                              ? "fullscreen-flow"
                              : "standard"
                        }
                        className={
                          hideGlobalChrome
                            ? "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none overscroll-y-contain touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--onboarding-agent-bar-clearance))] relative z-10 min-h-0"
                            : shouldLockFullscreenRoot
                              ? "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y relative z-10 min-h-0"
                              : "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--app-bottom-inset))] relative z-10 min-h-0"
                        }
                      >
                        {!hideGlobalChrome && !shouldLockFullscreenRoot ? (
                          <div data-app-shell-top-spacer="true" aria-hidden />
                        ) : null}
                        <div
                          data-app-shell-content="true"
                          className={
                            shouldLockFullscreenRoot
                              ? "min-h-0 h-full"
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
                    <div
                      className="flex flex-col flex-1 min-h-0"
                      style={topShellRouteStyle}
                      data-top-shell-profile={topShellRouteProfile.id}
                      data-app-shell-root="true"
                      data-app-shell-offset-mode={
                        signedInShellContentOffset.mode
                      }
                    >
                      {!hidesPersistentChrome ? (
                        <Suspense fallback={null}>
                          <AppTopShell model={topShellModel} />
                        </Suspense>
                      ) : null}
                      {!hidesPersistentChrome ? (
                        <Suspense fallback={null}>
                          <KaiCommandBarGlobal />
                        </Suspense>
                      ) : null}
                      {/* Main scroll container: extends under fixed bar so content can scroll behind it; padding clears bar height */}
                      <div
                        data-app-scroll-root="true"
                        data-app-scroll-mode={
                          hideGlobalChrome
                            ? "hidden-shell"
                            : shouldLockFullscreenRoot
                              ? "fullscreen-flow"
                              : "standard"
                        }
                        className={
                          hideGlobalChrome
                            ? // Landing/onboarding flows retain a scroll tail for the fixed Agent Bar.
                              "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none overscroll-y-contain touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--onboarding-agent-bar-clearance))] relative z-10 min-h-0"
                            : shouldLockFullscreenRoot
                              ? // Fullscreen flows keep chrome contract, but permit y-scroll for small devices.
                                "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y relative z-10 min-h-0"
                              : "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y pb-[var(--app-scroll-bottom-pad,var(--app-bottom-inset))] relative z-10 min-h-0"
                        }
                      >
                        {!hideGlobalChrome && !shouldLockFullscreenRoot ? (
                          <div data-app-shell-top-spacer="true" aria-hidden />
                        ) : null}
                        <div
                          data-app-shell-content="true"
                          className={
                            shouldLockFullscreenRoot
                              ? "min-h-0 h-full"
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
            </AgentPopoverProvider>
          </AgentRuntimeStateProvider>
        </VaultProvider>
      </PersonaProvider>
    </CacheProvider>
  );
}

export function Providers({ children }: ProvidersProps) {
  return (
    <>
      <ObservabilityRouteObserver />
      <StepProgressProvider>
        <StatusBarManager />
        <KeyboardInsetManager />
        {/* Step-based progress bar at top of viewport */}
        <StepProgressBar />
        <AuthProvider>
          {/* AppShellFrame resolves route-backed tab state through
              useSearchParams(). This boundary must be above that shared shell
              so static/native builds can pre-render every route, including
              /one and /agent. Route-local boundaries cannot catch a hook in
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
