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
 * Maintains a persistent CSS variable on the document root for the safe area height.
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

  // Force a re-layout to ensure the browser has computed the env() value
  const px = probe.offsetHeight;
  const rootStyle = document.documentElement.style;
  const previousProbe = parseFloat(rootStyle.getPropertyValue("--app-safe-area-top-probe")) || 0;

  // Only update if we have a valid measurement to avoid layout flicker
  if (px > 0 || previousProbe === 0) {
    rootStyle.setProperty("--app-safe-area-top-probe", `${px}px`);
  }
}

export function StatusBarManager() {
  const { resolvedTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const isUpdating = useRef(false);
  const pendingStyleRef = useRef<SystemBarsStyle | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 1. Safe Area Measurement Logic
  useEffect(() => {
    if (!mounted) return;

    // Run checks at intervals to handle late-committing WebKit insets
    const checkTicks = [0, 120, 500, 1000];
    const timers = checkTicks.map((delay) =>
      window.setTimeout(measureSafeAreaInsetTop, delay)
    );

    const onResize = () => {
      window.setTimeout(measureSafeAreaInsetTop, 100);
    };

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") measureSafeAreaInsetTop();
    }, { passive: true });

    return () => {
      timers.forEach(window.clearTimeout);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [mounted]);

  // 2. Native System Bar Theme Synchronization
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !mounted) return;

    async function updateSystemBars() {
      const effectiveTheme = resolvedTheme || theme || "dark";
      const nextStyle = effectiveTheme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light;

      if (pendingStyleRef.current === nextStyle) return;
      pendingStyleRef.current = nextStyle;

      if (isUpdating.current) return;
      isUpdating.current = true;

      try {
        await SystemBars.show({});
        await Promise.all([
          SystemBars.setStyle({ bar: SystemBarType.StatusBar, style: nextStyle }),
          SystemBars.setStyle({ bar: SystemBarType.NavigationBar, style: nextStyle }),
        ]);
      } catch (err) {
        console.warn("[StatusBarManager] Native bar sync failed:", err);
      } finally {
        isUpdating.current = false;
        // Re-run if theme changed while we were awaiting
        if (pendingStyleRef.current !== nextStyle) {
          void updateSystemBars();
        }
      }
    }

    void updateSystemBars();
  }, [resolvedTheme, theme, mounted]);

  return null;
}