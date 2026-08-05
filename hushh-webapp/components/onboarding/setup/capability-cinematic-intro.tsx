"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import { Button } from "@/lib/morphy-ux/button";
import {
  getCapabilitySetupCopy,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import { type OneSetupCapabilityId } from "@/lib/onboarding/setup-capability-ids";

const INTRO_SESSION_KEY_PREFIX = "one_capability_intro_seen_v1";

/**
 * AI access is a root setup prerequisite, not an agent capability. It uses
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
      title: "AI access",
      setupTitle: "Choose how One reaches Gemini",
      setupBlurb: "Start with Gemini today. More models are on the way.",
      actionLabel: "Continue",
      resumeActionLabel: "Continue",
      href: "/one/setup/connections",
      introPremise: "Choose the intelligence behind your private agent.",
      introPromise: "Gemini is ready today. More models are coming soon.",
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

  const content = (
    <section
      className={`motion-step-enter relative mx-auto flex w-full max-w-[36rem] flex-col items-start ${
        embedded
          ? "min-h-[calc(100dvh-var(--top-shell-reserved-height)-var(--app-scroll-bottom-pad,0px))] justify-center"
          : ""
      }`}
      aria-labelledby={`capability-intro-${capabilityId}`}
      data-capability-cinematic-intro={capabilityId}
    >
      {capabilityId === "connections" ? (
        <ul
          className="mb-5 flex flex-wrap items-center gap-2"
          aria-label="AI providers"
          data-runtime-provider-lane
        >
          {RUNTIME_PROVIDER_CATALOG.map((provider) => (
            <li key={provider.id} className="relative">
              <span
                className="inline-flex h-12 w-12 items-center justify-center"
                title={
                  provider.availability === "available"
                    ? `${provider.name} is available now`
                    : `${provider.name} is coming soon`
                }
              >
                <RuntimeProviderMark
                  provider={provider}
                  className={provider.id === "gemini" ? "h-12 w-12" : undefined}
                />
              </span>
              <span className="sr-only">
                {provider.availability === "available"
                  ? `${provider.name} is available now.`
                  : `${provider.name} is coming soon.`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
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
            setShouldFocusCapabilityBody(true);
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
      className="justify-center"
    >
      {content}
    </FullscreenFlowShell>
  );
}
