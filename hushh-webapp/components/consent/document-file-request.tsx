"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import { AuthService } from "@/lib/services/auth-service";
import {
  DriveSharingError,
  DriveSharingService,
  validDocumentRequestPeriod,
} from "@/lib/services/drive-sharing-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export type FileRequestTerms = {
  purpose: string;
  periodStart: string | null;
  periodEnd: string | null;
};

export const FILE_REQUEST_HELPER =
  "You get original Drive links for the files they share with you.";

const IDENTITY_REQUIRED = new Set([
  "verify_google_identity_required",
  "google_identity_required",
]);

export function validFileRequest(terms: FileRequestTerms): boolean {
  return (
    terms.purpose.trim().length > 0 &&
    terms.purpose.length <= 2000 &&
    validDocumentRequestPeriod(terms.periodStart || null, terms.periodEnd || null)
  );
}

function fileRequestError(code: string): string {
  if (IDENTITY_REQUIRED.has(code))
    return "Add a Google account once to receive original files.";
  switch (code) {
    case "identity_link_web_required":
      return "Open One on the web to add your Google account once.";
    case "identity_already_linked":
      return "That Google account belongs to another One account. Choose another.";
    case "identity_cancelled":
      return "Google verification was cancelled. No new request was sent.";
    case "identity_busy":
      return "Finish the verification already open, then retry.";
    case "identity_timeout":
      return "Google verification timed out. Close any open verification window, then retry.";
    case "identity_mismatch":
      return "Use the Google account linked to your One account.";
    case "native_identity_unavailable":
      return "Update the app to verify your Google account, then retry.";
    case "identity_popup_blocked":
      return "Allow the Google verification popup, then retry.";
    case "sharing_unavailable":
    case "connector_unavailable":
      return "File requests aren't available for this connection yet.";
    case "connection_required":
      return "You need an active connection with this person.";
    case "request_changed":
      return "This request was already sent with different details. Start a new request.";
    default:
      return "Couldn't confirm it was sent. Send again. It won't be sent twice.";
  }
}

/**
 * Sends one exact-file request. The requester proves the Google account already
 * linked to their One sign-in; nothing here connects their Drive. An unchanged
 * retry reuses its key, so the server never records it twice.
 */
export function useFileRequest({
  userId,
  personRef,
  getToken,
  initial,
}: {
  userId: string;
  personRef: string;
  getToken: () => string | null;
  initial?: { terms: FileRequestTerms; clientRequestId: string };
}) {
  const [phase, setPhase] = useState<"idle" | "verifying" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const alive = useRef(false);
  const serial = useRef(0);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(
    initial
      ? {
          fingerprint: fingerprintOf(personRef, initial.terms),
          id: initial.clientRequestId,
        }
      : null,
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // This is a monotonic operation fence, not a captured DOM reference.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++;
      inFlight.current = false;
    };
  }, []);
  const send = async (terms: FileRequestTerms): Promise<string | null> => {
    if (inFlight.current || !validFileRequest(terms) || !alive.current) return null;
    const token = getToken();
    if (!token) return null;
    const epoch = snapshotVaultSessionEpoch();
    const operation = ++serial.current;
    const current = () =>
      alive.current &&
      serial.current === operation &&
      isVaultSessionEpochCurrent(epoch) &&
      getToken() === token;
    const guard = () => {
      if (!current()) throw new DriveSharingError("session_changed");
    };
    const clean = normalize(terms);
    const fingerprint = fingerprintOf(personRef, clean);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    const clientRequestId = attempt.current.id;
    const linkGoogle = needsGoogle;
    inFlight.current = true;
    setError(null);
    setPhase("verifying");
    try {
      const firebaseToken = await (linkGoogle
        ? AuthService.linkGoogleIdentity(userId, current)
        : AuthService.documentRequestIdentityToken(userId, current));
      guard();
      if (linkGoogle) setNeedsGoogle(false);
      setPhase("sending");
      const result = await DriveSharingService.create(
        token,
        firebaseToken,
        { ownerPersonRef: personRef, clientRequestId, purpose: clean },
        guard,
      );
      guard();
      setNeedsGoogle(false);
      attempt.current = null;
      CacheSyncService.onConsentMutated(userId);
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, {
          detail: { reconcile: true },
        }),
      );
      return result.requestId;
    } catch (cause) {
      if (!current()) return null;
      const code =
        cause instanceof DriveSharingError
          ? cause.code
          : cause instanceof Error
            ? cause.message
            : "request_failed";
      if (IDENTITY_REQUIRED.has(code)) setNeedsGoogle(true);
      setError(fileRequestError(code));
      return null;
    } finally {
      if (serial.current === operation) {
        inFlight.current = false;
        if (alive.current) setPhase("idle");
      }
    }
  };
  /** Drops any in-flight result; the server may still have accepted the POST. */
  const reset = () => {
    serial.current++;
    inFlight.current = false;
    setPhase("idle");
    setError(null);
  };
  return { phase, error, needsGoogle, send, reset };
}

function normalize(terms: FileRequestTerms): FileRequestTerms {
  return {
    purpose: terms.purpose.trim(),
    periodStart: terms.periodStart || null,
    periodEnd: terms.periodEnd || null,
  };
}

function fingerprintOf(personRef: string, terms: FileRequestTerms): string {
  const clean = normalize(terms);
  return JSON.stringify({ personRef, ...clean });
}

export function fileRequestLabel(
  phase: "idle" | "verifying" | "sending",
  needsGoogle: boolean,
): string {
  if (phase !== "idle") return "Sending…";
  return needsGoogle ? "Add Google account" : "Request files";
}

/** Asks a connection for files; the requester gets original links for the files shared. */
export function RequestFilesButton({
  userId,
  personRef,
  personName,
  getToken,
}: {
  userId: string;
  personRef: string;
  personName: string;
  getToken: () => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const request = useFileRequest({ userId, personRef, getToken });
  const terms = { purpose, periodStart: start || null, periodEnd: end || null };
  const valid = validFileRequest(terms);
  const busy = request.phase !== "idle";
  const close = () => {
    // Dismissal cannot cancel a POST which the server may already have accepted.
    if (request.phase === "sending") return;
    request.reset();
    setOpen(false);
  };
  const submit = async () => {
    const requestId = await request.send(terms);
    if (!requestId) return;
    setCreated(requestId);
    setPurpose("");
    setStart("");
    setEnd("");
  };
  return (
    <>
      <Button size="standard" variant="none" onClick={() => setOpen(true)}>
        Request files
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (value) setOpen(true);
          else close();
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Request files</DialogTitle>
            <DialogDescription className="break-words">
              Ask {personName} for files. {FILE_REQUEST_HELPER}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="min-w-0 space-y-4">
              <BodyText role="status">
                Request sent. No files have been shared yet.
              </BodyText>
              <Button asChild size="prominent">
                <Link
                  href={buildConsentCenterHref("pending", {
                    requestId: `document_share_request:${created}`,
                    requestView: "sent",
                  })}
                >
                  View request
                </Link>
              </Button>
              <Button
                type="button"
                size="standard"
                variant="none"
                onClick={() => {
                  setCreated(null);
                  request.reset();
                }}
              >
                Request more files
              </Button>
            </div>
          ) : (
            <form
              className="min-w-0 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="document-request-purpose">
                  What do you need?
                </Label>
                <Textarea
                  id="document-request-purpose"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  maxLength={2000}
                  required
                  disabled={busy}
                  placeholder="Six months of bank statements"
                />
              </div>
              <fieldset
                className="grid min-w-0 gap-3 sm:grid-cols-2"
                disabled={busy}
              >
                <legend className="mb-2">Period (optional)</legend>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="document-period-start">Start date</Label>
                  <Input
                    id="document-period-start"
                    type="date"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="document-period-end">End date</Label>
                  <Input
                    id="document-period-end"
                    type="date"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </div>
              </fieldset>
              {!validDocumentRequestPeriod(start || null, end || null) ? (
                <HelperText role="status">
                  Choose both dates, with the end on or after the start.
                </HelperText>
              ) : null}
              <HelperText as="p">
                Uses the Google account linked to your One sign-in. You don&apos;t
                connect your Drive.
              </HelperText>
              {request.error ? (
                <HelperText as="p" role="alert">
                  {request.error}
                </HelperText>
              ) : null}
              <FlowActionGroup
                primary={
                  <Button type="submit" size="prominent" disabled={!valid || busy}>
                    {request.phase !== "idle"
                      ? "Sending…"
                      : request.needsGoogle
                        ? "Add Google account"
                        : "Send request"}
                  </Button>
                }
                secondary={
                  <Button
                    type="button"
                    size="standard"
                    variant="none"
                    disabled={request.phase === "sending"}
                    onClick={close}
                  >
                    Cancel
                  </Button>
                }
              />
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
