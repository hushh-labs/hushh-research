"use client";

import { useEffect, useRef, useState } from "react";
import {
  Capacitor,
  SystemBars,
  SystemBarsStyle,
  SystemBarType,
} from "@capacitor/core";
import { useTheme } from "next-themes";

const PROBE_ID = "app-safe-area-probe";

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
  const previousProbe = parseFloat(rootStyle.getPropertyValue("--app-safe-area-top-probe")) || 0;

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
  const isUpdating = useRef(false);
  const pendingStyleRef = useRef<SystemBarsStyle | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // ── Measure env(safe-area-inset-top) ──
  useEffect(() => {
    if (!mounted) return;

    // Use an array of delays to catch the WKWebView when it finally commits insets
    const checkTicks = [0, 120, 500, 1000];
    const timers = checkTicks.map((delay) =>
      window.setTimeout(() => measureSafeAreaInsetTop(), delay)
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
    document.addEventListener("visibilitychange", onVisibility, { passive: true });

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
      pendingStyleRef.current = effectiveTheme === "dark"
        ? SystemBarsStyle.Dark
        : SystemBarsStyle.Light;

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
            })
          ]);
        }
      } catch (err) {
        console.error("[StatusBarManager] Failed to update system bars:", err);
      } finally {
        isUpdating.current = false;
      }
    }

    void updateSystemBars();
  }, [resolvedTheme, theme, mounted]);

  return null;
}
