"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

/**
 * KeyboardInsetManager — native/mobile-only runtime bridge for keyboard avoidance.
 *
 * Publishes the on-screen keyboard height as `--kb-height` on <html> and toggles
 * `html.kb-open`, so fixed / bottom-anchored surfaces (drawers, sheets, dialogs,
 * the chat composer) can lift their content above the keyboard with pure CSS.
 * It also scrolls a focused field into view for normal-flow forms (OTP, etc.).
 *
 * DESKTOP / LAPTOP IS 100% INERT. On a non-native, non-mobile-touch environment
 * this effect binds NOTHING: `--kb-height` stays `0px`, `.kb-open` never appears,
 * and no focusin handler runs. Every CSS consumer resolves to a no-op at
 * `--kb-height: 0px`, so the website / desktop layout is byte-for-byte unchanged.
 *
 * Strategy (see mobile-bug-log B21): keep Capacitor `Keyboard.resize:"none"` (the
 * native WKWebView frame never resizes → no per-frame `dvh` thrash / vault jank),
 * and do avoidance HERE, event-driven — once per keyboard transition, not per
 * animation frame. This breaks the historical `native`(jank) ↔ `none`(hidden) loop.
 */

// Real software keyboards are > ~250px tall. Ignore anything smaller so a mobile
// URL-bar collapse, soft focus, or a stray viewport resize never trips avoidance.
const KB_MIN_SHRINK_PX = 120;

function isMobileWebEnv(): boolean {
  if (typeof window === "undefined") return false;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const hasTouch =
    "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  const narrow = window.matchMedia?.("(max-width: 820px)").matches ?? false;
  // All three required: a touchscreen laptop (fine pointer / wide) is treated as
  // desktop and stays fully inert.
  return coarsePointer && hasTouch && narrow;
}

function setKeyboardHeight(px: number): void {
  const root = document.documentElement;
  const clamped = px > 0 ? Math.round(px) : 0;
  root.style.setProperty("--kb-height", `${clamped}px`);
  root.classList.toggle("kb-open", clamped > 0);
}

export function KeyboardInsetManager() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const isNative = Capacitor.isNativePlatform();
    const mobileWeb = !isNative && isMobileWebEnv();

    // Firewall: desktop / laptop binds nothing and stays inert.
    if (!isNative && !mobileWeb) return;

    let disposed = false;
    let rafId = 0;
    const cleanups: Array<() => void> = [];

    // Focusin net — once the keyboard is up, center the focused field in its
    // nearest scroll container. Covers normal-flow forms (OTP, onboarding,
    // profile) with no per-screen code.
    const onFocusIn = (event: FocusEvent) => {
      if (!document.documentElement.classList.contains("kb-open")) return;
      const el = event.target as HTMLElement | null;
      if (!el) return;
      const editable =
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable;
      if (!editable) return;
      cancelAnimationFrame(rafId);
      // Defer past the layout that --kb-height triggers, then center.
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(() => {
          el.scrollIntoView({ block: "center" });
        });
      });
    };
    document.addEventListener("focusin", onFocusIn, true);
    cleanups.push(() =>
      document.removeEventListener("focusin", onFocusIn, true)
    );
    cleanups.push(() => cancelAnimationFrame(rafId));

    if (isNative) {
      // Native: authoritative keyboard height from @capacitor/keyboard.
      // Dynamic import keeps SSR / static export safe.
      let showHandle: { remove: () => void } | undefined;
      let hideHandle: { remove: () => void } | undefined;
      void import("@capacitor/keyboard")
        .then(({ Keyboard }) => {
          if (disposed) return;
          void Keyboard.addListener("keyboardWillShow", (info) => {
            setKeyboardHeight(info.keyboardHeight ?? 0);
          }).then((handle) => {
            if (disposed) handle.remove();
            else showHandle = handle;
          });
          void Keyboard.addListener("keyboardWillHide", () => {
            setKeyboardHeight(0);
          }).then((handle) => {
            if (disposed) handle.remove();
            else hideHandle = handle;
          });
        })
        .catch(() => {
          /* plugin unavailable → stay inert */
        });
      cleanups.push(() => showHandle?.remove());
      cleanups.push(() => hideHandle?.remove());
    } else {
      // Mobile web: derive height from a thresholded visualViewport shrink.
      const vv = window.visualViewport;
      if (vv) {
        const onViewport = () => {
          const overlap = window.innerHeight - vv.height - vv.offsetTop;
          setKeyboardHeight(overlap > KB_MIN_SHRINK_PX ? overlap : 0);
        };
        vv.addEventListener("resize", onViewport);
        vv.addEventListener("scroll", onViewport);
        onViewport();
        cleanups.push(() => {
          vv.removeEventListener("resize", onViewport);
          vv.removeEventListener("scroll", onViewport);
        });
      }
    }

    // Always reset the inset on unmount.
    cleanups.push(() => setKeyboardHeight(0));

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return null;
}
