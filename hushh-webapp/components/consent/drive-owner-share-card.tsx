"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { ROUTES } from "@/lib/navigation/routes";
import { Button } from "@/lib/morphy-ux/button";
import { BodyText, HelperText, MediumRowLabel } from "@/components/app-ui/typography";
import {
  DriveSharingError,
  DriveSharingService,
  type DriveOwnerShareView,
} from "@/lib/services/drive-sharing-service";
import { DocumentShareReview } from "@/components/consent/document-share-review";

type Phase = "idle" | "searching" | "sharing";

function shortDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function codeOf(cause: unknown): string {
  return cause instanceof DriveSharingError ? cause.code : "request_failed";
}

function failureCopy(code: string, name: string): string {
  switch (code) {
    case "recipient_google_identity_required":
      return `${name} needs to add a Google account to One before you can share files.`;
    case "connection_required":
      return `You're not connected with ${name}.`;
    case "reconnect_required":
    case "connection_changed":
      return "Reconnect Google Drive, then try again.";
    case "owner_share_expired":
      return "This search expired. Find the files again.";
    case "drive_query_unavailable":
      return "Drive didn't answer. Try again.";
    case "request_already_decided":
      return "These files were already shared.";
    case "request_changed":
      return "Your Drive changed. Find the files again.";
    case "sharing_unavailable":
      return "Sharing Drive files isn't available right now.";
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
 * The owner shares their own Drive files with one connected person, from chat.
 * The search runs only on the owner's tap; nothing is shared until the owner
 * picks files and taps Share. The person gets Viewer access in Google Drive.
 */
export function DriveOwnerShareCard({
  personRef,
  personName,
  clientRequestId,
  filesRequest,
}: {
  personRef: string;
  personName: string;
  clientRequestId: string;
  filesRequest: string;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked)
    return <BodyText role="status">Unlock your vault to share Drive files.</BodyText>;
  return (
    <UnlockedDriveOwnerShareCard
      key={`${user.uid}:${clientRequestId}:${snapshotVaultSessionEpoch()}`}
      userId={user.uid}
      personRef={personRef}
      personName={personName}
      clientRequestId={clientRequestId}
      filesRequest={filesRequest}
      getToken={getVaultOwnerToken}
    />
  );
}

function UnlockedDriveOwnerShareCard({
  userId,
  personRef,
  personName,
  clientRequestId,
  filesRequest,
  getToken,
}: {
  userId: string;
  personRef: string;
  personName: string;
  clientRequestId: string;
  filesRequest: string;
  getToken: () => string | null;
}) {
  const [view, setView] = useState<DriveOwnerShareView | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  // Files the owner left unticked; every found file starts selected.
  const [unshared, setUnshared] = useState<string[]>([]);
  const alive = useRef(false);
  const serial = useRef(0);
  const statusTarget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    const operations = serial;
    return () => {
      alive.current = false;
      operations.current += 1;
    };
  }, []);

  const run = useCallback(
    async (
      next: Phase,
      action: (token: string, guard: () => void) => Promise<DriveOwnerShareView>,
    ) => {
      const token = getToken();
      if (!token) {
        setNotice("Unlock your vault to share Drive files.");
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
      setPhase(next);
      setNotice(null);
      try {
        const result = await action(token, guard);
        if (!current()) return;
        setView(result);
        setUnshared([]);
      } catch (cause) {
        if (!current()) return;
        const code = codeOf(cause);
        // A search that is gone or changed must be found again, not re-shared.
        if (code === "owner_share_expired" || code === "request_changed") setView(null);
        setNotice(failureCopy(code, personName));
      } finally {
        if (operation === serial.current && alive.current) {
          setPhase("idle");
          statusTarget.current?.focus();
        }
      }
    },
    [getToken, personName],
  );

  const find = () => {
    if (phase !== "idle") return;
    void run("searching", (token, guard) =>
      DriveSharingService.prepareOwnerShare(
        token,
        { recipientPersonRef: personRef, clientRequestId, query: filesRequest, timeZone: browserTimeZone() },
        guard,
      ),
    );
  };

  const found = view?.status === "ready" ? view.files : [];
  const selected = found.map((file) => file.ref).filter((ref) => !unshared.includes(ref));

  const share = () => {
    const requestId = view?.requestId;
    if (!requestId || phase !== "idle" || selected.length === 0) return;
    const refs = [...selected];
    void run("sharing", async (token, guard) => {
      const result = await DriveSharingService.shareOwnerFiles(token, requestId, refs, guard);
      CacheSyncService.onConsentMutated(userId);
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, { detail: { reconcile: true } }),
      );
      return result;
    });
  };

  const statusLine =
    phase === "searching"
      ? "Searching your Drive…"
      : phase === "sharing"
        ? "Sharing…"
        : view?.status === "shared"
          ? `Shared with ${personName}.`
          : view?.status === "no_match"
            ? "No matching files found."
            : view?.status === "ready"
              ? "Choose the files to share."
              : null;

  return (
    <section
      aria-label="Share Drive files"
      className="min-w-0 space-y-4 break-words"
      data-testid="drive-owner-share"
      aria-busy={phase !== "idle"}
    >
      <div ref={statusTarget} tabIndex={-1} role="status" aria-live="polite" className="min-w-0 space-y-1">
        <MediumRowLabel as="p">Share Drive files with {personName}</MediumRowLabel>
        {statusLine ? <BodyText>{statusLine}</BodyText> : null}
      </div>
      <BodyText className="whitespace-pre-wrap break-words">“{filesRequest}”</BodyText>
      {notice ? <HelperText role="alert">{notice}</HelperText> : null}
      {notice && /Reconnect Google Drive/.test(notice) ? (
        <Button asChild size="standard">
          <Link href={ROUTES.PROFILE_CONNECTORS}>Reconnect Google Drive</Link>
        </Button>
      ) : null}
      {view?.status === "no_match" && view.message ? (
        <HelperText className="whitespace-pre-wrap">{view.message}</HelperText>
      ) : null}
      {!view || view.status === "no_match" ? (
        <>
          <HelperText>
            Your private agent searches your Drive once for these files. Nothing is shared until
            you choose files and tap Share.
          </HelperText>
          <Button size="prominent" disabled={phase !== "idle"} onClick={find}>
            {phase === "searching" ? "Searching…" : view ? "Search again" : "Find files"}
          </Button>
        </>
      ) : null}
      {found.length > 0 ? (
        <fieldset className="min-w-0 space-y-2" disabled={phase !== "idle"}>
          <legend>
            <MediumRowLabel as="span">Files to share with {personName}</MediumRowLabel>
          </legend>
          {found.length > 1 ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={selected.length === found.length}
                onChange={(event) =>
                  setUnshared(event.target.checked ? [] : found.map((file) => file.ref))
                }
              />
              <span>Select all</span>
            </label>
          ) : null}
          <ul aria-label="Files you can share" className="min-w-0 space-y-1">
            {found.map((file) => (
              <li key={file.ref}>
                <label className="flex min-h-11 min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selected.includes(file.ref)}
                    onChange={(event) =>
                      setUnshared(
                        event.target.checked
                          ? unshared.filter((ref) => ref !== file.ref)
                          : [...unshared, file.ref],
                      )
                    }
                  />
                  <span className="min-w-0 break-all">
                    {file.name}
                    {shortDate(file.modifiedTime) ? (
                      <HelperText as="span"> · {shortDate(file.modifiedTime)}</HelperText>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <HelperText>
            {personName} gets Viewer access to the original files in Google Drive. You can remove
            access anytime.
          </HelperText>
          <Button size="prominent" disabled={phase !== "idle" || selected.length === 0} onClick={share}>
            {phase === "sharing"
              ? "Sharing…"
              : selected.length === 1
                ? "Share 1 file"
                : `Share ${selected.length} files`}
          </Button>
        </fieldset>
      ) : null}
      {view?.status === "shared" && view.shareRequestId ? (
        <DocumentShareReview requestId={view.shareRequestId} onChanged={() => undefined} />
      ) : null}
    </section>
  );
}
