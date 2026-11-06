"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { requireDocumentSession, type DocumentSession } from "@/lib/services/document-hosting-service";
import { OneCopyService, type OneCopy, type OneCopyFile } from "@/lib/services/one-copy-service";
import { OneCopyPresentationService } from "@/lib/services/one-copy-presentation-service";
import { ONE_COPY_OPEN_BUDGET_MS } from "@/lib/services/one-copy-body";
import { withDeadline } from "@/lib/utils/with-deadline";
import { documentHash } from "@/lib/consent/document-hosting-crypto";
import { downloadFileBlob } from "@/lib/utils/native-download";
import { shareFile } from "@/lib/share/share-file";
import { isShareCancellationError } from "@/lib/share/share-link";
import { captureProductAttempt, type ProductAttempt } from "@/lib/observability/product-activity-client";

export function useOneCopyStatus(session: DocumentSession, requestId: string, close: () => boolean, acceptStatus: (copy: OneCopy) => void) {
  const [copy, setCopy] = useState<OneCopy | null>(() => OneCopyPresentationService.peekStatus(session, requestId));
  const scope = useRef({ session, requestId });
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const requested = useRef<{ session: DocumentSession; requestId: string; attempt: ProductAttempt } | null>(null);
  const refresh = useCallback((manual = false) => {
    if (manual && session.isCurrent()) {
      const attempt = captureProductAttempt("document.copy.refresh", session.userId); attempt.started();
      requested.current = { session, requestId, attempt };
    }
    setRevision(value => value + 1);
  }, [session, requestId]);
  useEffect(() => {
    const controller = new AbortController(); let serial = 0; let ticks = 0;
    scope.current = { session, requestId };
    setCopy(OneCopyPresentationService.peekStatus(session, requestId)); setError(false);
    const load = async (force = false, attempt?: ProductAttempt) => {
      const ticket = ++serial;
      try {
        const value = await OneCopyPresentationService.status(session, requestId, controller.signal, force);
        requireDocumentSession(session, controller.signal);
        if (ticket !== serial) return;
        attempt?.settled("returned");
        setCopy(value); setError(false); acceptStatus(value);
        if (value.status === "revoked") close();
      } catch { if (ticket === serial && !controller.signal.aborted && session.isCurrent()) { attempt?.settled("failed"); close(); setError(true); } }
    };
    const intent = requested.current; requested.current = null;
    void load(revision > 0, intent?.session === session && intent.requestId === requestId ? intent.attempt : undefined);
    const focus = () => { close(); void load(true); };
    const hidden = () => { if (document.visibilityState === "hidden") close(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", hidden);
    const interval = window.setInterval(() => {
      if (!session.isCurrent()) { controller.abort(); close(); setCopy(null); setError(true); }
      else if (++ticks % 10 === 0 && document.visibilityState === "visible") void load(true);
    }, 1000);
    return () => { controller.abort(); close(); window.clearInterval(interval); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", hidden); };
  }, [session, requestId, revision, close, acceptStatus]);
  const visible = scope.current.session === session && scope.current.requestId === requestId && session.isCurrent();
  return { copy: visible ? copy : OneCopyPresentationService.peekStatus(session, requestId), error: visible && error, refresh };
}

type Preview = { sha256?: string; fileRef: string; bytes: Uint8Array; controller: AbortController; attempt: ProductAttempt };
async function saveOriginal(session: DocumentSession, bytes: Uint8Array, file: OneCopyFile, signal: AbortSignal) {
  const name = file.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "_").slice(0, 180) || "document";
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ? file.mimeType : "application/octet-stream";
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: mime });
  const current = () => session.isCurrent() && !signal.aborted;
  if (Capacitor.isNativePlatform()) {
    await shareFile({ file: new File([blob], name, { type: mime }), title: "Save document", isEffectCurrent: current });
    requireDocumentSession(session, signal);
    return "Handed to system.";
  }
  if (!await downloadFileBlob(blob, name, current)) throw new Error("one_copy_save_failed");
  return "Download started.";
}

export function useOneCopyFileActions(session: DocumentSession, requestId: string) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<{ fileRef: string; download: boolean } | null>(null);
  const busy = pending !== null;
  const [notice, setNotice] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const active = useRef<AbortController | null>(null); const previewRef = useRef<Preview | null>(null);
  const close = useCallback(() => {
    const shown = previewRef.current;
    active.current?.abort(); active.current = null;
    shown?.controller.abort(); shown?.bytes.fill(0); previewRef.current = null;
    setPreview(null); setPending(null); if (shown) returnFocus.current?.focus({ preventScroll: true }); return Boolean(shown);
  }, []);
  useEffect(() => { close(); setNotice(null); return () => { active.current?.abort(); previewRef.current?.bytes.fill(0); }; }, [session, requestId, close]);
  const acceptStatus = useCallback((value: OneCopy) => {
    const shown = previewRef.current;
    if (shown && !value.files.some(file => file.fileRef === shown.fileRef && file.status === "ready" && file.sha256 === shown.sha256)) close();
  }, [close]);
  const open = async (file: OneCopyFile, download: boolean, trigger?: HTMLElement) => {
    if (active.current || !session.isCurrent()) return;
    close(); if (trigger) returnFocus.current = trigger; const controller = new AbortController(); active.current = controller;
    const attempt = captureProductAttempt(download ? "document.copy.download" : "document.copy.preview", session.userId); attempt.started();
    setPending({ fileRef: file.fileRef, download }); setNotice(null); let bytes: Uint8Array | null = null;
    try {
      // The clicked snapshot describes the immutable file; the content endpoint authorizes this read now.
      const current = file;
      if (!current || current.status !== "ready" || !download && (!current.previewAvailable || current.mimeType !== "application/pdf")) throw new Error("one_copy_unavailable");
      const deadline = Date.now() + ONE_COPY_OPEN_BUDGET_MS;
      await withDeadline((async () => {
        bytes = await OneCopyService.content(session, requestId, file.fileRef, download ? "download" : "preview", controller.signal, deadline);
        if (current.sha256 && await documentHash(bytes) !== current.sha256) throw new Error("one_copy_integrity");
        requireDocumentSession(session, controller.signal);
        // Recheck authority after transfer, before revealing or handing off readable bytes.
        const verified = await OneCopyService.status(session, requestId, controller.signal, deadline);
        if (!verified.files.some(item => item.fileRef === file.fileRef && item.status === "ready" && item.sha256 === current.sha256)) throw new Error("one_copy_unavailable");
        requireDocumentSession(session, controller.signal);
      })(), deadline);
      // The OS chooser owns its own lifecycle; the network deadline ends before handoff.
      const readable = bytes as Uint8Array | null;
      if (!readable) throw new Error("one_copy_unavailable");
      if (download) {
        setNotice(await saveOriginal(session, readable, current, controller.signal));
        if (session.isCurrent() && !controller.signal.aborted) attempt.settled("returned");
      } else { const next = { fileRef: file.fileRef, sha256: current.sha256, bytes: readable, controller, attempt }; previewRef.current = next; setPreview(next); bytes = null; }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const owned = active.current === controller;
      if (owned && !timedOut && !controller.signal.aborted && session.isCurrent()) attempt.settled(isShareCancellationError(error) ? "cancelled" : "failed");
      if (timedOut) controller.abort();
      if (owned && (!controller.signal.aborted || timedOut) && session.isCurrent()) { close(); setNotice(timedOut ? "File took too long. Try again." : isShareCancellationError(error) ? "File was not saved." : "This copy is unavailable. Try again or open Drive."); }
    } finally { (bytes as Uint8Array | null)?.fill(0); if (active.current === controller) { active.current = null; setPending(null); } }
  };
  return { preview, busy, pending, notice, close, open, acceptStatus };
}
