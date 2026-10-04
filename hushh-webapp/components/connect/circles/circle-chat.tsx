"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { MessageCircle, ImageIcon, Send, Loader2, BellOff, Bell, ArrowDown } from "@/components/icons";
import { CircleChatService, type CircleChatSession, type CircleChatState, type CircleChatReceipt } from "@/lib/services/circle-chat-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TEXT, type ChatMessage, type SealedChatMessage } from "@/lib/circle-chat/crypto";
import { CircleChatMessage, type OpenChatMessage as OpenMessage } from "./circle-chat-message";
import { ImageAttachmentPreview } from "./circle-chat-media";
import { CIRCLE_CHAT_CHANGED, dispatchCircleChatChanged } from "@/lib/circle-chat/events";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { circleStateChangeClosesDetail, subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

const unavailable = (error: unknown) => error instanceof ApiError &&
  ([401, 403, 423].includes(error.status) || apiErrorCode(error) === "CIRCLE_CHAT_UNAVAILABLE");
const errorText = (error: unknown) => error instanceof Error ? error.message : "Chat could not connect. Try again.";
const foreground = () => document.visibilityState === "visible" && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
// Coalesce busy-group doorbells within a quarter-second refresh cadence.
// Four sessions at four refreshes/sec fit the API's 1200/min owner read budget.
const REFRESH_CADENCE_MS = 250;
function cadence(signal: AbortSignal, earliest: number): Promise<void> {
  const delay = earliest - performance.now();
  if (delay <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function CircleChat({ session, circleName, initialOpen = false, onOpenIntentConsumed, active: paneActive = true, collapsible = true, readingBlocked = false }: {
  session: CircleChatSession; circleName: string; initialOpen?: boolean; onOpenIntentConsumed?: () => void;
  active?: boolean; collapsible?: boolean;
  readingBlocked?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [started, setStarted] = useState(initialOpen);
  useEffect(() => { if (initialOpen) { setOpen(true); setStarted(true); onOpenIntentConsumed?.(); } }, [initialOpen, onOpenIntentConsumed]);
  const [state, setState] = useState<CircleChatState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [revision, setRevision] = useState(0);
  const [muting, setMuting] = useState(false);
  const acknowledgedRead = useRef(0);
  useEffect(() => {
    let active = true;
    let cursor = 0;
    let running = false;
    let abort: AbortController | null = null;
    const listen = async () => {
      if (!active || running || !foreground() || revoked) return;
      running = true;
      abort = new AbortController();
      try {
        while (active && foreground()) {
          const startedAt = performance.now();
          const next = await CircleChatService.wait(session, cursor, abort.signal);
          if (!active || abort.signal.aborted || !foreground()) break;
          if (next.latestSequence !== cursor || next.changed) {
            dispatchCircleChatChanged(session.userId, session.circleId);
            if (next.photoChanged) CacheSyncService.onOneLocationStateMutated(session.userId, ["circles"], {
              notificationType: "location_circle_photo_updated", circleId: session.circleId,
            });
            if (next.readChanged) CircleChatService.refreshFeedRead(session.userId);
            if (next.latestSequence !== cursor || (!next.readChanged && !next.receiptsChanged && !next.photoChanged)) dispatchFeedStateChanged("arrived");
          }
          cursor = next.latestSequence;
          await cadence(abort.signal, startedAt + REFRESH_CADENCE_MS);
        }
      } catch (err) {
        if (active && !abort.signal.aborted && unavailable(err)) { setRevoked(true); setState(null); setOpen(false); }
      } finally {
        running = false;
        // On native, the physical HTTP request stayed awaited after a logical
        // pause. Resume only once it settles, without orphaning another wait.
        if (active && foreground() && abort.signal.aborted) void listen();
      }
    };
    const resume = () => { if (!foreground()) abort?.abort(); else void listen(); };
    void listen();
    const timer = window.setInterval(resume, 5000);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(resume);
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { active = false; abort?.abort(); clearInterval(timer); removeLifecycle();
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [session, revoked]);
  useEffect(() => {
    let active = true;
    let running = false;
    let ready = false;
    let dirty = false;
    let nextRefreshAt = 0;
    const abort = new AbortController();
    setState(null); setError(null); setRevoked(false);
    const refresh = async () => {
      if (!active || !foreground()) return;
      if (running) { dirty = true; return; }
      running = true;
      try {
        do {
        dirty = false;
        await cadence(abort.signal, nextRefreshAt);
        if (!active || abort.signal.aborted || !foreground()) break;
        nextRefreshAt = performance.now() + REFRESH_CADENCE_MS;
        if (!ready) { await CircleChatService.initialize(session); ready = true; }
        if (!active) return;
        const next = await CircleChatService.state(session, abort.signal);
        if (active) { setState(next.latestSequence <= acknowledgedRead.current ? { ...next, unreadCount: 0 } : next); setError(null); }
        } while (dirty && active && foreground());
      } catch (err) {
        if (active && !abort.signal.aborted) {
          setError(errorText(err));
          if (unavailable(err)) { setRevoked(true); setState(null); setOpen(false); active = false; abort.abort(); }
        }
      } finally { running = false; }
    };
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; circleId: string }>).detail;
      if (detail?.userId === session.userId && detail.circleId === session.circleId) void refresh();
    };
    const unsubscribe = subscribeToOneLocationStateChanges((detail) => {
      if (detail.userId === session.userId && circleStateChangeClosesDetail(detail, session.userId, session.circleId)) {
        active = false; abort.abort(); setRevoked(true); setState(null); setOpen(false);
      }
    });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    window.addEventListener(CIRCLE_CHAT_CHANGED, onEvent);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void refresh(); });
    return () => { active = false; abort.abort(); clearInterval(timer); unsubscribe(); removeLifecycle();
      window.removeEventListener(CIRCLE_CHAT_CHANGED, onEvent); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [session, revision]);

  return <section data-one-chat-surface aria-label={`${circleName} chat`} className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border bg-card">
    <div className={`flex min-w-0 items-center justify-between gap-2 px-3 py-3 sm:px-5 ${open ? "border-b border-border/60" : ""}`}>
      {collapsible ? <Button variant="ghost" className="min-h-11" onClick={() => { setOpen(!open); setStarted(true); }} disabled={revoked || !state} aria-expanded={open}>
        <MessageCircle aria-hidden="true" className="size-4" /> Circle chat
        {state && state.unreadCount > 0 ? <span aria-label={`${state.unreadCount} unread messages`} className="rounded-full bg-primary px-2 text-primary-foreground">{state.unreadCount}</span> : null}
      </Button> : <div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><MessageCircle className="size-5 shrink-0" aria-hidden="true" />Circle chat
        {state && state.unreadCount > 0 ? <span aria-label={`${state.unreadCount} unread messages`} className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{state.unreadCount}</span> : null}</div>}
      {open && state ? <ShellActionSurface variant="pill" className="min-h-11 text-sm" aria-label={state.muted ? "Unmute notifications" : "Mute notifications"} disabled={muting} onClick={async () => {
        setMuting(true);
        try { const next = await CircleChatService.mute(session, !state.muted); setState((old) => old ? { ...old, muted: next.muted } : old); }
        catch (err) { setError(errorText(err)); } finally { setMuting(false); }
      }}>{state.muted ? <Bell className="size-4" aria-hidden="true" /> : <BellOff className="size-4" aria-hidden="true" />}<span>{state.muted ? "Unmute" : "Mute"}</span></ShellActionSurface> : null}
    </div>
    {!state && !error && !revoked ? <p role="status" className="p-4 text-sm text-muted-foreground">Connecting chat…</p> : null}
    {revoked ? <p role="alert" className="p-4 text-sm">You no longer have access to this circle chat.</p> : null}
    {error && !revoked ? <div role="alert" className="p-4 text-sm">{error} <Button variant="ghost" size="sm" onClick={() => setRevision((n) => n + 1)}>Reconnect</Button></div> : null}
    {started && state && !revoked ? <div hidden={!open || !paneActive}><CircleChatThread session={session} visible={open && paneActive} readingBlocked={readingBlocked}
      onRead={(sequence) => { acknowledgedRead.current = Math.max(acknowledgedRead.current, sequence); setState((old) => old && old.latestSequence <= sequence ? { ...old, unreadCount: 0 } : old); }}
      onRevoked={() => { setRevoked(true); setState(null); setOpen(false); }} /></div> : null}
  </section>;
}

function CircleChatThread({ session, visible, onRead, onRevoked, readingBlocked }: {
  session: CircleChatSession; visible: boolean; onRead: (sequence: number) => void; onRevoked: () => void;
  readingBlocked: boolean;
}) {
  const [messages, setMessages] = useState<OpenMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<SealedChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [viewers, setViewers] = useState<Set<string>>(() => new Set());
  const viewerChanged = useCallback((id: string, open: boolean) => setViewers((current) => {
    if (current.has(id) === open) return current;
    const next = new Set(current); if (open) next.add(id); else next.delete(id); return next;
  }), []);
  const transcript = useRef<HTMLDivElement>(null);
  const messageList = useRef<HTMLOListElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  const last = useRef(0);
  const decryptFailures = useRef(new Set<number>());
  const readThrough = useRef(0);
  const reading = useRef(false);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const running = useRef(false);
  const refreshPending = useRef(false);
  const sendLock = useRef(false);
  const atBottomRef = useRef(true);
  const bottomInViewport = useRef(false);
  const onReadRef = useRef(onRead); onReadRef.current = onRead;
  const onRevokedRef = useRef(onRevoked); onRevokedRef.current = onRevoked;
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!editor.current || !visible) return;
    editor.current.style.height = "auto";
    editor.current.style.height = `${Math.min(128, Math.max(44, editor.current.scrollHeight))}px`;
  }, [text, visible]);

  const fail = useCallback((err: unknown) => {
    if (!active.current) return;
    if (unavailable(err)) { active.current = false; setMessages([]); setText(""); setFile(null); setPending(null); onRevokedRef.current(); }
    else setError(errorText(err));
  }, []);
  const decrypt = useCallback(async (items: ChatMessage[]) => Promise.all(items.map(async (message) => {
    try {
      const content = await CircleChatService.open(session, message);
      decryptFailures.current.delete(message.sequence);
      return { ...message, content, failed: false };
    } catch {
      if (message.senderUserId !== session.userId) decryptFailures.current.add(message.sequence);
      return { ...message, content: null, failed: true };
    }
  })), [session]);
  const append = useCallback((items: OpenMessage[], receipts: CircleChatReceipt[] = []) => {
    if (!active.current || (!items.length && !receipts.length)) return;
    const existing = new Map(messagesRef.current.map((item) => [item.id, item]));
    for (const item of items) {
      const previous = existing.get(item.id);
      // A delayed POST can arrive after a newer receipt refresh. Transcript
      // receipt pages remain authoritative, including recipient erasure.
      existing.set(item.id, { ...item, receipt: previous?.receipt ?? item.receipt });
    }
    const merged = [...existing.values()].sort((a, b) => a.sequence - b.sequence);
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
    for (let i = 0; i < merged.length; i++) {
      const item = merged[i]!;
      const receipt = byId.get(item.id);
      if (receipt && item.senderUserId === session.userId) merged[i] = { ...item, receipt };
    }
    if (merged.length > 300) setHasOlder(true);
    messagesRef.current = merged.slice(-300);
    setMessages(messagesRef.current);
    if (items.length && atBottomRef.current) requestAnimationFrame(() => {
      if (active.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
  }, [session.userId]);

  useEffect(() => {
    active.current = true;
    const abort = new AbortController();
    let nextRefreshAt = 0;
    const refresh = async () => {
      if (!active.current || !visibleRef.current || !foreground()
          || !atBottomRef.current && messagesRef.current.length >= 300) return;
      if (running.current) { refreshPending.current = true; return; }
      running.current = true;
      setRefreshing(true);
      try {
        do {
        refreshPending.current = false;
        await cadence(abort.signal, nextRefreshAt);
        if (!active.current || abort.signal.aborted || !visibleRef.current || !foreground()) break;
        nextRefreshAt = performance.now() + REFRESH_CADENCE_MS;
        const incremental = last.current > 0;
        const receiptRange = () => messagesRef.current.length ? {
          receiptAfter: messagesRef.current[0]!.sequence - 1, receiptThrough: last.current,
        } : {};
        let page = await CircleChatService.messages(session, incremental ? { after: last.current, ...receiptRange() } : {}, abort.signal);
        if (!active.current) return;
        if (!last.current) setHasOlder(page.hasMore);
        append(await decrypt(page.items), page.receipts);
        if (active.current && page.items.length) last.current = Math.max(last.current, ...page.items.map((item) => item.sequence));
        // Repair a reconnect gap in bounded pages, without skipping any sequence.
        for (let i = 0; incremental && page.hasMore && last.current && i < 4 && active.current; i++) {
          page = await CircleChatService.messages(session, { after: last.current, ...receiptRange() }, abort.signal);
          append(await decrypt(page.items), page.receipts);
          if (active.current && page.items.length) last.current = Math.max(last.current, ...page.items.map((item) => item.sequence));
        }
        if (incremental && page.hasMore) refreshPending.current = true;
        if (active.current) { setLoading(false); if (!sendLock.current) setError(null); setReadRevision((n) => n + 1); }
        } while (refreshPending.current && active.current && visibleRef.current && foreground()
                 && (atBottomRef.current || messagesRef.current.length < 300));
      } catch (err) { if (!abort.signal.aborted) fail(err); }
      finally { running.current = false; if (active.current) { setLoading(false); setRefreshing(false); } }
    };
    const event = (value: Event) => {
      const detail = (value as CustomEvent<{ userId: string; circleId: string }>).detail;
      if (detail?.userId === session.userId && detail.circleId === session.circleId) void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener(CIRCLE_CHAT_CHANGED, event); window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void refresh(); });
    return () => { active.current = false; abort.abort(); clearInterval(timer); removeLifecycle();
      window.removeEventListener(CIRCLE_CHAT_CHANGED, event); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [session, append, decrypt, fail]);

  useEffect(() => {
    if (visible) window.dispatchEvent(new CustomEvent(CIRCLE_CHAT_CHANGED,
      { detail: { userId: session.userId, circleId: session.circleId } }));
  }, [visible, session]);

  useEffect(() => {
    if (!bottom.current || !transcript.current) return;
    const resize = new ResizeObserver(() => {
      if (atBottomRef.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
    resize.observe(transcript.current);
    if (messageList.current) resize.observe(messageList.current);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      atBottomRef.current = entry.isIntersecting;
      setAtBottom(entry.isIntersecting);
      if (entry.isIntersecting) setReadRevision((n) => n + 1);
    }, { root: transcript.current, threshold: 1 });
    observer.observe(bottom.current);
    const viewportObserver = new IntersectionObserver(([entry]) => {
      bottomInViewport.current = Boolean(entry?.isIntersecting);
      if (entry?.isIntersecting) setReadRevision((n) => n + 1);
    }, { threshold: 1 });
    viewportObserver.observe(bottom.current);
    return () => { resize.disconnect(); observer.disconnect(); viewportObserver.disconnect(); };
  }, []);
  useEffect(() => {
    const read = async () => {
      // Never acknowledge across a message this device could not decrypt.
      let earliestFailure: number | null = null;
      for (const sequence of decryptFailures.current) earliestFailure = Math.min(earliestFailure ?? sequence, sequence);
      const sequence = earliestFailure === null ? last.current :
        (messagesRef.current.filter((message) => message.sequence < earliestFailure).at(-1)?.sequence ?? 0);
      const element = transcript.current;
      if (reading.current || !visibleRef.current || !active.current || !element || element.scrollHeight - element.scrollTop - element.clientHeight > 8
          || !atBottomRef.current || !bottomInViewport.current || !document.hasFocus() || !foreground() || sequence <= readThrough.current
          || readingBlocked || viewers.size > 0) return;
      reading.current = true;
      try { await CircleChatService.read(session, sequence); if (active.current) { readThrough.current = Math.max(readThrough.current, sequence); onReadRef.current(sequence); } }
      catch (err) { fail(err); }
      finally {
        reading.current = false;
        if (active.current && last.current > sequence && readThrough.current >= sequence) setReadRevision((n) => n + 1);
      }
    };
    void read();
    window.addEventListener("focus", read); document.addEventListener("visibilitychange", read);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void read(); });
    return () => { removeLifecycle(); window.removeEventListener("focus", read); document.removeEventListener("visibilitychange", read); };
  }, [session, readRevision, messages, fail, visible, readingBlocked, viewers]);

  const send = async () => {
    if (sendLock.current || !active.current || loading || (!pending && !text.trim() && !file)) return;
    sendLock.current = true; setSending(true); setError(null);
    try {
      const sealed = pending ?? await CircleChatService.prepare(session, text, file);
      if (!active.current) return;
      setPending(sealed);
      const sent = await CircleChatService.send(session, sealed);
      if (!active.current) return;
      append(await decrypt([sent]));
      setPending(null); setText(""); setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      fail(err);
      // A definite roster refusal never committed; reseal only on the person's next Send.
      if (["CIRCLE_CHAT_ROSTER_CHANGED", "CIRCLE_CHAT_RETRY_CONFLICT"].includes(apiErrorCode(err) ?? "")
          || err instanceof ApiError && [413, 422].includes(err.status)) setPending(null);
    } finally { sendLock.current = false; if (active.current) setSending(false); }
  };
  return <div className={file ? "[--chat-preview-height:5rem]" : "[--chat-preview-height:0px]"}>
    <div ref={transcript} tabIndex={0} aria-label="Circle messages" className="h-[min(36rem,max(10rem,calc(50dvh-var(--kb-height,0px)-var(--chat-preview-height))))] overflow-y-auto overscroll-contain bg-muted/30 px-3 py-4 sm:h-[min(36rem,max(10rem,calc(48dvh-var(--kb-height,0px)-var(--chat-preview-height))))] sm:px-5 sm:py-5">
      {hasOlder ? <Button variant="ghost" size="sm" className="min-h-11" disabled={loadingOlder || refreshing} onClick={async () => {
        if (!messages.length || loadingOlder || running.current) return;
        running.current = true;
        setLoadingOlder(true);
        const height = transcript.current?.scrollHeight ?? 0;
        try {
          const page = await CircleChatService.messages(session, { before: messages[0]!.sequence });
          const older = await decrypt(page.items);
          const receipts = new Map(page.receipts?.map((receipt) => [receipt.id, receipt]));
          for (const item of older) {
            const receipt = receipts.get(item.id);
            if (receipt) item.receipt = { recipientCount: receipt.recipientCount, readCount: receipt.readCount };
          }
          if (!active.current) return;
          const window = [...new Map([...older, ...messagesRef.current].map((item) => [item.id, item])).values()].sort((a, b) => a.sequence - b.sequence).slice(0, 300);
          messagesRef.current = window;
          setHasOlder(page.hasMore); setMessages(window);
          last.current = window.at(-1)?.sequence ?? 0;
          requestAnimationFrame(() => { if (active.current && transcript.current) transcript.current.scrollTop += transcript.current.scrollHeight - height; });
        } catch (err) { fail(err); } finally {
          running.current = false;
          if (active.current) {
            setLoadingOlder(false);
            if (refreshPending.current) dispatchCircleChatChanged(session.userId, session.circleId);
          }
        }
      }}>Load earlier messages</Button> : null}
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading messages…</p> : !messages.length ? <p className="py-8 text-center text-sm text-muted-foreground">Start the conversation. Say hello or share an image.</p> : null}
      <ol ref={messageList} className="space-y-4">{messages.map((message, index) => <CircleChatMessage key={message.id}
        message={message} previous={messages[index - 1]} session={session} visible={visible} layoutBlocked={readingBlocked} scrollRoot={transcript}
        onViewerChange={viewerChanged} onMediaError={(error) => { if (unavailable(error)) fail(error); }} />)}</ol>
      <div ref={bottom} className="h-1" />
    </div>
    <div className="space-y-2 border-t border-border/60 p-3 sm:px-5 sm:py-4">
    {!atBottom && messages.length ? <Button variant="ghost" size="sm" className="min-h-11" onClick={() => {
      atBottomRef.current = true;
      if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      window.dispatchEvent(new CustomEvent(CIRCLE_CHAT_CHANGED, { detail: { userId: session.userId, circleId: session.circleId } }));
    }}><ArrowDown className="size-4" aria-hidden="true" />Go to latest messages</Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {file ? <ImageAttachmentPreview file={file} disabled={sending || Boolean(pending)} onRemove={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }} /> : null}
    <form className="flex min-w-0 items-end gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Attach image" disabled={sending || Boolean(pending)} onChange={(event) => {
        const next = event.target.files?.[0];
        if (!next) return;
        if (!next.size || next.size > MAX_CHAT_IMAGE_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(next.type)) { setError("Choose a JPEG, PNG, or WebP image up to 5 MB."); event.target.value = ""; return; }
        setFile(next); setError(null);
      }} />
      <ShellActionSurface className="size-11" aria-label="Choose image" disabled={sending || Boolean(pending)} onClick={() => fileInput.current?.click()}><ImageIcon className="size-5" /></ShellActionSurface>
      <InputGroup className="min-h-11 min-w-0 flex-1 bg-background shadow-none">
      <InputGroupTextarea ref={editor} aria-label="Message" placeholder="Message…" value={text} maxLength={MAX_CHAT_TEXT} className="min-h-11 max-h-32 min-w-0 overflow-y-auto px-3 py-2.5 text-base leading-6 md:text-base" rows={1} disabled={sending || Boolean(pending)} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && window.matchMedia("(pointer: fine)").matches) { event.preventDefault(); void send(); }
      }} />
      </InputGroup>
      <ShellActionSurface type="submit" rippleEffect="fill" className="size-11 border-0 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] shadow-none hover:bg-[color:var(--app-accent-hover)] hover:text-[color:var(--app-accent-fg)]" aria-label={pending ? "Retry message" : "Send message"} disabled={sending || loading || (!text.trim() && !file && !pending)}>{sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</ShellActionSurface>
    </form>
    {pending && !sending ? <p className="text-xs text-muted-foreground">Delivery is unconfirmed. Retry sends the same message safely.</p> : null}
    <p className="text-center text-[11px] leading-4 text-muted-foreground">Only circle members can read these messages.</p>
    </div>
  </div>;
}
