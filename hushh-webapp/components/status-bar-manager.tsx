"use client";

import { useEffect, useRef, useState } from "react";
import {
  Capacitor,
  SystemBars,
  SystemBarsStyle,
  SystemBarType,
} from "@capacitor/core";
import { useTheme } from "next-themes";
import {
  AMBIENT_CHROME_TOP_SURFACE_ATTR,
  type AmbientChromeSurfaceTone,
} from "@/lib/morphy-ux/ambient-chrome";

const PROBE_ID = "app-safe-area-probe";

function readAmbientTopSurfaceTone(): AmbientChromeSurfaceTone | null {
  const value = document.documentElement.getAttribute(
    AMBIENT_CHROME_TOP_SURFACE_ATTR,
  );
  return value === "dark" || value === "light" ? value : null;
}

/**
 * SystemBarsStyle describes the content foreground, not the bar background.
 * A dark sampled surface therefore requires `Dark` (light icons and text).
 */
export function resolveNativeSystemBarStyle(
  topSurfaceTone: AmbientChromeSurfaceTone | null,
  fallbackTheme: string | undefined,
): SystemBarsStyle {
  if (topSurfaceTone === "dark") return SystemBarsStyle.Dark;
  if (topSurfaceTone === "light") return SystemBarsStyle.Light;
  return fallbackTheme === "dark"
    ? SystemBarsStyle.Dark
    : SystemBarsStyle.Light;
}

/**
 * measureSafeAreaInsetTop
 *
 * Optimized to use a persistent probe element to avoid DOM thrashing.
 */
function measureSafeAreaInsetTop() {
  if (typeof document === "undefined") return;

  let probe = document.getElementById(PROBE_ID);

  if (!probe) {
    probe = document.createElement("div");
    probe.id = PROBE_ID;
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;z-index:-1;";
    document.body.appendChild(probe);
  }

  // Force layout so the browser resolves env().
  const px = probe.offsetHeight;

  // Keep the previous non-zero probe if we get a transient 0 during relayout.
  const rootStyle = document.documentElement.style;
  const previousProbe =
    parseFloat(rootStyle.getPropertyValue("--app-safe-area-top-probe")) || 0;

  // Only update if we found a positive value to prevent flickering back to 0
  if (px > 0 || previousProbe === 0) {
    rootStyle.setProperty("--app-safe-area-top-probe", `${px}px`);
  }
}

/**
 * StatusBarManager - Native-only runtime bridge.
 * Synchronizes SystemBars with the app theme and solves WebKit inset bugs.
 */
export function StatusBarManager() {
  const { resolvedTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [ambientTopSurfaceTone, setAmbientTopSurfaceTone] =
    useState<AmbientChromeSurfaceTone | null>(null);
  const isUpdating = useRef(false);
  const pendingStyleRef = useRef<SystemBarsStyle | null>(null);
  const appliedStyleRef = useRef<SystemBarsStyle | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The ambient engine already makes the Hussh wordmark and top-shell controls
  // legible against the live painted surface. Subscribe to that same published
  // tone so native status icons do not remain dark over a dark route surface.
  useEffect(() => {
    if (!mounted || typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => setAmbientTopSurfaceTone(readAmbientTopSurfaceTone());
    const observer = new MutationObserver(sync);

    sync();
    observer.observe(root, {
      attributes: true,
      attributeFilter: [AMBIENT_CHROME_TOP_SURFACE_ATTR],
    });

    return () => observer.disconnect();
  }, [mounted]);

  // ── Measure env(safe-area-inset-top) ──
  useEffect(() => {
    if (!mounted) return;

    // Use an array of delays to catch the WKWebView when it finally commits insets
    const checkTicks = [0, 120, 500, 1000];
    const timers = checkTicks.map((delay) =>
      window.setTimeout(() => measureSafeAreaInsetTop(), delay),
    );

    // Optimized resize handler
    let resizeTimer: number;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => measureSafeAreaInsetTop(), 100);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") measureSafeAreaInsetTop();
    };

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility, {
      passive: true,
    });

    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mounted]);

  // ── Sync Native System Bars with Theme ──
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !mounted) return;

    async function updateSystemBars() {
      const effectiveTheme = resolvedTheme || theme || "dark";
      const requestedStyle = resolveNativeSystemBarStyle(
        ambientTopSurfaceTone,
        effectiveTheme,
      );
      if (
        requestedStyle === appliedStyleRef.current &&
        !pendingStyleRef.current
      ) {
        return;
      }
      pendingStyleRef.current = requestedStyle;

      if (isUpdating.current) return;
      isUpdating.current = true;

      try {
        while (pendingStyleRef.current) {
          const nextStyle = pendingStyleRef.current;
          pendingStyleRef.current = null;

          // Ensure bars are visible
          await SystemBars.show({});

          // Set styles in parallel for better performance
          await Promise.all([
            SystemBars.setStyle({
              bar: SystemBarType.StatusBar,
              style: nextStyle,
            }),
            SystemBars.setStyle({
              bar: SystemBarType.NavigationBar,
              style: nextStyle,
            }),
          ]);
          appliedStyleRef.current = nextStyle;
        }
      } catch (err) {
        console.error("[StatusBarManager] Failed to update system bars:", err);
      } finally {
        isUpdating.current = false;
      }
    }

    void updateSystemBars();
  }, [ambientTopSurfaceTone, resolvedTheme, theme, mounted]);

  return null;
}
