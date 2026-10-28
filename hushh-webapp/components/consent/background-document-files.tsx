"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { OneCopyService, backgroundDocumentUrl } from "@/lib/services/one-copy-service";
import { type DocumentSession } from "@/lib/services/document-hosting-service";
import { DocumentOriginalLink } from "./document-original-link";
import { useHostedDocumentSession } from "./use-hosted-document-session";
import { BackgroundDocumentActivity } from "./background-document-activity";
import { BackgroundDocumentRevokeDialog } from "./background-document-revoke-dialog";
import { HostedPdfCanvas } from "./hosted-pdf-canvas";
import { useOneCopyFileActions, useOneCopyStatus } from "./use-one-copy-files";

export function BackgroundDocumentFiles({ requestId, owner = false }: { requestId: string; owner?: boolean }) {
  const session = useHostedDocumentSession();
  return session ? <BackgroundDocumentFilesBody session={session} requestId={requestId} owner={owner} /> : null;
}
/** Feed locator only: no copy read, polling or authority before the protected reader opens. */
export function BackgroundDocumentLink({ requestId }: { requestId: string }) {
  const locator = backgroundDocumentUrl(requestId);
  if (!locator) return null;
  const { pathname, search } = new URL(locator);
  return <Button data-voice-control-id="document-copy-open-link" asChild size="compact" variant="none">
    <Link href={`${pathname}${search}`}>Open One link</Link>
  </Button>;
}
/** File actions in the dedicated authenticated reader. */
export function BackgroundDocumentFilesBody({ session, requestId }: { session: DocumentSession; requestId: string; owner?: boolean }) {
  const actions = useOneCopyFileActions(session, requestId);
  const { copy, error, refresh } = useOneCopyStatus(session, requestId, actions.close, actions.acceptStatus);
  const [revoking, setRevoking] = useState(false); const [revokeError, setRevokeError] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revokeOperation = useRef<AbortController | null>(null);
  useEffect(() => { setRevoking(false); setRevokeError(false); setConfirmRevoke(false); return () => revokeOperation.current?.abort(); }, [session, requestId]);
  const canManage = copy?.actorRole === "owner";
  const pathname = usePathname();
  useBackLayer(pathname, actions.preview ? 3 : 0, actions.close);
  const link = pathname !== "/one/documents/open" ? backgroundDocumentUrl(requestId) : null;
  const revoke = async () => {
    if (!session.isCurrent() || revoking) return;
    setConfirmRevoke(false);
    const controller = new AbortController(); revokeOperation.current = controller; setRevoking(true); setRevokeError(false); actions.close();
    try { await OneCopyService.revoke(session, requestId, controller.signal); }
    catch { if (session.isCurrent() && !controller.signal.aborted) setRevokeError(true); }
    finally { if (session.isCurrent() && !controller.signal.aborted) { setRevoking(false); refresh(); } }
  };
  return <section className="min-w-0 space-y-3" aria-label="One copies" aria-busy={actions.busy || revoking}>
    {error ? <HelperText role="alert">One copy unavailable. Drive access is separate.</HelperText> : null}
    {!copy && !error ? <HelperText role="status">Checking One copy…</HelperText> : null}
    {copy && ["pending", "preparing"].includes(copy.status) ? <HelperText role="status">{copy.status === "preparing" ? "Preparing One copy." : "Waiting for One copy."} Drive access is separate.</HelperText> : null}
    {copy?.status === "partial" ? <HelperText>Some One copies aren’t available. Drive access is separate.</HelperText> : null}
    {revokeError ? <HelperText role="alert">Couldn’t stop One access. Try again.</HelperText> : null}
    {copy?.status === "revoked" ? <HelperText>One access stopped.</HelperText> : null}
    {copy?.status === "unavailable" ? <HelperText>One copy unavailable. Open Drive for the original.</HelperText> : null}
    {copy?.files.map(file => <div key={file.fileRef} className="space-y-2 border-b border-border py-3">
      <BodyText className="break-words">{file.name}</BodyText>
      {file.rendition === "google_export" ? <HelperText>Google export{file.exportFormat ? ` · ${file.exportFormat}` : ""}{file.exportedAt ? ` · ${new Date(file.exportedAt).toLocaleString()}` : ""}</HelperText> : null}
      {file.status === "preparing" ? <HelperText>Preparing One copy…</HelperText> : file.status !== "ready" ? <HelperText>{file.status === "revoked" ? "Access stopped." : file.reason === "download_restricted" ? "Drive restricts downloads for this file." : file.reason === "native_export_unavailable" ? "This Google file needs an export. Open Drive." : file.reason === "source_changed" ? "The source changed before it could be copied." : "One copy unavailable."}</HelperText> : !file.previewAvailable || file.mimeType !== "application/pdf" ? <HelperText>Preview unavailable. {file.rendition === "google_export" ? "Download the export." : "Download the original."}</HelperText> : null}
      <div className="flex flex-wrap gap-2">
        {file.status === "ready" && file.previewAvailable && file.mimeType === "application/pdf" ? <Button data-voice-control-id="document-copy-preview" size="compact" variant="none" loading={actions.busy} onClick={event => void actions.open(file, false, event.currentTarget)}>Preview</Button> : null}
        {file.status === "ready" ? <Button data-voice-control-id="document-copy-download" size="compact" loading={actions.busy} onClick={() => void actions.open(file, true)}>Download</Button> : null}
        {file.openUrl ? <DocumentOriginalLink url={file.openUrl} googleEmail={null} /> : null}
      </div>
    </div>)}
    <HelperText role={actions.busy || actions.notice ? "status" : undefined} aria-hidden={!actions.busy && !actions.notice}>{actions.busy ? "Opening file…" : actions.notice || " "}</HelperText>
    {actions.preview ? <div role="region" aria-label="Document preview" className="space-y-2">
      <Button data-voice-control-id="document-copy-close-preview" size="compact" variant="none" onClick={actions.close}>Back to files</Button>
      <HelperText>Preview watermark only · download unchanged</HelperText>
      <div className="relative overflow-hidden">
        <HostedPdfCanvas bytes={actions.preview.bytes} signal={actions.preview.controller.signal} onRendered={() => undefined} />
        <BodyText aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center break-words p-6 text-center text-black/25">Shared in One · Access {requestId.slice(0, 8)} · {new Date().toLocaleDateString()}</BodyText>
      </div>
    </div> : null}
    {canManage ? <BackgroundDocumentActivity session={session} requestId={requestId} /> : null}
    <div className="flex flex-wrap gap-2">
      {link && copy?.files.some(file => file.status === "ready") ? <Button data-voice-control-id="document-copy-open-link" asChild size="compact" variant="none"><a href={link} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open One link</a></Button> : null}
      <Button data-voice-control-id="document-copy-refresh" size="compact" variant="none" onClick={() => { actions.close(); refresh(); }}>Refresh</Button>
      {canManage && copy && copy.status !== "revoked" ? <Button data-voice-control-id="document-copy-revoke" size="compact" variant="none" disabled={revoking} onClick={() => setConfirmRevoke(true)}>{revoking ? "Stopping…" : "Stop One access"}</Button> : null}
    </div>
    <BackgroundDocumentRevokeDialog open={confirmRevoke} onOpenChange={setConfirmRevoke} busy={revoking} onConfirm={() => void revoke()} />
  </section>;
}
