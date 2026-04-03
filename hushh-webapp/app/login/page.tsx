"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AuthStep } from "@/components/onboarding/AuthStep";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { ROUTES } from "@/lib/navigation/routes";

function LoginContent() {
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || ROUTES.KAI_HOME;

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
