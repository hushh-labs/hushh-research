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
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

const CALENDAR_OAUTH_COMPLETION_TIMEOUT_MS = 35_000;
const CALENDAR_OAUTH_RECONCILIATION_ATTEMPTS = 5;
const CALENDAR_OAUTH_RECONCILIATION_DELAY_MS = 2_000;

class CalendarOAuthCompletionPendingError extends Error {
  constructor() {
    super("Calendar connection is still being saved.");
  }
}

async function completeCalendarOAuth(params: {
  idToken: string;
  userId: string;
  code: string;
  state: string;
}) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      GoogleCalendarService.completeConnect(params),
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => {
          reject(new CalendarOAuthCompletionPendingError());
        }, CALENDAR_OAUTH_COMPLETION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

async function reconcileCalendarConnection(idToken: string, userId: string) {
  for (
    let attempt = 0;
    attempt < CALENDAR_OAUTH_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    const status = await GoogleCalendarService.status(idToken, userId).catch(
      () => null,
    );
    if (status?.connected) return true;
    if (attempt + 1 < CALENDAR_OAUTH_RECONCILIATION_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, CALENDAR_OAUTH_RECONCILIATION_DELAY_MS);
      });
    }
  }
  return false;
}

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
    const returnToSetup = consumeCalendarSetupOAuthReturn();
    const destination = returnToSetup
      ? ROUTES.ONE_SETUP_CALENDAR
      : ROUTES.CALENDAR;
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
      const isDenied = String(oauthError)
        .toLowerCase()
        .includes("access_denied");
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
        completeCalendarOAuth({
          idToken,
          userId: user.uid,
          code,
          state,
        }),
      )
      .then((completed) => {
        settle(
          completed.connected ? "succeeded" : "failed",
          completed.connected
            ? undefined
            : "Calendar authorization did not create an active connection.",
        );
      })
      .catch(async (err) => {
        if (err instanceof CalendarOAuthCompletionPendingError) {
          const connected = await reconcileCalendarConnection(
            await user.getIdToken(),
            user.uid,
          );
          settle(
            connected ? "succeeded" : "failed",
            connected
              ? undefined
              : "Calendar is still saving the connection. Please check Calendar and try again if needed.",
          );
          return;
        }
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
