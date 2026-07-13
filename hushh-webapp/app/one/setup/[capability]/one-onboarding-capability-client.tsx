"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { getOneSetupCapability } from "@/lib/onboarding/one-capabilities";
import {
  buildOneSetupCapabilityRoute,
  ROUTES,
} from "@/lib/navigation/routes";

/**
 * Compatibility-only legacy route.
 *
 * Physical setup workspaces are static pages. This dynamic segment does not
 * publish actions, mutate journey progress, or interpret `?finish=1`; it only
 * sends known old deep links to their canonical route and contains unknown
 * paths at the hub.
 */
export function OneOnboardingCapabilityClient({
  capabilityId,
}: {
  capabilityId: string;
}) {
  const router = useRouter();
  const target = getOneSetupCapability(capabilityId)
    ? buildOneSetupCapabilityRoute(capabilityId)
    : ROUTES.ONE_SETUP;

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return <RouteLoadingState label="Opening setup…" />;
}
