"use client";

import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { Button } from "@/lib/morphy-ux/button";

/* ────────────────────────────────────────────────────────────
 * Welcome ("/"). A living, theme-safe canvas (OnboardingHeroBackground:
 * breathing gold + violet mesh glow, drifting motes, grain) carries the
 * whole screen. Typography: eyebrow, one molten "One", one honest
 * declarative sentence, and a quiet tracked-out rhythm line that hints at
 * One's four motions (Listens / Remembers / Decides / Acts) without ever
 * labeling them as UI or naming internal specialists. Morphy mechanics
 * throughout: the CTA is a Morphy Button (gradient ripple, ink surface),
 * and the staggered one-reveal entrance is back. No WebGL.
 * ──────────────────────────────────────────────────────────── */

// One's four motions, shown as a quiet typographic rhythm — never as chips,
// never labeled "framework". Matches docs/vision/agent-ontology.md.
const MOTIONS = ["Listens", "Remembers", "Decides", "Acts"];

export function IntroStep({
  onLogin,
}: {
  onLogin?: () => void;
}) {
  return (
    <main className="relative flex min-h-[100dvh] w-full flex-col overflow-hidden">
      <OnboardingHeroBackground />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col items-center justify-between px-7 py-8 text-center">
        {/* ── Top row: wordmark left, quiet-mark right (no box). ── */}
        <div
          className="one-reveal flex w-full items-center justify-between pt-[var(--app-safe-area-top-effective,0px)]"
          style={{ ["--seq-delay" as string]: "80ms" }}
        >
          <HushhWordmark className="h-9" />
          <span className="select-none text-[32px] leading-none">🤫</span>
        </div>

        {/* ── Typography-led hero. No cards, no fake metrics. ── */}
        <div className="flex flex-1 flex-col items-center justify-center">
          <span
            className="one-reveal type-caption text-[color:var(--foundation-dim)]"
            style={{ ["--seq-delay" as string]: "220ms" }}
          >
            Your personal agent
          </span>

          {/* Sizing lives on h1.one-hero-title in globals.css: the global
              foundation h1 lock uses !important in @layer base, which beats
              Tailwind utilities AND inline styles, so the hero needs a
              same-layer higher-specificity override. */}
          <h1
            className="one-hero-title one-reveal mt-4 select-none font-[family-name:var(--font-app-display)]"
            style={{ ["--seq-delay" as string]: "320ms" }}
          >
            <span className="one-molten font-[family-name:var(--font-app-display)]">
              One
            </span>
          </h1>

          {/* Approved durable product line (docs/vision/agent-ontology.md
              Founder Copy Rules; brand punchline). Not ad-hoc copy. */}
          <p
            className="one-reveal mt-6 max-w-[20rem] text-[19px] font-medium leading-[1.4] tracking-[-0.2px] text-[color:var(--foundation-ink)] dark:text-[#F7F3EA]"
            style={{ ["--seq-delay" as string]: "420ms" }}
          >
            Your agents. Yours to own.
          </p>

          {/* Quiet rhythm line: the four motions, typographic not chip-like. */}
          <div
            className="one-reveal mt-5 flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--foundation-dim)]"
            style={{ ["--seq-delay" as string]: "500ms" }}
          >
            {MOTIONS.map((motion, i) => (
              <span key={motion} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden className="opacity-40">&middot;</span>}
                <span>{motion}</span>
              </span>
            ))}
          </div>

          <p
            className="one-reveal mt-6 max-w-[18rem] text-[13px] leading-[1.5] text-[color:var(--foundation-dim)]"
            style={{ ["--seq-delay" as string]: "580ms" }}
          >
            Everything stays encrypted in your vault. Nothing moves without your consent.
          </p>
        </div>

        {/* ── CTA: Morphy Button, ink surface, gradient ripple. Sits in the
              flex column normally (no absolute anchoring needed without the
              glass root constraint). Bottom padding clears the agent bar. ── */}
        <div
          className="one-reveal w-full pb-[calc(102px+var(--app-safe-area-bottom-effective,0px))]"
          style={{ ["--seq-delay" as string]: "680ms" }}
        >
          <Button
            type="button"
            variant="none"
            effect="fill"
            size="lg"
            fullWidth
            showRipple
            onClick={onLogin}
            // Theme-matching surface (same contract as the login provider
            // buttons): light button in light mode, dark button in dark
            // mode, definition from a hairline border + soft shadow instead
            // of an inverted slab.
            className="type-headline h-[56px] rounded-full border border-black/10 bg-white text-[16px] font-semibold text-[#17130C] shadow-[0_12px_30px_-12px_rgba(23,19,12,0.35)] transition-[background,transform] hover:bg-black/[0.03] active:scale-[0.99] dark:border-white/10 dark:bg-[#1c1c1e] dark:text-[#F7F3EA] dark:shadow-[0_12px_30px_-12px_rgba(0,0,0,0.6)] dark:hover:bg-[#26262a]"
          >
            <span className="inline-flex items-center gap-2">
              Claim your One
              <span aria-hidden>&rarr;</span>
            </span>
          </Button>
        </div>
      </div>
    </main>
  );
}
