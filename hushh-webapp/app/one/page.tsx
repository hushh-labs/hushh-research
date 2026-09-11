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
  // Keep the home admission path coarse. RIA and Finance own their respective
  // status reads and cache warmups once a person opens those workspaces; doing
  // that speculative work here competes with a secure-session revalidation on
  // a cold local runtime.
  const { byId } = useCapabilitySetupStates();

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
