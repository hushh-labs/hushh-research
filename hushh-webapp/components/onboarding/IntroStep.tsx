"use client";

import Link from "next/link";
import { useCallback } from "react";
import { Lock } from "lucide-react";
import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import styles from "./IntroStep.module.css";

/* ────────────────────────────────────────────────────────────
 * Welcome ("/"). Three things in three seconds: this is One, One is a
 * personal assistant, tap Get started. Everything that used to explain the
 * product ahead of that decision — the eyebrow, the quiet mark, the divider,
 * the brand punchline, the four motions, the two privacy lines — is gone,
 * because a person deciding whether to begin does not read any of it.
 *
 * The public destinations below the button stay a real navigation group with
 * equal targets, not footer text that happens to be clickable.
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
    title: "Welcome",
    purpose:
      "This is One's public welcome screen. The person can get started and continue to sign in.",
    actions: [
      {
        id: "onboarding_claim_one",
        // The spoken label tracks the visible button so One never offers a
        // control the screen does not show. The action id, its target, and
        // every older phrasing stay exactly as they were.
        actionId: "onboarding.claim_one",
        label: "Get started",
        purpose: "Continue to sign in and begin setting up One.",
        voiceAliases: [
          "get started",
          "claim your one",
          "claim one",
          "start with one",
        ],
      },
    ],
    controls: [
      {
        id: "onboarding_claim_one",
        actionId: "onboarding.claim_one",
        label: "Get started",
        type: "button",
        purpose: "Continue to sign in and begin setting up One.",
        voiceAliases: [
          "get started",
          "claim your one",
          "claim one",
          "start with one",
        ],
      },
    ],
  });

  return (
    <main className={styles.shell}>
      <OnboardingHeroBackground variant="plain" />

      <div className={styles.stage}>
        {/* One centered brand anchor. The quiet mark is part of the brand,
            not decoration: "hushh" IS the shush. It sits with the wordmark as
            a single lockup rather than floating alone above One, so the brand
            reads as one thing and One stays the only bold element. */}
        <div className={styles.brand}>
          <HushhWordmark className={styles.wordmark} />
          <span aria-hidden className={styles.quietMark}>
            🤫
          </span>
        </div>

        {/* ── The single message: the name, then what it does. ── */}
        <div className={styles.hero}>
          <h1 className={styles.title}>
            <span className={styles.oneMark}>One</span>
          </h1>

          <p className={styles.tagline}>
            Your personal assistant for everyday tasks.
          </p>
        </div>

        {/* ── The single action, then the two quiet rows under it. ── */}
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
              Get started
              <span aria-hidden>&rarr;</span>
            </span>
            <MaterialRipple variant="gradient" effect="fill" className="z-10" />
          </button>

          {/* One line, not a privacy section. "Locked", "encrypted" and
              "consent" all made a person pause here; this says the only thing
              that changes their decision. */}
          <p className={styles.privacy}>
            <Lock aria-hidden className={styles.privacyIcon} />
            You control what you share.
          </p>

          {/* Public destinations share the button width and use equal hit
              areas, so the longest label never pushes its siblings out of
              rhythm on a small screen. */}
          <nav aria-label="Explore Hussh" className={styles.links}>
            <Link href={ROUTES.RESEARCH} className={styles.link}>
              Research
            </Link>
            <Link href={ROUTES.BLOG} className={styles.link}>
              Blog
            </Link>
            <Link href={ROUTES.DEVELOPERS} className={styles.link}>
              Developers
            </Link>
          </nav>
        </div>
      </div>
    </main>
  );
}
