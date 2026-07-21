"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { trackEvent } from "@/lib/observability/client";
import type { RouteId } from "@/lib/observability/route-map";

interface ClientRedirectProps {
  to: string;
  /**
   * Emits a sanitized redirect page-view for a retired compatibility endpoint.
   * This intentionally accepts a stable route ID, never the source URL.
   */
  redirectRouteId?: RouteId;
}

export function ClientRedirect({ to, redirectRouteId }: ClientRedirectProps) {
  const router = useRouter();

  useEffect(() => {
    if (redirectRouteId) {
      trackEvent(
        "page_view",
        { route_id: redirectRouteId, nav_type: "redirect" },
        {
          dedupeKey: `deprecated_redirect:${redirectRouteId}`,
          dedupeWindowMs: 5_000,
        },
      );
    }
    router.replace(to, { scroll: false });
  }, [redirectRouteId, router, to]);

  return null;
}
