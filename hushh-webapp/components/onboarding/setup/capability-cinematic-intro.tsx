"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/lib/morphy-ux/button";
import { FLOW_ACTION_MEASURE_CLASSNAME } from "@/components/app-ui/flow-actions";
import {
  getCapabilitySetupCopy,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import { type OneSetupCapabilityId } from "@/lib/onboarding/setup-capability-ids";

const INTRO_SESSION_KEY_PREFIX = "one_capability_intro_seen_v1";

/**
 * AI access is deliberately NOT in this union. It is the one mandatory step
 * that blocks finishing setup, so it opens its real choice directly from the
 * hub instead of a prologue with its own Continue button in front of it.
 */
export type CapabilityCinematicIntroId = OneSetupCapabilityId;

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
  introSupplement,
  embedded = false,
  routeOwnsTopOffset: _routeOwnsTopOffset = false,
}: {
  capabilityId: CapabilityCinematicIntroId;
  children: ReactNode;
  /** Optional capability-specific value summary shown only in the visual prologue. */
  introSupplement?: ReactNode;
  /** The owning flow already provides its canonical FullscreenFlowShell. */
  embedded?: boolean;
  /** The standard route shell already contributes the fixed-header clearance. */
  routeOwnsTopOffset?: boolean;
}) {
  const [showIntro, setShowIntro] = useState(true);
  const [shouldFocusCapabilityBody, setShouldFocusCapabilityBody] =
    useState(false);
  const capabilityBodyRef = useRef<HTMLDivElement>(null);
  const copy =
    getCapabilitySetupCopy(capabilityId) ?? fallbackCopy(capabilityId);

  // This runs before the browser paints a callback return. Server-rendered
  // first entry still contains the semantic introduction, while an OAuth
  // callback with a session latch resumes its real body without a visual flash.
  useLayoutEffect(() => {
    setShowIntro(!hasSeenCapabilityIntro(capabilityId));
  }, [capabilityId]);

  // Continue removes the focused intro button. Move focus to the incoming
  // semantic screen only for that explicit handoff, without stealing focus
  // from a session-latched OAuth callback or a capability body's own control.
  useLayoutEffect(() => {
    if (showIntro || !shouldFocusCapabilityBody) return;
    const capabilityBody = capabilityBodyRef.current;
    const activeElement = document.activeElement;
    // A capability can claim an authored focus target during the same commit.
    // The shared container is only the fallback when focus would otherwise be
    // stranded on the removed Continue button or the document itself.
    if (
      capabilityBody &&
      (!activeElement ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        !capabilityBody.contains(activeElement))
    ) {
      capabilityBody.focus({ preventScroll: true });
    }
    setShouldFocusCapabilityBody(false);
  }, [showIntro, shouldFocusCapabilityBody]);

  // Lock body scroll while the intro is visible to remove any excess blank
  // space or tiny scrollbars caused by layout math mismatches with the voice bar.
  useLayoutEffect(() => {
    if (!showIntro) return;

    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, [showIntro]);

  // The prologue and the real capability body are two semantic screens inside
  // one route. Give the incoming body the same canonical in-route enter that
  // every controlled setup step uses; returning a raw fragment here made
  // Continue feel like a hard cut even though the intro itself revealed.
  if (!showIntro) {
    return (
      <div
        ref={capabilityBodyRef}
        className="motion-step-enter w-full"
        data-capability-cinematic-body={capabilityId}
        tabIndex={-1}
      >
        {children}
      </div>
    );
  }

  const premise = copy.introPremise ?? copy.setupTitle;
  const promise = copy.introPromise ?? copy.setupBlurb;
  const introLayoutClass =
    "motion-step-enter fixed inset-0 z-[5] mx-auto flex w-full flex-col items-center overflow-y-auto overscroll-contain bg-[color:var(--app-settings-canvas)] px-4 pb-[calc(var(--onboarding-agent-bar-clearance,4rem)+1rem)] pt-[var(--top-shell-reserved-height,60px)] text-center";

  const content = (
    <section
      // This is the intro's scroll owner. The inner block centers when it fits
      // and remains fully reachable in landscape or with larger text.
      className={introLayoutClass}
      aria-labelledby={`capability-intro-${capabilityId}`}
      data-capability-cinematic-intro={capabilityId}
    >
      <div className="my-auto flex w-full shrink-0 flex-col items-center py-6">
        <p className="ui-text-eyebrow text-muted-foreground">
          One · {copy.title}
        </p>
        <h1
          id={`capability-intro-${capabilityId}`}
          className="ui-text-large-page-title mt-4 max-w-[18ch] text-balance text-foreground"
        >
          {premise}
        </h1>
        <p className="ui-text-page-subtitle mt-4 max-w-[30rem] text-pretty text-muted-foreground">
          {promise}
        </p>
        {introSupplement ? (
          <div className="mt-8 w-full max-w-[34rem]">{introSupplement}</div>
        ) : null}
        <div className={`${FLOW_ACTION_MEASURE_CLASSNAME} mt-8`}>
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="prominent"
            fullWidth
            className="justify-center text-center"
            onClick={() => {
              markCapabilityIntroSeen(capabilityId);
              setShouldFocusCapabilityBody(true);
              setShowIntro(false);
            }}
            data-capability-intro-continue={capabilityId}
          >
            Continue
          </Button>
        </div>
      </div>
    </section>
  );

  if (embedded) return content;

  return content;
}
