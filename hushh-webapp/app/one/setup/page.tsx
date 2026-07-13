"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";

export default function OneSetupPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      const currentPath =
        typeof window === "undefined"
          ? ROUTES.ONE_SETUP
          : window.location.pathname +
            window.location.search +
            window.location.hash;
      router.replace(
        `${ROUTES.LOGIN}?redirect=${encodeURIComponent(currentPath)}`,
      );
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <RouteLoadingState surface="onboarding" label="Preparing setup…" />;
  }

  return (
    <>
      <NativeRouteMarker
        routeId="/one/setup"
        marker="native-route-one-setup"
        authState="authenticated"
        dataState="loaded"
      />
      <OneSetupHub />
    </>
  );
}
