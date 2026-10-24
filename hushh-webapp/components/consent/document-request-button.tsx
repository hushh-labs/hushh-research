"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import type { PersonConnectorAvailability } from "@/lib/connections/use-person-connector-features";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
  subscribeVaultSessionEpoch,
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
import { IllustratedRequestContent, IllustratedRequestForm, IllustratedRequestBody, IllustratedRequestActions } from "@/components/app-ui/illustrated-request-dialog";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DocumentShareReview } from "@/components/consent/document-share-review";
import { DocumentRequestQuoteNotice, useDocumentRequestQuote } from "@/components/consent/document-request-quote";
import { DriveQueryRequestCard } from "@/components/consent/drive-query-request-card";
import {
  FILE_REQUEST_HELPER,
  RecipientIdentityNotice,
  RequestFilesButton,
  fileRequestLabel,
  useFileRequest,
  useRecipientIdentityPreview,
  validFileRequest,
} from "@/components/consent/document-file-request";
import {
  Dialog,
} from "@/components/ui/dialog";

type RequestDraft = {
  clientRequestId: string;
  purpose: string;
  periodStart: string | null;
  periodEnd: string | null;
};

const ASK_HELPER =
  "They see your question and decide. Nothing in their Drive is read unless they allow it. If they share files, you get Viewer access through the Google account linked to your One sign-in.";

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
  renderTrigger,
  canRequest = true,
  availability,
  onAvailabilityRetry,
  showTrigger = true,
  returnFocusRef,
}: {
  personRef: string;
  personName: string;
  draft?: RequestDraft;
  renderTrigger?: (label: string) => ReactNode;
  canRequest?: boolean;
  availability?: PersonConnectorAvailability;
  onAvailabilityRetry?: () => unknown;
  showTrigger?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken, vaultOwnerToken } = useVault();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [intent, setIntent] = useState<"files" | "query" | null>(null);
  if (!user) return null;
  if (!isVaultUnlocked) return draft ? null : <>
    {showTrigger && (["files", "query"] as const).map((action) => <Button key={action} size="standard" variant="none" onClick={() => { setIntent(action); setUnlockOpen(true); }}>
      {renderTrigger?.(action === "files" ? "Request files" : "Ask about files") ?? (action === "files" ? "Request files" : "Ask about files")}
    </Button>)}
    <VaultUnlockDialog user={user} open={unlockOpen} onOpenChange={setUnlockOpen} onSuccess={() => setUnlockOpen(false)} title="Unlock to request" description="Unlock your vault to continue this request." presentationClassName="consent-presentation-surface" />
  </>;
  return (
    <UnlockedRequestButton
      key={`${user.uid}:${personRef}:${draft?.clientRequestId ?? "manual"}`}
      userId={user.uid}
      personRef={personRef}
      personName={personName}
      draft={draft}
      renderTrigger={renderTrigger}
      getToken={getVaultOwnerToken}
      credentialReady={Boolean(vaultOwnerToken || getVaultOwnerToken())}
      canRequest={canRequest}
      availability={availability}
      onAvailabilityRetry={onAvailabilityRetry}
      initialAction={intent}
      showTrigger={showTrigger}
      returnFocusRef={returnFocusRef}
    />
  );
}

function UnlockedRequestButton({
  userId,
  personRef,
  personName,
  draft,
  getToken,
  renderTrigger,
  canRequest,
  availability,
  onAvailabilityRetry,
  credentialReady,
  initialAction,
  showTrigger,
  returnFocusRef,
}: {
  userId: string;
  personRef: string;
  personName: string;
  draft?: RequestDraft;
  renderTrigger?: (label: string) => ReactNode;
  canRequest: boolean;
  availability?: PersonConnectorAvailability;
  onAvailabilityRetry?: () => unknown;
  credentialReady: boolean;
  initialAction: "files" | "query" | null;
  showTrigger: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  getToken: () => string | null;
}) {
  const [fallbackEnabled, setEnabled] = useState(false);
  const [fallbackPackagesEnabled, setAgentPackagesEnabled] = useState(false);
  const [featureError, setFeatureError] = useState(false);
  const [featureChecked, setFeatureChecked] = useState(false);
  const [featureRetry, setFeatureRetry] = useState(0);
  const enabled = availability ? availability.status === "ready" && availability.documentSharing : fallbackEnabled;
  const agentPackagesEnabled = availability ? availability.status === "ready" && availability.agentPackages : fallbackPackagesEnabled;
  const allowed = canRequest && enabled && !featureError;
  const injectedAvailability = availability !== undefined;
  const eligibility = useRef(allowed);
  eligibility.current = allowed;
  const [open, setOpen] = useState(initialAction === "query");
  const questionTriggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState(draft ? draftQuestion(draft) : "");
  const [phase, setPhase] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DriveQueryView | null>(null);
  // A chat card whose file request was sent keeps showing that request.
  const [fileRequestId, setFileRequestId] = useState<string | null>(null);
  const draftTerms = draft
    ? { purpose: draft.purpose, periodStart: draft.periodStart, periodEnd: draft.periodEnd }
    : null;
  const draftNeedsDates = Boolean(draftTerms && (!draftTerms.periodStart || !draftTerms.periodEnd));
  const fileQuote = useDocumentRequestQuote({
    active: Boolean(draftTerms && enabled && !fileRequestId),
    ownerPersonRef: personRef,
    getToken,
  });
  const fileIdentity = useRecipientIdentityPreview({
    active: Boolean(draftTerms && enabled && !fileRequestId),
    userId,
    getToken,
  });
  const files = useFileRequest({
    canRequest: allowed,
    userId,
    personRef,
    getToken,
    initial: draftTerms && draft
      ? { terms: draftTerms, clientRequestId: draft.clientRequestId }
      : undefined,
    onQuoteChanged: fileQuote.refresh,
    identityMissing: fileIdentity.state === "missing",
    onIdentityLinked: fileIdentity.refresh,
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
  const credentialEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Monotonic operation fence, intentionally advanced at owner cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++;
      inFlight.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const epoch = snapshotVaultSessionEpoch();
    const token = getToken();
    if (token && !injectedAvailability) {
      setFeatureError(false);
      setFeatureChecked(false);
      void ExternalConnectorService.overview(token)
        .then((result) => {
          if (
            active && alive.current &&
            isVaultSessionEpochCurrent(epoch) &&
            getToken() === token
          ) {
            setEnabled(result.features.drive_document_sharing === true);
            setFeatureChecked(true);
            setAgentPackagesEnabled(result.driveAgentPackagesEnabled === true);
          }
        })
        .catch(() => {
          if (active && alive.current && isVaultSessionEpochCurrent(epoch)) setFeatureError(true);
        });
    }
    if (token && draftClientRequestId) {
      const guard = () => {
        if (!active || !alive.current || !isVaultSessionEpochCurrent(epoch) || getToken() !== token)
          throw new DriveSharingError("session_changed");
      };
      void DriveSharingService.lookupClient(token, draftClientRequestId, guard)
        .then((requestId) => { guard(); if (requestId) setFileRequestId(requestId); })
        .catch(() => { /* Sending still requires an explicit tap and server idempotency. */ });
    }
    return () => {
      active = false;
    };
  }, [getToken, draftClientRequestId, credentialReady, credentialEpoch, featureRetry, injectedAvailability]);
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
    if (!eligibility.current || inFlight.current || !valid || !alive.current || files.phase !== "idle") return;
    const token = getToken();
    if (!token) return;
    const epoch = snapshotVaultSessionEpoch();
    const operation = ++serial.current;
    const current = () =>
      alive.current &&
      serial.current === operation &&
      isVaultSessionEpochCurrent(epoch) &&
      getToken() === token;
    const guard = Object.assign(() => {
      if (!current()) throw new DriveSharingError("session_changed");
    }, { canDispatch: () => eligibility.current });
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
    const requestId = await files.send(draftTerms, fileQuote.quote);
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
  const availabilityNotice = !allowed ? <div role="status" className="space-y-2">
    <HelperText>{!canRequest ? "Your connection needs to be confirmed before sending. Your details are kept."
      : availability?.status === "error" || featureError ? "Availability could not be checked. Your details are kept."
      : availability?.status === "ready" || featureChecked ? "File requests are unavailable for this connection."
      : "Checking availability…"}</HelperText>
    {availability?.status === "error" || featureError ? <Button type="button" size="compact" variant="none" onClick={() => { if (onAvailabilityRetry) void onAvailabilityRetry(); else setFeatureRetry((value) => value + 1); }}>Try again</Button> : null}
  </div> : null;
  if (!enabled && draft && !created)
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
        <RecipientIdentityNotice preview={fileIdentity} />
        <DocumentRequestQuoteNotice quote={fileQuote.quote} loading={fileQuote.loading}
          error={fileQuote.error} onRetry={fileQuote.refresh} personName={personName} />
        <HelperText>Ask as a question: {ASK_HELPER}</HelperText>
        {draftNeedsDates ? (
          <HelperText role="status">
            Choose exact start and end dates with your private agent before sending this request.
          </HelperText>
        ) : null}
        {tooLong ? (
          <HelperText role="status">This question is too long to send.</HelperText>
        ) : null}
        {files.error ? <HelperText role="alert">{files.error}</HelperText> : null}
        {error ? <HelperText role="alert">{error}</HelperText> : null}
        <FlowActionGroup
          primary={
            <Button
              size="prominent"
              disabled={!draftTerms || !validFileRequest(draftTerms) || !fileQuote.quote || busy}
              onClick={() => void requestDraftFiles()}
            >
              {fileRequestLabel(files.phase, files.needsGoogle)}
            </Button>
          }
          secondary={
            <Button
              size="standard"
              variant="none"
              disabled={!valid || busy || draftNeedsDates}
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
        agentPackagesEnabled={agentPackagesEnabled}
        renderTrigger={renderTrigger}
        canRequest={allowed}
        availabilityNotice={availabilityNotice}
        initialOpen={initialAction === "files"}
        showTrigger={showTrigger}
        returnFocusRef={returnFocusRef}
      />
      {showTrigger ? <Button ref={questionTriggerRef} size="standard" variant="none" onClick={() => setOpen(true)}>
        {renderTrigger?.("Ask about files") ?? "Ask about files"}
      </Button> : null}
      <Dialog
        modal
        open={open}
        onOpenChange={(value) => {
          if (value) setOpen(true);
          else close();
        }}
      >
        <IllustratedRequestContent
          intent="drive" className="consent-presentation-surface"
          title={created ? "Question sent" : "Ask about files"}
          description={`To ${personName}`}
          success={Boolean(created)}
          showCloseButton={phase !== "sending"}
          onCloseAutoFocus={(event) => {
            const target = questionTriggerRef.current ?? returnFocusRef?.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {created ? (
            <IllustratedRequestBody>
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
            </IllustratedRequestBody>
          ) : (
            <IllustratedRequestForm
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <IllustratedRequestBody>
              {availabilityNotice}
              <div className="space-y-2">
                <Label htmlFor="drive-query-text">Your question</Label>
                <Textarea
                  id="drive-query-text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={2000}
                  required
                  disabled={phase !== "idle"}
                  placeholder="Which file has your latest project update?"
                />
              </div>
              <HelperText as="p">{ASK_HELPER}</HelperText>
              {tooLong ? (
                <HelperText role="status">Shorten your question.</HelperText>
              ) : null}
              {error ? (
                <HelperText as="p" role="alert">
                  {error}
                </HelperText>
              ) : null}
              </IllustratedRequestBody>
              <IllustratedRequestActions>
              <FlowActionGroup
                primary={
                  <Button
                    type="submit"
                    size="prominent"
                    disabled={!allowed || !valid || phase !== "idle"}
                  >
                    {phase === "sending" ? "Sending…" : "Send request"}
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
              </IllustratedRequestActions>
            </IllustratedRequestForm>
          )}
        </IllustratedRequestContent>
      </Dialog>
    </>
  );
}
