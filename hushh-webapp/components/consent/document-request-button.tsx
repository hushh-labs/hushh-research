"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import {
  DriveSharingError,
  DriveSharingService,
  validDriveQuery,
  type DriveQueryView,
} from "@/lib/services/drive-sharing-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { driveQuerySelection } from "@/lib/consent/drive-query-consent";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DocumentShareReview } from "@/components/consent/document-share-review";
import { DriveQueryRequestCard } from "@/components/consent/drive-query-request-card";
import {
  FILE_REQUEST_HELPER,
  RequestFilesButton,
  fileRequestLabel,
  useFileRequest,
  validFileRequest,
} from "@/components/consent/document-file-request";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type RequestDraft = {
  clientRequestId: string;
  purpose: string;
  periodStart: string | null;
  periodEnd: string | null;
};

const ASK_HELPER =
  "They see your question and decide. Nothing in their Drive is read unless they allow it.";

/** A chat draft becomes one plain question; its period travels as text. */
function draftQuestion(draft: RequestDraft): string {
  const purpose = draft.purpose.trim();
  return draft.periodStart && draft.periodEnd
    ? `${purpose} (${draft.periodStart} to ${draft.periodEnd})`
    : purpose;
}

/**
 * Two ways to ask a connection about their Drive. A question gets an answer
 * with file titles and needs no Google account. A file request gets the
 * original Drive links after they approve the exact files. Sending either
 * creates a pending request only. Drafts and retry keys never leave memory.
 */
export function DocumentRequestButton({
  personRef,
  personName,
  draft,
}: {
  personRef: string;
  personName: string;
  draft?: RequestDraft;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked) return null;
  return (
    <UnlockedRequestButton
      key={`${user.uid}:${personRef}:${draft?.clientRequestId ?? "manual"}:${snapshotVaultSessionEpoch()}`}
      userId={user.uid}
      personRef={personRef}
      personName={personName}
      draft={draft}
      getToken={getVaultOwnerToken}
    />
  );
}

function UnlockedRequestButton({
  userId,
  personRef,
  personName,
  draft,
  getToken,
}: {
  userId: string;
  personRef: string;
  personName: string;
  draft?: RequestDraft;
  getToken: () => string | null;
}) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(draft ? draftQuestion(draft) : "");
  const [phase, setPhase] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DriveQueryView | null>(null);
  // A chat card whose file request was sent keeps showing that request.
  const [fileRequestId, setFileRequestId] = useState<string | null>(null);
  const draftTerms = draft
    ? { purpose: draft.purpose, periodStart: draft.periodStart, periodEnd: draft.periodEnd }
    : null;
  const files = useFileRequest({
    userId,
    personRef,
    getToken,
    initial: draftTerms && draft
      ? { terms: draftTerms, clientRequestId: draft.clientRequestId }
      : undefined,
  });
  const alive = useRef(false);
  const serial = useRef(0);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(
    draft
      ? {
          fingerprint: JSON.stringify({ personRef, query: draftQuestion(draft) }),
          id: draft.clientRequestId,
        }
      : null,
  );
  const draftClientRequestId = draft?.clientRequestId;
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
    if (token && draftClientRequestId) {
      const guard = () => {
        if (!alive.current || !isVaultSessionEpochCurrent(epoch) || getToken() !== token)
          throw new DriveSharingError("session_changed");
      };
      void DriveSharingService.lookupClient(token, draftClientRequestId, guard)
        .then((requestId) => { guard(); if (requestId) setFileRequestId(requestId); })
        .catch(() => { /* Sending still requires an explicit tap and server idempotency. */ });
    }
    return () => {
      alive.current = false;
      // This is a monotonic operation fence, not a captured DOM reference.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++;
      inFlight.current = false;
    };
  }, [getToken, draftClientRequestId]);
  const question = query.trim();
  const valid = validDriveQuery(question);
  const close = () => {
    // Dismissal cannot cancel a POST which the server may already have accepted.
    if (phase === "sending") return;
    serial.current++;
    inFlight.current = false;
    setPhase("idle");
    setOpen(false);
  };
  const send = async () => {
    // One draft sends one request: a question or a file request, never both at once.
    if (inFlight.current || !valid || !alive.current || files.phase !== "idle") return;
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
    // An unchanged retry reuses its key, so the server never records it twice.
    const fingerprint = JSON.stringify({ personRef, query: question });
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    const clientRequestId = attempt.current.id;
    inFlight.current = true;
    setError(null);
    setPhase("sending");
    try {
      const view = await DriveSharingService.createQuery(
        token,
        { ownerPersonRef: personRef, clientRequestId, query: question },
        guard,
      );
      guard();
      setCreated(view);
      if (!draft) {
        setQuery("");
        attempt.current = null;
      }
      CacheSyncService.onConsentMutated(userId);
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, {
          detail: { reconcile: true },
        }),
      );
    } catch (cause) {
      if (!current()) return;
      const code =
        cause instanceof DriveSharingError ? cause.code : "request_failed";
      setError(
        code === "sharing_unavailable" || code === "connector_unavailable"
          ? "Drive questions aren't available for this connection yet."
          : code === "connection_required"
            ? "You need an active connection with this person."
            : code === "request_changed"
              ? "This question was already sent with different words. Start a new question."
              : code === "invalid_argument"
                ? "Check your question and try again."
                : "Couldn't confirm it was sent. Send again. It won't be sent twice.",
      );
    } finally {
      if (serial.current === operation) {
        inFlight.current = false;
        if (alive.current) setPhase("idle");
      }
    }
  };
  const requestDraftFiles = async () => {
    if (!draftTerms || phase !== "idle") return;
    const requestId = await files.send(draftTerms);
    if (requestId) setFileRequestId(requestId);
  };
  const busy = phase !== "idle" || files.phase !== "idle";
  const tooLong = question.length > 0 && !valid;
  if (draft && fileRequestId)
    return (
      <DocumentShareReview
        requestId={fileRequestId}
        onChanged={() => CacheSyncService.onConsentMutated(userId)}
      />
    );
  if (!enabled)
    return draft ? (
      <HelperText>Drive questions are unavailable here.</HelperText>
    ) : null;
  if (draft)
    return created ? (
      <DriveQueryRequestCard
        requestId={created.requestId}
        direction="outgoing"
        initial={created}
      />
    ) : (
      <div className="min-w-0 space-y-3 break-words">
        <BodyText className="whitespace-pre-wrap">
          Ask {personName}: “{question}”
        </BodyText>
        <HelperText>Request files: {FILE_REQUEST_HELPER}</HelperText>
        <HelperText>Ask as a question: {ASK_HELPER}</HelperText>
        {tooLong ? (
          <HelperText role="status">This question is too long to send.</HelperText>
        ) : null}
        {files.error ? <HelperText role="alert">{files.error}</HelperText> : null}
        {error ? <HelperText role="alert">{error}</HelperText> : null}
        <FlowActionGroup
          primary={
            <Button
              size="prominent"
              disabled={!draftTerms || !validFileRequest(draftTerms) || busy}
              onClick={() => void requestDraftFiles()}
            >
              {fileRequestLabel(files.phase, files.needsGoogle)}
            </Button>
          }
          secondary={
            <Button
              size="standard"
              variant="none"
              disabled={!valid || busy}
              onClick={() => void send()}
            >
              {phase === "sending" ? "Sending…" : "Ask as a question"}
            </Button>
          }
        />
      </div>
    );
  return (
    <>
      <RequestFilesButton
        userId={userId}
        personRef={personRef}
        personName={personName}
        getToken={getToken}
      />
      <Button size="standard" variant="none" onClick={() => setOpen(true)}>
        Ask about files
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
            <DialogTitle>Ask about their Drive</DialogTitle>
            <DialogDescription className="break-words">
              {ASK_HELPER}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="min-w-0 space-y-4">
              <DriveQueryRequestCard
                requestId={created.requestId}
                direction="outgoing"
                initial={created}
              />
              <Button asChild size="prominent">
                <Link
                  href={buildConsentCenterHref("pending", {
                    requestId: driveQuerySelection(created.requestId),
                    requestView: "sent",
                  })}
                >
                  View question
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
                Ask another question
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
                <Label htmlFor="drive-query-text">Your question</Label>
                <Textarea
                  id="drive-query-text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={2000}
                  required
                  disabled={phase !== "idle"}
                  placeholder="e.g. Find my bank statement from March"
                />
              </div>
              {tooLong ? (
                <HelperText role="status">Shorten your question.</HelperText>
              ) : null}
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
                    disabled={!valid || phase !== "idle"}
                  >
                    {phase === "sending" ? "Sending…" : "Send"}
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
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
