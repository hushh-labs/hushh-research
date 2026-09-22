"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

/**
 * KeyboardInsetManager — native/mobile-only runtime bridge for keyboard avoidance.
 *
 * Publishes the part of the on-screen keyboard that still covers the page as
 * `--kb-height` on <html> (the whole keyboard on iOS; on Android, whatever the
 * WebView's own resize has not already taken) and toggles
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
  const coarsePointer =
    window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const hasTouch =
    "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  const narrow = window.matchMedia?.("(max-width: 820px)").matches ?? false;
  // All three required: a touchscreen laptop (fine pointer / wide) is treated as
  // desktop and stays fully inert.
  return coarsePointer && hasTouch && narrow;
}

function setKeyboardHeight(px: number): void {
  const root = document.documentElement;
  // Render-performance attribution only (the probe sets this for one launch
  // of a lane run; never in a normal session): leave the inset alone so the
  // keyboard's own presentation can be told apart from the page's response.
  if (root.dataset.perfExperiment?.split(",").includes("kb-inset-off")) return;
  const clamped = px > 0 ? Math.round(px) : 0;
  root.style.setProperty("--kb-height", `${clamped}px`);
  root.classList.toggle("kb-open", clamped > 0);
}

function isEditableElement(element: HTMLElement | null): element is HTMLElement {
  if (!element) return false;

  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable
  );
}

export function KeyboardInsetManager() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const isNative = Capacitor.isNativePlatform();
    const mobileWeb = !isNative && isMobileWebEnv();

    // Firewall: desktop / laptop binds nothing and stays inert.
    if (!isNative && !mobileWeb) return;

    // Full-screen mobile-web surfaces already shrink with `dvh` when the
    // keyboard opens. Mark only Capacitor runtimes as needing a composer lift,
    // so those surfaces do not reserve the visual-viewport overlap twice.
    document.documentElement.classList.toggle("native-keyboard-inset", isNative);

    let disposed = false;
    let rafId = 0;
    const cleanups: Array<() => void> = [];

    const scrollEditableIntoView = (element: HTMLElement | null) => {
      if (!isEditableElement(element)) return;
      // Fixed keyboard-anchored layers already track visualViewport through
      // --kb-height. Scrolling their autofocus target feeds viewport movement
      // back into that same measurement and makes the command palette jump.
      if (element.closest('[data-keyboard-anchor="bottom"]')) return;

      cancelAnimationFrame(rafId);
      // A native keyboard event lands after focus. Wait for the inset style and
      // the form's keyboard-reduced scroll area to commit, then reveal only the
      // focused control. `nearest` preserves the Figma composition instead of
      // re-centering the whole screen while someone types a phone number.
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(() => {
          element.scrollIntoView({ block: "nearest" });
        });
      });
    };

    const scrollFocusedEditableIntoView = () => {
      scrollEditableIntoView(document.activeElement as HTMLElement | null);
    };

    // Focusin net — once the keyboard is up, center the focused field in its
    // nearest scroll container. Covers normal-flow forms (OTP, onboarding,
    // profile) with no per-screen code.
    const onFocusIn = (event: FocusEvent) => {
      if (!document.documentElement.classList.contains("kb-open")) return;
      scrollEditableIntoView(event.target as HTMLElement | null);
    };
    document.addEventListener("focusin", onFocusIn, true);
    cleanups.push(() =>
      document.removeEventListener("focusin", onFocusIn, true),
    );
    cleanups.push(() => cancelAnimationFrame(rafId));

    if (isNative) {
      // Native: authoritative keyboard height from @capacitor/keyboard, less
      // whatever the web view has already given up for it. iOS keeps its
      // frame (resize "none"), so nothing is absorbed and the full height is
      // published. Android shrinks the WebView for the keyboard even with
      // adjustNothing (measured on a Galaxy S24 Ultra: 3120 -> 1775 px with
      // the keyboard up), so publishing the full height there subtracted the
      // keyboard twice: the vault gate's box collapsed to 44 dp and clipped
      // the field, the Unlock button and every link (mobile bug log B54).
      // Only the part of the keyboard still covering the viewport is an inset.
      let keyboardPx = 0;
      let baselineInnerHeight = window.innerHeight;
      const publishInset = () => {
        if (keyboardPx <= 0) {
          setKeyboardHeight(0);
          return;
        }
        const absorbed = Math.max(0, baselineInnerHeight - window.innerHeight);
        setKeyboardHeight(Math.max(0, keyboardPx - absorbed));
      };
      const onWindowResize = () => {
        // With no keyboard up, a taller viewport is the new baseline (an
        // orientation change, the system bars settling). A shorter one is
        // left alone: on Android the resize can land before the keyboard
        // event, and adopting it would hide the shrink this corrects for.
        if (keyboardPx <= 0) {
          if (window.innerHeight > baselineInnerHeight) baselineInnerHeight = window.innerHeight;
          return;
        }
        publishInset();
      };
      const onOrientationChange = () => {
        if (keyboardPx <= 0) baselineInnerHeight = window.innerHeight;
      };
      window.addEventListener("resize", onWindowResize);
      window.addEventListener("orientationchange", onOrientationChange);
      cleanups.push(() => {
        window.removeEventListener("resize", onWindowResize);
        window.removeEventListener("orientationchange", onOrientationChange);
      });
      // Dynamic import keeps SSR / static export safe.
      const listenerHandles: Array<{ remove: () => void }> = [];
      void import("@capacitor/keyboard")
        .then(({ Keyboard }) => {
          if (disposed) return;
          const register = (promise: Promise<{ remove: () => void }>) => {
            void promise.then((handle) => {
              if (disposed) handle.remove();
              else listenerHandles.push(handle);
            });
          };
          // iOS normally emits `will*`, but an interrupted animation/reopened
          // command palette can arrive only as `did*`. Subscribe to both so the
          // CSS inset always converges on the keyboard's final geometry.
          const handleKeyboardShow = (height: number) => {
            keyboardPx = height > 0 ? height : 0;
            publishInset();
            // `focusin` fires before iOS publishes keyboard visibility, so it
            // intentionally does nothing on a first focus. The native event is
            // the authoritative second chance that keeps the active phone/OTP
            // field above the keyboard without moving the whole viewport.
            scrollFocusedEditableIntoView();
          };
          register(
            Keyboard.addListener("keyboardWillShow", (info) =>
              handleKeyboardShow(info.keyboardHeight ?? 0),
            ),
          );
          register(
            Keyboard.addListener("keyboardDidShow", (info) =>
              handleKeyboardShow(info.keyboardHeight ?? 0),
            ),
          );
          const handleKeyboardHide = () => {
            keyboardPx = 0;
            setKeyboardHeight(0);
          };
          register(Keyboard.addListener("keyboardWillHide", handleKeyboardHide));
          register(Keyboard.addListener("keyboardDidHide", handleKeyboardHide));
        })
        .catch(() => {
          /* plugin unavailable → stay inert */
        });
      cleanups.push(() => listenerHandles.forEach((handle) => handle.remove()));
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
    cleanups.push(() => {
      setKeyboardHeight(0);
      document.documentElement.classList.remove("native-keyboard-inset");
    });

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return null;
}
