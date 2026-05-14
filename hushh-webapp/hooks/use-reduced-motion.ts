"use client";

import * as React from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * useReducedMotion
 *
 * Reports whether the user has expressed a preference for reduced motion
 * via their OS-level setting:
 *   - Windows  → Settings → Accessibility → Visual effects → Animation effects
 *   - macOS    → System Settings → Accessibility → Display → Reduce motion
 *   - iOS      → Settings → Accessibility → Motion → Reduce Motion
 *   - Android  → Settings → Accessibility → Remove animations
 *
 * Use this to gate non-essential animations (autoplay carousels, parallax,
 * scroll-triggered effects, decorative transitions) and avoid triggering
 * vestibular responses in motion-sensitive users.
 *
 * WCAG 2.3.3 (Animation from Interactions, AAA): Motion animation
 * triggered by interaction can be disabled, unless the animation is
 * essential to the functionality or information being conveyed.
 *
 * SSR / hydration safety:
 *   Returns `false` during server rendering and on the very first client
 *   commit, then resolves to the real preference inside `useEffect`.
 *   This avoids hydration mismatches; pair with a `motion-safe:` CSS
 *   variant or skip-animation fallback for the initial paint if needed.
 *
 * @example
 *   const reduced = useReducedMotion();
 *   return (
 *     <div className={reduced ? "" : "animate-pulse"}>
 *       …
 *     </div>
 *   );
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    setReduced(mql.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setReduced(event.matches);
    };

    // Modern browsers (Chrome 14+, Firefox 55+, Safari 14+).
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handleChange);
      return () => mql.removeEventListener("change", handleChange);
    }

    // Legacy Safari < 14 / older browsers: deprecated addListener API.
    const legacy = mql as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    legacy.addListener?.(handleChange);
    return () => {
      legacy.removeListener?.(handleChange);
    };
  }, []);

  return reduced;
}