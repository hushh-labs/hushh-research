"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { getRouteScope } from "@/lib/navigation/route-scope";
import { isAnalyticsExemptRoute } from "@/lib/navigation/routes";
import { captureGrowthAttribution } from "@/lib/observability/growth";
import { trackPageView } from "@/lib/observability/client";
import { setObservabilityUserId } from "@/lib/observability/identity";
import { refreshWebGtmPageContext } from "@/lib/observability/adapters/web-gtm";
import { liveActivitySectionSubject, recordSectionVisit } from "@/components/observability/live-activity-section-subject";
import { useAuth } from "@/hooks/use-auth";
import { useKaiSession } from "@/lib/stores/kai-session-store";

export function ObservabilityRouteObserver() {
  const pathname = usePathname();
  const { user, userId, loading } = useAuth();
  const mountedRef = useRef(false);
  const lastObservedPathRef = useRef<string | null>(null);
  const lastSectionVisitRef = useRef<string | null>(null);
  const setLastKaiPath = useKaiSession((state) => state.setLastKaiPath);
  const setLastRiaPath = useKaiSession((state) => state.setLastRiaPath);

  useEffect(() => {
    // Wallet Profile visitors are strangers holding someone else's QR, not our
    // users. Bail before any capture — including the session-path writes, which
    // would otherwise persist a card token into local state.
    if (isAnalyticsExemptRoute(pathname)) {
      mountedRef.current = true;
      lastObservedPathRef.current = pathname;
      return;
    }
    refreshWebGtmPageContext();
    // Preserve the landing attribution even when auth restoration is still
    // pending and this route redirects before an analytics hit can be sent.
    captureGrowthAttribution(pathname);
    if (loading) return;
    // A signed-in person is named only by their validated owner. Until it is
    // published, send nothing: after start fresh the Firebase UID names the
    // deleted account. The view is sent once the owner arrives.
    if (user?.uid && !userId) return;
    // One section visit is one journal entry: tabs and sub-screens of the same
    // section are the same visit. The journal drops it unless this owner's
    // store is unlocked, so it does not wait for the analytics identity.
    const section = userId ? liveActivitySectionSubject(pathname) : null;
    const visit = section ? `${userId}:${section}` : null;
    if (visit !== lastSectionVisitRef.current) {
      lastSectionVisitRef.current = visit;
      if (userId) recordSectionVisit(userId, section);
    }
    let cancelled = false;
    // A route view emitted before AuthProvider restores the account lands in
    // GA4 as an anonymous browser. Bind the validated identity first, then
    // send the view. This does not infer people from devices or page traffic.
    const observe = async () => {
      // A cold signed-in load may restore auth before the afterInteractive
      // gtag script exists. Never send that first view anonymously: retry the
      // binding for a bounded window and omit the view if GA4 stays unavailable.
      let bound = false;
      for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
        // AuthProvider binds the application owner; keep the same identity here.
        bound = await setObservabilityUserId(userId).catch(() => false);
        if (bound) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!bound) return;
      if (cancelled) return;
      if (lastObservedPathRef.current === pathname) return;
      trackPageView(pathname, mountedRef.current ? "route_change" : "initial_load");
      lastObservedPathRef.current = pathname;
      const scope = getRouteScope(pathname);
      if (scope === "investor") setLastKaiPath(pathname);
      else if (scope === "ria") setLastRiaPath(pathname);
      mountedRef.current = true;
    };
    void observe();
    return () => { cancelled = true; };
  }, [pathname, user?.uid, userId, loading, setLastKaiPath, setLastRiaPath]);

  return null;
}
