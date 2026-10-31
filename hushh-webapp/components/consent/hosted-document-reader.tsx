"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { Button } from "@/lib/morphy-ux/button";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { DocumentHostingService, requireDocumentSession, protectedDocumentUrl, type DocumentSession } from "@/lib/services/document-hosting-service";
import { openHostedDocuments, openHostedArtifact, hostedDocumentContentHash, verifyHostedPackage } from "@/lib/consent/document-hosting-open";
import { documentHash } from "@/lib/consent/document-hosting-crypto";
import { HostedPdfCanvas } from "./hosted-pdf-canvas";
import { downloadFileBlob } from "@/lib/utils/native-download";
import { shareFile } from "@/lib/share/share-file";
import { isShareCancellationError } from "@/lib/share/share-link";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { verifyHostedRecipientKey } from "@/lib/consent/document-hosting-preparation";

type Opened = Awaited<ReturnType<typeof openHostedDocuments>>;
export function documentHostingErrorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("key_unavailable")) return "The key for this copy is unavailable. Recover your existing vault key or ask the owner to repair access.";
  if (code.includes("not_delivered")) return "This file has not finished delivery. Other available files can still be opened.";
  if (code.includes("changed")) return "This document changed. Refresh the request before continuing.";
  if (code.includes("restricted")) return "Google does not permit downloading this source file.";
  if (code.includes("native_browser_required")) return "Open this protected One link in a supported browser to preview or download. Native document delivery is not yet enabled.";
  if (code.includes("browser_required")) return "Open One in your browser to prepare this encrypted copy.";
  if (code.includes("size") || code.includes("page_limit")) return "This PDF exceeds the supported file or page limit. No payment can start for this copy.";
  return "This protected copy is unavailable. Refresh to check current access.";
}

/** Same production reader for request details and protected HTTPS entry; session supplied by the owning auth/vault surface. */
export function HostedDocumentReader({ session, requestId }: { session: DocumentSession; requestId: string }) {
  const pathname = usePathname();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [preview, setPreview] = useState<{ bytes: Uint8Array; fileRef: string; artifactId: string; controller: AbortController } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null); const previewRef = useRef(preview);
  const openedRef = useRef(opened);
  useLayoutEffect(() => { previewRef.current = preview; openedRef.current = opened; }, [preview, opened]);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    operation.current?.abort(); operation.current = null;
    const current = previewRef.current;
    current?.controller.abort(); current?.bytes.fill(0); previewRef.current = null;
    setPreview(null); setBusy(false); returnFocus.current?.focus({ preventScroll: true });
    return Boolean(current);
  }, []);
  useBackLayer(pathname, preview ? 3 : 0, close);
  useEffect(() => {
    const controller = new AbortController();
    setOpened(null); setError(null); setBusy(true);
    void (async () => {
      if (Capacitor.isNativePlatform()) {
        const readiness = await DocumentHostingService.readiness(session, controller.signal);
        if (readiness.nativeViewerEnabled !== true) throw new Error("document_native_browser_required");
      }
      return openHostedDocuments(session, requestId, controller.signal);
    })().then(value => { requireDocumentSession(session, controller.signal); setOpened(value); })
      .catch(cause => { if (!controller.signal.aborted && session.isCurrent()) setError(documentHostingErrorCopy(cause)); })
      .finally(() => { if (!controller.signal.aborted && session.isCurrent()) setBusy(false); });
    const recheck = () => {
      if (document.visibilityState !== "visible" || !openedRef.current) return;
      void DocumentHostingService.package(session, requestId, controller.signal).then(async value => {
        await verifyHostedPackage(session, value);
        requireDocumentSession(session, controller.signal);
        if (value.packageDigest !== openedRef.current?.package.packageDigest) throw new Error("document_changed");
      }).catch(() => { if (!controller.signal.aborted) { close(); setOpened(null); setError("Access ended or needs verification. Refresh this request."); } });
    };
    window.addEventListener("focus", recheck);
    const expiry = window.setInterval(() => {
      if (!session.isCurrent() || openedRef.current && Date.parse(openedRef.current.package.accessExpiresAt) <= Date.now()) {
        close(); setOpened(null); openedRef.current = null; setError("Access ended. Decrypted documents have been closed.");
      }
    }, 1000);
    return () => { controller.abort(); close(); window.clearInterval(expiry); window.removeEventListener("focus", recheck); };
    // The parent recreates session only for an owner/vault/request generation change.
  }, [session, requestId, close]);
  const record = (artifactId: string, kind: "preview_rendered" | "download_requested" | "handoff_reported", outcome: "success" | "cancelled" | "failed", value: Opened = opened!) => {
    if (!value || !session.isCurrent()) return;
    void DocumentHostingService.activity(session, requestId, { interactionId: value.package.interactionId, artifactId, eventId: crypto.randomUUID(), kind, outcome }).catch(() => undefined);
  };
  const loadFile = async (file: Opened["manifest"]["files"][number], role: "original" | "watermarked", download: boolean, trigger?: HTMLButtonElement) => {
    if (busy) return;
    close(); if (trigger) returnFocus.current = trigger;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(null); setNotice(null);
    let bytes: Uint8Array | null = null;
    try {
      const current = await openHostedDocuments(session, requestId, controller.signal);
      const currentFile = current.manifest.files.find(item => item.fileRef === file.fileRef);
      if (!currentFile || currentFile.originalArtifactId !== file.originalArtifactId || currentFile.watermarkedArtifactId !== file.watermarkedArtifactId) throw new Error("document_changed");
      const artifactId = role === "original" ? currentFile.originalArtifactId : currentFile.watermarkedArtifactId;
      const descriptor = current.package.artifacts.find(item => item.artifactId === artifactId);
      if (!descriptor) throw new Error("document_unavailable");
      if (download) record(artifactId, "download_requested", "success", current);
      bytes = await openHostedArtifact(session, requestId, current.package, descriptor, controller.signal);
      if (await documentHash(bytes) !== hostedDocumentContentHash(currentFile, role)) throw new Error("document_integrity_failed");
      requireDocumentSession(session, controller.signal);
      await verifyHostedPackage(session, current.package);
      requireDocumentSession(session, controller.signal);
      if (download) {
        const safeName = currentFile.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "_").slice(0, 160) || "document.pdf";
        const name = role === "watermarked" ? `${safeName.replace(/\.pdf$/i, "")}-watermarked.pdf` : safeName;
        const blob = new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" });
        if (Capacitor.isNativePlatform()) {
          await shareFile({ file: new File([blob], name, { type: "application/pdf" }), title: "Save document", isEffectCurrent: () => session.isCurrent() && !controller.signal.aborted });
          requireDocumentSession(session, controller.signal); setNotice("Handed to system.");
        } else {
          if (!await downloadFileBlob(blob, name, () => session.isCurrent() && !controller.signal.aborted && Date.parse(current.package.accessExpiresAt) > Date.now())) throw new Error("document_save_failed");
          setNotice("Download started.");
        }
        record(artifactId, "handoff_reported", "success", current);
      } else { setOpened(current); setPreview({ bytes, fileRef: file.fileRef, artifactId, controller }); bytes = null; }
    } catch (cause) {
      if (!controller.signal.aborted && session.isCurrent()) {
        if (isShareCancellationError(cause)) setNotice("Document was not saved.");
        else setError(documentHostingErrorCopy(cause));
      }
    } finally { bytes?.fill(0); if (!controller.signal.aborted && session.isCurrent()) setBusy(false); }
  };
  const announced = useRef(new Set<string>());
  return <section className="min-w-0 space-y-4" aria-label="Protected documents">
    <HelperText>The owner can see access activity and approximate network country when available. Downloaded copies cannot be recalled.</HelperText>
    {busy ? <HelperText role="status">Opening protected copy…</HelperText> : null}
    {error ? <HelperText role="alert">{error}</HelperText> : null}
    {error?.includes("supported browser") && protectedDocumentUrl(requestId) ? <Button asChild size="compact"><a href={protectedDocumentUrl(requestId)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open protected link in browser</a></Button> : null}
    {error?.includes("key") ? <Button data-voice-control-id="document-hosting-recovery-request" size="compact" disabled={busy} onClick={() => {
      if (!window.confirm("Set up or recover your current vault-backed key and ask the owner to repair this paid copy? This does not create a new purchase.")) return;
      const controller = new AbortController(); operation.current = controller; setBusy(true);
      void OneKycClientZkService.ensureConnector({ userId: session.userId, vaultKey: session.vaultKey, vaultOwnerToken: session.vaultOwnerToken })
        .then(connector => { requireDocumentSession(session, controller.signal); return verifyHostedRecipientKey(session, requestId, connector.connector_key_id, controller.signal, "recovery"); })
        .then(() => { if (session.isCurrent() && !controller.signal.aborted) setNotice("Recovery requested. The owner must authorize repairing this copy. Nothing was charged."); })
        .catch(cause => { if (session.isCurrent() && !controller.signal.aborted) setError(documentHostingErrorCopy(cause)); })
        .finally(() => { if (session.isCurrent() && !controller.signal.aborted) setBusy(false); });
    }}>Request key recovery</Button> : null}
    {notice ? <HelperText role="status">{notice}</HelperText> : null}
    {opened?.manifest.files.map(file => <div key={file.fileRef} className="space-y-2 border-b border-border py-3">
      <BodyText className="break-words">{file.name}</BodyText>
      <HelperText>Approved snapshot · source version {file.sourceRevision}</HelperText>
      <div className="flex flex-wrap gap-2">
        <Button data-voice-control-id="document-hosting-preview" size="compact" variant="none" disabled={busy} onClick={event => void loadFile(file, "watermarked", false, event.currentTarget)}>Preview</Button>
        <Button data-voice-control-id="document-hosting-download-copy" size="compact" disabled={busy} onClick={() => void loadFile(file, "watermarked", true)}>Download watermarked copy</Button>
        <Button data-voice-control-id="document-hosting-download-original" size="compact" variant="none" disabled={busy} onClick={() => void loadFile(file, "original", true)}>Download original</Button>
      </div>
    </div>)}
    {preview ? <div className="space-y-3" role="region" aria-label="Document preview">
      <Button data-voice-control-id="document-hosting-close-preview" size="compact" variant="none" onClick={close}>Back to documents</Button>
      <HelperText>This is a watermarked preview. The original and any signatures remain unchanged.</HelperText>
      <HostedPdfCanvas key={preview.artifactId} bytes={preview.bytes} signal={preview.controller.signal} onRendered={() => {
        const key = `${opened?.package.interactionId}:${preview.artifactId}`;
        if (!announced.current.has(key)) { announced.current.add(key); record(preview.artifactId, "preview_rendered", "success"); }
      }} />
    </div> : null}
  </section>;
}
