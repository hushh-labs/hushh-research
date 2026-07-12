"use client";

import Link from "next/link";
import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";

/* ────────────────────────────────────────────────────────────
 * Welcome ("/"). A restrained, Foundation-warm canvas carries one centered
 * brand anchor, one "One" moment, and one clear next action. The public
 * destinations below the CTA are a real navigation group with equal targets,
 * not footer text that happens to be clickable.
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

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[34rem] flex-col items-center justify-between px-6 py-7 text-center sm:px-8 sm:py-8">
        {/* One centered brand anchor keeps the page calm on both compact and
            wide surfaces; the old wordmark/emoji pair read as two competing
            logos rather than one header. */}
        <div
          className="one-reveal flex w-full items-center justify-center pt-[var(--app-safe-area-top-effective,0px)]"
          style={{ ["--seq-delay" as string]: "80ms" }}
        >
          <HushhWordmark className="h-8 sm:h-9" />
        </div>

        {/* ── Typography-led hero. No cards, no fake metrics. ── */}
        <div className="flex w-full max-w-[30rem] flex-1 flex-col items-center justify-center">
          <span
            className="one-reveal type-caption text-[color:var(--foundation-dim)]"
            style={{ ["--seq-delay" as string]: "220ms" }}
          >
            Your private agent
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

          <div
            aria-hidden
            className="one-reveal mt-8 h-px w-full bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--foundation-gold-deep)_34%,transparent),transparent)] dark:bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--foundation-gold-accent)_30%,transparent),transparent)]"
            style={{ ["--seq-delay" as string]: "370ms" }}
          />

          {/* Approved durable product line (docs/vision/agent-ontology.md
              Founder Copy Rules; brand punchline). Not ad-hoc copy. */}
          <p
            className="one-reveal mt-8 max-w-[20rem] text-[19px] font-medium leading-[1.4] tracking-[-0.2px] text-[color:var(--foundation-ink)] dark:text-[#F7F3EA]"
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
            className="one-reveal mt-6 max-w-[19rem] text-[13px] leading-[1.5] text-[color:var(--foundation-dim)]"
            style={{ ["--seq-delay" as string]: "580ms" }}
          >
            Everything stays encrypted in your vault. Nothing moves without your consent.
          </p>
        </div>

        {/* ── CTA: Morphy Button, ink surface, gradient ripple. Sits in the
              flex column normally (no absolute anchoring needed without the
              glass root constraint). Bottom padding clears the agent bar. ── */}
        <div
          className="one-reveal w-full max-w-[30rem] pb-[calc(102px+var(--app-safe-area-bottom-effective,0px))]"
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

          {/* Public destinations share the CTA width and use equal hit areas.
              That preserves discoverable navigation on small screens without
              letting the longest label push its siblings out of rhythm. */}
          <nav
            aria-label="Explore Hushh"
            className="one-reveal mt-3 grid w-full grid-cols-3 divide-x divide-[color:var(--foundation-hairline)] border-t border-[color:var(--foundation-hairline)] pt-3 text-[12px] font-medium text-[color:var(--foundation-dim)] dark:divide-white/10 dark:border-white/10"
            style={{ ["--seq-delay" as string]: "760ms" }}
          >
            <Link
              href={ROUTES.RESEARCH}
              className="flex min-h-11 items-center justify-center px-2 text-center leading-tight transition-colors hover:text-[color:var(--foundation-ink)] dark:hover:text-[#F7F3EA]"
            >
              Research
            </Link>
            <Link
              href={ROUTES.BLOG}
              className="flex min-h-11 items-center justify-center px-2 text-center leading-tight transition-colors hover:text-[color:var(--foundation-ink)] dark:hover:text-[#F7F3EA]"
            >
              Blog
            </Link>
            <Link
              href={ROUTES.DEVELOPERS}
              className="flex min-h-11 items-center justify-center px-2 text-center leading-tight transition-colors hover:text-[color:var(--foundation-ink)] dark:hover:text-[#F7F3EA]"
            >
              Developers
            </Link>
          </nav>
        </div>
      </div>
    </main>
  );
}
