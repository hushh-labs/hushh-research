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
 * Reads the real env(safe-area-inset-top) value via a probe element and
 * writes it to --app-safe-area-top-probe on <html>. This sidesteps the
 * WebKit bug where env() values can transiently resolve to 0 during startup.
 *
 * `--top-inset` remains a derived CSS token in globals.css:
 * max(env(safe-area-inset-top), env(safe-area-max-inset-top), probe)
 *
 * This avoids hard-overwriting layout math from JS while still recovering
 * when WKWebView is late to commit safe-area values.
 *
 * Note: This sidesteps the WebKit bug where
 * env() assigned to a CSS custom-property at :root level can evaluate to 0
 * if the WKWebView hasn't committed its safe-area values by parse time.
 *
 * Called once on mount, and again after orientation changes.
 */
function measureSafeAreaInsetTop() {
  if (typeof document === "undefined") return;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  // Force layout so the browser resolves env().
  const px = probe.offsetHeight;
  probe.remove();
  // Keep the previous non-zero probe if we get a transient 0 during relayout.
  const rootStyle = document.documentElement.style;
  const previousProbe =
    parseFloat(rootStyle.getPropertyValue("--app-safe-area-top-probe")) || 0;
  const nextProbe = px > 0 ? px : previousProbe;
  rootStyle.setProperty("--app-safe-area-top-probe", `${nextProbe}px`);
}

/**
 * StatusBarManager - Native-only runtime bridge that synchronizes
 * Capacitor v8 SystemBars style with the app theme.
 *
 * Also measures and sets --app-safe-area-top-probe at runtime so top-shell
 * layout tokens resolve correctly on every platform.
 *
 * Migration note:
 * - This component name is retained for import stability.
 * - Runtime control now uses SystemBars for both StatusBar and NavigationBar.
 */
export function StatusBarManager() {
  const { resolvedTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [ambientTopSurfaceTone, setAmbientTopSurfaceTone] =
    useState<AmbientChromeSurfaceTone | null>(null);
  const isUpdating = useRef(false);
  const pendingStyleRef = useRef<SystemBarsStyle | null>(null);
  const appliedStyleRef = useRef<SystemBarsStyle | null>(null);

  // Wait for theme to be mounted to avoid hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // The ambient chrome engine publishes the same sampled tone used to make
  // the web controls legible. Native status icons must follow that tone too,
  // otherwise a dark route can briefly show dark icons during a shell change.
  useEffect(() => {
    if (!mounted || typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => {
      const value = root.getAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR);
      setAmbientTopSurfaceTone(
        value === "dark" || value === "light" ? value : null,
      );
    };
    const observer = new MutationObserver(sync);

    sync();
    observer.observe(root, {
      attributes: true,
      attributeFilter: [AMBIENT_CHROME_TOP_SURFACE_ATTR],
    });

    return () => observer.disconnect();
  }, [mounted]);

  // ── Measure env(safe-area-inset-top) and write --app-safe-area-top-probe ──
  useEffect(() => {
    // Initial measurements (extra ticks handle late WKWebView inset commits).
    const raf = requestAnimationFrame(() => measureSafeAreaInsetTop());
    const t1 = window.setTimeout(() => measureSafeAreaInsetTop(), 120);
    const t2 = window.setTimeout(() => measureSafeAreaInsetTop(), 500);

    // Re-measure on orientation / resize changes.
    const onResize = () => measureSafeAreaInsetTop();
    const onVisibility = () => {
      if (document.visibilityState === "visible") measureSafeAreaInsetTop();
    };
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility, {
      passive: true,
    });

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

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
          const style = pendingStyleRef.current;
          pendingStyleRef.current = null;
          await SystemBars.show({});
          await Promise.all([
            SystemBars.setStyle({
              bar: SystemBarType.StatusBar,
              style,
            }),
            SystemBars.setStyle({
              bar: SystemBarType.NavigationBar,
              style,
            }),
          ]);
          appliedStyleRef.current = style;
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
