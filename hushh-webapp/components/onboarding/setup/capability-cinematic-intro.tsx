"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { Button } from "@/lib/morphy-ux/button";
import {
  getCapabilitySetupCopy,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import { type OneSetupCapabilityId } from "@/lib/onboarding/setup-capability-ids";

const INTRO_SESSION_KEY_PREFIX = "one_capability_intro_seen_v1";

/**
 * Connections is a root setup prerequisite, not an agent capability. It uses
 * the same presentational prologue without entering the capability catalog or
 * generated action registry.
 */
export type CapabilityCinematicIntroId = OneSetupCapabilityId | "connections";

export function capabilityCinematicIntroSessionKey(
  capabilityId: CapabilityCinematicIntroId,
): string {
  return `${INTRO_SESSION_KEY_PREFIX}:${capabilityId}`;
}

function hasSeenCapabilityIntro(
  capabilityId: CapabilityCinematicIntroId,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.sessionStorage.getItem(
        capabilityCinematicIntroSessionKey(capabilityId),
      ) === "1"
    );
  } catch {
    // Private browser settings can deny session storage. A repeatable visual
    // introduction is safe; setup and OAuth state remain completely separate.
    return false;
  }
}

function markCapabilityIntroSeen(capabilityId: CapabilityCinematicIntroId) {
  try {
    window.sessionStorage.setItem(
      capabilityCinematicIntroSessionKey(capabilityId),
      "1",
    );
  } catch {
    // Do not let presentation storage prevent entry into a real capability.
  }
}

function fallbackCopy(
  capabilityId: CapabilityCinematicIntroId,
): CapabilitySetupCopy {
  if (capabilityId === "connections") {
    return {
      id: capabilityId,
      title: "Connections",
      setupTitle: "Choose how One runs",
      setupBlurb: "Pick the option that feels right for you.",
      actionLabel: "Continue",
      resumeActionLabel: "Continue",
      href: "/one/setup/connections",
      introPremise: "One gets more useful when you choose its starting point.",
      introPromise:
        "Choose the way One works for you. You can change it later.",
    };
  }

  return {
    id: capabilityId,
    title: capabilityId,
    setupTitle: `Set up ${capabilityId}`,
    setupBlurb: "Choose how One can help with this part of your life.",
    actionLabel: "Continue",
    resumeActionLabel: "Continue",
    href: "/one/setup",
    introPremise: "A more personal way to get things done.",
    introPromise: "You stay in control at every step.",
  };
}

/**
 * A session-scoped visual prologue for a capability journey.
 *
 * It deliberately owns no setup, consent, OAuth, or completion state. The
 * body remains mounted only after Continue; returning from an OAuth callback
 * observes the same session latch and resumes that body immediately.
 */
export function CapabilityCinematicIntroGate({
  capabilityId,
  children,
  embedded = false,
}: {
  capabilityId: CapabilityCinematicIntroId;
  children: ReactNode;
  /** The owning flow already provides its canonical FullscreenFlowShell. */
  embedded?: boolean;
}) {
  const [showIntro, setShowIntro] = useState(true);
  const copy =
    getCapabilitySetupCopy(capabilityId) ?? fallbackCopy(capabilityId);

  // This runs before the browser paints a callback return. Server-rendered
  // first entry still contains the semantic introduction, while an OAuth
  // callback with a session latch resumes its real body without a visual flash.
  useLayoutEffect(() => {
    setShowIntro(!hasSeenCapabilityIntro(capabilityId));
  }, [capabilityId]);

  if (!showIntro) return <>{children}</>;

  const premise = copy.introPremise ?? copy.setupTitle;
  const promise = copy.introPromise ?? copy.setupBlurb;

  const content = (
    <section
      className={`motion-step-enter relative isolate mx-auto flex w-full max-w-[36rem] flex-col items-start overflow-hidden ${
        embedded
          ? "min-h-[calc(100dvh-var(--top-shell-reserved-height)-var(--app-scroll-bottom-pad,0px))] justify-center px-[var(--page-inline-gutter-standard)] pb-[var(--app-scroll-bottom-pad)] pt-[var(--top-content-pad)]"
          : ""
      }`}
      aria-labelledby={`capability-intro-${capabilityId}`}
      data-capability-cinematic-intro={capabilityId}
    >
      {/* Decorative only: copy remains semantic and immediately available. */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        aria-hidden="true"
      >
        <span className="absolute -left-20 top-[18%] h-52 w-52 rounded-full bg-[var(--app-accent-tint)] blur-3xl" />
        <span className="absolute -right-16 bottom-[14%] h-40 w-40 rounded-full bg-[var(--app-accent-tint)] blur-3xl" />
      </div>
      <p className="type-subhead text-muted-foreground">One · {copy.title}</p>
      <h1
        id={`capability-intro-${capabilityId}`}
        className="mt-4 max-w-[16ch] text-balance type-display text-foreground"
      >
        {premise}
      </h1>
      <p className="mt-5 max-w-[34rem] text-pretty type-title3 text-muted-foreground">
        {promise}
      </p>
      <div className="mt-10 w-full max-w-[30rem] self-center">
        <Button
          type="button"
          variant="blue-gradient"
          effect="fill"
          size="lg"
          fullWidth
          className="min-h-14 justify-center text-center"
          onClick={() => {
            markCapabilityIntroSeen(capabilityId);
            setShowIntro(false);
          }}
          data-capability-intro-continue={capabilityId}
        >
          Continue
        </Button>
      </div>
    </section>
  );

  if (embedded) return content;

  return (
    <FullscreenFlowShell
      width="reading"
      className="min-h-[calc(100dvh-var(--app-scroll-bottom-pad,0px))] justify-center px-[var(--page-inline-gutter-standard)] pb-[var(--app-scroll-bottom-pad)] pt-[var(--top-content-pad)]"
    >
      {content}
    </FullscreenFlowShell>
  );
}
