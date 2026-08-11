"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useAuth } from "@/hooks/use-auth";
import { consumeCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
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
    const returnToSetup = consumeCalendarSetupOAuthReturn();
    const destination = returnToSetup ? ROUTES.ONE_SETUP_CALENDAR : ROUTES.CALENDAR;
    if (!user || !code || !state) { router.replace(destination); return; }
    void user.getIdToken()
      .then((idToken) => GoogleCalendarService.completeConnect({ idToken, userId: user.uid, code, state }))
      .then(() => router.replace(destination))
      .catch(() => router.replace(`${destination}?calendar=error`));
  }, [loading, router, search, user]);
  // Stay on the Calendar surface while the backend exchanges the code and
  // stores the encrypted refresh token. This is deliberately not a blank
  // callback/loading screen between Google and the connected Calendar state.
  return <CalendarAgentPage connectionPending />;
}

export default function GoogleOAuthReturnPage() {
  return (
    <Suspense fallback={<CalendarAgentPage connectionPending />}>
      <GoogleOAuthReturnContent />
    </Suspense>
  );
}
