"use client";

import { useCallback, useState } from "react";
import { GuestPreview } from "@/components/onboarding/guest-preview";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

export function IntroStep({ onLogin }: { onLogin?: () => void }) {
  const [previewReady, setPreviewReady] = useState(false);
  const claimOne = useCallback(() => {
    if (!previewReady)
      return {
        status: "blocked" as const,
        summary: "Explore One’s introduction before signing in.",
      };
    if (!onLogin)
      return {
        status: "blocked" as const,
        summary: "Sign-in is not available yet. Please try again.",
      };
    onLogin();
    return {
      status: "started" as const,
      summary: "Opening sign-in.",
      routeAfter: ROUTES.LOGIN,
      screenAfter: "login",
    };
  }, [onLogin, previewReady]);
  useLocalOnboardingActionHandler("onboarding.claim_one", claimOne);
  usePublishVoiceSurfaceMetadata({
    screenId: "one_intro",
    title: "Explore One",
    purpose:
      "See how One helps with everyday plans, saved details, and private sharing.",
    actions: [
      {
        id: "onboarding_claim_one",
        actionId: "onboarding.claim_one",
        label: "Get started",
        purpose: "Continue to sign in.",
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
        label: "Get started",
        type: "button",
        purpose: "Continue to sign in.",
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
    <GuestPreview
      publicLinks
      onReadyChange={setPreviewReady}
      onStart={() => {
        // The visible final-card CTA is an explicit sign-in choice. The voice
        // action above still waits until that card is the active screen.
        onLogin?.();
      }}
    />
  );
}
