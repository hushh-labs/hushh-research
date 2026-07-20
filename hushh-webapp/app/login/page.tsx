"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AuthStep } from "@/components/onboarding/AuthStep";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";

function LoginContent() {
  const searchParams = useSearchParams();
  // Empty means an organic sign-in. Do not manufacture `/` as a redirect:
  // it is the public welcome route and must never participate in private
  // capability/persona routing after authentication.
  const redirectPath = searchParams.get("redirect") || "";

  return (
    <>
      <AuthStep redirectPath={redirectPath} compact />
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
      <Suspense fallback={null}>
        <LoginContent />
      </Suspense>
    </>
  );
}
