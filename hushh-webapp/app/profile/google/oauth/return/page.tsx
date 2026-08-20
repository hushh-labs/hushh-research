"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useAuth } from "@/hooks/use-auth";
import { consumeCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
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
    // The one-click cloud setup rides the same registered Google return route;
    // its state is prefixed so the two flows can never be confused.
    if (state && state.startsWith("byoc.")) {
      if (!user || !code) { router.replace(ROUTES.ONE_SETUP_CLOUD); return; }
      void ApiService.completeByocAuthorize({ code, state })
        .then(() => router.replace(ROUTES.ONE_SETUP))
        .catch((error: unknown) => {
          const reason =
            error instanceof Error && error.message && error.message !== "BYOC_AUTHORIZE_FAILED"
              ? error.message
              : "We could not finish setting up your cloud. Try again.";
          router.replace(
            `${ROUTES.ONE_SETUP_CLOUD}?authorize_error=${encodeURIComponent(reason)}`,
          );
        });
      return;
    }
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
