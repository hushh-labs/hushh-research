"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { useAuth } from "@/hooks/use-auth";
import { consumeCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import {
  readGoogleOAuthPopupAttempt,
  settleGoogleOAuthPopup,
} from "@/lib/google/google-oauth-popup";
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
    const code = search.get("code");
    const state = search.get("state");
    const oauthError = search.get("error") || search.get("error_description");
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
    const attempt = readGoogleOAuthPopupAttempt();

    const settle = (
      outcome: "succeeded" | "cancelled" | "failed",
      message?: string,
    ) => {
      if (attempt) {
        settleGoogleOAuthPopup(attempt, outcome, message);
      } else {
        const query = outcome === "succeeded" ? "" : "?calendar=error";
        router.replace(`${destination}${query}`);
      }
    };

    if (oauthError) {
      const isDenied = String(oauthError).toLowerCase().includes("access_denied");
      settle(
        isDenied ? "cancelled" : "failed",
        oauthError || "Google authorization was denied.",
      );
      return;
    }

    if (!user || !code || !state) {
      settle("failed", "Missing authorization parameters. Please try again.");
      return;
    }

    void user
      .getIdToken()
      .then((idToken) =>
        GoogleCalendarService.completeConnect({
          idToken,
          userId: user.uid,
          code,
          state,
        }),
      )
      .then(() => {
        settle("succeeded");
      })
      .catch((err) => {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Google Calendar connection could not be completed.";
        settle("failed", msg);
      });
  }, [loading, router, search, user]);

  return <CalendarAgentPage connectionPending />;
}

export default function GoogleOAuthReturnPage() {
  return (
    <Suspense fallback={<CalendarAgentPage connectionPending />}>
      <GoogleOAuthReturnContent />
    </Suspense>
  );
}
