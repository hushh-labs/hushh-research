"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Download, FileText, ImageIcon, Loader2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { CircleChatService, type CircleChatSession } from "@/lib/services/circle-chat-service";
import type { ChatMessage } from "@/lib/circle-chat/crypto";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

// Downloads/decryption are expensive on a phone. No image bytes or URLs live
// in this scheduler: each mounted, visible thumbnail owns and releases them.
let downloading = 0;
const queued = new Set<() => void>();
async function imageSlot(signal: AbortSignal): Promise<() => void> {
  while (downloading >= 2) {
    await new Promise<void>((resolve) => {
      const wake = () => { queued.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
      queued.add(wake); signal.addEventListener("abort", wake, { once: true });
      if (signal.aborted) wake();
    });
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  downloading++;
  return () => { downloading--; for (const wake of queued) wake(); };
}

const foreground = () => document.visibilityState === "visible" &&
  appInteractionCoordinator.getLifecycleSnapshot().state === "active";

export function ChatImage({ session, message, type, visible, layoutBlocked, scrollRoot, onError, onViewerChange }: {
  session: CircleChatSession; message: ChatMessage; type: string; visible: boolean;
  layoutBlocked: boolean; scrollRoot: RefObject<HTMLDivElement | null>; onError: (error: unknown) => void;
  onViewerChange: (open: boolean) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef({ message, onError, onViewerChange }); latest.current = { message, onError, onViewerChange };
  const [near, setNear] = useState(false);
  const [inForeground, setInForeground] = useState(foreground);
  const [retry, setRetry] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [decodingFailed, setDecodingFailed] = useState(false);
  useEffect(() => {
    latest.current.onViewerChange(expanded);
    return () => latest.current.onViewerChange(false);
  }, [expanded]);

  useEffect(() => {
    if (!visible || !element.current || !scrollRoot.current) { setNear(false); return; }
    let observing = true;
    // The viewport observer also intersects every clipping ancestor, including
    // the transcript. One observer avoids contradictory inner/outer snapshots
    // when a phone sheet changes the body's scroll lock.
    const observer = new IntersectionObserver(([entry]) => {
      if (observing) setNear(Boolean(entry?.isIntersecting));
    }, { rootMargin: "240px" });
    observer.observe(element.current);
    return () => { observing = false; observer.disconnect(); };
    // Owned sheets change scroll clipping. Resubscribe when they close so a
    // stale Chrome intersection snapshot cannot strand a visible thumbnail.
  }, [visible, scrollRoot, layoutBlocked]);
  useEffect(() => {
    const update = () => setInForeground(foreground());
    document.addEventListener("visibilitychange", update);
    const remove = appInteractionCoordinator.subscribeLifecycle(update);
    return () => { document.removeEventListener("visibilitychange", update); remove(); };
  }, []);
  useEffect(() => {
    if (!visible || !near || !inForeground) return;
    const controller = new AbortController();
    let allocated: string | null = null;
    setError(false); setDecodingFailed(false);
    void (async () => {
      let release: (() => void) | undefined;
      try {
        release = await imageSlot(controller.signal);
        const blob = await CircleChatService.image(session, latest.current.message, type, controller.signal);
        if (controller.signal.aborted) return;
        allocated = URL.createObjectURL(blob);
        setUrl(allocated);
      } catch (error) {
        if (!controller.signal.aborted) { setError(true); latest.current.onError(error); }
      } finally { release?.(); }
    })();
    return () => {
      controller.abort();
      if (allocated) URL.revokeObjectURL(allocated);
      setUrl(null); setExpanded(false);
    };
  }, [session, message.id, type, visible, near, inForeground, retry]);

  // Decrypted blobs remain in this mounted view. An optimizer would upload
  // them; no image bytes, URLs or filenames enter a cache or a server preview.
  /* eslint-disable @next/next/no-img-element */
  return <div ref={element} data-circle-chat-image className="w-64 max-w-full overflow-hidden rounded-xl bg-muted/60">
    {url && !decodingFailed ? <button type="button" aria-label="Open shared image"
      className="block aspect-[4/3] w-full touch-manipulation focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => setExpanded(true)}>
      <img src={url} alt="Image shared in circle" className="h-full w-full object-contain" onError={() => setDecodingFailed(true)} />
    </button> : <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 text-muted-foreground">
      {error || decodingFailed ? <>
        <ImageIcon aria-hidden="true" className="size-6" />
        <p className="text-xs">Image couldn’t load</p>
        <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setRetry((n) => n + 1)}>Retry image</Button>
      </> : <><Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" /><span role="status" className="text-xs">Loading image…</span></>}
    </div>}
    {url && visible && inForeground ? <Dialog modal open={expanded} onOpenChange={setExpanded}>
      <DialogContent showCloseButton={false} className="sm:max-w-3xl" srDescription="Image shared in this circle">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <DialogTitle className="text-base">Shared image</DialogTitle>
          <ShellActionSurface className="size-11 shrink-0" aria-label="Close" onClick={() => setExpanded(false)}><X aria-hidden="true" className="size-5" /></ShellActionSurface>
        </div>
        <img src={url} alt="Image shared in circle" className="max-h-[70dvh] max-w-full object-contain" />
      </DialogContent>
    </Dialog> : null}
  </div>;
}

export function ImageAttachmentPreview({ file, disabled, onRemove, onValidity }: { file: File; disabled: boolean; onRemove: () => void; onValidity: (file: File, valid: boolean) => void }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const allocated = URL.createObjectURL(file);
    setPreview({ file, url: allocated }); setFailed(false);
    return () => URL.revokeObjectURL(allocated);
  }, [file]);
  /* eslint-disable @next/next/no-img-element */
  return <div aria-label="Attached image preview" className="flex min-w-0 items-center gap-3 pb-3">
    <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
      {preview?.file === file && !failed ? <img src={preview.url} alt="Image ready to send" className="h-full w-full object-cover" onLoad={() => onValidity(file, true)} onError={() => { setFailed(true); onValidity(file, false); }} /> : <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />}
    </div>
    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{file.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{failed ? "Choose another image" : "Image ready to send"}</p></div>
    <ShellActionSurface className="size-11" aria-label="Remove attached image" disabled={disabled} onClick={onRemove}><X className="size-4" /></ShellActionSurface>
  </div>;
}

export function FileAttachmentPreview({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  return <div aria-label="Attached file preview" className="flex min-w-0 items-center gap-3 pb-3">
    <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted"><FileText aria-hidden="true" className="size-6" /></div>
    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{file.name}</p><p className="text-xs text-muted-foreground">{file.type.startsWith("video/") ? "Video" : "Document"} ready to send</p></div>
    <ShellActionSurface className="size-11" aria-label="Remove attached file" disabled={disabled} onClick={onRemove}><X className="size-4" /></ShellActionSurface>
  </div>;
}

/** Decrypt only on an explicit open/download; revoke the URL when the view closes. */
export function ChatSharedFile({ session, message, type, name, onError }: {
  session: CircleChatSession; message: ChatMessage; type: string; name: string; onError: (error: unknown) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const open = async () => {
    if (loading) return;
    setLoading(true); setError(false);
    try {
      const blob = await CircleChatService.image(session, message, type);
      const nextUrl = URL.createObjectURL(blob);
      setUrl(nextUrl);
      if (!type.startsWith("video/")) {
        const link = document.createElement("a");
        link.href = nextUrl;
        link.download = name;
        link.click();
      }
    } catch (caught) { setError(true); onError(caught); }
    finally { setLoading(false); }
  };
  return <div className="max-w-full rounded-xl bg-muted/70 p-3">
    <div className="flex min-w-0 items-center gap-2"><FileText aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm">{name}</span></div>
    {type.startsWith("video/") && url ? <video controls preload="metadata" src={url} className="mt-2 max-h-64 w-full rounded-lg" /> : null}
    <button type="button" onClick={() => void open()} disabled={loading} className="mt-2 flex min-h-10 items-center gap-1 text-sm font-semibold text-[color:var(--chat-accent,var(--app-accent))]">
      {loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Download aria-hidden="true" className="size-4" />}
      {type.startsWith("video/") ? url ? "Reload video" : "Open video" : "Download document"}
    </button>
    {error ? <p role="alert" className="text-xs">File couldn’t load. Try again.</p> : null}
  </div>;
}
