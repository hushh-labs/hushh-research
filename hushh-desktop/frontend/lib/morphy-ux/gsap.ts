// =============================================================================
// GSAP Helpers for Morphy (Material 3 expressive inspired)
// =============================================================================

import { motionDefaults, motionEasings } from "./motion";

type GSAPCore = {
  to: (target: unknown, vars: Record<string, unknown>) => unknown;
  fromTo: (
    target: unknown,
    fromVars: Record<string, unknown>,
    toVars: Record<string, unknown>
  ) => unknown;
  set?: (target: unknown, vars: Record<string, unknown>) => unknown;
  context?: (fn: () => void, scope?: Element | string) => { revert: () => void };
  registerPlugin?: (...plugins: unknown[]) => void;
};

let gsapCache: GSAPCore | null = null;
let scrollTriggerCache: unknown | null = null;

export const getGsap = async () => {
  if (typeof window === "undefined") return null;
  if (gsapCache) return gsapCache;
  const m = await import("gsap");
  // Support both ESM and CJS default exports without relying on gsap types
  const mod = m as unknown as { gsap?: unknown; default?: unknown };
  const coreCandidate: unknown =
    typeof mod.gsap !== "undefined"
      ? mod.gsap
      : typeof mod.default !== "undefined"
        ? mod.default
        : (m as unknown);

  const isGSAPCore = (x: unknown): x is GSAPCore => {
    if (!x || typeof x !== "object") return false;
    const rec = x as Record<string, unknown>;
    return typeof rec.to === "function" && typeof rec.fromTo === "function";
  };

  if (isGSAPCore(coreCandidate)) {
    gsapCache = coreCandidate;
  }
  return gsapCache;
};

export const getScrollTrigger = async () => {
  if (typeof window === "undefined") return null;
  if (scrollTriggerCache) return scrollTriggerCache;
  const gsap = await getGsap();
  if (!gsap) return null;
  const st = await import("gsap/ScrollTrigger");
  const stMod = st as unknown as { ScrollTrigger?: unknown; default?: unknown };
  const ScrollTrigger =
    typeof stMod.ScrollTrigger !== "undefined"
      ? stMod.ScrollTrigger
      : typeof stMod.default !== "undefined"
        ? stMod.default
        : (st as unknown);
  if (gsap.registerPlugin) {
    gsap.registerPlugin(ScrollTrigger);
  }
  scrollTriggerCache = ScrollTrigger;
  return st;
};

export const prefersReducedMotion = () => {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

export const animateOnce = async (
  target: Element | Element[] | string,
  vars: Record<string, unknown>,
  durationOverrideMs?: number
) => {
  if (prefersReducedMotion()) return;
  const gsap = await getGsap();
  if (!gsap) return;
  gsap.to(target, {
    duration: ((durationOverrideMs ?? motionDefaults.durationMs) /
      1000) as number,
    ease: motionDefaults.easing,
    overwrite: "auto",
    ...vars,
  });
};

export const scrollReveal = async (
  target: Element | string,
  from: Record<string, unknown>,
  to: Record<string, unknown>
) => {
  if (prefersReducedMotion()) return;
  const gsap = await getGsap();
  const st = await getScrollTrigger();
  if (!gsap || !st) return;
  const triggerEl =
    typeof target === "string"
      ? document.querySelector(target)
      : (target as Element);
  if (!triggerEl) return;
  gsap.fromTo(
    triggerEl,
    { ...from },
    {
      ...to,
      duration: (motionDefaults.durationMs / 1000) as number,
      ease: motionEasings.emphasized,
      overwrite: "auto",
      scrollTrigger: {
        trigger: triggerEl,
        start: "top 75%",
        toggleActions: "play none none reverse",
      },
    }
  );
};

export const scrollStaggerReveal = async (
  container: Element | string,
  targets: Element[] | string,
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  staggerMs = 60
) => {
  if (prefersReducedMotion()) return;
  const gsap = await getGsap();
  const st = await getScrollTrigger();
  if (!gsap || !st) return;
  const containerEl =
    typeof container === "string"
      ? (document.querySelector(container) as Element | null)
      : (container as Element | null);
  if (!containerEl) return;
  const targetEls: Element[] =
    typeof targets === "string"
      ? Array.from(containerEl.querySelectorAll(targets))
      : targets;
  if (!targetEls.length) return;
  gsap.fromTo(
    targetEls,
    { ...from },
    {
      ...to,
      duration: (motionDefaults.durationMs / 1000) as number,
      ease: motionEasings.emphasized,
      overwrite: "auto",
      stagger: staggerMs / 1000,
      scrollTrigger: {
        trigger: containerEl,
        start: "top 75%",
        toggleActions: "play none none reverse",
      },
    }
  );
};

export const createFloatingParticles = async (
  container: HTMLElement,
  count = 8
) => {
  if (prefersReducedMotion()) return;
  const gsap = await getGsap();
  if (!gsap || !container) return;
  // Clear previous
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className =
      "absolute w-1 h-1 bg-gradient-to-r from-[var(--morphy-primary-start)]/30 to-[var(--morphy-primary-end)]/30 rounded-full opacity-60";
    el.style.left = `${Math.random() * 100}%`;
    el.style.top = `${Math.random() * 100}%`;
    container.appendChild(el);
    gsap.to(el, {
      y: -50,
      x: Math.random() * 100 - 50,
      duration: 6 + Math.random() * 4,
      repeat: -1,
      yoyo: true,
      ease: "power2.inOut",
      delay: Math.random() * 2,
    });
  }
  // Fade in container quietly
  gsap.to(container, {
    opacity: 1,
    duration: 1.2,
    ease: motionEasings.decelerate,
  });
};
