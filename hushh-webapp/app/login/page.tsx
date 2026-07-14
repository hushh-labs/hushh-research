"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AuthStep } from "@/components/onboarding/AuthStep";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { ROUTES } from "@/lib/navigation/routes";

function LoginContent() {
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || ROUTES.HOME;

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
