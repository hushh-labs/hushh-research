"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { EmailAgentPage } from "@/components/email/email-agent-page";
import { consumeGoogleEmailSendReturn } from "@/components/gmail/gmail-send-access-card";
import { useAuth } from "@/hooks/use-auth";
import { consumeCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import { ROUTES } from "@/lib/navigation/routes";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { GoogleEmailSendService } from "@/lib/services/google-email-send-service";
import {
  readGoogleOAuthPopupAttempt,
  settleGoogleOAuthPopup,
} from "@/lib/google/google-oauth-popup";

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
    const popupAttempt = readGoogleOAuthPopupAttempt();
    const emailSendReturn =
      popupAttempt?.service === "gmail_send"
        ? ROUTES.EMAIL
        : consumeGoogleEmailSendReturn();
    const returnToSetup = emailSendReturn
      ? false
      : consumeCalendarSetupOAuthReturn();
    const destination =
      emailSendReturn ||
      (returnToSetup ? ROUTES.ONE_SETUP_CALENDAR : ROUTES.CALENDAR);
    if (!user || !code || !state) {
      if (popupAttempt) {
        settleGoogleOAuthPopup(
          popupAttempt,
          "failed",
          "Google sign-in did not return a usable authorization.",
        );
        return;
      }
      router.replace(destination);
      return;
    }
    const completesEmailSend =
      popupAttempt?.service === "gmail_send" || Boolean(emailSendReturn);
    void user
      .getIdToken()
      .then((idToken) =>
        completesEmailSend
          ? GoogleEmailSendService.completeConnect({
              idToken,
              userId: user.uid,
              code,
              state,
            })
          : GoogleCalendarService.completeConnect({
              idToken,
              userId: user.uid,
              code,
              state,
            }),
      )
      .then(() => {
        if (popupAttempt) {
          settleGoogleOAuthPopup(popupAttempt, "succeeded");
          return;
        }
        router.replace(destination);
      })
      .catch(() => {
        if (popupAttempt) {
          settleGoogleOAuthPopup(
            popupAttempt,
            "failed",
            "Gmail sending setup could not be completed.",
          );
          return;
        }
        router.replace(
          `${destination}?${emailSendReturn ? "emailSend" : "calendar"}=error`,
        );
      });
  }, [loading, router, search, user]);
  // Keep the user on the relevant agent surface while the backend exchanges
  // the code and stores the encrypted refresh token.
  return search.get("state") &&
    readGoogleOAuthPopupAttempt()?.service === "gmail_send" ? (
    <EmailAgentPage />
  ) : (
    <CalendarAgentPage connectionPending />
  );
}

export default function GoogleOAuthReturnPage() {
  return (
    <Suspense fallback={<CalendarAgentPage connectionPending />}>
      <GoogleOAuthReturnContent />
    </Suspense>
  );
}
