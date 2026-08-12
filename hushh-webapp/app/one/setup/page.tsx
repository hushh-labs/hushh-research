"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";
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
    return <HushhLoader variant="page" label="Preparing setup…" />;
  }

  return (
    <>
      <NativeRouteMarker
        routeId="/one/setup"
        marker="native-route-one-setup"
        authState="authenticated"
        dataState="loaded"
      />
      {/* A render error in the setup hub used to take down the whole native
          shell (the TestFlight "Hussh One … Crashed" alert). Wrapping the hub
          in the shared route error boundary contains any such failure to a
          recoverable in-app screen (Retry / Go home) instead of crashing. */}
      <RouteErrorBoundary fallbackRoute={ROUTES.ONE_HOME}>
        <OneSetupHub />
      </RouteErrorBoundary>
    </>
  );
}
