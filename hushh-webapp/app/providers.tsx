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
import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";
import { TopAppBar } from "@/components/app-ui/top-app-bar";
import { Navbar } from "@/components/navbar";
import { Toaster } from "@/components/ui/sonner";
import { StatusBarManager } from "@/components/status-bar-manager";
import { usePathname } from "next/navigation";
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
import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const pathname = usePathname();
  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const routeLayoutMode = useMemo(() => resolveAppRouteLayoutMode(pathname), [pathname]);
  const topShellRouteProfile = useMemo(
    () => resolveTopShellRouteProfile(pathname),
    [pathname]
  );
  const topShellMetrics = topShellRouteProfile.metrics;
  const topShellBreadcrumb = useMemo(() => resolveTopShellBreadcrumb(pathname), [pathname]);
  const hideGlobalChrome = !topShellMetrics.shellVisible;
  const isFullscreenTopFlow = routeLayoutMode === "flow";
  const shouldLockFullscreenRoot = isFullscreenTopFlow;
  const topShellRouteStyle = useMemo(
    () =>
      ({
        "--top-tabs-gap": "0px",
        "--top-tabs-total": topShellMetrics.hasTabs
          ? "calc(var(--top-tabs-h) + var(--top-tabs-gap))"
          : "0px",
        "--top-subnav-total": topShellBreadcrumb
          ? "calc(var(--top-subnav-h) + var(--top-subnav-gap))"
          : "0px",
        "--top-systembar-row-gap": "4px",
        "--top-fade-active": topShellMetrics.hasTabs ? "22px" : "18px",
        "--top-content-pad": "var(--top-shell-reserved-height)",
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
        "--app-scroll-bottom-pad": "var(--bottom-chrome-stack-height)",
      } as CSSProperties),
    [
      chromeState.hideCommandBar,
      topShellMetrics.contentOffsetMode,
      topShellBreadcrumb,
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
                <ConsentNotificationProvider>
                  <Suspense
                    fallback={
                      <>
                        {/* Flex container for proper scroll behavior */}
                        <div
                          className="flex flex-col flex-1 min-h-0"
                          style={topShellRouteStyle}
                          data-top-shell-profile={topShellRouteProfile.id}
                        >
                          <Navbar />
                          <TopAppBar />
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
                                        height: `calc(var(--bottom-chrome-full-height) - (${hideBottomChromeGlassProgress} * var(--app-bottom-fixed-ui)))`,
                                        "--app-bar-glass-bg-light": "rgba(255, 255, 255, 0.46)",
                                        "--app-bar-glass-bg-dark": "rgba(10, 12, 16, 0.64)",
                                        "--app-bar-glass-blur": "2px",
                                        "--app-bar-shadow": "none",
                                        "--app-bar-mask-overscan": "22px",
                                      } as CSSProperties
                                    }
                                  />
                                </div>
                              ) : null
                            }
                          </VaultContext.Consumer>
                          <PostAuthOnboardingSyncBridge />
                          <KaiCommandBarGlobal />
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
                            <div
                              ref={pageRef}
                              className={shouldLockFullscreenRoot ? "min-h-0 h-full" : "min-h-0"}
                            >
                              {children}
                            </div>
                          </div>
                        </div>
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
                      </>
                    }
                  >
                    <ConsentSheetProvider>
                      {/* Flex container for proper scroll behavior */}
                      <div
                        className="flex flex-col flex-1 min-h-0"
                        style={topShellRouteStyle}
                        data-top-shell-profile={topShellRouteProfile.id}
                      >
                        <Navbar />
                        <TopAppBar />
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
                                      height: `calc(var(--bottom-chrome-full-height) - (${hideBottomChromeGlassProgress} * var(--app-bottom-fixed-ui)))`,
                                      "--app-bar-glass-bg-light": "rgba(255, 255, 255, 0.46)",
                                      "--app-bar-glass-bg-dark": "rgba(10, 12, 16, 0.64)",
                                      "--app-bar-glass-blur": "2px",
                                      "--app-bar-shadow": "none",
                                      "--app-bar-mask-overscan": "22px",
                                    } as CSSProperties
                                  }
                                />
                              </div>
                            ) : null
                          }
                        </VaultContext.Consumer>
                        <PostAuthOnboardingSyncBridge />
                        <KaiCommandBarGlobal />
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
                          <div
                            ref={pageRef}
                            className={shouldLockFullscreenRoot ? "min-h-0 h-full" : "min-h-0"}
                          >
                            {children}
                          </div>
                        </div>
                      </div>
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
                    </ConsentSheetProvider>
                  </Suspense>
                </ConsentNotificationProvider>
              </VaultProvider>
            </PersonaProvider>
          </CacheProvider>
        </AuthProvider>
      </StepProgressProvider>
    </ThemeProvider>
  );
}
