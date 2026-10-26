"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { DocumentHostingService, type HostingReadiness } from "@/lib/services/document-hosting-service";
import { useHostedDocumentSession } from "./use-hosted-document-session";
import { validDocumentRequestPeriod } from "@/lib/services/drive-sharing-service";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { MobileDocumentDateRange } from "./mobile-document-date-range";
import { IllustratedRequestContent, IllustratedRequestForm, IllustratedRequestBody, IllustratedRequestActions } from "@/components/app-ui/illustrated-request-dialog";
import { DocumentRequestQuoteNotice, useDocumentRequestQuote } from "./document-request-quote";
import { PacketRow } from "./packets/packet-rows";
import { dayRangeLabel } from "./packets/packet-copy";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { validFileRequest } from "./file-request-contract";
import { useFileRequest } from "./use-file-request";
import { useRecipientIdentityPreview, RecipientIdentityNotice } from "./recipient-identity-preview";

// Public compatibility facade: retain existing import and test-mock paths.
export { FILE_REQUEST_HELPER, validFileRequest, fileRequestLabel } from "./file-request-contract";
export type { FileRequestTerms } from "./file-request-contract";
export { useFileRequest } from "./use-file-request";
export { useRecipientIdentityPreview, RecipientIdentityNotice } from "./recipient-identity-preview";
export type { RecipientIdentityPreview } from "./recipient-identity-preview";

/** Asks a connection for exact files through the selected, separately approved delivery method. */
export function RequestFilesButton({
  userId,
  personRef,
  personName,
  getToken,
  agentPackagesEnabled = false,
  renderTrigger,
  canRequest = true,
  driveAllowed = canRequest,
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
  driveAllowed?: boolean;
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
  const [receiveThrough, setReceiveThrough] = useState<"drive" | "one" | "both">("drive");
  const [activityAccepted, setActivityAccepted] = useState(false);
  const [hosting, setHosting] = useState<HostingReadiness | null>(null);
  const hostingSession = useHostedDocumentSession();
  useEffect(() => {
    if (!open || !hostingSession) return;
    const controller = new AbortController();
    void DocumentHostingService.readiness(hostingSession, controller.signal).then(value => {
      if (hostingSession.isCurrent() && !controller.signal.aborted) {
        setHosting(value.enabled ? value : null);
        if (value.enabled && !driveAllowed) setReceiveThrough(current => current === "drive" ? "one" : current);
      }
    }).catch(() => { if (!controller.signal.aborted) setHosting(null); });
    return () => controller.abort();
  }, [open, hostingSession, driveAllowed]);
  const [created, setCreated] = useState<{ requestId: string; purpose: string; start: string; end: string } | null>(null);
  const allowedForMode = canRequest && (receiveThrough === "drive" ? driveAllowed : Boolean(hosting));
  const quote = useDocumentRequestQuote({ active: receiveThrough === "drive" && open && !created && canRequest && driveAllowed, ownerPersonRef: personRef, getToken });
  const identity = useRecipientIdentityPreview({ active: receiveThrough !== "one" && open && !created && allowedForMode, userId, getToken });
  const request = useFileRequest({
    canRequest: allowedForMode,
    userId,
    personRef,
    getToken,
    onQuoteChanged: quote.refresh,
    identityMissing: identity.state === "missing",
    onIdentityLinked: identity.refresh,
  });
  const terms = { purpose, periodStart: start || null, periodEnd: end || null,
    ...(receiveThrough === "drive" ? {} : { receiveThrough, activityAccepted, activityDisclosureVersion: hosting?.activityDisclosureVersion, accessDays }),
    ...(agentPackagesEnabled ? {
      accessDays,
      requesterActorType: receiveThrough === "drive" ? requesterActorType : "person" as const,
      ...(receiveThrough === "drive" && requesterActorType === "ria" ? { reason } : {}),
    } : {}) };
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
    setReceiveThrough("drive"); setActivityAccepted(false);
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
              {!canRequest || (receiveThrough === "drive" && !driveAllowed) ? availabilityNotice : null}
              {hosting ? <div className="space-y-[var(--app-form-field-gap)]">
                <Label htmlFor="document-receive-through" data-consent-role="form-label">Receive through</Label>
                <select id="document-receive-through" data-voice-control-id="document-hosting-receive-through" data-consent-input="true" value={receiveThrough}
                  onChange={event => { setReceiveThrough(event.target.value as "drive" | "one" | "both"); setActivityAccepted(false); }} disabled={busy}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="drive" disabled={!driveAllowed}>Google Drive</option><option value="one">Secure One link</option><option value="both">Both</option>
                </select>
                {receiveThrough !== "drive" ? <>
                  <HelperText>Request as yourself. The owner must approve access before you can read or download PDF copies.</HelperText>
                  <label htmlFor="document-activity-accepted" className="flex min-h-11 cursor-pointer items-start gap-3">
                    <Checkbox id="document-activity-accepted" checked={activityAccepted} disabled={busy} onCheckedChange={value => setActivityAccepted(value === true)} className="mt-1" />
                    <HelperText as="span">I accept that the owner sees access activity and approximate network country when available. Activity is kept for up to 90 days. Downloaded copies cannot be recalled.</HelperText>
                  </label>
                </> : null}
              </div> : null}
              <div className="space-y-[var(--app-form-field-gap)]">
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
              {agentPackagesEnabled && receiveThrough === "drive" && <>
                <div className="space-y-[var(--app-form-field-gap)]">
                  <Label htmlFor="document-request-role" data-consent-role="form-label">Requesting as</Label>
                  <select id="document-request-role" data-consent-input="true" value={requesterActorType}
                    onChange={event => setRequesterActorType(event.target.value as "person" | "ria")}
                    disabled={busy}
                    className="block min-h-11 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm font-normal">
                    <option value="person">Myself</option>
                    <option value="ria">Verified RIA</option>
                  </select>
                </div>
                {requesterActorType === "ria" ? <div className="space-y-[var(--app-form-field-gap)]">
                  <Label htmlFor="document-request-reason" data-consent-role="form-label">Reason</Label>
                  <Textarea id="document-request-reason" data-consent-input="true" value={reason}
                    onChange={event => setReason(event.target.value)} maxLength={500}
                    required disabled={busy}
                    placeholder="Why do you need these documents?" />
                </div> : null}
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
              {(agentPackagesEnabled || receiveThrough !== "drive") && <div className="space-y-[var(--app-form-field-gap)]">
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
              {receiveThrough !== "one" ? <RecipientIdentityNotice preview={identity} /> : null}
              {receiveThrough === "drive" ? <DocumentRequestQuoteNotice quote={quote.quote} loading={quote.loading}
                error={quote.error} onRetry={quote.refresh} personName={personName} /> : <HelperText>The owner approves the files, price and access deadline. Review these terms before paying.</HelperText>}
              </IllustratedRequestBody>
              <IllustratedRequestActions>
              <FlowActionGroup
                primary={
                  <Button data-consent-role="primary-action" type="submit" size="prominent" disabled={!allowedForMode || !valid || (receiveThrough === "drive" && !quote.quote) || busy}>
                    {request.phase !== "idle"
                      ? "Sending…"
                      : receiveThrough !== "one" && request.needsGoogle
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
