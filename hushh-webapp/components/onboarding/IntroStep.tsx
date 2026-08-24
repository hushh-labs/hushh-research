"use client";

import Link from "next/link";
import { useCallback } from "react";

import dynamic from "next/dynamic";

import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import GlassSurface from "@/components/react-bits/GlassSurface";
import { LandingAurora } from "@/components/onboarding/LandingAurora";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import styles from "./IntroStep.module.css";

/* The lens pulls in three/@react-three/fiber/drei. Loading it lazily and
 * client-only keeps that entire graph out of the welcome screen's first
 * payload — the component decides for itself whether to mount at all, and on
 * touch or reduced-motion it never does, so the chunk is never fetched. */
const FluidGlassLens = dynamic(
  () => import("@/components/react-bits/FluidGlassLens"),
  { ssr: false },
);

/* ────────────────────────────────────────────────────────────
 * Welcome ("/"). One screen, no scroll — the same composition as before,
 * with the material and the fit fixed rather than the content changed.
 *
 * What was broken: the screen locked itself to exactly one viewport and
 * clipped anything that did not fit, so on short viewports the brand mark
 * collided with the quiet mark and the closing line was sliced in half by
 * the CTA. That was a sizing bug, not a content problem — every element
 * here is the one that was here before. The fix is in the CSS: the column
 * scales its own rhythm to the space it actually has, so it fits on one
 * screen instead of being cut to fit.
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
      <LandingAurora />
      <FluidGlassLens />

      <div className={styles.stage}>
        {/* ── Brand bar: React Bits GlassSurface. A real refracting pane
              (three per-channel displacement passes, hence the chromatic
              fringe at the rim) rather than a blurred rectangle. It is the
              one piece of chrome on this screen, so it is the one place the
              material is worth paying for. ── */}
        <GlassSurface
          width="100%"
          height={54}
          borderRadius={999}
          /* Softer than the component's default (-180): at full strength the
             displacement smears the wordmark's own edges, and the bar has to
             stay legible before it is decorative. */
          distortionScale={-92}
          redOffset={0}
          greenOffset={8}
          blueOffset={16}
          blur={12}
          saturation={1.15}
          backgroundOpacity={0.04}
          className={styles.brandBar}
        >
          <div className={styles.brandBarContent}>
            <HushhWordmark className={styles.wordmark} />

            {/* Public destinations. A real navigation group with equal
                targets, not footer text that happens to be clickable. */}
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
        </GlassSurface>

        {/* ── Typography-led hero. No cards, no fake metrics. ── */}
        <div className={styles.hero}>
          <span className={styles.eyebrow}>Your private agent</span>

          <span aria-hidden="true" className={styles.emoji}>
            🤫
          </span>

          <h1 className={styles.title}>
            <span className={styles.molten}>One</span>
          </h1>

          <div aria-hidden className={styles.divider} />

          {/* Approved durable product line (docs/vision/agent-ontology.md
              Founder Copy Rules; brand punchline). Not ad-hoc copy. */}
          <p className={styles.tagline}>Your agents. Yours to own.</p>

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

          {/* Plain words only. "Encrypted" and "consent" are the mechanism and
              the legal term; "locked" and "your yes" are what a person actually
              pictures. "Vault" is a code noun and never appears in copy. */}
          <p className={styles.description}>
            Everything you save stays locked.
            <br />
            Nothing moves without your yes.
          </p>
        </div>

        {/* ── CTA. The one solid element on a screen otherwise made of glass,
              which is what keeps it reading as the thing to press. ── */}
        <div className={styles.footer}>
          <button
            type="button"
            onClick={() => {
              void claimOne();
            }}
            data-voice-control-id="onboarding_claim_one"
            className={styles.cta}
          >
            <span className={styles.ctaLabel}>
              Claim your One
              <span aria-hidden>&rarr;</span>
            </span>
            <MaterialRipple variant="gradient" effect="fill" className="z-10" />
          </button>
        </div>
      </div>
    </main>
  );
}
