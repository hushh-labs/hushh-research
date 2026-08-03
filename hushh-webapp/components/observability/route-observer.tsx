"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { getRouteScope } from "@/lib/navigation/route-scope";
import { isAnalyticsExemptRoute } from "@/lib/navigation/routes";
import { captureGrowthAttribution } from "@/lib/observability/growth";
import { trackPageView } from "@/lib/observability/client";
import { useKaiSession } from "@/lib/stores/kai-session-store";

export function ObservabilityRouteObserver() {
  const pathname = usePathname();
  const mountedRef = useRef(false);
  const setLastKaiPath = useKaiSession((state) => state.setLastKaiPath);
  const setLastRiaPath = useKaiSession((state) => state.setLastRiaPath);

  useEffect(() => {
    // Wallet Profile visitors are strangers holding someone else's QR, not our
    // users. Bail before any capture — including the session-path writes, which
    // would otherwise persist a card token into local state.
    if (isAnalyticsExemptRoute(pathname)) {
      mountedRef.current = true;
      return;
    }
    captureGrowthAttribution(pathname);
    trackPageView(
      pathname,
      mountedRef.current ? "route_change" : "initial_load",
    );
    const scope = getRouteScope(pathname);
    if (scope === "investor") {
      setLastKaiPath(pathname);
    } else if (scope === "ria") {
      setLastRiaPath(pathname);
    }
    mountedRef.current = true;
  }, [pathname, setLastKaiPath, setLastRiaPath]);

  return null;
}
