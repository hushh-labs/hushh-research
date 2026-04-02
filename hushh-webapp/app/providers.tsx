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

import { CSSProperties, ReactNode, Suspense, useEffect, useMemo, useRef } from "react";
import { ThemeProvider } from "@/components/theme-provider";
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
import { Navbar } from "@/components/navbar";
import { Toaster } from "@/components/ui/sonner";
import { StatusBarManager } from "@/components/status-bar-manager";
import { usePathname, useRouter } from "next/navigation";
import { ensureMorphyGsapReady } from "@/lib/morphy-ux/gsap-init";
import { usePageEnterAnimation } from "@/lib/morphy-ux/hooks/use-page-enter";
import { PostAuthOnboardingSyncBridge } from "@/components/onboarding/PostAuthOnboardingSyncBridge";
import { KaiCommandBarGlobal } from "@/components/kai/kai-command-bar-global";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { Capacitor } from "@capacitor/core";
import { ObservabilityRouteObserver } from "@/components/observability/route-observer";
import {
  resetKaiBottomChromeVisibility,
  useKaiBottomChromeVisibility,
} from "@/lib/navigation/kai-bottom-chrome-visibility";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { PersonaBootstrapRedirect } from "@/components/iam/persona-bootstrap-redirect";
import { PersonaProvider } from "@/lib/persona/persona-context";
import { resolveSignedInShellContentOffset } from "@/components/app-ui/signed-in-shell-content-offset";
import {
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";

interface ProvidersProps {
  children: ReactNode;
}

function readCustomVar(
  style: CSSProperties,
  key: string
): string {
  const value = (style as Record<string, string | number | undefined>)[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

export function Providers({ children }: ProvidersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const routeLayout = useMemo(() => resolveAppRouteLayout(pathname), [pathname]);
  const routeLayoutMode = routeLayout.mode;
  const topShellRouteProfile = useMemo(
    () => resolveTopShellRouteProfile(pathname),
    [pathname]
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
    [routeLayout.pageTopLocalOffset, routeLayoutMode, topShellMetrics.shellVisible]
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
          topShellMetrics.contentOffsetMode === "fullscreen-flow" ? "fullscreen-flow" : "normal",
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
        "--bottom-chrome-hide-distance": "var(--bottom-chrome-full-height)",
        "--app-scroll-bottom-pad": "var(--bottom-chrome-stack-height)",
      } as CSSProperties),
    [
      chromeState.hideCommandBar,
      signedInShellContentOffset.style,
      topShellMetrics.contentOffsetMode,
      topShellMetrics.hasTabs,
      topShellMetrics.shellVisible,
    ]
  );
  const showSharedBottomChromeGlass = topShellMetrics.shellVisible && !isFullscreenTopFlow;
  const { progress: hideBottomChromeGlassProgress } = useKaiBottomChromeVisibility(
    showSharedBottomChromeGlass
  );
  const pageRef = useRef<HTMLDivElement | null>(null);
  const pageAnimationKey = useMemo(
    () => (pathname.startsWith("/kai") ? "/kai-stable-shell" : pathname),
    [pathname]
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
  usePageEnterAnimation(pageRef, { enabled: true, key: pageAnimationKey });
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
      if (replace) {
        router.replace(href, { scroll });
        return;
      }
      router.push(href, { scroll });
    };

    window.addEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      handleInternalNavigation
    );
    return () => {
      window.removeEventListener(
        INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
        handleInternalNavigation
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
  }, [routeLayoutMode, signedInShellContentOffset.mode, signedInShellContentOffset.style, topShellRouteProfile.id, topShellRouteStyle]);

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <ObservabilityRouteObserver />
      <StepProgressProvider>
        <StatusBarManager />
        {/* Step-based progress bar at top of viewport */}
        <StepProgressBar />
        <AuthProvider>
          <CacheProvider>
            <PersonaProvider>
              <VaultProvider>
                <PersonaBootstrapRedirect />
                <Suspense
                  fallback={
                    <>
                      {/* Flex container for proper scroll behavior */}
                      <div
                        className="flex flex-col flex-1 min-h-0"
                        style={topShellRouteStyle}
                        data-top-shell-profile={topShellRouteProfile.id}
                        data-app-shell-root="true"
                        data-app-shell-offset-mode={signedInShellContentOffset.mode}
                      >
                        <Navbar />
                        <Suspense fallback={null}>
                          <TopAppBar />
                        </Suspense>
                        <VaultContext.Consumer>
                          {(vault) =>
                            showSharedBottomChromeGlass && vault?.isVaultUnlocked ? (
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
                                      "--bottom-chrome-progress": String(hideBottomChromeGlassProgress),
                                      "--app-bar-glass-bg-light": "rgba(245, 245, 247, 0.72)",
                                      "--app-bar-glass-bg-dark": "rgba(29, 29, 31, 0.72)",
                                      "--app-bar-glass-blur": "2px",
                                      "--app-bar-shadow": "none",
                                      "--app-bar-mask-overscan": "14px",
                                    } as CSSProperties
                                  }
                                />
                              </div>
                            ) : null
                          }
                        </VaultContext.Consumer>
                        <PostAuthOnboardingSyncBridge />
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
                              ? "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none overscroll-y-contain touch-pan-y relative z-10 min-h-0"
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
                            className={shouldLockFullscreenRoot ? "min-h-0 h-full" : "min-h-0"}
                          >
                            {children}
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
                        data-app-shell-offset-mode={signedInShellContentOffset.mode}
                      >
                        <Navbar />
                        <Suspense fallback={null}>
                          <TopAppBar />
                        </Suspense>
                        <VaultContext.Consumer>
                          {(vault) =>
                            showSharedBottomChromeGlass && vault?.isVaultUnlocked ? (
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
                                      "--bottom-chrome-progress": String(hideBottomChromeGlassProgress),
                                      "--app-bar-glass-bg-light": "rgba(245, 245, 247, 0.72)",
                                      "--app-bar-glass-bg-dark": "rgba(29, 29, 31, 0.72)",
                                      "--app-bar-glass-blur": "2px",
                                      "--app-bar-shadow": "none",
                                      "--app-bar-mask-overscan": "14px",
                                    } as CSSProperties
                                  }
                                />
                              </div>
                            ) : null
                          }
                        </VaultContext.Consumer>
                        <PostAuthOnboardingSyncBridge />
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
                              ? // Landing/onboarding flows should still allow vertical scroll on small screens.
                                "flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none overscroll-y-contain touch-pan-y relative z-10 min-h-0"
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
                            className={shouldLockFullscreenRoot ? "min-h-0 h-full" : "min-h-0"}
                          >
                            {children}
                          </div>
                        </div>
                      </div>
                    </ConsentSheetProvider>
                  </ConsentNotificationProvider>
                </Suspense>
              </VaultProvider>
            </PersonaProvider>
          </CacheProvider>
        </AuthProvider>
        <Toaster
          position="top-center"
          closeButton
          offset={{
            top: "calc(var(--top-inset, 0px) + 12px)",
          }}
          mobileOffset={{
            top: "calc(var(--top-inset, 0px) + 12px)",
          }}
        />
      </StepProgressProvider>
    </ThemeProvider>
  );
}
