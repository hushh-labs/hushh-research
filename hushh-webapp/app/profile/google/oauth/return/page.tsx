"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

function GoogleOAuthReturnContent() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const started = useRef(false);
  useEffect(() => {
    if (loading || started.current) return;
    started.current = true;
    const code = search.get("code"); const state = search.get("state");
    if (!user || !code || !state) { router.replace(ROUTES.PROFILE_INTEGRATIONS); return; }
    void user.getIdToken()
      .then((idToken) => GoogleCalendarService.completeConnect({ idToken, userId: user.uid, code, state }))
      .then(() => router.replace(ROUTES.PROFILE_INTEGRATIONS))
      .catch(() => router.replace(`${ROUTES.PROFILE_INTEGRATIONS}?calendar=error`));
  }, [loading, router, search, user]);
  return <HushhLoader label="Finishing Google Calendar connection…" />;
}

export default function GoogleOAuthReturnPage() {
  return <Suspense fallback={<HushhLoader label="Finishing Google Calendar connection…" />}><GoogleOAuthReturnContent /></Suspense>;
}
