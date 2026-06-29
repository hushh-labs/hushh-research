"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";

export default function OneHomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  // Dashboard uses coarse states only (no vault/oauth enrichment) so it stays
  // cheap; the /one/setup flow opts into full enrichment for skip-vs-continue.
  const { byId } = useCapabilitySetupStates();

  useEffect(() => {
    if (!loading && !user) {
      router.replace(
        `${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.ONE_HOME)}`,
      );
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <HushhLoader label="Opening One..." variant="fullscreen" />;
  }

  return (
    <>
      <NativeRouteMarker
        routeId="/one"
        marker="native-route-one-home"
        authState="authenticated"
        dataState="loaded"
      />
      <OneDashboardPage
        displayName={user.displayName || user.email}
        capabilityStatusById={byId}
      />
    </>
  );
}
