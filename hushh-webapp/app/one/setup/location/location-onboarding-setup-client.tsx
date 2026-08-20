"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import OneLocationAgentPage from "@/app/one/location/page";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export const LOCATION_COMPLETION_RETURN_DELAY_MS = 4_000;

export function LocationOnboardingCompletedScreen({
  onReturn,
}: {
  onReturn: () => void;
}) {
  const returnedRef = useRef(false);
  const returnOnce = useCallback(() => {
    if (returnedRef.current) return;
    returnedRef.current = true;
    onReturn();
  }, [onReturn]);

  useEffect(() => {
    const returnTimer = window.setTimeout(
      returnOnce,
      LOCATION_COMPLETION_RETURN_DELAY_MS,
    );
    return () => window.clearTimeout(returnTimer);
  }, [returnOnce]);

  usePublishVoiceSurfaceMetadata({
    screenId: "one_setup_location_complete",
    title: "Location setup complete",
    purpose: "Confirm Location is already set up before returning to setup.",
    primaryEntity: "Location",
    actions: [
      {
        id: "return_to_setup",
        label: "Back to setup",
        purpose: "Return to the One setup hub.",
      },
    ],
    controls: [
      {
        id: "one_setup_location_complete_return",
        label: "Back to setup",
        type: "button",
        purpose: "Return to the One setup hub.",
      },
    ],
    availableActions: ["Back to setup"],
  });

  return (
    <FullscreenFlowShell
      width="reading"
      className="min-h-[calc(100dvh-var(--top-shell-reserved-height,0px))] justify-start px-[var(--page-inline-gutter-standard)] pb-10 pt-[max(56px,calc(env(safe-area-inset-top)+36px))] [--type-agent-title-line:37px] [--type-agent-title-size:34px] [--type-agent-title-tracking:-0.9px] [--type-agent-title-weight:600] sm:[--type-agent-title-line:48px] sm:[--type-agent-title-size:44px] sm:[--type-agent-title-tracking:-1.1px]"
      data-testid="location-onboarding-completed"
    >
      <section
        className="motion-step-enter mx-auto flex w-full max-w-[34rem] flex-col items-center text-center"
        aria-labelledby="location-onboarding-completed-title"
      >
        <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[var(--app-radius-md)] bg-[color:var(--app-success)]/12 text-[color:var(--app-success)]">
          <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
        </span>
        <p className="mt-5 text-[13px] font-normal leading-[18px] text-muted-foreground">
          One · Location
        </p>
        <h1
          id="location-onboarding-completed-title"
          className="ui-text-agent-title mt-2 max-w-[18ch] text-balance"
        >
          Your Location onboarding is complete
        </h1>
        <p className="mt-3 max-w-[34rem] text-pretty text-[15px] font-normal leading-[20px] text-muted-foreground">
          Everything is ready. You can manage Location anytime from One.
        </p>
        <div className="mt-8 w-full max-w-[30rem]">
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="lg"
            fullWidth
            className="min-h-14 justify-center text-center"
            onClick={returnOnce}
            data-testid="location-onboarding-completed-return"
            data-voice-control-id="one_setup_location_complete_return"
          >
            Back to setup
          </Button>
        </div>
        <p
          className="mt-3 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          Returning automatically in a few seconds.
        </p>
      </section>
    </FullscreenFlowShell>
  );
}

export function LocationOnboardingSetupClient() {
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "location",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_location",
    skipActionId: "setup.skip_location",
    terminalPresentation: "automatic",
  });

  if (!coordinator.isReady)
    return <SetupCapabilityLoading label="Preparing location setup…" />;

  if (coordinator.isAlreadyComplete) {
    return (
      <LocationOnboardingCompletedScreen onReturn={coordinator.returnToSetup} />
    );
  }

  // No cinematic intro and no permission primer here any more. Both sat in
  // front of the flow's own welcome screen, which already frames the value, and
  // the features screen already requests Location and notifications the moment
  // it opens -- so the primer was asking a second time for the same thing. That
  // put first-run Location at five taps; it is now three. Other capabilities
  // keep their intro gate: this is a Location-only change.
  return (
    <OneLocationAgentPage
      mode="setup"
      onSetupReadinessChange={setReady}
      onSetupComplete={async () => {
        await toast
          .promise(
            coordinator.finish({ suppressErrorToast: true }).then((result) => {
              if (result.status !== "succeeded")
                throw new Error(result.summary);
              return result;
            }),
            {
              loading: "Finishing Location setup…",
              success: (result) => result.summary,
              error: "Location setup could not be saved. Please try again.",
            },
          )
          .unwrap();
      }}
      onSetupSkip={async () => {
        await toast
          .promise(
            coordinator.skip({ suppressErrorToast: true }).then((result) => {
              if (result.status !== "succeeded")
                throw new Error(result.summary);
              return result;
            }),
            {
              loading: "Skipping Location setup…",
              success: (result) => result.summary,
              error: "Location setup could not be updated. Please try again.",
            },
          )
          .unwrap();
      }}
    />
  );
}
