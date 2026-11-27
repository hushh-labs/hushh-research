"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { RouteErrorBoundary } from "@/components/app-ui/route-error-boundary";
import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { isByocSelectableOnBuild, isPooledSandboxSwitchAvailable } from "@/lib/one/owner-cloud";

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
    return (
      <HushhLoader
        stage={loading ? "session" : "redirect"}
        label="Preparing setup…"
        holdThroughNavigation={!loading}
      />
    );
  }

  // Keep setup failures within the route instead of crashing the shell.
  return (
    <RouteErrorBoundary fallbackRoute={ROUTES.ONE_HOME}>
      {isPooledSandboxSwitchAvailable() && isByocSelectableOnBuild() ? (
        <Suspense fallback={null}>
          <ByocCloudSetupPage owningRoute={ROUTES.ONE_SETUP} />
        </Suspense>
      ) : (
        <OneSetupHub />
      )}
    </RouteErrorBoundary>
  );
}
