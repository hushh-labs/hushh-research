"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { BodyText, HelperText, MediumRowLabel } from "@/components/app-ui/typography";
import { FlowSelectionSummary } from "@/components/app-ui/flow-actions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DocumentHostingService, protectedDocumentUrl, approvedProtectedDocumentUrl, type DocumentSession, type HostedTermsProjection, type HostedDocumentActivity } from "@/lib/services/document-hosting-service";
import { prepareHostedDocuments, verifyHostedRecipientKey, repairHostedRecipientKey, type HostedPreparationProgress } from "@/lib/consent/document-hosting-preparation";
import { DriveRequestPaymentService } from "@/lib/services/drive-request-payment-service";
import { useHostedDocumentSession } from "./use-hosted-document-session";
import { HostedDocumentReader, documentHostingErrorCopy } from "./hosted-document-reader";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { DocumentPayoutAccountCard, type PayoutAccountState } from "./document-payout-account";
import { shareLink, isShareCancellationError } from "@/lib/share/share-link";
import { GoogleDrivePickerService } from "@/lib/services/google-drive-picker-service";
import { useHostedSourceSelection } from "./use-hosted-source-selection";

function localDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function HostedDocumentPanel({ requestId, onChanged = () => undefined }: { requestId: string; onChanged?: () => void }) {
  const session = useHostedDocumentSession(); const { user } = useAuth();
  if (!session) return <BodyText role="status">Sign in and unlock your vault to open protected documents.</BodyText>;
  return <HostedDocumentPanelBody key={`${session.userId}:${requestId}`} session={session} requestId={requestId} onChanged={onChanged}
    getIdToken={async () => { const token = await user?.getIdToken(); if (!token || !session.isCurrent()) throw new Error("session_changed"); return token; }} />;
}

/** Explicit session/transport entrypoint also used by the full-loop integration harness. */
export function HostedDocumentPanelBody({ session, requestId, getIdToken, onChanged }: { session: DocumentSession; requestId: string; getIdToken: () => Promise<string>; onChanged: () => void }) {
  const [terms, setTerms] = useState<HostedTermsProjection | null>(null);
  const [selected, setSelected] = useState<string[]>([]); const [copyAccepted, setCopyAccepted] = useState(false); const [accepted, setAccepted] = useState(false);
  const [price, setPrice] = useState(""); const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [confirmation, setConfirmation] = useState<"one" | "drive" | "both" | "repair" | "decline" | null>(null);
  const [paymentReady, setPaymentReady] = useState<boolean | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<HostedPreparationProgress | null>(null);
  const [events, setEvents] = useState<HostedDocumentActivity[]>([]);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const activityCursor = useRef("0");
  const activityScope = useRef<DocumentSession | null>(null);
  const operation = useRef<AbortController | null>(null);
  const statusRead = useRef<AbortController | null>(null);
  const foregroundBusy = useRef(false);
  const termsVersion = useRef<string | null>(null);
  const refreshPayment = useCallback(async (signal: AbortSignal, next: HostedTermsProjection) => {
    if (!session.isCurrent() || signal.aborted) return;
    if (next.ownerUserId === session.userId || !["ready_for_buyer", "checkout_open"].includes(next.status)) {
      setPaymentReady(null);
      return;
    }
    try {
      const token = await getIdToken();
      if (!session.isCurrent() || signal.aborted) return;
      const payment = await DriveRequestPaymentService.status(token, requestId);
      if (session.isCurrent() && !signal.aborted)
        setPaymentReady(payment.paymentsReady === true && payment.ownerPriceRequired !== true && payment.ownerPayoutAccountReady !== false && ["awaiting_payment", "checkout_open"].includes(payment.status));
    } catch { if (session.isCurrent() && !signal.aborted) setPaymentReady(false); }
  }, [session, requestId, getIdToken]);
  const source = useHostedSourceSelection(session, requestId, activityScope.current === session ? terms : null);
  useLayoutEffect(() => { setSelected([]); setCopyAccepted(false); }, [source.files]);
  const loadActivity = useCallback(async (signal: AbortSignal) => {
    const timeline = await DocumentHostingService.timeline(session, requestId, signal, activityCursor.current);
    if (signal.aborted || !session.isCurrent() || activityScope.current !== session) return;
    const latest = timeline.items.at(-1);
    if (latest) activityCursor.current = String(latest.sequence);
    setEvents(previous => Array.from(new Map([...previous, ...timeline.items].map(event => [event.sequence, event])).values()).sort((a, b) => a.sequence - b.sequence).slice(-500));
    setHasMoreActivity(timeline.nextCursor !== null);
  }, [session, requestId]);
  const reload = useCallback(async (signal: AbortSignal, preserveDrafts = false) => {
    const next = await DocumentHostingService.terms(session, requestId, signal);
    if (signal.aborted || !session.isCurrent()) return;
    const version = `${next.revision}:${next.termsDigest}:${next.packageDigest}`;
    if (!preserveDrafts || termsVersion.current !== version) setAccepted(false);
    termsVersion.current = version;
    setTerms(next);
    if (!preserveDrafts) {
      setPrice(next.amountCents === null ? "" : String(next.amountCents / 100));
      setDeadline(next.accessExpiresAt);
    }
    if (next.ownerUserId === session.userId) {
      await loadActivity(signal).catch(() => undefined);
    }
    await refreshPayment(signal, next);
  }, [session, requestId, loadActivity, refreshPayment]);
  useLayoutEffect(() => {
    // Session identity owns all draft, operation and decrypted presentation state.
    // Reset before paint so a renewed owner session cannot inherit a retired operation.
    operation.current?.abort();
    statusRead.current?.abort();
    foregroundBusy.current = false;
    termsVersion.current = null;
    setTerms(null); setSelected([]); setCopyAccepted(false); setAccepted(false);
    setBusy(false); setChoosing(false); setPreparing(false); setConfirmation(null); setError(null); setProgress(null); setEvents([]); setHasMoreActivity(false);
    setCheckoutPending(false);
    activityScope.current = session; activityCursor.current = "0";
    setPrice(""); setDeadline(""); setPaymentReady(null); setLinkNotice(null);
    const controller = new AbortController(); operation.current = controller;
    void reload(controller.signal).catch(cause => { if (!controller.signal.aborted && session.isCurrent()) setError(documentHostingErrorCopy(cause)); })
      .finally(() => { if (operation.current === controller) operation.current = null; });
    return () => { activityScope.current = null; controller.abort(); operation.current?.abort(); statusRead.current?.abort(); };
  }, [reload, session]);
  usePeriodicTask(`hosted-document-status:${requestId}`, 5000, async () => {
    if (foregroundBusy.current || operation.current && !operation.current.signal.aborted || busy || preparing || !session.isCurrent()) return;
    const controller = new AbortController();
    statusRead.current?.abort(); statusRead.current = controller;
    try {
      await reload(controller.signal, true);
      if (!controller.signal.aborted && session.isCurrent())
        setError(current => current === "Status could not update. Retrying…" ? null : current);
    } catch {
      if (!controller.signal.aborted && session.isCurrent()) setError("Status could not update. Retrying…");
    }
  }, { enabled: Boolean(terms && ["requested", "awaiting_owner", "preparing_on_owner_device", "staged", "ready_for_buyer", "checkout_open", "paid", "delivering"].includes(terms.status)) });
  const run = async (effect: (signal: AbortSignal) => Promise<HostedTermsProjection | void>, options: { refreshTerms?: boolean } = {}) => {
    if (foregroundBusy.current) return;
    foregroundBusy.current = true;
    statusRead.current?.abort();
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(true); setError(null);
    try {
      const next = await effect(controller.signal);
      if (!controller.signal.aborted && session.isCurrent()) {
        if (next) { setTerms(next); await refreshPayment(controller.signal, next); }
        else if (options.refreshTerms !== false) await reload(controller.signal);
        if (options.refreshTerms !== false && !controller.signal.aborted && session.isCurrent()) onChanged();
      }
    } catch (cause) { if (!controller.signal.aborted && session.isCurrent()) setError(documentHostingErrorCopy(cause)); }
    finally {
      if (operation.current === controller) { foregroundBusy.current = false; operation.current = null; }
      if (!controller.signal.aborted && session.isCurrent()) { setBusy(false); setCheckoutPending(false); setProgress(null); }
    }
  };
  const payoutBecameReady = useCallback((account: PayoutAccountState) => {
    if (busy || account.loading || account.failed || account.account?.ready !== true || !session.isCurrent()) return;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    void reload(controller.signal).catch(() => undefined);
  }, [session, reload, busy]);
  if (!terms) return <HelperText role={error ? "alert" : "status"}>{error ?? "Checking protected document access…"}</HelperText>;
  const owner = terms.ownerUserId === session.userId;
  const state = terms.status;
  const available = ["paid", "delivering", "delivered", "partial"].includes(state);
  const canPrepare = ["requested", "awaiting_owner", "preparing_on_owner_device"].includes(state);
  const reviewedFiles = owner && state === "staged" ? source.files : terms.files;
  const approvedLink = approvedProtectedDocumentUrl(requestId, terms.hostedUrl);
  const canDecline = ["requested", "awaiting_owner", "preparing_on_owner_device", "staged"].includes(state);
  const canStopOne = ["ready_for_buyer", "checkout_open", "paid", "delivering", "delivered", "partial"].includes(state);
  const canStopDrive = terms.receiveThrough === "both" &&
    (available || (["revoked", "expired"].includes(state) && (terms.deliverySummary?.expected ?? 0) > 0)) &&
    [undefined, "not_requested", "needs_attention"].includes(terms.driveRevokeStatus);
  const amountCents = Math.round(Number(price) * 100);
  const validPrice = Number.isFinite(Number(price)) && amountCents >= 50 && amountCents <= 50000;
  const validDeadline = Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) > Date.now() && Date.parse(deadline) <= Date.parse(terms.accessExpiresAt);
  const prepareBlocked = source.loading ? "Checking selected files…" : source.unavailable ? "Choose PDFs again or refresh to check this connection." : !validPrice ? "Enter a price from $0.50 to $500." : !validDeadline ? "Choose a future date within the requested access period." : !copyAccepted ? "Accept the copy permission to continue." : null;
  const ownerStatus = canPrepare ? (progress ? "Preparing encrypted copies…" : "Choose files and review the terms") : state === "ready_for_buyer" ? "Waiting for recipient acceptance" : null;
  return <section aria-label="One document delivery" className="consent-presentation-surface min-w-0 space-y-4" data-testid="hosted-document-panel" aria-busy={busy}>
    <MediumRowLabel as="p">{owner ? "Document delivery" : "Your protected documents"}</MediumRowLabel>
    <HelperText role="status">{(owner && ownerStatus) || ({ requested: "Waiting for owner approval", awaiting_owner: "Waiting for owner approval", preparing_on_owner_device: "Waiting for owner to prepare", staged: "Prepared — review final terms", ready_for_buyer: "Ready for your acceptance", checkout_open: "Waiting for payment", paid: "Payment received", delivering: "Delivering documents", delivered: "Documents available", partial: "Some documents available", revoked: "Access revoked", expired: "Access expired", refunded: "Payment refunded", erasing: "Removing copies", erased: "Copies removed" } as Record<string, string>)[state] || "Checking document status…"}</HelperText>
    <HelperText>{terms.receiveThrough === "both" ? "Google Drive and secure One link" : "Secure One link"} · Access ends {new Date(terms.accessExpiresAt).toLocaleString()}.</HelperText>
    {terms.amountCents !== null && !(owner && canPrepare && selected.length) ? <BodyText>Price ${(terms.amountCents / 100).toFixed(2)}</BodyText> : null}
    {owner && terms.ownerSetup && !terms.ownerSetup.ownerPayoutAccountReady ? <div className="space-y-2"><HelperText>Connect your payout bank before the recipient can pay.</HelperText><DocumentPayoutAccountCard compact disabled={busy} onAccountChange={payoutBecameReady} /></div> : null}
    {owner && terms.ownerSetup?.paymentsReady === false ? <HelperText role="status">Payments are unavailable. You can prepare copies; checkout waits for payout and payment setup.</HelperText> : null}
    {approvedLink ? <div className="space-y-2" aria-label="Protected One link">
      <Button asChild size="compact" variant="none"><a data-voice-control-id="document-hosting-open-link" href={approvedLink} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open protected One link</a></Button>
      <Button data-voice-control-id="document-hosting-share-link" size="compact" variant="none" disabled={busy} onClick={() => {
        setLinkNotice(null);
        void shareLink({ title: "Protected One document", text: "Sign in with the One account this document was shared with and unlock your vault.", dialogTitle: "Share protected One link", url: approvedLink }, session.isCurrent)
          .then(delivery => { if (session.isCurrent()) setLinkNotice(delivery === "copied" ? "Protected link copied." : "Link handed to sharing."); })
          .catch(cause => { if (session.isCurrent()) setLinkNotice(isShareCancellationError(cause) ? "Link was not shared." : "Could not share this link. Open the protected link to copy its address."); });
      }}>Share protected One link</Button>
      <HelperText>Forwarding this link grants no access. Only the approved recipient can decrypt the copy; no file key is included in the link.</HelperText>
      {linkNotice ? <HelperText role="status">{linkNotice}</HelperText> : null}
    </div> : null}
    {error ? <HelperText role="alert">{error}</HelperText> : null}
    {progress ? <HelperText role="status">{({ source: "Reading source on this device", preview: "Creating local preview", encrypt: "Encrypting on this device", upload: "Uploading encrypted copy", staged: "Encrypted copy prepared" })[progress.stage]} · {progress.completed} of {progress.total}</HelperText> : null}
    {owner && canPrepare ? <>
      {Capacitor.isNativePlatform() ? <div className="space-y-2"><HelperText>Open One in your browser to prepare hosted copies. Your Drive connection does not authorize copying files.</HelperText>
        {protectedDocumentUrl(requestId) ? <Button asChild size="compact"><a href={protectedDocumentUrl(requestId)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Prepare in browser</a></Button> : null}</div> : <>
        <fieldset disabled={busy || source.loading} className="space-y-2"><legend><MediumRowLabel as="span">PDFs to share</MediumRowLabel></legend>
          {source.files.map(file => <label data-consent-role="form-label" className="flex min-h-11 items-center gap-3" key={file.fileRef}><input type="checkbox" checked={selected.includes(file.fileRef)}
            onChange={event => { setCopyAccepted(false); setSelected(value => event.target.checked ? [...value, file.fileRef] : value.filter(ref => ref !== file.fileRef)); }} /><BodyText as="span" className="break-words">{file.name} · PDF</BodyText></label>)}
          {source.loading ? <HelperText>Checking files available to prepare…</HelperText> : source.unavailable ? <HelperText>Couldn’t check selected PDFs. Choose them again or refresh status.</HelperText> : !source.files.length ? <HelperText>No PDFs selected.</HelperText> : null}
        </fieldset>
        <Button data-consent-role={source.files.length ? "compact-action" : "primary-action"} data-voice-control-id="document-hosting-choose" size={source.files.length ? "compact" : "prominent"} variant={source.files.length ? "none" : undefined} disabled={busy || source.loading} onClick={() => void run(async signal => {
          setChoosing(true);
          try {
            const picker = await ExternalConnectorService.pickerSession(session.vaultOwnerToken, window.location.origin);
            try {
              if (!session.isCurrent() || signal.aborted) return;
              const files = await GoogleDrivePickerService.choose(picker, signal);
              if (!files.length || !session.isCurrent() || signal.aborted) return;
              await ExternalConnectorService.selectDocuments(session.vaultOwnerToken, picker.sessionId, files.map(file => file.id), false);
              if (!session.isCurrent() || signal.aborted) return;
              setCopyAccepted(false); setSelected([]); source.refresh();
            } finally { picker.accessToken = ""; }
          } finally { if (session.isCurrent() && !signal.aborted) setChoosing(false); }
        }, { refreshTerms: false })}>{choosing ? "Choosing files…" : "Choose files"}</Button>
        {source.files.length > 0 && selected.length > 0 ? <>
        <div className="space-y-[var(--app-form-field-gap)]"><Label data-consent-role="form-label" htmlFor="hosting-price">Price (USD)</Label><Input id="hosting-price" type="number" min="0.50" max="500" step="0.01" disabled={busy} value={price} onChange={event => { setPrice(event.target.value); setCopyAccepted(false); }} /></div>
        <div className="space-y-[var(--app-form-field-gap)]"><Label data-consent-role="form-label" htmlFor="hosting-deadline">Access until (your time)</Label><Input id="hosting-deadline" type="datetime-local" step="1" max={localDateTime(terms.accessExpiresAt)} disabled={busy} value={localDateTime(deadline)} onChange={event => { const next = new Date(event.target.value); setDeadline(Number.isFinite(next.getTime()) ? next.toISOString() : ""); setCopyAccepted(false); }} /></div>
        <label data-consent-role="disclosure" className="flex min-h-11 items-start gap-3"><input type="checkbox" checked={copyAccepted} disabled={busy || source.loading || source.unavailable || !selected.length} onChange={event => setCopyAccepted(event.target.checked)} className="mt-1" />
          <BodyText as="span">I authorize my private agent to read these PDFs on this device, create watermarked previews, encrypt and store copies until access ends, and let this recipient view and download them. Downloaded copies cannot be recalled.</BodyText></label>
        {selected.length ? <FlowSelectionSummary label="To prepare" value={`${selected.length} PDF${selected.length === 1 ? "" : "s"}`} detail={validPrice && validDeadline ? `$${(amountCents / 100).toFixed(2)} · Until ${new Date(deadline).toLocaleString()}` : undefined} /> : null}
        {prepareBlocked ? <HelperText id="hosting-prepare-help">{prepareBlocked}</HelperText> : null}
        <Button data-consent-role="primary-action" data-voice-control-id="document-hosting-prepare" size="prominent" aria-describedby={prepareBlocked ? "hosting-prepare-help" : undefined} disabled={busy || source.loading || source.unavailable || !copyAccepted || !selected.length || !validPrice || !validDeadline} onClick={() => { setPreparing(true); void run(async signal => {
          const approved = await DocumentHostingService.approve(session, requestId, { phase: "prepare", expectedRevision: terms.revision, idempotencyKey: crypto.randomUUID(),
            selectedFiles: source.files.filter(file => selected.includes(file.fileRef)), amountCents, accessExpiresAt: new Date(deadline).toISOString(),
            copyDisclosureVersion: "one-document-copy-v1", copyAccepted: true }, signal);
          // Approval commits a new revision before device preparation can fail.
          // Retain that acknowledgement so a retry uses the current authority.
          if (signal.aborted || !session.isCurrent()) return;
          setTerms(approved);
          return prepareHostedDocuments({ session, requestId, termsProjection: approved, signal, onProgress: value => {
            if (!signal.aborted && session.isCurrent()) setProgress(value);
          } });
        }).finally(() => { if (session.isCurrent()) setPreparing(false); }); }}>{preparing ? "Preparing…" : "Prepare encrypted copies"}</Button>
        </> : source.files.length ? <HelperText>Select the PDFs to prepare.</HelperText> : null}
      </>}
    </> : null}
    {!canPrepare && reviewedFiles.length ? <div aria-label="Approved files" className="space-y-1">{reviewedFiles.map(file => <BodyText key={file.fileRef} className="break-words">{file.name} · PDF</BodyText>)}</div> : null}
    {owner && state === "staged" && source.unavailable ? <HelperText>Selected files are unavailable for review in this connection. Refresh status to try again before final approval.</HelperText> : null}
    {owner && terms.termsDigest && terms.packageDigest && ["staged", "preparing_on_owner_device"].includes(state) ? <Button data-consent-role="primary-action" size="prominent" data-voice-control-id="document-hosting-final-approve" disabled={busy || source.loading || source.unavailable || !source.files.length} onClick={() => void run(signal => DocumentHostingService.approve(session, requestId,
      { phase: "final", expectedRevision: terms.revision, idempotencyKey: crypto.randomUUID(), termsDigest: terms.termsDigest, packageDigest: terms.packageDigest }, signal))}>Approve prepared copies</Button> : null}
    {!owner && ["ready_for_buyer", "checkout_open"].includes(state) && paymentReady !== true ? <HelperText role="status">{paymentReady === null ? "Checking payment readiness…" : "Payment is unavailable. Checking automatically…"}</HelperText> : null}
    {!owner && paymentReady === true && ["ready_for_buyer", "checkout_open"].includes(state) && terms.terms && terms.termsDigest && terms.packageDigest ? <>
      <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} className="mt-1" /><span>I accept this approved document version, price, access deadline and download rights.</span></label>
      <Button data-voice-control-id="document-hosting-pay" aria-busy={checkoutPending} disabled={busy || !accepted} onClick={() => {
        if (foregroundBusy.current) return;
        setCheckoutPending(true);
        void run(async signal => {
        await verifyHostedRecipientKey(session, requestId, terms.terms!.recipientKeyId, signal);
        const idToken = await getIdToken();
        if (!session.isCurrent() || signal.aborted) throw new DOMException("Session changed", "AbortError");
        const url = await DriveRequestPaymentService.checkout(idToken, requestId, { acceptedTermsRevision: terms.terms!.revision,
          acceptedTermsDigest: terms.termsDigest!, acceptedPackageDigest: terms.packageDigest! });
        if (typeof url !== "string") throw new Error("document_checkout_unavailable");
        if (session.isCurrent() && !signal.aborted) window.location.assign(url);
        });
      }}>{checkoutPending ? "Opening Checkout…" : `Accept and pay $${(terms.amountCents! / 100).toFixed(2)}`}</Button>
    </> : null}
    {!owner && available ? <HostedDocumentReader session={session} requestId={requestId} /> : null}
    {owner && terms.recoveryRequested ? <div className="space-y-2"><HelperText>The recipient proved a replacement key. Repairing access preserves the same files, price and deadline, and does not charge again.</HelperText>
      <Button data-consent-role="compact-action" data-voice-control-id="document-hosting-repair" variant="none" size="compact" disabled={busy} onClick={() => setConfirmation("repair")}>Repair recipient access</Button></div> : null}
    {terms.receiveThrough === "both" && (approvedLink || available || (terms.driveRevokeStatus && terms.driveRevokeStatus !== "not_requested")) ? <div className="space-y-1" aria-label="Delivery channels">
      <HelperText>One access: {state === "revoked" ? "stopped" : state === "expired" ? "expired" : available ? "available under the approved terms" : "waiting for payment"}.</HelperText>
      <HelperText>Drive removal: {terms.driveRevokeStatus === "pending" ? "pending reconciliation — Google access is not yet confirmed removed" : (terms.driveRevokeStatus ?? "not requested").replaceAll("_", " ")}.</HelperText>
      {terms.deliverySummary ? <HelperText>{terms.deliverySummary.confirmed} of {terms.deliverySummary.expected} files confirmed across both channels; {terms.deliverySummary.unsettled} unsettled.</HelperText> : null}
    </div> : null}
    {owner && (canDecline || canStopOne || canStopDrive) ? <div className="flex flex-wrap gap-2">
      {canDecline ? <Button data-consent-role="compact-action" data-consent-quiet-action="true" data-voice-control-id="document-hosting-revoke" variant="none" size="compact" disabled={busy} onClick={() => setConfirmation("decline")}>Decline request</Button> : null}
      {canStopOne ? <Button data-consent-role="compact-action" data-voice-control-id="document-hosting-revoke" variant="none" size="compact" disabled={busy} onClick={() => setConfirmation("one")}>Stop One access</Button> : null}
      {canStopDrive ? <>
        <Button data-consent-role="compact-action" data-voice-control-id="document-hosting-revoke-drive" variant="none" size="compact" disabled={busy} onClick={() => setConfirmation("drive")}>Stop Drive access</Button>
        {canStopOne ? <Button data-consent-role="compact-action" data-voice-control-id="document-hosting-revoke-both" variant="none" size="compact" disabled={busy} onClick={() => setConfirmation("both")}>Stop both channels</Button> : null}
      </> : null}
    </div> : null}
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation === "decline" ? "Decline this request?" : confirmation === "repair" ? "Repair recipient access?" : confirmation === "both" ? "Stop both channels?" : confirmation === "drive" ? "Stop Drive access?" : "Stop One access?"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation === "decline" ? "This ends this document delivery request and stops future One access. Downloaded copies cannot be recalled." : confirmation === "repair" ? "Authorize these unchanged encrypted copies for the recipient’s proven replacement key. Files, price and access deadline stay the same, with no new charge." : confirmation === "one" ? "This stops future One access and leaves Google Drive access unchanged. Downloaded copies cannot be recalled." : confirmation === "drive" ? "Request removal of Drive access created by this app. Existing or independently granted access remains. Removal may stay pending; One access is unchanged." : "This stops future One access and requests removal of Drive access created by this app. Existing or independently granted Drive access remains. Removal may stay pending. Downloaded copies cannot be recalled."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{confirmation === "decline" ? "Keep request" : confirmation === "repair" ? "Not now" : "Keep access"}</AlertDialogCancel>
          <AlertDialogAction variant={confirmation === "repair" ? "default" : "destructive"} disabled={busy} onClick={() => {
            const scope = confirmation;
            setConfirmation(null);
            if (scope === "repair" && terms.recoveryRequested) void run(signal => repairHostedRecipientKey(session, requestId, terms, signal));
            else if (scope === "decline" && canDecline) void run(signal => DocumentHostingService.revoke(session, requestId, terms.revision, "one", signal));
            else if (scope && scope !== "repair" && scope !== "decline" && (scope === "one" ? canStopOne : scope === "drive" ? canStopDrive : canStopOne && canStopDrive))
              void run(signal => DocumentHostingService.revoke(session, requestId, terms.revision, scope, signal));
          }}>{confirmation === "decline" ? "Decline request" : confirmation === "repair" ? "Repair access" : "Stop access"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {owner && events.length ? <div className="space-y-2" aria-label="Document activity"><BodyText>Activity</BodyText>{events.map(event => <div key={event.sequence}><BodyText>{event.actorUserId === terms.recipientUserId ? "Recipient" : event.actorUserId === terms.ownerUserId ? "Owner" : "System"} · {event.kind.replaceAll("_", " ")}</BodyText><HelperText>{new Date(event.createdAt).toLocaleString()} · {event.provenance ?? "Recorded"}{event.country ? ` · Approximate network country: ${event.country}` : ""}</HelperText></div>)}</div> : null}
    {owner && hasMoreActivity ? <div className="space-y-2"><HelperText>More recent activity is available. Load the next page to continue.</HelperText><Button data-voice-control-id="document-hosting-load-activity" size="compact" variant="none" disabled={busy} onClick={() => void run(signal => loadActivity(signal), { refreshTerms: false })}>Load newer activity</Button></div> : null}
    {owner && events.length === 500 ? <HelperText>Showing the 500 most recently loaded activity events.</HelperText> : null}
    <Button data-consent-role="compact-action" data-consent-quiet-action="true" data-voice-control-id="document-hosting-refresh" variant="none" size="compact" disabled={busy} onClick={() => void run(signal => reload(signal), { refreshTerms: false })}>Refresh status</Button>
  </section>;
}
