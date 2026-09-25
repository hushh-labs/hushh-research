"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/hooks/use-auth";
import {
  snapshotValidatedAuthSessionOwner,
  isValidatedAuthSessionOwnerCurrent,
} from "@/lib/auth/session-owner";
import { consumeCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import {
  clearGoogleOAuthAttempt,
  readGoogleOAuthPopupAttempt,
  settleGoogleOAuthPopup,
  type GoogleOAuthPopupAttempt,
} from "@/lib/google/google-oauth-popup";
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import { trackEvent } from "@/lib/observability/client";
import {
  GoogleConnectionService,
  type GoogleConnectionCompletion,
} from "@/lib/services/google-connection-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

const COMPLETION_TIMEOUT_MS = 35_000;
class CompletionUnknownError extends Error {}

async function completeGoogleOAuth(
  params: Parameters<typeof GoogleConnectionService.completeConnect>[0],
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      GoogleConnectionService.completeConnect(params),
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new CompletionUnknownError()),
          COMPLETION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

type CompletionFlow = {
  ownerId: string;
  generation: number;
  attempt: GoogleOAuthPopupAttempt | null;
  returnToSetup: boolean;
  result: Promise<GoogleConnectionCompletion>;
};

function GoogleOAuthReturnContent() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const flow = useRef<CompletionFlow | null>(null);
  const cloudFlow = useRef<{ ownerId: string; generation: number; result: Promise<void> } | null>(null);
  const terminalOutcomeRecorded = useRef(false);
  const authority = useRef({
    ownerId: loading ? null : user?.uid,
    generation: 0,
    mounted: false,
  });
  const ownerId = loading ? null : user?.uid;
  useLayoutEffect(() => {
    if (authority.current.ownerId !== ownerId) {
      authority.current = {
        ownerId,
        generation: authority.current.generation + 1,
        mounted: authority.current.mounted,
      };
    }
  }, [ownerId]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    authority.current.mounted = true;
    let current = true;
    const effectGeneration = authority.current.generation;
    const cleanup = () => {
      current = false;
      authority.current.mounted = false;
    };
    const code = search.get("code");
    const state = search.get("state");
    // Cloud authorization uses the registered Google return URL, but its state
    // is namespaced and never enters the Calendar completion or popup flow.
    if (state?.startsWith("byoc.")) {
      if (!user || !code || authority.current.ownerId !== user.uid) {
        router.replace(ROUTES.ONE_SETUP_CLOUD);
        return cleanup;
      }
      if (cloudFlow.current && (cloudFlow.current.ownerId !== user.uid || cloudFlow.current.generation !== effectGeneration)) {
        router.replace(ROUTES.ONE_SETUP_CLOUD);
        return cleanup;
      }
      if (!cloudFlow.current) {
        cloudFlow.current = {
          ownerId: user.uid,
          generation: effectGeneration,
          result: ApiService.completeByocAuthorize({ code, state }).then(() => undefined),
        };
      }
      const active = cloudFlow.current;
      void active.result
        .then(() => {
          if (current && authority.current.generation === active.generation && authority.current.ownerId === active.ownerId) {
            router.replace(ROUTES.ONE_SETUP);
          }
        })
        .catch((error: unknown) => {
          if (!current || authority.current.generation !== active.generation || authority.current.ownerId !== active.ownerId) return;
          const reason =
            error instanceof Error && error.message && error.message !== "BYOC_AUTHORIZE_FAILED"
              ? error.message
              : "We could not finish setting up your cloud. Try again.";
          router.replace(`${ROUTES.ONE_SETUP_CLOUD}?authorize_error=${encodeURIComponent(reason)}`);
        });
      return cleanup;
    }
    const attempt = flow.current?.attempt ?? readGoogleOAuthPopupAttempt();
    const isSameWindowCalendar =
      attempt?.service === "calendar" && attempt.returnMode === "same_window";
    const fail = (text: string, outcome: "cancelled" | "failed" = "failed") => {
      if (!current || authority.current.generation !== effectGeneration) return;
      if (attempt && attempt.ownerId !== authority.current.ownerId) {
        if (isSameWindowCalendar) clearGoogleOAuthAttempt();
        setMessage("Please return to connections and start again with the same account.");
        return;
      }
      setMessage(text);
      if (
        flow.current &&
        flow.current.ownerId !== authority.current.ownerId
      ) {
        return;
      }
      if (terminalOutcomeRecorded.current) return;
      terminalOutcomeRecorded.current = true;
      if (isSameWindowCalendar) clearGoogleOAuthAttempt();
      if (attempt?.service === "calendar") {
        trackEvent("one_calendar_action", {
          route_id: "one_calendar",
          action: "connected",
          result: outcome === "cancelled" ? "expected_error" : "error",
        });
      }
      if (attempt && !isSameWindowCalendar) {
        settleGoogleOAuthPopup(attempt, outcome, text);
      }
    };
    const providerError = search.get("error");
    if (providerError) {
      fail(
        providerError === "access_denied"
          ? "Google connection was cancelled. You can try again from connections."
          : "Google connection could not be completed. Please try again from connections.",
        providerError === "access_denied" ? "cancelled" : "failed",
      );
      return cleanup;
    }
    if (
      !user ||
      !code ||
      !state ||
      (flow.current &&
        (flow.current.ownerId !== user.uid ||
          flow.current.generation !== authority.current.generation))
    ) {
      fail(
        "Please return to connections and start again with the same account.",
      );
      return cleanup;
    }
    // Retain only the in-memory promise so Strict Mode cannot consume a code
    // twice. Each effect subscribes independently; obsolete owners never settle UI.
    if (!flow.current) {
      const generation = authority.current.generation;
      const sessionOwner = snapshotValidatedAuthSessionOwner();
      const isEffectCurrent = () =>
        Boolean(
          sessionOwner &&
          sessionOwner.userId === user.uid &&
          isValidatedAuthSessionOwnerCurrent(sessionOwner) &&
          authority.current.mounted &&
          authority.current.generation === generation &&
          authority.current.ownerId === user.uid,
        );
      flow.current = {
        ownerId: user.uid,
        generation,
        attempt,
        returnToSetup: consumeCalendarSetupOAuthReturn(),
        result: user.getIdToken().then((idToken) => {
          if (!isEffectCurrent()) {
            throw new Error("Restart the Google connection.");
          }
          return completeGoogleOAuth({
            idToken,
            userId: user.uid,
            code,
            state,
            isEffectCurrent,
          });
        }),
      };
    }
    const active = flow.current;
    const requestedAccessLevel =
      attempt?.service === "calendar" ? attempt.accessLevel ?? "read" : "read";
    const isVerifiedCalendarConnection = (connection: {
      service?: string;
      connected?: boolean;
      status?: string;
      access_level?: string | null;
    } | null) =>
      Boolean(
        connection?.service === "calendar" &&
          (!attempt || connection.service === attempt.service) &&
          connection.connected &&
          connection.status === "connected" &&
          (requestedAccessLevel !== "manage" ||
            connection.access_level === "manage"),
      );
    const settleSuccess = () => {
      if (!current || authority.current.generation !== active.generation)
        return;
      if (terminalOutcomeRecorded.current) return;
      terminalOutcomeRecorded.current = true;
      if (isSameWindowCalendar) clearGoogleOAuthAttempt();
      trackEvent("one_calendar_action", {
        route_id: "one_calendar",
        action: "connected",
        result: "success",
      });
      if (attempt && !isSameWindowCalendar) {
        settleGoogleOAuthPopup(attempt, "succeeded");
      } else {
        router.replace(
          active.returnToSetup ? ROUTES.ONE_SETUP_CALENDAR : ROUTES.CALENDAR,
        );
      }
    };
    void active.result
      .then((completed) => {
        if (!current || authority.current.generation !== active.generation)
          return;
        if (!isVerifiedCalendarConnection(completed)) {
          fail(
            "Google connection could not be verified. Please check connections before trying again.",
          );
          return;
        }
        settleSuccess();
      })
      .catch(async (error: unknown) => {
        if (error instanceof CompletionUnknownError) {
          const remainsCurrent = () =>
            current &&
            authority.current.mounted &&
            authority.current.generation === active.generation &&
            authority.current.ownerId === active.ownerId;
          if (!remainsCurrent()) return;
          const status = await user
            .getIdToken()
            .then((idToken) => {
              if (!remainsCurrent()) return null;
              return GoogleCalendarService.status(idToken, active.ownerId);
            })
            .catch(() => null);
          if (!remainsCurrent()) return;
          if (
            isVerifiedCalendarConnection({
              service: "calendar",
              ...status,
            })
          ) {
            settleSuccess();
            return;
          }
        }
        fail(
          error instanceof CompletionUnknownError
            ? "Google may still be saving this connection. Check connections before starting again."
            : "Google connection could not be completed. Please try again from connections.",
        );
      });
    return cleanup;
  }, [loading, router, search, user]);

  if (!message) return <HushhLoader label="Finishing Google connection…" />;
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <p role="status">{message}</p>
      <Link
        className="inline-flex min-h-11 items-center text-primary underline"
        href={ROUTES.PROFILE_CONNECTORS}
      >
        Back to connections
      </Link>
    </div>
  );
}

export default function GoogleOAuthReturnPage() {
  return (
    <Suspense fallback={<HushhLoader label="Finishing Google connection…" />}>
      <GoogleOAuthReturnContent />
    </Suspense>
  );
}
