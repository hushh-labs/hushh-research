"use client";

import Link from "next/link";
import { useCallback } from "react";
import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import styles from "./IntroStep.module.css";

/* ────────────────────────────────────────────────────────────
 * Welcome ("/"). A restrained, Foundation-warm canvas carries one centered
 * brand anchor, one "One" moment, and one clear next action. The public
 * destinations below the CTA are a real navigation group with equal targets,
 * not footer text that happens to be clickable.
 * ──────────────────────────────────────────────────────────── */

// One's four motions, shown as a quiet typographic rhythm — never as chips,
// never labeled "framework". Matches docs/vision/agent-ontology.md.
const MOTIONS = ["Listens", "Remembers", "Decides", "Acts"];

export function IntroStep({ onLogin }: { onLogin?: () => void }) {
  const claimOne = useCallback(() => {
    if (!onLogin) {
      return {
        status: "blocked" as const,
        summary:
          "Sign-in is not available yet. Please wait a moment and try again.",
      };
    }
    // Voice and tap intentionally share this one navigation path so a valid
    // post-sign-in redirect is preserved instead of rebuilt by the voice layer.
    onLogin();
    return {
      status: "started" as const,
      summary: "Opening sign-in.",
      routeAfter: ROUTES.LOGIN,
      screenAfter: "login",
    };
  }, [onLogin]);

  useLocalOnboardingActionHandler("onboarding.claim_one", claimOne);
  usePublishVoiceSurfaceMetadata({
    screenId: "one_intro",
    title: "Claim your One",
    purpose:
      "This is One's public welcome screen. The person can claim their private agent and continue to sign in.",
    actions: [
      {
        id: "onboarding_claim_one",
        actionId: "onboarding.claim_one",
        label: "Claim your One",
        purpose: "Continue to sign in and begin setting up One.",
        voiceAliases: [
          "claim your one",
          "claim one",
          "get started",
          "start with one",
        ],
      },
    ],
    controls: [
      {
        id: "onboarding_claim_one",
        actionId: "onboarding.claim_one",
        label: "Claim your One",
        type: "button",
        purpose: "Continue to sign in and begin setting up One.",
        voiceAliases: [
          "claim your one",
          "claim one",
          "get started",
          "start with one",
        ],
      },
    ],
  });

  return (
    <main className={styles.shell}>
      <OnboardingHeroBackground />

      <div className={styles.stage}>
        {/* One centered brand anchor keeps the page calm on both compact and
            wide surfaces; the old wordmark/emoji pair read as two competing
            logos rather than one header. */}
        <div className={styles.brand}>
          <HushhWordmark className={styles.wordmark} />
        </div>

        {/* ── Typography-led hero. No cards, no fake metrics. ── */}
        <div className={styles.hero}>
          <span className={styles.eyebrow}>
            Your private agent
          </span>

          <span
            aria-hidden="true"
            className={styles.emoji}
          >
            🤫
          </span>

          <h1 className={styles.title}>
            <span className={styles.molten}>
              One
            </span>
          </h1>

          <div
            aria-hidden
            className={styles.divider}
          />

          {/* Approved durable product line (docs/vision/agent-ontology.md
              Founder Copy Rules; brand punchline). Not ad-hoc copy. */}
          <p className={styles.tagline}>
            Your agents. Yours to own.
          </p>

          {/* Quiet rhythm line: the four motions, typographic not chip-like. */}
          <div className={styles.motions}>
            {MOTIONS.map((motion, i) => (
              <span key={motion} className={styles.motionItem}>
                {i > 0 && (
                  <span aria-hidden className={styles.motionDot}>
                    &middot;
                  </span>
                )}
                <span>{motion}</span>
              </span>
            ))}
          </div>

          <p className={styles.description}>
            Everything stays encrypted in your vault.
            <br />
            Nothing moves without your consent.
          </p>
        </div>

        {/* ── CTA: Morphy Button, ink surface, gradient ripple. Sits in the
              flex column normally (no absolute anchoring needed without the
              glass root constraint). Bottom padding clears the agent bar. ── */}
        <div className={styles.footer}>
          <button
            type="button"
            onClick={() => {
              void claimOne();
            }}
            data-voice-control-id="onboarding_claim_one"
            className={styles.cta}
          >
            <span className="relative z-0 inline-flex items-center gap-2">
              Claim your One
              <span aria-hidden>&rarr;</span>
            </span>
            <MaterialRipple variant="gradient" effect="fill" className="z-10" />
          </button>

          {/* Public destinations share the CTA width and use equal hit areas.
              That preserves discoverable navigation on small screens without
              letting the longest label push its siblings out of rhythm. */}
          <nav
            aria-label="Explore Hushh"
            className={styles.links}
          >
            <Link
              href={ROUTES.RESEARCH}
              className={styles.link}
            >
              Research
            </Link>
            <Link
              href={ROUTES.DEVELOPERS}
              className={styles.link}
            >
              Developers
            </Link>
          </nav>
        </div>
      </div>
    </main>
  );
}
