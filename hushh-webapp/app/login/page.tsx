"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { AuthStep } from "@/components/onboarding/AuthStep";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import {
  AUTH_SESSION_NOTICE_QUERY_PARAM,
  loginRouteWithoutAuthSessionNotice,
  readAuthSessionLandingNotice,
} from "@/lib/auth/session-invalidation";

function LoginContent() {
  const searchParams = useSearchParams();
  const consumedNoticeRef = useRef<string | null>(null);
  const searchParamsString = searchParams.toString();
  // Empty means an organic sign-in. Do not manufacture `/` as a redirect:
  // it is the public welcome route and must never participate in private
  // capability/persona routing after authentication.
  const redirectPath = searchParams.get("redirect") || "";

  useEffect(() => {
    const rawNotice = searchParams.get(AUTH_SESSION_NOTICE_QUERY_PARAM);
    if (!rawNotice) {
      consumedNoticeRef.current = null;
      return;
    }

    // React Strict Mode replays effects in development. Treat the complete
    // landing query as the one-shot identity so neither the toast nor the URL
    // cleanup fires twice during that replay.
    if (consumedNoticeRef.current === searchParamsString) return;
    consumedNoticeRef.current = searchParamsString;

    const notice = readAuthSessionLandingNotice(searchParams);
    if (notice) {
      const showNotice =
        notice.code === "account_deleted" ? toast.success : toast.error;
      showNotice(notice.message, { id: notice.toastId });
    }

    // Scrub valid and invalid values alike. This prevents refresh/back from
    // replaying a stale terminal-session notice and preserves `redirect`.
    // This is query hygiene, not an application navigation. Replacing the
    // browser entry directly avoids an RSC round trip that could leave the
    // sensitive reason-bearing URL visible while Login is offline or the
    // backend is unavailable.
    window.history.replaceState(
      window.history.state,
      "",
      loginRouteWithoutAuthSessionNotice(searchParams),
    );
  }, [searchParams, searchParamsString]);

  return (
    <>
      <AuthStep redirectPath={redirectPath} compact />
    </>
  );
}

export default function LoginPage() {
  return (
    <>
      <NativeRouteMarker
        routeId="/login"
        marker="native-route-login"
        authState="anonymous"
        dataState="loaded"
      />
      <Suspense fallback={null}>
        <LoginContent />
      </Suspense>
    </>
  );
}
