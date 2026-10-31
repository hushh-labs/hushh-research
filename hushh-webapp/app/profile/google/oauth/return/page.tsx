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
import { consumeCalendarSetupOAuthReturn, markCalendarMeetingOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import {
  clearGoogleOAuthAttempt,
  hasCalendarMeetingFileGrant,
  readGoogleOAuthPopupAttempt,
  settleGoogleOAuthPopup,
  watchGoogleOAuthSettlementAck,
  type GoogleOAuthPopupAttempt,
} from "@/lib/google/google-oauth-popup";
import { ROUTES } from "@/lib/navigation/routes";
import { buildProfileConnectorsPaneHref } from "@/lib/navigation/profile-pane";
import { ApiService } from "@/lib/services/api-service";
import { trackEvent } from "@/lib/observability/client";
import {
  GoogleConnectionService,
  type GoogleConnectionCompletion,
} from "@/lib/services/google-connection-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { CalendarFollowupsService } from "@/lib/services/calendar-followups-service";
import { requireSharedGoogleExchange } from "@/lib/services/private-google-connections";

const COMPLETION_TIMEOUT_MS = 35_000;
// A popup that is going to close does so within a frame or two. Past this,
// the browser has refused (Google's opener policy can make a popup
// uncloseable), so the person needs a visible, working way back.
const POPUP_CLOSE_GRACE_MS = 500;
class CompletionUnknownError extends Error {}

type PopupEnd = {
  attempt: GoogleOAuthPopupAttempt;
  ownerId: string;
  outcome: "succeeded" | "cancelled" | "failed";
  returnToSetup: boolean;
};

/**
 * Same-origin way back to One for a popup that could not close. Navigating this
 * window is safe: it already holds the signed-in session, and the meeting
 * journey is restored from the validated, expiring return context.
 */
function popupReturnTarget(end: PopupEnd): { href: string; prepare: () => void } | null {
  const { attempt } = end;
  if (attempt.service === "calendar") {
    if (attempt.meetingFiles && attempt.meetingReturn) {
      const context = attempt.meetingReturn;
      return { href: ROUTES.CALENDAR, prepare: () => markCalendarMeetingOAuthReturn(end.ownerId, context) };
    }
    return { href: end.returnToSetup ? ROUTES.ONE_SETUP_CALENDAR : ROUTES.CALENDAR, prepare: () => undefined };
  }
  if (attempt.service === "gmail_read" && attempt.calendarAdditional)
    return { href: ROUTES.CALENDAR, prepare: () => undefined };
  return null;
}

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
  result: Promise<GoogleConnectionCompletion | { service: "gmail"; completed_account_id: string; connected: boolean }>;
};

async function completeSelectedMailOAuth(params: {
  idToken: string; userId: string; accountId: string; code: string; state: string;
  isEffectCurrent: () => boolean;
}): Promise<{ service: "gmail"; completed_account_id: string; connected: boolean }> {
  await requireSharedGoogleExchange();
  if (!params.isEffectCurrent()) throw new Error("Selected Mail connection changed.");
  const value = await CalendarFollowupsService.post<{
    service: "gmail"; completed_account_id: string; connected: boolean;
  }>("mail/connect/complete", {
    user_id: params.userId, account_id: params.accountId,
    code: params.code, state: params.state,
    redirect_uri: `${window.location.origin}/one/profile/google/oauth/return`,
  }, params.idToken);
  if (!params.isEffectCurrent() || value.service !== "gmail" ||
      value.completed_account_id !== params.accountId || value.connected !== true)
    throw new Error("Selected Mail connection could not be verified.");
  return value;
}

function GoogleOAuthReturnContent() {
  const { user, userId, loading } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const flow = useRef<CompletionFlow | null>(null);
  const cloudFlow = useRef<{ ownerId: string; generation: number; result: Promise<void> } | null>(null);
  const terminalOutcomeRecorded = useRef(false);
  const authority = useRef({
    ownerId: loading ? null : userId,
    generation: 0,
    mounted: false,
  });
  const ownerId = loading ? null : userId;
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
  const [popupEnd, setPopupEnd] = useState<PopupEnd | null>(null);
  const [windowRemains, setWindowRemains] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    if (!popupEnd) return;
    return watchGoogleOAuthSettlementAck(popupEnd.attempt.attemptId, () => setAcknowledged(true));
  }, [popupEnd]);

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
      if (!user || !userId || !code || authority.current.ownerId !== userId) {
        router.replace(ROUTES.ONE_SETUP_CLOUD);
        return cleanup;
      }
      if (cloudFlow.current && (cloudFlow.current.ownerId !== userId || cloudFlow.current.generation !== effectGeneration)) {
        router.replace(ROUTES.ONE_SETUP_CLOUD);
        return cleanup;
      }
      if (!cloudFlow.current) {
        cloudFlow.current = {
          ownerId: userId,
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
        watchPopupWindow({ attempt, ownerId: attempt.ownerId, outcome, returnToSetup: flow.current?.returnToSetup ?? false });
      }
    };
    const watchPopupWindow = (end: PopupEnd) => {
      setPopupEnd(end);
      window.setTimeout(() => {
        if (authority.current.mounted && !window.closed) setWindowRemains(true);
      }, POPUP_CLOSE_GRACE_MS);
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
      !userId ||
      !code ||
      !state ||
      (flow.current &&
        (flow.current.ownerId !== userId ||
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
          sessionOwner.userId === userId &&
          isValidatedAuthSessionOwnerCurrent(sessionOwner) &&
          authority.current.mounted &&
          authority.current.generation === generation &&
          authority.current.ownerId === userId,
        );
      flow.current = {
        ownerId: userId,
        generation,
        attempt,
        returnToSetup: consumeCalendarSetupOAuthReturn(),
        result: user.getIdToken().then<GoogleConnectionCompletion | { service: "gmail"; completed_account_id: string; connected: boolean }>((idToken) => {
          if (!isEffectCurrent()) {
            throw new Error("Restart the Google connection.");
          }
          return attempt?.service === "gmail_read" && attempt.calendarAdditional && attempt.targetAccountId
            ? completeSelectedMailOAuth({
                idToken, userId, accountId: attempt.targetAccountId,
                code, state, isEffectCurrent,
              })
            : completeGoogleOAuth({
            idToken,
            userId,
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
    const isVerifiedCalendarConnection = (connection: GoogleConnectionCompletion | null) => {
      if (attempt?.calendarAdditional && !connection?.completed_account_id) return false;
      const completedId = connection?.completed_account_id || "default";
      if (attempt?.targetAccountId && completedId !== attempt.targetAccountId) return false;
      const account = connection?.accounts?.find(item => item.account_id === completedId);
      const completedAccount = account || (completedId === "default" ? connection : null);
      return Boolean(
        connection?.service === "calendar" &&
          (!attempt || connection.service === attempt.service) &&
          completedAccount?.connected &&
          completedAccount.status === "connected" &&
          (requestedAccessLevel !== "manage" ||
            completedAccount.access_level === "manage") &&
          (!attempt?.targetAccountId || hasCalendarMeetingFileGrant(
            connection!, attempt.targetAccountId || "", attempt.expectedSubjectSha256, attempt.priorGrantGeneration,
          )),
      );
    };
    const settleSuccess = () => {
      if (!current || authority.current.generation !== active.generation)
        return;
      if (terminalOutcomeRecorded.current) return;
      terminalOutcomeRecorded.current = true;
      if (isSameWindowCalendar) {
        if (attempt?.meetingFiles && attempt.meetingReturn) {
          markCalendarMeetingOAuthReturn(active.ownerId, attempt.meetingReturn);
        }
        clearGoogleOAuthAttempt();
      }
      if (attempt?.service !== "gmail_read") trackEvent("one_calendar_action", {
        route_id: "one_calendar", action: "connected", result: "success",
      });
      if (attempt && !isSameWindowCalendar) {
        settleGoogleOAuthPopup(attempt, "succeeded");
        watchPopupWindow({ attempt, ownerId: active.ownerId, outcome: "succeeded", returnToSetup: active.returnToSetup });
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
        const verified = attempt?.service === "gmail_read"
          ? completed.service === "gmail" && completed.completed_account_id === attempt.targetAccountId && completed.connected
          : isVerifiedCalendarConnection(completed.service === "calendar" ? completed : null);
        if (!verified) {
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
          const status = attempt?.calendarAdditional && !attempt.meetingFiles ? null : await user
            .getIdToken()
            .then((idToken) => {
              if (!remainsCurrent()) return null;
              return GoogleCalendarService.status(idToken, active.ownerId);
            })
            .catch(() => null);
          if (!remainsCurrent()) return;
          if (
            status && (!attempt?.meetingFiles || Boolean(attempt.priorGrantGeneration)) && isVerifiedCalendarConnection({
              service: "calendar",
              ...status,
              ...(attempt?.meetingFiles && attempt.targetAccountId ? { completed_account_id: attempt.targetAccountId } : {}),
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
  }, [loading, router, search, user, userId]);

  const target = popupEnd ? popupReturnTarget(popupEnd) : null;
  if (popupEnd?.outcome === "succeeded" && windowRemains) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-6" data-testid="google-oauth-popup-done">
        <p role="status">
          {acknowledged
            ? "Google access saved and One is updated. You can close this window."
            : "Google access saved. If One did not update on its own, return to it here."}
        </p>
        {target ? (
          <Link className="inline-flex min-h-11 items-center text-primary underline" href={target.href} onClick={target.prepare}>
            Return to One
          </Link>
        ) : (
          <Link className="inline-flex min-h-11 items-center text-primary underline" href={buildProfileConnectorsPaneHref()}>
            Back to connections
          </Link>
        )}
      </div>
    );
  }
  if (!message) return <HushhLoader label="Finishing Google connection…" />;
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <p role="status">{message}</p>
      {target ? (
        <Link className="inline-flex min-h-11 items-center text-primary underline" href={target.href} onClick={target.prepare}>
          Return to One
        </Link>
      ) : (
        <Link
          className="inline-flex min-h-11 items-center text-primary underline"
          href={buildProfileConnectorsPaneHref()}
        >
          Back to connections
        </Link>
      )}
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
