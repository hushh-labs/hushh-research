"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";

export default function OneHomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  // Dashboard stays coarse (no vault/oauth enrichment) to stay cheap, but opts
  // into `enrichRia` — a single cached getOnboardingStatus call — so the
  // "N of 6 ready" count matches the /one/setup hub. Without it, an onboarded
  // RIA counts on the hub but not here (the count read "1 of 6" vs "2 of 6").
  const { byId } = useCapabilitySetupStates({ enrichRia: true });

  useEffect(() => {
    if (!loading && !user) {
      router.replace(
        `${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.ONE_HOME)}`,
      );
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <HushhLoader variant="page" label="Opening One…" />;
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
        userId={user.uid}
      />
    </>
  );
}
