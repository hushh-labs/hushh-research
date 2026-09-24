"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import {
  BodyText,
  HelperText,
  MediumRowLabel,
} from "@/components/app-ui/typography";
import {
  DriveSharingError,
  DriveSharingService,
  type DriveQueryView,
} from "@/lib/services/drive-sharing-service";

type Direction = DriveQueryView["direction"];
type SessionGuard = () => void;
/** `notice: undefined` keeps the current notice (a quiet background poll). */
type Outcome = { view: DriveQueryView; notice?: string | null };
type Phase = "idle" | "loading" | "allowing" | "denying";

const POLL_MS = 5000;
/** Three minutes: long enough to watch one allowed search finish. */
const POLL_BUDGET = 36;

const LAST_ERROR_COPY: Record<NonNullable<DriveQueryView["lastError"]>, string> = {
  reconnect_required: "Reconnect Google Drive, then allow again.",
  drive_query_unavailable: "Drive didn't answer. Try again.",
};

function codeOf(cause: unknown): string {
  return cause instanceof DriveSharingError ? cause.code : "request_failed";
}

function decisionFailureCopy(code: string): string {
  switch (code) {
    case "reconnect_required":
    case "drive_query_unavailable":
      return LAST_ERROR_COPY[code];
    case "request_expired":
      return "This question expired.";
    case "request_changed":
      return "This question changed. Check it and try again.";
    case "connection_required":
      return "You're no longer connected with this person.";
    case "sharing_unavailable":
      return "Drive questions aren't available right now.";
    default:
      return "Something went wrong. Try again.";
  }
}

function loadFailureCopy(code: string): string {
  if (code === "request_unavailable") return "This question isn't available.";
  if (code === "sharing_unavailable")
    return "Drive questions aren't available right now.";
  return "Couldn't load this question. Try again.";
}

/**
 * One question about the owner's Drive. The owner only allows or denies; this
 * card never reads Drive itself and never prepares or reviews files.
 */
export function DriveQueryRequestCard({
  requestId,
  direction,
  initial,
}: {
  requestId: string;
  direction?: Direction;
  initial?: DriveQueryView;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked)
    return (
      <BodyText role="status">Unlock your vault to see this question.</BodyText>
    );
  return (
    <UnlockedDriveQueryCard
      key={`${user.uid}:${requestId}:${snapshotVaultSessionEpoch()}`}
      userId={user.uid}
      requestId={requestId}
      direction={direction}
      initial={
        initial?.requestId.toLowerCase() === requestId.toLowerCase()
          ? initial
          : undefined
      }
      getToken={getVaultOwnerToken}
    />
  );
}

function UnlockedDriveQueryCard({
  userId,
  requestId,
  direction,
  initial,
  getToken,
}: {
  userId: string;
  requestId: string;
  direction?: Direction;
  initial?: DriveQueryView;
  getToken: () => string | null;
}) {
  const [view, setView] = useState<DriveQueryView | null>(initial ?? null);
  const [phase, setPhase] = useState<Phase>(initial ? "idle" : "loading");
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(false);
  const serial = useRef(0);
  const busy = useRef<"none" | "load" | "decide">("none");
  const polls = useRef(0);
  const lastStatus = useRef(initial?.status ?? null);
  const quietFirstLoad = useRef(!!initial);
  const statusTarget = useRef<HTMLDivElement>(null);
  const titlesId = useId();
  const now = useCoarseClock(1000);

  const load = useCallback(
    async (token: string, guard: SessionGuard): Promise<Outcome> => ({
      view: await DriveSharingService.getQuery(token, requestId, guard),
    }),
    [requestId],
  );

  const run = useCallback(
    async (
      action: (token: string, guard: SessionGuard) => Promise<Outcome>,
      kind: "load" | "decide",
      presentation: Phase | null,
    ) => {
      // A decision is never overlapped; it may supersede an in-flight read.
      if (!alive.current || busy.current === "decide") return;
      if (kind === "load" && busy.current === "load") return;
      const token = getToken();
      if (!token) {
        setView(null);
        return;
      }
      const epoch = snapshotVaultSessionEpoch();
      const operation = ++serial.current;
      const current = () =>
        alive.current &&
        operation === serial.current &&
        isVaultSessionEpochCurrent(epoch) &&
        getToken() === token;
      const guard = () => {
        if (!current()) throw new DriveSharingError("session_changed");
      };
      busy.current = kind;
      if (presentation) {
        setPhase(presentation);
        setNotice(null);
      }
      try {
        guard();
        const outcome = await action(token, guard);
        if (!current()) return;
        if (lastStatus.current !== outcome.view.status) {
          lastStatus.current = outcome.view.status;
          polls.current = 0;
        }
        setView(outcome.view);
        if (outcome.notice !== undefined) setNotice(outcome.notice);
      } catch (cause) {
        if (!current()) return;
        // A failed read never leaves an old question decidable.
        setView(null);
        setNotice(loadFailureCopy(codeOf(cause)));
      } finally {
        if (operation === serial.current) {
          busy.current = "none";
          if (alive.current) {
            setPhase("idle");
            if (kind === "decide" && current()) statusTarget.current?.focus();
          }
        }
      }
    },
    [getToken],
  );

  const announceChange = useCallback(() => {
    CacheSyncService.onConsentMutated(userId);
    window.dispatchEvent(
      new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, {
        detail: { reconcile: true },
      }),
    );
  }, [userId]);

  useEffect(() => {
    alive.current = true;
    void run(load, "load", quietFirstLoad.current ? null : "loading");
    const operations = serial;
    return () => {
      alive.current = false;
      operations.current += 1;
      busy.current = "none";
    };
  }, [load, run]);

  const open = view?.status === "pending" || view?.status === "running";
  usePeriodicTask(
    `drive-query-request:${requestId}`,
    POLL_MS,
    () => {
      if (polls.current++ < POLL_BUDGET) return run(load, "load", null);
      return undefined;
    },
    { enabled: open && phase === "idle" },
  );

  const expired =
    view?.status === "expired" ||
    (view?.status === "pending" && Date.parse(view.expiresAt) <= now);
  const showDecision =
    !!view && (view.canDecide || phase === "allowing" || phase === "denying") && !expired;
  const canDecide = showDecision && !!view?.canDecide && phase === "idle";

  const decide = (choice: "allow" | "deny") => {
    if (!view || !canDecide) return;
    const revision = view.revision;
    void run(
      async (token, guard) => {
        try {
          const result =
            choice === "allow"
              ? await DriveSharingService.allowQuery(token, requestId, revision, guard)
              : await DriveSharingService.denyQuery(token, requestId, revision, guard);
          guard();
          announceChange();
          return { view: result, notice: null };
        } catch (cause) {
          const code = codeOf(cause);
          if (code === "session_changed") throw cause;
          guard();
          // The request may have moved on; show the server's current state.
          const fresh = await DriveSharingService.getQuery(token, requestId, guard);
          guard();
          if (fresh.status !== "pending") announceChange();
          return {
            view: fresh,
            notice: fresh.status === "pending" ? decisionFailureCopy(code) : null,
          };
        }
      },
      "decide",
      choice === "allow" ? "allowing" : "denying",
    );
  };

  const refresh = () => {
    polls.current = 0;
    void run(load, "load", "loading");
  };

  const incoming = (view?.direction ?? direction) === "incoming";
  const name = view?.counterpartName?.trim() || null;
  const heading = !view
    ? "Drive question"
    : incoming
      ? `${name ?? "Someone"} asked about your Drive`
      : name
        ? `Your question for ${name}`
        : "Your question";
  const statusLine =
    phase === "loading" && !view
      ? "Loading…"
      : !view
        ? null
        : incoming
          ? phase === "allowing" || view.status === "running"
            ? "Searching your Drive…"
            : phase === "denying"
              ? "Declining…"
              : expired
                ? "This question expired."
                : view.status === "answered"
                  ? "You allowed this question."
                  : view.status === "denied"
                    ? "You declined this question."
                    : null
          : view.status === "running"
            ? "Allowed — finding the answer"
            : view.status === "answered"
              ? "Answered"
              : view.status === "denied"
                ? "Declined"
                : expired
                  ? "Expired"
                  : `Waiting for ${name ?? "them"} to allow`;
  const lastError =
    incoming && view?.status === "pending" && view.lastError && !notice
      ? LAST_ERROR_COPY[view.lastError]
      : null;
  const showRefresh =
    phase === "idle" &&
    (!view ||
      view.status === "running" ||
      (!incoming && view.status === "pending" && !expired));

  return (
    <section
      aria-label="Drive question"
      className="min-w-0 space-y-4 break-words"
      data-testid="drive-query-request"
      aria-busy={phase !== "idle"}
    >
      <div
        ref={statusTarget}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="min-w-0 space-y-1"
      >
        <MediumRowLabel as="p">{heading}</MediumRowLabel>
        {statusLine ? <BodyText>{statusLine}</BodyText> : null}
      </div>
      {view ? (
        <BodyText className="whitespace-pre-wrap break-words">
          “{view.query}”
        </BodyText>
      ) : null}
      {notice ? <HelperText role="alert">{notice}</HelperText> : null}
      {lastError ? <HelperText>{lastError}</HelperText> : null}
      {view?.answer ? (
        <div className="min-w-0 space-y-2">
          <BodyText className="whitespace-pre-wrap break-words">
            {view.answer.text}
          </BodyText>
          {view.answer.truncated ? (
            <HelperText>This answer may be incomplete.</HelperText>
          ) : null}
          {view.answer.titles.length > 0 ? (
            <>
              <HelperText id={titlesId}>From these files:</HelperText>
              <ul
                aria-labelledby={titlesId}
                className="min-w-0 list-inside list-disc space-y-1"
              >
                {view.answer.titles.map((title, index) => (
                  <li key={index} className="break-all">
                    {title}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {showDecision ? (
        <>
          <HelperText>
            If you allow, your private agent searches your Drive once for this
            question and shares the answer and file names with{" "}
            {name ?? "them"}. Your files aren&apos;t shared.
          </HelperText>
          <FlowActionGroup
            primary={
              <Button
                size="prominent"
                disabled={!canDecide}
                onClick={() => decide("allow")}
              >
                Allow
              </Button>
            }
            secondary={
              <Button
                size="standard"
                variant="none"
                disabled={!canDecide}
                onClick={() => decide("deny")}
              >
                Deny
              </Button>
            }
          />
        </>
      ) : null}
      {showRefresh ? (
        <Button size="standard" variant="none" onClick={refresh}>
          Refresh
        </Button>
      ) : null}
    </section>
  );
}
