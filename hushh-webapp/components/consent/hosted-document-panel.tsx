"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
  const [paymentReady, setPaymentReady] = useState<boolean | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<HostedPreparationProgress | null>(null);
  const [events, setEvents] = useState<HostedDocumentActivity[]>([]);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const activityCursor = useRef("0");
  const activityScope = useRef<DocumentSession | null>(null);
  const operation = useRef<AbortController | null>(null);
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
  const reload = useCallback(async (signal: AbortSignal) => {
    const next = await DocumentHostingService.terms(session, requestId, signal);
    if (signal.aborted || !session.isCurrent()) return;
    setTerms(next); setAccepted(false);
    setPrice(next.amountCents === null ? "" : String(next.amountCents / 100));
    setDeadline(next.accessExpiresAt);
    if (next.ownerUserId === session.userId) {
      await loadActivity(signal).catch(() => undefined);
    }
  }, [session, requestId, loadActivity]);
  useLayoutEffect(() => {
    // Session identity owns all draft, operation and decrypted presentation state.
    // Reset before paint so a renewed owner session cannot inherit a retired operation.
    operation.current?.abort();
    setTerms(null); setSelected([]); setCopyAccepted(false); setAccepted(false);
    setBusy(false); setError(null); setProgress(null); setEvents([]); setHasMoreActivity(false);
    activityScope.current = session; activityCursor.current = "0";
    setPrice(""); setDeadline(""); setPaymentReady(null); setLinkNotice(null);
    const controller = new AbortController(); operation.current = controller;
    void reload(controller.signal).catch(cause => { if (!controller.signal.aborted && session.isCurrent()) setError(documentHostingErrorCopy(cause)); });
    return () => { activityScope.current = null; controller.abort(); operation.current?.abort(); };
  }, [reload, session]);
  const run = async (effect: (signal: AbortSignal) => Promise<HostedTermsProjection | void>, options: { refreshTerms?: boolean } = {}) => {
    if (busy) return;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(true); setError(null);
    try {
      const next = await effect(controller.signal);
      if (!controller.signal.aborted && session.isCurrent()) {
        if (next) setTerms(next); else if (options.refreshTerms !== false) await reload(controller.signal);
        if (options.refreshTerms !== false) onChanged();
      }
    } catch (cause) { if (!controller.signal.aborted && session.isCurrent()) setError(documentHostingErrorCopy(cause)); }
    finally { if (!controller.signal.aborted && session.isCurrent()) { setBusy(false); setProgress(null); } }
  };
  const payoutBecameReady = useCallback((account: PayoutAccountState) => {
    if (busy || account.loading || account.failed || account.account?.ready !== true || !session.isCurrent()) return;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    void reload(controller.signal).catch(() => undefined);
  }, [session, reload, busy]);
  useEffect(() => {
    setPaymentReady(null);
    if (!terms || terms.ownerUserId === session.userId || !["ready_for_buyer", "checkout_open"].includes(terms.status)) return;
    const controller = new AbortController();
    void getIdToken().then(token => {
      if (!session.isCurrent() || controller.signal.aborted) throw new DOMException("Session changed", "AbortError");
      return DriveRequestPaymentService.status(token, requestId);
    }).then(payment => {
      if (session.isCurrent() && !controller.signal.aborted)
        setPaymentReady(payment.paymentsReady === true && payment.ownerPriceRequired !== true && payment.ownerPayoutAccountReady !== false && ["awaiting_payment", "checkout_open"].includes(payment.status));
    }).catch(() => { if (session.isCurrent() && !controller.signal.aborted) setPaymentReady(false); });
    return () => controller.abort();
  }, [terms, session, requestId, getIdToken]);
  if (!terms) return <HelperText role={error ? "alert" : "status"}>{error ?? "Checking protected document access…"}</HelperText>;
  const owner = terms.ownerUserId === session.userId;
  const state = terms.status;
  const available = ["paid", "delivering", "delivered", "partial"].includes(state);
  const canPrepare = ["requested", "awaiting_owner", "preparing_on_owner_device"].includes(state);
  const reviewedFiles = owner && state === "staged" ? source.files : terms.files;
  const approvedLink = approvedProtectedDocumentUrl(requestId, terms.hostedUrl);
  const amountCents = Math.round(Number(price) * 100);
  const validPrice = Number.isFinite(Number(price)) && amountCents >= 50 && amountCents <= 50000;
  const validDeadline = Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) > Date.now() && Date.parse(deadline) <= Date.parse(terms.accessExpiresAt);
  return <section aria-label="One document delivery" className="min-w-0 space-y-4" data-testid="hosted-document-panel">
    <BodyText className="font-medium">{owner ? "Document delivery" : "Your protected documents"}</BodyText>
    <HelperText role="status">{({ requested: "Waiting for owner approval", awaiting_owner: "Waiting for owner approval", preparing_on_owner_device: "Waiting for owner to prepare", staged: "Prepared — confirm final approval", ready_for_buyer: "Ready for your acceptance", checkout_open: "Waiting for payment", paid: "Payment received", delivering: "Delivering documents", delivered: "Documents available", partial: "Some documents available", revoked: "Access revoked", expired: "Access expired" } as Record<string, string>)[state] ?? state.replaceAll("_", " ")}</HelperText>
    <HelperText>Receive through: {terms.receiveThrough === "both" ? "Google Drive and secure One link" : "Secure One link"}. Access ends {new Date(terms.accessExpiresAt).toLocaleString()}.</HelperText>
    {terms.amountCents !== null ? <BodyText>Price ${(terms.amountCents / 100).toFixed(2)}</BodyText> : null}
    {owner && terms.ownerSetup?.ownerPriceRequired ? <HelperText>Set the price before preparing copies. The recipient cannot pay until the final terms are approved.</HelperText> : null}
    {owner && terms.ownerSetup && !terms.ownerSetup.ownerPayoutAccountReady ? <div className="space-y-2"><HelperText>Connect your payout bank before the recipient can pay.</HelperText><DocumentPayoutAccountCard compact disabled={busy} onAccountChange={payoutBecameReady} /></div> : null}
    {owner && terms.ownerSetup?.paymentsReady === false ? <HelperText role="status">Payments are unavailable until payout setup and payment processing are ready. Preparing a copy does not open checkout.</HelperText> : null}
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
        <fieldset disabled={busy || source.loading} className="space-y-2"><legend>Select exact PDF files to copy</legend>
          {source.files.map(file => <label className="flex min-h-11 items-center gap-3" key={file.fileRef}><input type="checkbox" checked={selected.includes(file.fileRef)}
            onChange={event => { setCopyAccepted(false); setSelected(value => event.target.checked ? [...value, file.fileRef] : value.filter(ref => ref !== file.fileRef)); }} /><span className="break-words text-sm">{file.name} · PDF</span></label>)}
          {source.loading ? <HelperText>Checking files available to prepare…</HelperText> : source.unavailable ? <HelperText>Source files are unavailable in this connection. Status and access controls remain available. Refresh status to try again.</HelperText> : !source.files.length ? <HelperText>No supported selected Drive PDFs are available. Select files in your Drive connection first.</HelperText> : null}
        </fieldset>
        <Button data-voice-control-id="document-hosting-choose" size="compact" variant="none" disabled={busy} onClick={() => void run(async signal => {
          setCopyAccepted(false); setSelected([]);
          const picker = await ExternalConnectorService.pickerSession(session.vaultOwnerToken, window.location.origin);
          try {
            const files = await GoogleDrivePickerService.choose(picker, signal);
            if (files.length && session.isCurrent() && !signal.aborted)
              await ExternalConnectorService.selectDocuments(session.vaultOwnerToken, picker.sessionId, files.map(file => file.id), false);
          } finally { picker.accessToken = ""; }
        })}>Choose PDFs from Drive</Button>
        <div className="space-y-2"><Label htmlFor="hosting-price">Price (USD)</Label><Input id="hosting-price" type="number" min="0.50" max="500" step="0.01" disabled={busy} value={price} onChange={event => setPrice(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="hosting-deadline">Access until (UTC)</Label><Input id="hosting-deadline" type="text" disabled={busy} value={deadline} onChange={event => setDeadline(event.target.value)} /></div>
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" checked={copyAccepted} disabled={busy} onChange={event => setCopyAccepted(event.target.checked)} className="mt-1" />
          <span>One will store an encrypted copy until access ends. I authorize these selected files to be read directly on this device, previewed, watermarked and encrypted for this recipient to view and download. Downloaded copies cannot be taken back.</span></label>
        <Button data-voice-control-id="document-hosting-prepare" disabled={busy || source.loading || !copyAccepted || !selected.length || !validPrice || !validDeadline} onClick={() => void run(async signal => {
          const approved = await DocumentHostingService.approve(session, requestId, { phase: "prepare", expectedRevision: terms.revision, idempotencyKey: crypto.randomUUID(),
            selectedFiles: source.files.filter(file => selected.includes(file.fileRef)), amountCents, accessExpiresAt: new Date(deadline).toISOString(),
            copyDisclosureVersion: "one-document-copy-v1", copyAccepted: true }, signal);
          return prepareHostedDocuments({ session, requestId, termsProjection: approved, signal, onProgress: value => {
            if (!signal.aborted && session.isCurrent()) setProgress(value);
          } });
        })}>{busy ? "Preparing…" : "Authorize and prepare encrypted copies"}</Button>
      </>}
    </> : null}
    {!canPrepare && reviewedFiles.length ? <div aria-label="Approved files" className="space-y-1">{reviewedFiles.map(file => <BodyText key={file.fileRef} className="break-words">{file.name} · PDF</BodyText>)}</div> : null}
    {owner && state === "staged" && source.unavailable ? <HelperText>Selected files are unavailable for review in this connection. Refresh status to try again before final approval.</HelperText> : null}
    {owner && terms.termsDigest && terms.packageDigest && ["staged", "preparing_on_owner_device"].includes(state) ? <Button data-voice-control-id="document-hosting-final-approve" disabled={busy || source.loading || source.unavailable || !source.files.length} onClick={() => void run(signal => DocumentHostingService.approve(session, requestId,
      { phase: "final", expectedRevision: terms.revision, idempotencyKey: crypto.randomUUID(), termsDigest: terms.termsDigest, packageDigest: terms.packageDigest }, signal))}>Approve these prepared copies and final terms</Button> : null}
    {!owner && ["ready_for_buyer", "checkout_open"].includes(state) && paymentReady !== true ? <HelperText role="status">{paymentReady === null ? "Checking payment readiness…" : "Payment is unavailable. Refresh status to check again before starting checkout."}</HelperText> : null}
    {!owner && paymentReady === true && ["ready_for_buyer", "checkout_open"].includes(state) && terms.terms && terms.termsDigest && terms.packageDigest ? <>
      <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} className="mt-1" /><span>I accept this approved document version, price, access deadline and download rights.</span></label>
      <Button data-voice-control-id="document-hosting-pay" disabled={busy || !accepted} onClick={() => void run(async signal => {
        await verifyHostedRecipientKey(session, requestId, terms.terms!.recipientKeyId, signal);
        const idToken = await getIdToken();
        if (!session.isCurrent() || signal.aborted) throw new DOMException("Session changed", "AbortError");
        const url = await DriveRequestPaymentService.checkout(idToken, requestId, { acceptedTermsRevision: terms.terms!.revision,
          acceptedTermsDigest: terms.termsDigest!, acceptedPackageDigest: terms.packageDigest! });
        if (typeof url !== "string") throw new Error("document_checkout_unavailable");
        if (session.isCurrent() && !signal.aborted) window.location.assign(url);
      })}>Accept and pay ${(terms.amountCents! / 100).toFixed(2)}</Button>
    </> : null}
    {!owner && available ? <HostedDocumentReader session={session} requestId={requestId} /> : null}
    {owner && terms.recoveryRequested ? <div className="space-y-2"><HelperText>The recipient proved a replacement key. Repairing access preserves the same files, price and deadline, and does not charge again.</HelperText>
      <Button data-voice-control-id="document-hosting-repair" disabled={busy} onClick={() => { if (window.confirm("Authorize wrapping these unchanged copies to the recipient's proven replacement key?")) void run(signal => repairHostedRecipientKey(session, requestId, terms, signal)); }}>Repair recipient access</Button></div> : null}
    {terms.receiveThrough === "both" ? <div className="space-y-1" aria-label="Delivery channels">
      <HelperText>One access: {state === "revoked" ? "stopped" : state === "expired" ? "expired" : "subject to the current grant"}.</HelperText>
      <HelperText>Drive removal: {terms.driveRevokeStatus === "pending" ? "pending reconciliation — Google access is not yet confirmed removed" : (terms.driveRevokeStatus ?? "not requested").replaceAll("_", " ")}.</HelperText>
      {terms.deliverySummary ? <HelperText>{terms.deliverySummary.confirmed} of {terms.deliverySummary.expected} files confirmed across both channels; {terms.deliverySummary.unsettled} unsettled.</HelperText> : null}
    </div> : null}
    {owner ? <div className="flex flex-wrap gap-2">
      {!["revoked", "expired"].includes(state) ? <Button data-voice-control-id="document-hosting-revoke" variant="destructive" disabled={busy} onClick={() => {
        if (window.confirm("Stop future One hosted access? This does not remove Google Drive access. Downloaded copies cannot be taken back.")) void run(signal => DocumentHostingService.revoke(session, requestId, terms.revision, "one", signal));
      }}>Stop One access</Button> : null}
      {terms.receiveThrough === "both" && terms.driveRevokeStatus !== "pending" ? <>
        <Button data-voice-control-id="document-hosting-revoke-drive" variant="destructive" disabled={busy} onClick={() => {
          if (window.confirm("Request removal of Drive access created by this app? Existing or independently granted access cannot be removed. Drive reconciliation may remain pending; One access is unchanged.")) void run(signal => DocumentHostingService.revoke(session, requestId, terms.revision, "drive", signal));
        }}>Stop Drive access</Button>
        {!["revoked", "expired"].includes(state) ? <Button data-voice-control-id="document-hosting-revoke-both" variant="destructive" disabled={busy} onClick={() => {
          if (window.confirm("Stop One access and request removal of Drive access created by this app? Existing or independently granted Drive access cannot be removed, and Drive reconciliation may remain pending. Downloaded copies cannot be taken back.")) void run(signal => DocumentHostingService.revoke(session, requestId, terms.revision, "both", signal));
        }}>Stop both channels</Button> : null}
      </> : null}
    </div> : null}
    {owner && events.length ? <div className="space-y-2" aria-label="Document activity"><BodyText>Activity</BodyText>{events.map(event => <div key={event.sequence}><BodyText>{event.actorUserId === terms.recipientUserId ? "Recipient" : event.actorUserId === terms.ownerUserId ? "Owner" : "System"} · {event.kind.replaceAll("_", " ")}</BodyText><HelperText>{new Date(event.createdAt).toLocaleString()} · {event.provenance ?? "Recorded"}{event.country ? ` · Approximate network country: ${event.country}` : ""}</HelperText></div>)}</div> : null}
    {owner && hasMoreActivity ? <div className="space-y-2"><HelperText>More recent activity is available. Load the next page to continue.</HelperText><Button data-voice-control-id="document-hosting-load-activity" size="compact" variant="none" disabled={busy} onClick={() => void run(signal => loadActivity(signal), { refreshTerms: false })}>Load newer activity</Button></div> : null}
    {owner && events.length === 500 ? <HelperText>Showing the 500 most recently loaded activity events.</HelperText> : null}
    <Button data-voice-control-id="document-hosting-refresh" variant="none" size="compact" disabled={busy} onClick={() => void run(signal => reload(signal), { refreshTerms: false })}>Refresh status</Button>
  </section>;
}
