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
  useRef,
} from "react";
import { AuthProvider } from "@/lib/firebase";
import { VaultContext, VaultProvider } from "@/lib/vault/vault-context";
import { StepProgressProvider } from "@/lib/progress/step-progress-context";
import { StepProgressBar } from "@/components/app-ui/step-progress-bar";
import { CacheProvider } from "@/lib/cache/cache-context";
import { ConsentNotificationProvider } from "@/components/consent/notification-provider";
import { ConsentSheetProvider } from "@/components/consent/consent-sheet-controller";
import { resolveTopShellRouteProfile } from "@/components/app-ui/top-shell-metrics";
import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { TopAppBar } from "@/components/app-ui/top-app-bar";
import { AgentPopoverProvider } from "@/components/agent/agent-popover-provider";
import { AgentRuntimeStateProvider } from "@/lib/agent/agent-runtime-context";
import { AgentBar } from "@/components/agent/agent-bar";
import { AgentVoiceEdgeGlow } from "@/components/agent/agent-voice-edge-glow";
import { FoundationPublicAmbient } from "@/components/app-ui/foundation-public-ambient";
import { Navbar } from "@/components/navbar";
import { Toaster } from "@/components/ui/sonner";
import { StatusBarManager } from "@/components/status-bar-manager";
import { usePathname, useRouter } from "next/navigation";
import { ensureMorphyGsapReady } from "@/lib/morphy-ux/gsap-init";
import { usePageEnterAnimation } from "@/lib/morphy-ux/hooks/use-page-enter";
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
import { ROUTES, isRiaRoute } from "@/lib/navigation/routes";
import { useAuth } from "@/hooks/use-auth";
import { PersonaProvider } from "@/lib/persona/persona-context";
import { resolveSignedInShellContentOffset } from "@/components/app-ui/signed-in-shell-content-offset";
import { NativeTestRouter } from "@/components/app-ui/native-test-router";
import { RiaSurfaceScopeSync } from "@/components/ria/ria-surface-scope-sync";
import { NativeTestBootstrap } from "@/components/app-ui/native-test-bootstrap";
import { NativeTestRouteStatus } from "@/components/app-ui/native-test-route-status";
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

// Shared bottom chrome glass vars. Mirrors the top app bar glass (same bg,
// blur via the .bar-glass default, overscan, and fade strengths) so the bottom
// mask fade matches the top exactly, just flipped to fade upward. The dark
// tint derives from the live --background (same as the top bar) so neither
// band can read lighter (milky) than the page behind it.
const SHARED_BOTTOM_CHROME_GLASS_VARS = {
  "--app-bar-glass-bg-light": "rgba(245, 245, 247, 0.76)",
  "--app-bar-glass-bg-dark":
    "color-mix(in oklab, var(--background) 76%, transparent)",
  "--app-bar-shadow": "none",
  "--app-bar-mask-overscan": "14px",
} as const;

function AppShellFrame({ children }: ProvidersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const shellPathname = useMemo(
    () =>
      pathname === ROUTES.HOME && (authLoading || !isAuthenticated)
        ? ROUTES.LOGIN
        : pathname,
    [authLoading, isAuthenticated, pathname],
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
  const topShellRouteProfile = useMemo(
    () => resolveTopShellRouteProfile(shellPathname),
    [shellPathname],
  );
  const topShellMetrics = topShellRouteProfile.metrics;
  const hideGlobalChrome = !topShellMetrics.shellVisible;
  const isFullscreenTopFlow = routeLayoutMode === "flow";
  const shouldLockFullscreenRoot = isFullscreenTopFlow;
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
        "--top-tabs-gap": "0px",
        "--top-tabs-total": topShellMetrics.hasTabs
          ? "calc(var(--top-tabs-h) + var(--top-tabs-gap))"
          : "0px",
        "--top-subnav-total": "0px",
        "--top-systembar-row-gap": "4px",
        "--top-fade-active": topShellMetrics.hasTabs ? "22px" : "18px",
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
          : "calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui))",
        "--bottom-chrome-full-height": chromeState.hideCommandBar
          ? "calc(var(--app-bottom-inset) + var(--bottom-chrome-fade-overscan))"
          : "calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui) + var(--bottom-chrome-fade-overscan))",
        "--bottom-chrome-search-height": chromeState.hideCommandBar
          ? "calc(var(--app-bottom-inset) + var(--bottom-chrome-fade-overscan))"
          : "calc(var(--app-safe-area-bottom-effective) + var(--app-bottom-chrome-lift) + var(--kai-command-fixed-ui) + var(--bottom-chrome-fade-overscan))",
        "--bottom-chrome-visual-height": "var(--bottom-chrome-full-height)",
        "--bottom-chrome-hide-distance": "var(--app-bottom-fixed-ui)",
        // Hidden-shell routes deliberately omit the app navigation, but many
        // of them still render the fixed onboarding Agent Bar. The scroll root
        // owns the clearance for that fixed chrome so feature routes do not
        // need to guess at device safe areas or bar geometry.
        "--app-scroll-bottom-pad": hideGlobalChrome
          ? "calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"
          : "var(--bottom-chrome-stack-height)",
      }) as CSSProperties,
    [
      chromeState.hideCommandBar,
      hideGlobalChrome,
      signedInShellContentOffset.style,
      topShellMetrics.contentOffsetMode,
      topShellMetrics.hasTabs,
      topShellMetrics.shellVisible,
    ],
  );
  const showSharedBottomChromeGlass =
    topShellMetrics.shellVisible && !isFullscreenTopFlow;
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
    !chromeState.useOnboardingChrome && !riaPinnedChrome,
  );
  const pageRef = useRef<HTMLDivElement | null>(null);
  const isKaiRoute = useMemo(
    () =>
      pathname === ROUTES.KAI_HOME ||
      pathname.startsWith(`${ROUTES.KAI_HOME}/`) ||
      pathname === ROUTES.LEGACY_KAI_HOME ||
      pathname.startsWith(`${ROUTES.LEGACY_KAI_HOME}/`),
    [pathname],
  );
  const pageAnimationKey = useMemo(
    () => (isKaiRoute ? `${ROUTES.KAI_HOME}-stable-shell` : pathname),
    [isKaiRoute, pathname],
  );
  const shouldObservePageMutations = useMemo(
    () =>
      !(
        pathname.startsWith(ROUTES.KAI_ANALYSIS) ||
        pathname.startsWith(`${ROUTES.KAI_HOME}/dashboard/analysis`) ||
        pathname.startsWith("/kai/analysis") ||
        pathname.startsWith("/kai/dashboard/analysis")
      ),
    [pathname],
  );

  // One-time GSAP init (non-blocking).
  useEffect(() => {
    void ensureMorphyGsapReady();
  }, []);

  // Add a root platform class for native-iOS specific CSS hooks.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const isNativeIOS =
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
    root.classList.toggle("native-ios", isNativeIOS);
    return () => root.classList.remove("native-ios");
  }, []);

  // App-wide page enter fade.
  usePageEnterAnimation(pageRef, {
    enabled: true,
    key: pageAnimationKey,
    observeMutations: shouldObservePageMutations,
  });
  // App-wide route crossfade: fades the outgoing page out before navigating so
  // route loads feel continuous instead of a hard cut (pairs with the GSAP
  // enter animation above). See globals.css → "UNIFORM ROUTE TRANSITION".
  useRouteTransition();
  useScrollReset(pathname, { enabled: true, behavior: "auto" });

  useEffect(() => {
    resetKaiBottomChromeVisibility();
  }, [pathname]);

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
      beginRouteTransition(href, () => {
        if (replace) {
          router.replace(href, { scroll });
          return;
        }
        router.push(href, { scroll });
      });
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
              <FoundationPublicAmbient />
              {/* Voice chrome is hoisted ABOVE the page Suspense boundary so it
                mounts exactly once and survives client-side route transitions.
                Inside the boundary it would remount whenever a navigation
                suspends (fallback tree <-> resolved tree swap), tearing down
                the live voice session and restarting the conversation on every
                route switch. Both are fixed overlays, so position is unaffected. */}
              <AgentVoiceEdgeGlow />
              <AgentBar />
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
                      <Navbar />
                      {!hideGlobalChrome ? (
                        <Suspense fallback={null}>
                          <TopAppBar />
                        </Suspense>
                      ) : null}
                      <VaultContext.Consumer>
                        {() =>
                          showSharedBottomChromeGlass ? (
                            <div
                              aria-hidden
                              className="pointer-events-none fixed inset-x-0 bottom-0 z-[108]"
                            >
                              <div
                                className="w-full bar-glass bar-glass-bottom"
                                style={
                                  {
                                    height: "var(--bottom-chrome-full-height)",
                                    transform:
                                      "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance)), 0)",
                                    ...SHARED_BOTTOM_CHROME_GLASS_VARS,
                                  } as CSSProperties
                                }
                              />
                            </div>
                          ) : null
                        }
                      </VaultContext.Consumer>
                      <Suspense fallback={null}>
                        <KaiCommandBarGlobal />
                      </Suspense>
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
                          ref={pageRef}
                          data-app-shell-content="true"
                          className={
                            shouldLockFullscreenRoot
                              ? "min-h-0 h-full"
                              : "min-h-0"
                          }
                        >
                          <OnboardingJourneyGuard>{children}</OnboardingJourneyGuard>
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
                      <Navbar />
                      {!hideGlobalChrome ? (
                        <Suspense fallback={null}>
                          <TopAppBar />
                        </Suspense>
                      ) : null}
                      <VaultContext.Consumer>
                        {() =>
                          showSharedBottomChromeGlass ? (
                            <div
                              aria-hidden
                              className="pointer-events-none fixed inset-x-0 bottom-0 z-[108]"
                            >
                              <div
                                className="w-full bar-glass bar-glass-bottom"
                                style={
                                  {
                                    height: "var(--bottom-chrome-full-height)",
                                    transform:
                                      "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance)), 0)",
                                    ...SHARED_BOTTOM_CHROME_GLASS_VARS,
                                  } as CSSProperties
                                }
                              />
                            </div>
                          ) : null
                        }
                      </VaultContext.Consumer>
                      <Suspense fallback={null}>
                        <KaiCommandBarGlobal />
                      </Suspense>
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
                          ref={pageRef}
                          data-app-shell-content="true"
                          className={
                            shouldLockFullscreenRoot
                              ? "min-h-0 h-full"
                              : "min-h-0"
                          }
                        >
                          <OnboardingJourneyGuard>{children}</OnboardingJourneyGuard>
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
        {/* Step-based progress bar at top of viewport */}
        <StepProgressBar />
        <AuthProvider>
          <AppShellFrame>{children}</AppShellFrame>
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
