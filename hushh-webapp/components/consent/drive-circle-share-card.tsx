"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { Button } from "@/lib/morphy-ux/button";
import { BodyText, HelperText, MediumRowLabel } from "@/components/app-ui/typography";
import {
  DriveSharingError,
  DriveSharingService,
  type DriveCircleExclusion,
  type DriveCircleShareView,
} from "@/lib/services/drive-sharing-service";

type Phase = "idle" | "searching" | "sharing";
type Result = { state: "queued" | "failed"; code?: string; shareRequestId?: string | null };
type TimedOperation = { kind: "search" | "share"; outcome: "ready" | "no_match" | "no_recipients" | "shared" | "partial" | "error" | "expired"; durationMs: number };

function elapsedLabel(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

const EXCLUSION_COPY: Record<DriveCircleExclusion, string> = {
  not_connected: "not connected with you",
  contacts: "connected through contacts, not a request",
  circle: "connected through a circle, not a request",
  imported: "an imported connection, not a request",
  unavailable: "can't receive Drive files yet",
  no_google_account: "can't verify their Google sign-in",
  no_verified_email: "needs a verified email in One",
  limit: "more than 10 people; share with them by name",
};

function codeOf(cause: unknown): string {
  return cause instanceof DriveSharingError ? cause.code : "request_failed";
}

function failureCopy(code: string): string {
  switch (code) {
    case "reconnect_required":
    case "connection_changed":
      return "Reconnect Google Drive, then try again.";
    case "drive_query_unavailable":
      return "Drive didn't answer. Try again.";
    case "sharing_unavailable":
      return "Sharing Drive files isn't available right now.";
    case "connection_required":
      return "Connect with this person, then try again.";
    case "recipient_google_identity_required":
      return "Their Google sign-in needs attention in One.";
    case "recipient_verified_email_required":
      return "They need a verified email in One.";
    default:
      return "Couldn't finish that. Try again.";
  }
}

function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z0-9_+\-/]{1,64}$/.test(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The owner shares their own Drive files with their Trusted circle, from chat.
 * Only members the owner connected with by request can receive; everyone
 * else is listed with the reason. Nothing is searched until Find files and
 * nothing is shared until Share; each person gets their own Viewer share.
 */
export function DriveCircleShareCard({
  clientRequestId,
  filesRequest,
}: {
  clientRequestId: string;
  filesRequest: string;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked)
    return <BodyText role="status">Unlock your vault to share Drive files.</BodyText>;
  return (
    <UnlockedDriveCircleShareCard
      key={`${user.uid}:${clientRequestId}:${snapshotVaultSessionEpoch()}`}
      userId={user.uid}
      clientRequestId={clientRequestId}
      filesRequest={filesRequest}
      getToken={getVaultOwnerToken}
    />
  );
}

function UnlockedDriveCircleShareCard({
  userId,
  clientRequestId,
  filesRequest,
  getToken,
}: {
  userId: string;
  clientRequestId: string;
  filesRequest: string;
  getToken: () => string | null;
}) {
  const [view, setView] = useState<DriveCircleShareView | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [unsharedFiles, setUnsharedFiles] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [activeElapsedMs, setActiveElapsedMs] = useState(0);
  const [lastOperation, setLastOperation] = useState<TimedOperation | null>(null);
  const alive = useRef(false);
  const serial = useRef(0);
  const operationStartedAt = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    const operations = serial;
    return () => {
      alive.current = false;
      operations.current += 1;
    };
  }, []);

  useEffect(() => {
    if (phase === "idle") return;
    const timer = window.setInterval(() => {
      if (operationStartedAt.current !== null)
        setActiveElapsedMs(Math.max(0, performance.now() - operationStartedAt.current));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const guarded = useCallback(() => {
    const token = getToken();
    if (!token) return null;
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
    return { token, current, guard };
  }, [getToken]);

  const find = async () => {
    if (phase !== "idle") return;
    const session = guarded();
    if (!session) {
      setNotice("Unlock your vault to share Drive files.");
      return;
    }
    setPhase("searching");
    operationStartedAt.current = performance.now();
    setActiveElapsedMs(0);
    setNotice(null);
    let outcome: TimedOperation["outcome"] = "error";
    try {
      const result = await DriveSharingService.prepareTrustedShare(
        session.token,
        { clientRequestId, query: filesRequest, timeZone: browserTimeZone() },
        session.guard,
      );
      if (!session.current()) return;
      outcome = result.status;
      setView(result);
      setUnsharedFiles([]);
      setSkipped([]);
    } catch (cause) {
      if (session.current()) setNotice(failureCopy(codeOf(cause)));
    } finally {
      if (session.current()) {
        setLastOperation({ kind: "search", outcome, durationMs: Math.max(0, performance.now() - operationStartedAt.current!) });
        operationStartedAt.current = null;
        setPhase("idle");
      }
    }
  };

  const files = view && (view.status === "ready" || view.status === "shared") ? view.files : [];
  const selectedFiles = files.map((file) => file.ref).filter((ref) => !unsharedFiles.includes(ref));
  const open = (view?.recipients ?? []).filter(
    (item) => item.status === "ready" && results[item.requestId]?.state !== "queued",
  );
  const chosen = open.filter((item) => !skipped.includes(item.requestId));

  const share = async () => {
    if (phase !== "idle" || !selectedFiles.length || !chosen.length) return;
    const session = guarded();
    if (!session) {
      setNotice("Unlock your vault to share Drive files.");
      return;
    }
    const refs = [...selectedFiles];
    setPhase("sharing");
    operationStartedAt.current = performance.now();
    setActiveElapsedMs(0);
    setNotice(null);
    const next: Record<string, Result> = {};
    let stale = false;
    let outcome: TimedOperation["outcome"] = "error";
    try {
      // One person at a time: each is their own Viewer share and outcome.
      for (const person of chosen) {
        try {
          const shared = await DriveSharingService.shareOwnerFiles(
            session.token, person.requestId, refs, session.guard,
          );
          next[person.requestId] = {
            state: "queued", shareRequestId: shared.shareRequestId,
          };
        } catch (cause) {
          const code = codeOf(cause);
          if (code === "session_changed") return;
          if (code === "owner_share_expired" || code === "request_changed") stale = true;
          next[person.requestId] = { state: "failed", code };
        }
        if (!session.current()) return;
        setResults((prior) => ({ ...prior, ...next }));
      }
      if (stale) {
        // The search is gone or changed: find the files again, never re-share it.
        setView(null);
        setResults({});
        setNotice("This search expired. Find the files again.");
        outcome = "expired";
        return;
      }
      CacheSyncService.onConsentMutated(userId);
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, { detail: { reconcile: true } }),
      );
      if (Object.values(next).some((result) => result.state === "failed"))
        setNotice("Couldn't start sharing with everyone. Retry the people marked below.");
      outcome = Object.values(next).some((result) => result.state === "failed") ? "partial" : "shared";
    } finally {
      if (session.current()) {
        setLastOperation({ kind: "share", outcome, durationMs: Math.max(0, performance.now() - operationStartedAt.current!) });
        operationStartedAt.current = null;
        setPhase("idle");
      }
    }
  };

  const requestedCount =
    (view?.recipients ?? []).filter(
      (item) => item.status === "shared" || results[item.requestId]?.state === "queued",
    ).length;
  const statusLine =
    phase === "searching"
      ? "Searching your Drive…"
      : phase === "sharing"
        ? "Sharing…"
        : view?.status === "no_match"
          ? "No matching files found."
          : view?.status === "no_recipients"
            ? "No eligible people yet."
            : requestedCount > 0 && open.length === 0
              ? `Sharing requested for ${requestedCount} ${requestedCount === 1 ? "person" : "people"}.`
              : view
                ? "Choose the files and people."
                : null;

  return (
    <section aria-label="Share Drive files with your Trusted circle" className="min-w-0 space-y-4 break-words"
      data-testid="drive-circle-share" aria-busy={phase !== "idle"}>
      <div role="status" aria-live="polite" className="min-w-0 space-y-1">
        {statusLine ? <BodyText>{statusLine}</BodyText> : null}
      </div>
      {phase !== "idle" ? (
        <HelperText data-operation={phase === "searching" ? "drive_search" : "drive_share"}>
          {phase === "searching" ? "Search" : "Share"} time: {elapsedLabel(activeElapsedMs)}
        </HelperText>
      ) : lastOperation ? (
        <HelperText data-operation={`drive_${lastOperation.kind}`} data-outcome={lastOperation.outcome}
          data-duration-ms={Math.round(lastOperation.durationMs)}>
          {lastOperation.outcome === "no_recipients" ? "People check" : lastOperation.kind === "search" ? "Search" : "Share"} took {elapsedLabel(lastOperation.durationMs)}.
        </HelperText>
      ) : null}
      <BodyText className="whitespace-pre-wrap break-words">“{filesRequest}”</BodyText>
      {notice ? <HelperText role="alert">{notice}</HelperText> : null}
      {view?.message ? <HelperText className="whitespace-pre-wrap">{view.message}</HelperText> : null}
      {view?.status === "no_recipients" ? (
        <>
          <HelperText>
            {view.excluded.length > 0
              ? "See why below. Connect by request or ask them to verify their email."
              : "Connect with someone by request, then check again."}
          </HelperText>
          <Button size="prominent" disabled={phase !== "idle"} onClick={() => void find()}>
            {phase === "searching" ? "Checking…" : "Check people again"}
          </Button>
        </>
      ) : null}
      {!view || view.status === "no_match" ? (
        <>
          <HelperText>
            Review the matches and recipients. Nothing is shared until you tap Share.
          </HelperText>
          <Button size="prominent" disabled={phase !== "idle"} onClick={() => void find()}>
            {phase === "searching" ? "Searching…" : view ? "Search again" : "Find files"}
          </Button>
        </>
      ) : null}
      {files.length > 0 && open.length > 0 ? (
        <fieldset className="min-w-0 space-y-2" disabled={phase !== "idle"}>
          <legend>
            <MediumRowLabel as="span">Files</MediumRowLabel>
          </legend>
          <ul aria-label="Files you can share" className="min-w-0 space-y-1">
            {files.map((file) => (
              <li key={file.ref}>
                <label className="flex min-h-11 min-w-0 items-center gap-3">
                  <input type="checkbox" checked={selectedFiles.includes(file.ref)}
                    onChange={(event) => setUnsharedFiles(event.target.checked
                      ? unsharedFiles.filter((ref) => ref !== file.ref)
                      : [...unsharedFiles, file.ref])} />
                  <span className="min-w-0 break-all">{file.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {view && view.recipients.length > 0 ? (
        <fieldset className="min-w-0 space-y-2" disabled={phase !== "idle"}>
          <legend>
            <MediumRowLabel as="span">People</MediumRowLabel>
          </legend>
          <ul aria-label="People who can receive" className="min-w-0 space-y-1">
            {view.recipients.map((person) => {
              const result = results[person.requestId];
              const done = person.status === "shared" || result?.state === "queued";
              const shareRequestId = result?.shareRequestId ?? person.shareRequestId;
              return (
                <li key={person.requestId}>
                  <label className="flex min-h-11 min-w-0 items-center gap-3">
                    <input type="checkbox" disabled={done}
                      checked={done || !skipped.includes(person.requestId)}
                      onChange={(event) => setSkipped(event.target.checked
                        ? skipped.filter((item) => item !== person.requestId)
                        : [...skipped, person.requestId])} />
                    <span className="min-w-0 break-all">
                      {person.name ?? "A connection"}
                      {done ? <HelperText as="span"> · sharing requested</HelperText> : null}
                      {result?.state === "failed" ? (
                        <HelperText as="span"> · {failureCopy(result.code ?? "request_failed")}</HelperText>
                      ) : null}
                    </span>
                  </label>
                  {shareRequestId ? (
                    <Link className="ml-8 text-sm text-primary underline"
                      aria-label={`Sharing status and links for ${person.name ?? "this person"}`}
                      href={buildConsentCenterHref(
                      "pending", { requestId: `document_share_request:${shareRequestId}` },
                    )}>
                      View sharing status and links
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}
      {view && view.excluded.length > 0 ? (
        <div className="min-w-0 space-y-1">
          <HelperText>Not included:</HelperText>
          <ul aria-label="Not included" className="min-w-0 list-inside list-disc space-y-1">
            {view.excluded.map((person, index) => (
              <li key={index} className="break-words text-sm">
                {person.name ?? "Someone"} — {EXCLUSION_COPY[person.reason]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {files.length > 0 && open.length > 0 ? (
        <>
          <HelperText>
            Each person gets Viewer access. Google emails new access links. You can remove access anytime.
          </HelperText>
          <Button size="prominent" disabled={phase !== "idle" || !selectedFiles.length || !chosen.length}
            onClick={() => void share()}>
            {phase === "sharing"
              ? "Sharing…"
              : `Share ${selectedFiles.length === 1 ? "1 file" : `${selectedFiles.length} files`} with ${chosen.length === 1 ? "1 person" : `${chosen.length} people`}`}
          </Button>
        </>
      ) : null}
    </section>
  );
}
