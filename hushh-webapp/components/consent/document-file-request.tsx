"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
  validDocumentRequestTerms,
} from "@/lib/services/drive-sharing-service";
import { DriveRequestRequesterService } from "@/lib/services/drive-request-requester-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { MobileDocumentDateRange } from "@/components/consent/mobile-document-date-range";
import { IllustratedRequestContent, IllustratedRequestForm, IllustratedRequestBody, IllustratedRequestActions } from "@/components/app-ui/illustrated-request-dialog";
import {
  DocumentRequestQuoteNotice,
  useDocumentRequestQuote,
} from "@/components/consent/document-request-quote";
import { IDENTITY_REQUIRED, fileRequestError } from "@/components/consent/file-request-errors";
import { PacketRow } from "@/components/consent/packets/packet-rows";
import { dayRangeLabel } from "@/components/consent/packets/packet-copy";
import type { DriveRequestQuote } from "@/lib/services/drive-request-pricing-service";
import {
  Dialog,
  DialogTrigger,
} from "@/components/ui/dialog";

export type FileRequestTerms = {
  purpose: string;
  periodStart: string | null;
  periodEnd: string | null;
  accessDays?: number;
  requesterActorType?: "person" | "ria";
  reason?: string;
};

export const FILE_REQUEST_HELPER =
  "You get original Drive links for the files they share with you.";

export function validFileRequest(terms: FileRequestTerms): boolean {
  if (terms.accessDays !== undefined &&
    (!Number.isSafeInteger(terms.accessDays) || terms.accessDays < 1 || terms.accessDays > 90)) return false;
  if (terms.requesterActorType !== undefined &&
    terms.requesterActorType !== "person" && terms.requesterActorType !== "ria") return false;
  if (terms.reason !== undefined && (terms.reason.length > 500 ||
    (terms.requesterActorType === "ria" && !terms.reason.trim()))) return false;
  return validDocumentRequestTerms(
    terms.purpose,
    terms.periodStart || null,
    terms.periodEnd || null,
  );
}

export type RecipientIdentityPreview = {
  state: "idle" | "loading" | "ready" | "missing" | "unavailable";
  email: string | null;
  refresh: () => void;
};

/**
 * The Google account a new request's files would go to, checked by the server
 * the way sending checks it, never from client providerData. A failed check
 * only hides the line: sending verifies the account again.
 */
export function useRecipientIdentityPreview({
  active,
  userId,
  getToken,
}: {
  active: boolean;
  userId: string;
  getToken: () => string | null;
}): RecipientIdentityPreview {
  const [result, setResult] = useState<Omit<RecipientIdentityPreview, "refresh">>({
    state: "idle",
    email: null,
  });
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((current) => current + 1), []);

  useEffect(() => {
    const token = active ? getToken() : null;
    if (!token) {
      setResult({ state: "idle", email: null });
      return;
    }
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    const current = () =>
      !cancelled && isVaultSessionEpochCurrent(epoch) && getToken() === token;
    const guard = () => {
      if (!current()) throw new DriveSharingError("session_changed");
    };
    setResult((previous) => ({ state: "loading", email: previous.email }));
    void Promise.resolve()
      .then(() => AuthService.documentRequestIdentityToken(userId, current))
      .then((firebaseToken) => {
        guard();
        return DriveRequestRequesterService.recipientIdentity(token, firebaseToken, guard);
      })
      .then((identity) => {
        if (current()) setResult({ state: "ready", email: identity.email });
      })
      .catch((cause) => {
        if (!current()) return;
        const code =
          cause instanceof DriveSharingError
            ? cause.code
            : cause instanceof Error
              ? cause.message
              : "";
        setResult({ state: IDENTITY_REQUIRED.has(code) ? "missing" : "unavailable", email: null });
      });
    return () => {
      cancelled = true;
    };
  }, [active, userId, getToken, reload]);

  return { ...result, refresh };
}

/** "Files will be shared with a@gmail.com", or what to add before sending. */
export function RecipientIdentityNotice({ preview }: { preview: RecipientIdentityPreview }) {
  if (preview.state === "ready" && preview.email)
    return (
      <HelperText className="[overflow-wrap:anywhere]">
        Files will be shared with {preview.email}
      </HelperText>
    );
  if (preview.state === "missing")
    return <HelperText role="status">Add a Google account to receive the files.</HelperText>;
  return null;
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
  onQuoteChanged,
  identityMissing = false,
  onIdentityLinked,
  canRequest = true,
}: {
  userId: string;
  personRef: string;
  getToken: () => string | null;
  initial?: { terms: FileRequestTerms; clientRequestId: string };
  onQuoteChanged?: () => void;
  /** The preview found no linked Google account: sending links one first. */
  identityMissing?: boolean;
  /** A Google account was linked while sending; the preview reads it again. */
  onIdentityLinked?: () => void;
  canRequest?: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "verifying" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsGoogleAfterSend, setNeedsGoogle] = useState(false);
  const [linked, setLinked] = useState(false);
  const needsGoogle = needsGoogleAfterSend || (identityMissing && !linked);
  const alive = useRef(false);
  const eligibility = useRef(canRequest);
  eligibility.current = canRequest;
  const serial = useRef(0);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string; quoteVersion: number | null } | null>(
    initial
      ? {
          fingerprint: fingerprintOf(personRef, initial.terms),
          id: initial.clientRequestId,
          quoteVersion: null,
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
  const send = async (terms: FileRequestTerms, quote: DriveRequestQuote | null): Promise<string | null> => {
    if (!eligibility.current || inFlight.current || !validFileRequest(terms) || !quote || !alive.current) return null;
    const token = getToken();
    if (!token) return null;
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
    const clean = normalize(terms);
    const fingerprint = fingerprintOf(personRef, clean);
    if (attempt.current?.fingerprint !== fingerprint ||
        (attempt.current.quoteVersion !== null && attempt.current.quoteVersion !== quote.version)) {
      attempt.current = { fingerprint, id: crypto.randomUUID(), quoteVersion: quote.version };
    } else {
      attempt.current.quoteVersion = quote.version;
    }
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
      if (!eligibility.current) {
        setError("Your connection needs to be confirmed before sending. Your details are kept.");
        return null;
      }
      if (linkGoogle) {
        setNeedsGoogle(false);
        setLinked(true);
        onIdentityLinked?.();
      }
      setPhase("sending");
      const result = await DriveSharingService.create(
        token,
        firebaseToken,
        { ownerPersonRef: personRef, clientRequestId, expectedQuoteVersion: quote.version,
          ...(clean.accessDays === undefined ? {} : { accessDays: clean.accessDays }),
          ...(clean.requesterActorType === undefined ? {} : { requesterActorType: clean.requesterActorType }),
          ...(clean.reason === undefined ? {} : { reason: clean.reason }),
          purpose: {
            purpose: clean.purpose, periodStart: clean.periodStart, periodEnd: clean.periodEnd,
          } },
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
      if (code === "price_changed") onQuoteChanged?.();
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
    ...(terms.accessDays === undefined ? {} : { accessDays: terms.accessDays }),
    ...(terms.requesterActorType === undefined ? {} : { requesterActorType: terms.requesterActorType }),
    ...(terms.reason === undefined ? {} : { reason: terms.reason.trim() }),
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
  agentPackagesEnabled = false,
  renderTrigger,
  canRequest = true,
  availabilityNotice,
  initialOpen = false,
  showTrigger = true,
  returnFocusRef,
}: {
  userId: string;
  personRef: string;
  personName: string;
  getToken: () => string | null;
  agentPackagesEnabled?: boolean;
  renderTrigger?: (label: string) => ReactNode;
  canRequest?: boolean;
  availabilityNotice?: ReactNode;
  initialOpen?: boolean;
  showTrigger?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [purpose, setPurpose] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [accessDays, setAccessDays] = useState(30);
  const [requesterActorType, setRequesterActorType] = useState<"person" | "ria">("person");
  const [reason, setReason] = useState("");
  const [created, setCreated] = useState<{ requestId: string; purpose: string; start: string; end: string } | null>(null);
  const quote = useDocumentRequestQuote({ active: open && !created && canRequest, ownerPersonRef: personRef, getToken });
  const identity = useRecipientIdentityPreview({ active: open && !created && canRequest, userId, getToken });
  const request = useFileRequest({
    canRequest,
    userId,
    personRef,
    getToken,
    onQuoteChanged: quote.refresh,
    identityMissing: identity.state === "missing",
    onIdentityLinked: identity.refresh,
  });
  const terms = { purpose, periodStart: start || null, periodEnd: end || null,
    ...(agentPackagesEnabled ? { accessDays, requesterActorType, reason } : {}) };
  const valid = validFileRequest(terms);
  const busy = request.phase !== "idle";
  const close = () => {
    // Dismissal cannot cancel a POST which the server may already have accepted.
    if (request.phase === "sending") return;
    request.reset();
    setOpen(false);
  };
  const submit = async () => {
    const requestId = await request.send(terms, quote.quote);
    if (!requestId) return;
    setCreated({ requestId, purpose: purpose.trim(), start, end });
    setPurpose("");
    setStart("");
    setEnd("");
    setAccessDays(30);
    setRequesterActorType("person");
    setReason("");
  };
  return (
    <>
      <Dialog
        modal
        open={open}
        onOpenChange={(value) => {
          if (value) setOpen(true);
          else close();
        }}
      >
        {showTrigger ? <DialogTrigger asChild>
          <Button data-consent-role="compact-action" size="standard" variant="none">{renderTrigger?.("Request files") ?? "Request files"}</Button>
        </DialogTrigger> : null}
        <IllustratedRequestContent
          intent="files" className="consent-presentation-surface"
          title={created ? "Request sent" : "Request files"}
          description={`To ${personName}`}
          success={Boolean(created)}
          data-request-files-dialog
          showCloseButton={request.phase !== "sending"}
          srDescription={`Request files from ${personName}.`}
          onCloseAutoFocus={(event) => {
            if (!showTrigger && returnFocusRef?.current) {
              event.preventDefault();
              returnFocusRef.current.focus();
            }
          }}
        >
          {created ? (
            <>
              <IllustratedRequestBody>
              <BodyText role="status">Request sent.</BodyText>
              {agentPackagesEnabled && <SettingsGroup density="compact">
                <PacketRow item={{
                  id: created.requestId,
                  title: created.purpose,
                  statusLine: [`Waiting for ${personName}`, dayRangeLabel(created.start, created.end)]
                    .filter(Boolean).join(" · "),
                  amountCents: null,
                  tone: "waiting",
                }} />
              </SettingsGroup>}
              </IllustratedRequestBody>
              <IllustratedRequestActions>
              <FlowActionGroup
                primary={
                  <Button data-consent-role="primary-action" asChild size="prominent">
                    <Link
                      href={buildConsentCenterHref("pending", {
                        requestId: `document_share_request:${created.requestId}`,
                        requestView: "sent",
                      })}
                    >
                      View request
                    </Link>
                  </Button>
                }
                secondary={
                  <Button data-consent-quiet-action="true" data-consent-role="primary-action"
                    type="button"
                    size="prominent"
                    variant="none"
                    disabled={!canRequest}
                    onClick={() => {
                      setCreated(null);
                      request.reset();
                    }}
                  >
                    Request more files
                  </Button>
                }
              />
              </IllustratedRequestActions>
            </>
          ) : (
            <IllustratedRequestForm
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <IllustratedRequestBody>
              {availabilityNotice}
              <div className="space-y-2">
                <Label htmlFor="document-request-purpose" data-consent-role="form-label">
                  Which files do you need?
                </Label>
                <Textarea
                  id="document-request-purpose" data-consent-input="true"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  maxLength={2000}
                  required
                  disabled={busy}
                  placeholder="Bank statements"
                />
              </div>
              {agentPackagesEnabled && <>
                <div className="space-y-2">
                  <Label htmlFor="document-request-role" data-consent-role="form-label">Requesting as</Label>
                  <select id="document-request-role" data-consent-input="true" value={requesterActorType}
                    onChange={event => setRequesterActorType(event.target.value as "person" | "ria")}
                    disabled={busy}
                    className="block min-h-11 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm font-normal">
                    <option value="person">Myself</option>
                    <option value="ria">Verified RIA</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="document-request-reason" data-consent-role="form-label">Reason{requesterActorType === "ria" ? "" : " (optional)"}</Label>
                  <Textarea id="document-request-reason" data-consent-input="true" value={reason}
                    onChange={event => setReason(event.target.value)} maxLength={500}
                    required={requesterActorType === "ria"} disabled={busy}
                    placeholder="Why do you need these documents?" />
                </div>
              </>}
              <fieldset className="min-w-0" disabled={busy} aria-describedby="document-period-help">
                <legend data-consent-role="form-label" className="mb-2">Dates covered</legend>
                <span id="document-period-help" className="sr-only">Start and end dates are required.</span>
                <MobileDocumentDateRange
                  start={start}
                  end={end}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                />
                <div className="hidden min-w-0 gap-3 sm:grid sm:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="document-period-start" data-consent-role="form-label">Start date</Label>
                    <Input
                      id="document-period-start" data-consent-input="true"
                      type="date"
                      value={start}
                      onChange={(event) => setStart(event.target.value)}
                      required
                    />
                  </div>
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="document-period-end" data-consent-role="form-label">End date</Label>
                    <Input
                      id="document-period-end" data-consent-input="true"
                      type="date"
                      value={end}
                      onChange={(event) => setEnd(event.target.value)}
                      required
                    />
                  </div>
                </div>
              </fieldset>
              {agentPackagesEnabled && <div className="space-y-2">
                <Label htmlFor="document-access-days" data-consent-role="form-label">Access period</Label>
                <select id="document-access-days" data-consent-input="true" value={accessDays}
                  onChange={event => setAccessDays(Number(event.target.value))}
                  disabled={busy}
                  className="block min-h-11 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm font-normal">
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>}
              {(start || end) && (!start || !end) ? (
                <HelperText role="status">Choose a start and end date.</HelperText>
              ) : null}
              {start && end && !validDocumentRequestPeriod(start, end) ? (
                <HelperText role="status">
                  The end date must be on or after the start date.
                </HelperText>
              ) : null}
              {request.error ? (
                <HelperText as="p" role="alert">
                  {request.error}
                </HelperText>
              ) : null}
              <RecipientIdentityNotice preview={identity} />
              <DocumentRequestQuoteNotice quote={quote.quote} loading={quote.loading}
                error={quote.error} onRetry={quote.refresh} personName={personName} />
              </IllustratedRequestBody>
              <IllustratedRequestActions>
              <FlowActionGroup
                primary={
                  <Button data-consent-role="primary-action" type="submit" size="prominent" disabled={!canRequest || !valid || !quote.quote || busy}>
                    {request.phase !== "idle"
                      ? "Sending…"
                      : request.needsGoogle
                        ? "Add Google account"
                        : "Send request"}
                  </Button>
                }
                secondary={
                  <Button data-consent-quiet-action="true" data-consent-role="compact-action"
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
              </IllustratedRequestActions>
            </IllustratedRequestForm>
          )}
        </IllustratedRequestContent>
      </Dialog>
    </>
  );
}
