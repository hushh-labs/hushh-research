"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";

function GettingStartedContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const loginUrl = redirectPath
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.LOGIN;

  const { user, loading } = useAuth();

  // The marketing carousel is disabled for now: signed-out visitors go straight
  // to sign-in, signed-in users go to their home.
  useEffect(() => {
    if (loading) return;
    router.replace(user ? ROUTES.ONE_HOME : loginUrl);
  }, [loading, user, router, loginUrl]);

  return <HushhLoader variant="fullscreen" label="Preparing welcome…" />;
}

export default function GettingStartedPage() {
  return (
    <>
      <NativeRouteMarker
        routeId={ROUTES.GETTING_STARTED}
        marker="native-route-getting-started"
        authState="anonymous"
        dataState="loaded"
      />
      <Suspense fallback={null}>
        <GettingStartedContent />
      </Suspense>
    </>
  );
}
