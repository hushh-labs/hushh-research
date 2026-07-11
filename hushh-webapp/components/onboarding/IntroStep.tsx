"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import {
  GLASS_PRESET_DARK,
  GLASS_PRESET_FROSTED,
  registerGlassElement,
  registerGlassRoot,
} from "@/lib/glass/liquid-glass-surface";

/* ────────────────────────────────────────────────────────────
 * Welcome ("/"). Rebuilt from scratch on the /test-proven pattern: the
 * exact conditions under which @ybouane/liquidglass renders its reference
 * demo, with ZERO app effects layered on top.
 *
 * The contract (verified against the library demo site):
 *   1. <main> is the glass root; the backdrop <canvas> and the CTA are its
 *      DIRECT children (hard library requirement).
 *   2. Glass elements are fully transparent (no background, ring, shadow,
 *      or backdrop-filter) — the shader IS the surface.
 *   3. NO animations, transforms, or transitions on the glass element or
 *      any refraction contributor: the engine caches captures, and a
 *      mid-animation capture bakes in forever. Content here is static.
 *   4. Stock demo presets only, theme-aware: "Frosted Glass" in light
 *      mode, "Dark Glass" in dark mode, switched through data-config (the
 *      engine's official MutationObserver-watched channel).
 *   5. Stock button:true drives hover/press feedback, exactly like the
 *      demo's "Click Me" pill.
 * ──────────────────────────────────────────────────────────── */

// One's four motions, a quiet typographic rhythm. Matches
// docs/vision/agent-ontology.md.
const MOTIONS = ["Listens", "Remembers", "Decides", "Acts"];

export function IntroStep({
  onLogin,
}: {
  onLogin?: () => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  const { resolvedTheme } = useTheme();

  // Register the glass surface once per mount. The root is published so the
  // agent bar can portal its greeter pill in as a sibling glass element on
  // the same engine instance.
  useEffect(() => {
    const root = rootRef.current;
    const cta = ctaRef.current;
    if (!root || !cta) return;
    const releaseRoot = registerGlassRoot(root);
    const releaseCta = registerGlassElement(cta);
    return () => {
      releaseCta();
      releaseRoot();
    };
  }, []);

  // Theme awareness: swap between the two stock demo presets through
  // data-config. The engine re-reads it via MutationObserver, so the swap is
  // a pure shader-side update — no re-init, no CSS.
  useEffect(() => {
    const cta = ctaRef.current;
    if (!cta) return;
    const preset = resolvedTheme === "dark" ? GLASS_PRESET_DARK : GLASS_PRESET_FROSTED;
    cta.dataset.config = JSON.stringify({ ...preset, cornerRadius: 28, button: true });
  }, [resolvedTheme]);

  return (
    <main
      ref={rootRef}
      className="relative flex min-h-[100dvh] w-full flex-col overflow-hidden"
    >
      {/* Live backdrop: a <canvas> direct child — the engine's fast
          drawImage capture path (same shape as the demo's <img>). */}
      <OnboardingHeroBackground />

      {/* Static content column. Deliberately animation-free: it paints
          before the CTA in stacking order, so it is a refraction
          contributor and must never be captured mid-animation. */}
      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col items-center justify-between px-7 py-8 text-center">
        <div className="flex w-full items-center justify-between pt-[var(--app-safe-area-top-effective,0px)]">
          <HushhWordmark className="h-9" />
          <span className="select-none text-[32px] leading-none">🤫</span>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center">
          <span className="type-caption text-[color:var(--foundation-dim)]">
            Your personal agent
          </span>

          <h1 className="mt-4 select-none font-[family-name:var(--font-app-display)] text-[clamp(64px,20vw,88px)] font-bold leading-[0.9] tracking-[-3.5px]">
            <span className="one-molten font-[family-name:var(--font-app-display)]">
              One
            </span>
          </h1>

          <p className="mt-6 max-w-[20rem] text-[17px] leading-[1.45] text-[color:var(--foundation-ink)] dark:text-[#F7F3EA]">
            One agent for everything you own online, that answers only to you.
          </p>

          <div className="mt-5 flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--foundation-dim)]">
            {MOTIONS.map((motion, i) => (
              <span key={motion} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden className="opacity-40">&middot;</span>}
                <span>{motion}</span>
              </span>
            ))}
          </div>

          <p className="mt-6 max-w-[18rem] text-[13px] leading-[1.5] text-[color:var(--foundation-dim)]">
            Everything stays encrypted in your vault. Nothing moves without your consent.
          </p>
        </div>

        {/* Inert spacer reserving the CTA's landing zone in the column; the
            real button lives below as a direct child of <main>. */}
        <div
          aria-hidden
          className="w-full pb-[calc(102px+var(--app-safe-area-bottom-effective,0px))]"
        >
          <div className="h-[56px] w-full" />
        </div>
      </div>

      {/* The CTA: bare transparent button, DIRECT child of <main>, exactly
          like the demo's "Click Me". The injected shader canvas becomes its
          first child; the label span sits above it. */}
      <button
        ref={ctaRef}
        type="button"
        onClick={onLogin}
        className="absolute inset-x-7 z-10 h-[56px] rounded-full border-0 bg-transparent p-0"
        style={{
          bottom: "calc(102px + var(--app-safe-area-bottom-effective, 0px))",
        }}
      >
        <span className="pointer-events-none relative z-[2] flex items-center justify-center gap-2 text-[16px] font-semibold text-[color:var(--foundation-ink)] dark:text-[#F7F3EA]">
          Open your vault
          <span aria-hidden>&rarr;</span>
        </span>
      </button>
    </main>
  );
}
