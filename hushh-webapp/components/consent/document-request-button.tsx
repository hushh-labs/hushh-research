"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import { AuthService } from "@/lib/services/auth-service";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
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

/** Independent of B's Drive grant. Drafts and retry keys never leave memory. */
export function DocumentRequestButton({
  personRef,
  personName,
}: {
  personRef: string;
  personName: string;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked) return null;
  return (
    <UnlockedRequestButton
      key={`${user.uid}:${personRef}:${snapshotVaultSessionEpoch()}`}
      userId={user.uid}
      personRef={personRef}
      personName={personName}
      getToken={getVaultOwnerToken}
    />
  );
}

function UnlockedRequestButton({
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
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [phase, setPhase] = useState<"idle" | "verifying" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const alive = useRef(false);
  const serial = useRef(0);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    const epoch = snapshotVaultSessionEpoch();
    const token = getToken();
    if (token)
      void ExternalConnectorService.overview(token)
        .then((result) => {
          if (
            alive.current &&
            isVaultSessionEpochCurrent(epoch) &&
            getToken() === token
          )
            setEnabled(result.features.drive_document_sharing === true);
        })
        .catch(() => {
          /* A rollout-status failure cannot enable a new action. */
        });
    return () => {
      alive.current = false;
      // This is a monotonic operation fence, not a captured DOM reference.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++;
      inFlight.current = false;
    };
  }, [getToken]);
  const valid =
    purpose.trim().length > 0 &&
    purpose.length <= 2000 &&
    validDocumentRequestPeriod(start || null, end || null);
  const close = () => {
    // Dismissal cannot cancel a POST which the server may already have accepted.
    if (phase === "sending") return;
    serial.current++;
    inFlight.current = false;
    setPhase("idle");
    setOpen(false);
  };
  const send = async () => {
    if (inFlight.current || !valid || !alive.current) return;
    const token = getToken();
    if (!token) return;
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
    const terms = {
      purpose: purpose.trim(),
      periodStart: start || null,
      periodEnd: end || null,
    };
    const fingerprint = JSON.stringify({ personRef, ...terms });
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    const clientRequestId = attempt.current.id;
    inFlight.current = true;
    setError(null);
    setPhase("verifying");
    try {
      // Called directly from the gesture; no fetch/await before the popup.
      const firebaseToken = await AuthService.reauthenticateGoogleIdentity(
        userId,
        current,
      );
      guard();
      setPhase("sending");
      const result = await DriveSharingService.create(
        token,
        firebaseToken,
        { ownerPersonRef: personRef, clientRequestId, purpose: terms },
        guard,
      );
      guard();
      setCreated(result.requestId);
      setPurpose("");
      setStart("");
      setEnd("");
      attempt.current = null;
      CacheSyncService.onConsentMutated(userId);
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, {
          detail: { reconcile: true },
        }),
      );
    } catch (cause) {
      if (!current()) return;
      const code =
        cause instanceof DriveSharingError
          ? cause.code
          : cause instanceof Error
            ? cause.message
            : "request_failed";
      setError(
        code === "identity_cancelled"
          ? "Google verification was cancelled. No new attempt was sent. Check Sent documents for any earlier request."
          : code === "identity_busy"
            ? "Finish the verification already open, then retry."
          : code === "identity_timeout"
            ? "Google verification timed out. Close any open verification window, then retry. Update the app if this continues."
          : code === "identity_mismatch" || code === "google_identity_required"
            ? "Use the Google identity linked to your current One account."
            : code === "native_identity_unavailable"
              ? "Update the app to verify your Google identity, then retry."
              : code === "sharing_unavailable" ||
                  code === "connector_unavailable"
                ? "Document requests are not available for this connection yet."
                : code === "connection_required"
                  ? "An active connection with this person is required."
                  : code === "identity_popup_blocked"
                    ? "Allow the Google verification popup, then retry."
                    : "The request could not be confirmed. Retry these same details to check without duplicating it.",
      );
    } finally {
      if (serial.current === operation) {
        inFlight.current = false;
        if (alive.current) setPhase("idle");
      }
    }
  };
  if (!enabled) return null;
  return (
    <>
      <Button size="standard" variant="none" onClick={() => setOpen(true)}>
        Request documents
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
            <DialogTitle>Request documents</DialogTitle>
            <DialogDescription className="break-words">
              Ask {personName} for files. They choose the exact files and
              approve or decline.
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-4">
              <BodyText role="status">
                Request sent. No files have been shared by this action.
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
                  setError(null);
                }}
              >
                New request
              </Button>
            </div>
          ) : (
            <form
              className="min-w-0 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
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
                  disabled={phase !== "idle"}
                  placeholder="Six months of bank statements"
                />
              </div>
              <fieldset
                className="grid min-w-0 gap-3 sm:grid-cols-2"
                disabled={phase !== "idle"}
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
                Verify the Google identity that should receive access. You don’t
                need to connect Drive to open approved files in Google.
              </HelperText>
              {error ? (
                <HelperText as="p" role="alert">
                  {error}
                </HelperText>
              ) : null}
              <FlowActionGroup
                primary={
                  <Button
                    type="submit"
                    size="prominent"
                    disabled={
                      !valid || phase !== "idle"
                    }
                  >
                    {phase === "verifying"
                      ? "Verifying…"
                      : phase === "sending"
                        ? "Sending…"
                        : "Verify Google & send"}
                  </Button>
                }
                secondary={
                  <Button
                    type="button"
                    size="standard"
                    variant="none"
                    disabled={phase === "sending"}
                    onClick={close}
                  >
                    Cancel
                  </Button>
                }
              />
              {phase !== "sending" ? (
                <Button asChild size="standard" variant="none">
                  <Link
                    href={buildConsentCenterHref("pending", {
                      requestView: "sent",
                    })}
                  >
                    Sent documents
                  </Link>
                </Button>
              ) : null}
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
