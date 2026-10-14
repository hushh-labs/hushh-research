"use client";

import type { ReactNode } from "react";
import { AgentOneOnboarding } from "./mentor-onboarding/AgentOneOnboarding";

/** The existing welcome/invitation host owns admission and routing. */
export function IntroV2Carousel({
  step, onStepChange, onStart, finalActionLabel = "Get started",
  finalActionDisabled = false, invitationContent,
}: {
  step: number;
  onStepChange: (step: number) => void;
  onStart: () => void;
  finalActionLabel?: string;
  finalActionDisabled?: boolean;
  invitationContent?: ReactNode;
}) {
  return (
    <AgentOneOnboarding
      index={step - 1}
      onIndexChange={(index) => onStepChange(index + 1)}
      onComplete={() => onStart()}
      finalActionLabel={finalActionLabel}
      finalActionDisabled={finalActionDisabled}
      invitationContent={invitationContent}
    />
  );
}
