"use client";

import { useCallback } from "react";
import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
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
    title: "Meet your agents",
    purpose:
      "This is One's public welcome screen. The person can continue to sign in.",
    actions: [
      {
        id: "onboarding_claim_one",
        actionId: "onboarding.claim_one",
        label: "Meet your agents",
        purpose: "Continue to sign in and begin setting up One.",
        voiceAliases: [
          "meet your agents",
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
        label: "Meet your agents",
        type: "button",
        purpose: "Continue to sign in and begin setting up One.",
        voiceAliases: [
          "meet your agents",
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
      <div className={styles.stage}>
        {/* One centered brand anchor keeps the page calm on both compact and
            wide surfaces; the old wordmark/emoji pair read as two competing
            logos rather than one header. */}
        <div className={styles.brand}>
          <HushhWordmark className={styles.wordmark} />
        </div>

        {/* ── Typography-led hero. No cards, no fake metrics. ── */}
        <div className={styles.hero}>
          <span
            aria-hidden="true"
            className={`hushh-brand-mark ${styles.emoji}`}
          >
            🤫
          </span>

          <h1 className={styles.title}>
            <span className={styles.molten}>
              One
            </span>
          </h1>

          <p className={styles.tagline}>
            Personal agents for everyday life.
          </p>

          <p className={styles.tagline}>
            One app to bring them together.
          </p>

          <p className={styles.tagline}>
            Your agents. Yours to own.
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
              Meet your agents
            </span>
            <MaterialRipple variant="gradient" effect="fill" className="z-10" />
          </button>

          <button
            type="button"
            onClick={() => {
              void claimOne();
            }}
            className={styles.signIn}
          >
            Already have One? Sign in
          </button>
        </div>
      </div>
    </main>
  );
}
