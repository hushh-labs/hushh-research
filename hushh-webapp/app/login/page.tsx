"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AuthStep } from "@/components/onboarding/AuthStep";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

function LoginContent() {
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || ROUTES.HOME;

  // Publish screen context so the onboarding guide knows the person is on the
  // sign-in screen (not, say, phone verification) and greets/orients them into
  // signing in. The action ids are the generated gateway contracts already
  // reachable on the "login" screen, so voice proposals stay inside the
  // governed action plane. Keeps parity with the getting-started welcome.
  usePublishVoiceSurfaceMetadata({
    screenId: "login",
    title: "Sign in to One",
    purpose:
      "This is the sign-in screen. Welcome the person in and help them sign in with Apple or Google so they can open their private vault. A verified phone number is required afterward.",
    actions: [
      {
        id: "auth.sign_in_google",
        actionId: "auth.sign_in_google",
        label: "Continue with Google",
        purpose: "Open Google sign-in.",
      },
      {
        id: "auth.sign_in_apple",
        actionId: "auth.sign_in_apple",
        label: "Continue with Apple",
        purpose: "Open Apple sign-in.",
      },
      {
        id: "route.getting_started",
        actionId: "route.getting_started",
        label: "Back to welcome",
        purpose: "Return to the welcome carousel.",
      },
    ],
  });

  return (
    <>
      <AuthStep
        redirectPath={redirectPath}
        compact
      />
    </>
  );
}

export default function LoginPage() {
  return (
    <>
      <NativeRouteMarker
        routeId="/login"
        marker="native-route-login"
        authState="anonymous"
        dataState="loaded"
      />
      <Suspense fallback={<HushhLoader label="Loading login..." variant="fullscreen" />}>
        <LoginContent />
      </Suspense>
    </>
  );
}
