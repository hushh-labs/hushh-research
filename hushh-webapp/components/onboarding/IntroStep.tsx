"use client";

import { useCallback, useState } from "react";
import { GuestPreview } from "@/components/onboarding/guest-preview";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export function IntroStep({ onLogin }: { onLogin?: () => void }) {
  const [previewReady, setPreviewReady] = useState(false);
  const claimOne = useCallback(() => {
    if (!previewReady)
      return {
        status: "blocked" as const,
        summary: "Explore the three introduction screens before signing in.",
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
      "Explore Circles and private agents without signing in. Sign in only to get started.",
    actions: [
      {
        id: "onboarding_claim_one",
        actionId: "onboarding.claim_one",
        label: "Create your One",
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
        label: "Create your One",
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
        void claimOne();
      }}
    />
  );
}
