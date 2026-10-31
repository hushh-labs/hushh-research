"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { IntroV2Carousel } from "./IntroV2Carousel";
import { OneWelcomeStory } from "./OneWelcomeStory";
import introStyles from "./IntroV2Carousel.module.css";
import welcomeStyles from "./IntroStep.module.css";

export type GuestPreviewInvitation = {
  kind: "circle" | "connection";
  name?: string;
  ownerName?: string;
  loading?: boolean;
  error?: string | null;
  /** Definitively invalid/expired; a slow preview is not admission. */
  unavailable?: boolean;
  onRetry?: () => void;
};

/** The welcome illustration respects reduced motion and tab visibility. */
function usePreviewMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReducedMotion(preference.matches);
    const syncVisibility = () => setVisible(!document.hidden);
    syncMotion();
    syncVisibility();
    preference.addEventListener("change", syncMotion);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      preference.removeEventListener("change", syncMotion);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);
  return !reducedMotion && visible;
}

/** Presentation only. No account, membership, connector or sharing writes. */
export function GuestPreview({
  onStart,
  invitation,
  publicLinks = false,
  locationTypography = false,
  onReadyChange,
}: {
  onStart: () => void;
  invitation?: GuestPreviewInvitation;
  publicLinks?: boolean;
  /** Location's invitation host opts into its presentation scale only. */
  locationTypography?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  // Step zero is the existing public welcome screen. Steps one to four are V2.
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLDivElement>(null);
  const previousStepRef = useRef(step);
  const motionEnabled = usePreviewMotionPreference();

  useEffect(() => {
    onReadyChange?.(step === 4);
  }, [step, onReadyChange]);

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    const heading = step === 0
      ? headingRef.current
      : document.querySelector<HTMLElement>('[data-intro-v2-active-heading="true"]');
    const scrollRoot =
      heading?.closest('[data-app-scroll-root="true"]') ??
      document.scrollingElement;
    if (scrollRoot) scrollRoot.scrollTop = 0;
    heading?.focus({ preventScroll: true });
  }, [step]);

  function moveTo(next: number) {
    if (next < 0 || next > 4) return;
    setStep(next);
  }

  useBackLayer(ROUTES.HOME, invitation ? 0 : step, () => {
    if (step < 1) return false;
    moveTo(step - 1);
    return true;
  });

  const invitationContent = invitation ? (
    <>
      <strong data-location-type-role="section-heading" role="heading" aria-level={2}>
        {invitation.name ||
          (invitation.kind === "circle" ? "Your Circle invitation" : "Connect on One")}
      </strong>
      <span data-location-type-role="status" role="status">
        {invitation.loading
          ? "Checking your invitation…"
          : invitation.error
            ? invitation.error
            : invitation.ownerName
              ? "Invited by " + invitation.ownerName
              : "Sign in to continue with this invitation."}
      </span>
      {invitation.error && invitation.onRetry && (
        <button data-location-type-role="primary-action"
          type="button"
          className={introStyles["invite-retry"]}
          onClick={invitation.onRetry}
        >
          Try again
        </button>
      )}
    </>
  ) : undefined;

  const finalActionLabel = invitation?.kind === "circle"
    ? "Join this Circle"
    : invitation
      ? "Accept invitation"
      : "Get started";

  return (
    <FullscreenFlowShell
      width="expanded"
      className={step === 0 ? welcomeStyles.shell : introStyles["intro-shell"]}
      style={{ maxWidth: "none" }}
      data-testid="guest-preview"
      data-location-type-scale={locationTypography ? "connect" : undefined}
      data-location-type-context={locationTypography ? "flow" : undefined}
      data-preview-step={step + 1}
      data-has-invitation={Boolean(invitation)}
    >
      {step === 0 ? (
        <div className={welcomeStyles.stage}>
          <OneWelcomeStory headingRef={headingRef} motionEnabled={motionEnabled}>
            <footer className={welcomeStyles.footer}>
              <Button
                type="button"
                variant="blue"
                effect="fill"
                size="prominent"
                className={welcomeStyles.welcomeCta}
                onClick={() => moveTo(1)}
              >
                <span data-location-type-role="primary-action" className={welcomeStyles.ctaLabel}>Create your One</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M4 12h15M13 5l7 7-7 7" />
                </svg>
              </Button>
              {publicLinks && (
                <nav className={welcomeStyles.links} aria-label="Explore One">
                  <Link href={ROUTES.RESEARCH} className={welcomeStyles.link}>Research</Link>
                  <Link href={ROUTES.BLOG} className={welcomeStyles.link}>Blog</Link>
                  <Link href={ROUTES.DEVELOPERS} className={welcomeStyles.link}>Developers</Link>
                </nav>
              )}
            </footer>
          </OneWelcomeStory>
        </div>
      ) : (
        <IntroV2Carousel
          step={step}
          onStepChange={moveTo}
          onStart={onStart}
          finalActionLabel={finalActionLabel}
          finalActionDisabled={Boolean(invitation?.unavailable)}
          invitationContent={invitationContent}
        />
      )}
    </FullscreenFlowShell>
  );
}
