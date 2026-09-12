"use client";

import Link from "next/link";
import { useCallback } from "react";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import {
  FigmaHushhLogo,
  FigmaIllustration,
  FigmaOneLogo,
  FigmaPrivacyNote,
} from "@/components/onboarding/FigmaOnboardingPrimitives";
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
    <main className={styles.shell} data-testid="one-intro-screen">
      <OnboardingHeroBackground />

      <div className={styles.stage}>
        <div className={styles.composition}>
          <FigmaHushhLogo className={styles.brand} />
          <FigmaIllustration variant="intro" className={styles.illustration} />
          <div className={styles.hero}>
            <h1 className={styles.title} aria-label="One">
              <span className={styles.srOnly}>One</span>
              <FigmaOneLogo />
            </h1>
            <p className={styles.tagline}>Your agents. Yours to own.</p>
            <p className={styles.subtitle}>Your private network of AI agents</p>
          </div>
          <div className={styles.footer}>
            <div className={styles.privacy}>
              <FigmaPrivacyNote>
                You have full control over your data.
                <br />
                Your data. Your rules.
              </FigmaPrivacyNote>
            </div>
          <button
            type="button"
            onClick={() => {
              void claimOne();
            }}
            data-voice-control-id="onboarding_claim_one"
            className={styles.cta}
          >
            <span className="relative z-0 inline-flex items-center gap-2">
              Create your One
              <span aria-hidden>&rarr;</span>
            </span>
            <MaterialRipple variant="gradient" effect="fill" className="z-10" />
          </button>

            <nav aria-label="Explore Hussh" className={styles.links}>
              <Link href={ROUTES.RESEARCH} className={styles.link}>Research</Link>
              <Link href={ROUTES.BLOG} className={styles.link}>Blog</Link>
              <Link href={ROUTES.DEVELOPERS} className={styles.link}>Developers</Link>
            </nav>
          </div>
        </div>
      </div>
    </main>
  );
}
