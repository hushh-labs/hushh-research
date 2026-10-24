"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConversationComposer } from "@/components/app-ui/conversation-composer";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { MessageCircle, ImageIcon, ArrowDown, Plus, X } from "@/components/icons";
import { CircleChatService, type CircleChatSession, type CircleChatState, type CircleChatReceipt, type CircleMembershipEvent, type CircleChatPage, type CircleMessageState, type ChatMutationResult } from "@/lib/services/circle-chat-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TEXT, validateChatAttachmentBytes, type ChatImageThumbnail, type ChatMessage, type SealedChatMessage } from "@/lib/circle-chat/crypto";
import { CircleChatMessage, type CircleMessageAction, type OutgoingChatMessage, type OpenChatMessage as OpenMessage } from "./circle-chat-message";
import { CircleChatMessageActionDialog } from "./circle-chat-message-action-dialog";
import { ChatLaneMicAction } from "./circle-chat-mic-action";
import { FileAttachmentPreview, ImageAttachmentPreview } from "./circle-chat-media";
import { CIRCLE_CHAT_CHANGED, dispatchCircleChatChanged } from "@/lib/circle-chat/events";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { circleStateChangeClosesDetail, subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { chatReadIsBlocked, subscribeChatLayerChanges } from "@/lib/interaction/chat-read-visibility";
import { useChatAlertVisibility } from "@/lib/notifications/chat-alert-visibility";
import { FeedPushPrompt } from "@/components/feed/feed-push-prompt";
import { useVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { AgentDockPortal } from "@/components/agent/agent-dock";
import laneStyles from "./circle-chat-lane.module.css";
import quietStyles from "@/components/direct-messages/messages-quiet-action.module.css";
import { DirectMessageEmojiPicker } from "@/components/direct-messages/direct-message-emoji-picker";
import { CircleMembershipEventPill, groupCircleMembershipEvents } from "./circle-chat-system-event";
import { connectPersonName } from "@/lib/connections/person-label";

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

export function CircleChat({ session, circleName, initialOpen = false, onOpenIntentConsumed, active: paneActive = true, collapsible = true, readingBlocked = false, chatLane = false, chatLaneTheme = "light" }: {
  session: CircleChatSession; circleName: string; initialOpen?: boolean; onOpenIntentConsumed?: () => void;
  active?: boolean; collapsible?: boolean;
  readingBlocked?: boolean;
  chatLane?: boolean;
  chatLaneTheme?: "light" | "dark";
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
  const threadScope = useRef({ session, revision: 0 });
  if (threadScope.current.session !== session) {
    threadScope.current = { session, revision: threadScope.current.revision + 1 };
    acknowledgedRead.current = 0;
  }
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
            dispatchCircleChatChanged(session.userId, session.circleId, {
              reactionsChanged: next.reactionsChanged,
              membershipChanged: next.membershipChanged,
            });
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

  return <><section data-one-chat-surface data-circle-chat-lane={chatLane || undefined} data-circle-chat-inline={!chatLane || undefined} data-messages-type-scale={chatLane || undefined} aria-label={`${circleName} chat`} className={chatLane
    ? "flex h-full min-h-0 flex-col overflow-visible bg-transparent"
    : "overflow-clip rounded-[var(--app-card-radius-standard)] border border-border bg-card"}>
    {!chatLane ? <div className={`flex min-w-0 items-center justify-between gap-2 px-3 py-2 sm:px-5 ${open ? "border-b border-border/60" : ""}`}>
      {collapsible ? <Button variant="ghost" className="min-h-11" onClick={() => { setOpen(!open); setStarted(true); }} disabled={revoked || !state} aria-expanded={open}>
        <MessageCircle aria-hidden="true" className="size-4" /> Circle chat
        {state && state.unreadCount > 0 ? <span aria-label={`${state.unreadCount} unread messages`} className="rounded-full bg-primary px-2 text-primary-foreground">{state.unreadCount}</span> : null}
      </Button> : <div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><MessageCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="text-muted-foreground">Circle chat</span>
        {state && state.unreadCount > 0 ? <span aria-label={`${state.unreadCount} unread messages`} className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{state.unreadCount}</span> : null}</div>}
      {open && state ? <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"><span>Alerts</span>
        <Switch size="ios" aria-label="Chat alerts" checked={!state.muted} disabled={muting} aria-busy={muting}
          className="motion-reduce:transition-none motion-reduce:[&_[data-slot=switch-thumb]]:transition-none" onCheckedChange={async (enabled) => {
        setMuting(true);
        try { const next = await CircleChatService.mute(session, !enabled); setState((old) => old ? { ...old, muted: next.muted } : old); }
        catch (err) { setError(errorText(err)); } finally { setMuting(false); }
      }} /></label> : null}
    </div> : null}
    {open && paneActive && state && !state.muted && !revoked ? <div className="px-3 pt-3"><FeedPushPrompt context="chat" /></div> : null}
    {!state && !error && !revoked ? <p role="status" className="p-4 text-sm text-muted-foreground">Connecting chat…</p> : null}
    {revoked ? <p role="alert" className="p-4 text-sm">You no longer have access to this circle chat.</p> : null}
    {error && !revoked ? <div role="alert" className="p-4 text-sm">{error} <Button variant="ghost" size="sm" className={chatLane ? quietStyles.action : undefined} onClick={() => setRevision((n) => n + 1)}>Reconnect</Button></div> : null}
    {started && state && !revoked ? <div hidden={!open || !paneActive} className={chatLane ? "min-h-0 flex-1" : undefined}><CircleChatThread key={threadScope.current.revision} circleName={circleName} session={session} visible={open && paneActive} readingBlocked={readingBlocked} chatLane={chatLane} chatLaneTheme={chatLaneTheme}
      onRead={(sequence) => { acknowledgedRead.current = Math.max(acknowledgedRead.current, sequence); setState((old) => old && old.latestSequence <= sequence ? { ...old, unreadCount: 0 } : old); }}
      onRevoked={() => { setRevoked(true); setState(null); setOpen(false); }} /></div> : null}
  </section>
  </>;
}

function CircleChatThread({ circleName, session, visible, onRead, onRevoked, readingBlocked, chatLane, chatLaneTheme }: {
  session: CircleChatSession; visible: boolean; onRead: (sequence: number) => void; onRevoked: () => void;
  circleName: string; readingBlocked: boolean; chatLane: boolean; chatLaneTheme: "light" | "dark";
}) {
  const blockingLayer = useVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions;
  const [messages, setMessages] = useState<OpenMessage[]>([]);
  const [membershipEvents, setMembershipEvents] = useState<CircleMembershipEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<OpenMessage | null>(null);
  const [actionRequest, setActionRequest] = useState<{ message: OpenMessage; action: CircleMessageAction } | null>(null);
  const replyRef = useRef(reply); replyRef.current = reply;
  const actionRef = useRef(actionRequest); actionRef.current = actionRequest;
  const [replyTargets, setReplyTargets] = useState<Map<string, OpenMessage>>(() => new Map());
  const targetsRef = useRef(replyTargets); targetsRef.current = replyTargets;
  // Metadata contains no decrypted content and fences delayed POST/history/decrypt results.
  const versions = useRef(new Map<string, CircleMessageState>());
  const anchored = useRef(false);
  const historyGeneration = useRef(0);
  const [jumping, setJumping] = useState(false);
  const [pickerDismissSignal, setPickerDismissSignal] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [validFile, setValidFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<SealedChatMessage | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingChatMessage | null>(null);
  const outgoingRef = useRef<OutgoingChatMessage | null>(null);
  const sendAttempt = useRef<{ id: string | null; confirmed: boolean } | null>(null);
  const thumbnailRef = useRef<{ file: File; thumbnail?: ChatImageThumbnail } | null>(null);
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
  const composerEditor = useRef<HTMLTextAreaElement>(null);
  useChatAlertVisibility(visible && !loading && !readingBlocked && !blockingLayer && !actionRequest && viewers.size === 0
    ? `circle-chat:${session.circleId}` : null, transcript);

  const fail = useCallback((err: unknown) => {
    if (!active.current) return;
    if (unavailable(err)) { active.current = false; setMessages([]); messagesRef.current = []; targetsRef.current.clear(); setReplyTargets(new Map()); setReply(null); setActionRequest(null); outgoingRef.current = null; thumbnailRef.current = null; setOutgoing(null); setText(""); setFile(null); setValidFile(null); setPending(null); onRevokedRef.current(); }
    else setError(errorText(err));
  }, []);
  const decrypt = useCallback(async (items: ChatMessage[]) => Promise.all(items.map(async (message) => {
    if (message.deletedForEveryoneAt) { decryptFailures.current.delete(message.sequence); return { ...message, content: null, failed: false, hasImage: false, reactions: [] }; }
    const current = () => {
      const known = versions.current.get(message.id);
      return active.current && !known?.hidden && !known?.deletedForEveryoneAt && (message.revision ?? 0) >= (known?.revision ?? 0);
    };
    try {
      const content = await CircleChatService.open(session, message);
      if (current()) decryptFailures.current.delete(message.sequence);
      return { ...message, content, failed: false };
    } catch {
      if (current() && message.senderUserId !== session.userId) decryptFailures.current.add(message.sequence);
      return { ...message, content: null, failed: true };
    }
  })), [session]);
  const accepts = useCallback((message: ChatMessage) => {
    const known = versions.current.get(message.id);
    return !known?.hidden && (message.revision ?? 0) >= (known?.revision ?? 0)
      && (!known?.deletedForEveryoneAt || Boolean(message.deletedForEveryoneAt));
  }, []);
  const cacheTargets = useCallback(async (items: ChatMessage[] = []) => {
    const opened = await decrypt(items);
    if (!active.current) return;
    const next = new Map(targetsRef.current);
    for (const item of opened) if (accepts(item) && (item.revision ?? 0) >= (next.get(item.id)?.revision ?? 0)) next.set(item.id, item);
    while (next.size > 300) next.delete(next.keys().next().value!);
    targetsRef.current = next; setReplyTargets(next);
    setReply((current) => current ? next.get(current.id) ?? current : null);
  }, [decrypt, accepts]);
  const applyStates = useCallback((states: CircleMessageState[]) => {
    for (const state of states) {
      const previous = versions.current.get(state.id);
      if (previous?.hidden || (previous?.revision ?? 0) > state.revision) continue;
      versions.current.set(state.id, state);
    }
    const clean = (item: OpenMessage): OpenMessage | null => {
      const state = versions.current.get(item.id);
      if (state?.hidden) { decryptFailures.current.delete(item.sequence); return null; }
      if (state?.deletedForEveryoneAt) {
        decryptFailures.current.delete(item.sequence);
        return { ...item, revision: state.revision, deletedForEveryoneAt: state.deletedForEveryoneAt, content: null, failed: false, localImage: undefined, hasImage: false, reactions: [] };
      }
      return item;
    };
    messagesRef.current = messagesRef.current.map(clean).filter((item): item is OpenMessage => item !== null);
    setMessages(messagesRef.current);
    const targets = new Map<string, OpenMessage>();
    for (const [id, item] of targetsRef.current) { const next = clean(item); if (next) targets.set(id, next); }
    targetsRef.current = targets; setReplyTargets(targets);
    setReply((current) => current && (versions.current.get(current.id)?.hidden || versions.current.get(current.id)?.deletedForEveryoneAt) ? null : current);
    setActionRequest((current) => current && (versions.current.get(current.message.id)?.hidden || current.action !== "me" && versions.current.get(current.message.id)?.deletedForEveryoneAt) ? null : current);
  }, []);
  const append = useCallback((items: OpenMessage[], receipts: CircleChatReceipt[] = [], reactionUpdates: CircleChatPage["reactionUpdates"] = [], generation?: number) => {
    if (!active.current || generation !== undefined && generation !== historyGeneration.current || (!items.length && !receipts.length && !reactionUpdates?.length)) return;
    const existing = new Map(messagesRef.current.map((item) => [item.id, item]));
    for (const item of items) {
      if (!accepts(item)) continue;
      const previous = existing.get(item.id);
      if ((previous?.revision ?? 0) > (item.revision ?? 0)) continue;
      versions.current.set(item.id, { id: item.id, revision: item.revision ?? 0, hidden: false, deletedForEveryoneAt: item.deletedForEveryoneAt ?? null });
      // A delayed POST can arrive after a newer receipt refresh. Transcript
      // receipt pages remain authoritative, including recipient erasure.
      const local = outgoingRef.current;
      const attempt = sendAttempt.current;
      if (attempt?.id && item.senderUserId === session.userId && attempt.id === item.clientMessageId) attempt.confirmed = true;
      const matchesOutgoing = local && item.senderUserId === session.userId && item.clientMessageId === local.clientMessageId;
      existing.set(item.id, { ...previous, ...item, receipt: previous?.receipt ?? item.receipt,
        reactions: item.deletedForEveryoneAt ? [] : previous?.reactions ?? item.reactions,
        localImage: item.deletedForEveryoneAt ? undefined : previous?.localImage ?? (matchesOutgoing ? local.localImage : undefined) });
      if (matchesOutgoing) {
        outgoingRef.current = null; setOutgoing(null); setPending(null); setText(""); setReply(null); setFile(null); setValidFile(null); thumbnailRef.current = null;
        setPickerDismissSignal((value) => value + 1);
        if (fileInput.current) fileInput.current.value = "";
      }
    }
    const merged = [...existing.values()].sort((a, b) => a.sequence - b.sequence);
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
    const reactionsById = new Map(reactionUpdates?.map((update) => [update.id, update.reactions]));
    for (let i = 0; i < merged.length; i++) {
      const item = merged[i]!;
      const receipt = byId.get(item.id);
      const reactions = item.deletedForEveryoneAt ? undefined : reactionsById.get(item.id);
      if (receipt && item.senderUserId === session.userId || reactions !== undefined) merged[i] = {
        ...item,
        ...(receipt && item.senderUserId === session.userId ? { receipt } : {}),
        ...(reactions !== undefined ? { reactions } : {}),
      };
    }
    if (merged.length > 300) setHasOlder(true);
    messagesRef.current = merged.slice(-300);
    // Four local originals at most (20 MB); older photos use their encrypted preview.
    let originals = 0;
    for (let i = messagesRef.current.length - 1; i >= 0; i--) {
      const item = messagesRef.current[i]!;
      if (item.localImage && ++originals > 4) messagesRef.current[i] = { ...item, localImage: undefined };
    }
    setMessages(messagesRef.current);
    if (items.length && atBottomRef.current) requestAnimationFrame(() => {
      if (active.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
  }, [session.userId, accepts]);
  const reconcile = useCallback(async (signal?: AbortSignal) => {
    const selected = [replyRef.current, actionRef.current?.message].filter((item): item is OpenMessage => Boolean(item));
    const loaded = new Map([...selected.map((item) => [item.id, item] as const), ...messagesRef.current.map((item) => [item.id, item] as const), ...targetsRef.current]);
    if (!loaded.size) return;
    const updates = await CircleChatService.updates(session, [...loaded.keys()].slice(0, 600), signal);
    if (!active.current || signal?.aborted) return;
    applyStates([...updates.states, ...updates.unavailableIds.map((id) => ({ id, revision: loaded.get(id)?.revision ?? 0, hidden: true, deletedForEveryoneAt: null }))]);
    const changed = updates.states.filter((state) => !state.hidden && !state.deletedForEveryoneAt && state.revision > (loaded.get(state.id)?.revision ?? 0)).map((state) => state.id);
    for (let index = 0; index < changed.length && active.current; index += 40) {
      const resolved = await CircleChatService.resolve(session, changed.slice(index, index + 40), signal);
      if (!active.current || signal?.aborted) return;
      const opened = await decrypt(resolved.items);
      append(opened.filter((item) => messagesRef.current.some((loaded) => loaded.id === item.id)));
      await cacheTargets(resolved.items);
    }
  }, [session, applyStates, decrypt, append, cacheTargets]);
  const mergeMembershipEvents = useCallback((incoming: CircleMembershipEvent[] | undefined) => {
    if (!incoming?.length) return;
    setMembershipEvents((previous) => {
      const sorted = [...new Map([...previous, ...incoming].map((event) => [event.id, event])).values()]
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
      let start = Math.max(0, sorted.length - 200);
      const firstBatch = sorted[start]?.batchId;
      while (start > 0 && firstBatch && sorted[start - 1]?.batchId === firstBatch) start--;
      return sorted.slice(start);
    });
  }, []);

  useEffect(() => {
    active.current = true;
    const abort = new AbortController();
    let nextRefreshAt = 0;
    const refresh = async () => {
      if (!active.current || !visibleRef.current || !foreground()) return;
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
        const generation = historyGeneration.current;
        const receiptRange = () => messagesRef.current.length ? {
          receiptAfter: messagesRef.current[0]!.sequence - 1, receiptThrough: last.current,
        } : {};
        let page = await CircleChatService.messages(session, incremental ? { after: last.current, ...receiptRange() } : {}, abort.signal);
        if (!active.current || generation !== historyGeneration.current) continue;
        await reconcile(abort.signal);
        if (!active.current || generation !== historyGeneration.current) continue;
        await cacheTargets(page.replyTargets);
        if (!last.current) setHasOlder(page.hasMore);
        mergeMembershipEvents(page.events);
        // Keep the older scroll window stable while still reconciling live
        // reactions and receipts for the messages visible in that window.
        const holdOlderWindow = anchored.current || !atBottomRef.current && messagesRef.current.length >= 300;
        append(holdOlderWindow ? [] : await decrypt(page.items), page.receipts, page.reactionUpdates, generation);
        if (generation !== historyGeneration.current) continue;
        if (!holdOlderWindow && active.current && page.items.length) last.current = Math.max(last.current, ...page.items.map((item) => item.sequence));
        // Repair a reconnect gap in bounded pages, without skipping any sequence.
        for (let i = 0; !holdOlderWindow && incremental && page.hasMore && last.current && i < 4 && active.current; i++) {
          page = await CircleChatService.messages(session, { after: last.current, ...receiptRange() }, abort.signal);
          if (generation !== historyGeneration.current) break;
          mergeMembershipEvents(page.events);
          await cacheTargets(page.replyTargets);
          append(await decrypt(page.items), page.receipts, page.reactionUpdates, generation);
          if (generation !== historyGeneration.current) break;
          if (active.current && page.items.length) last.current = Math.max(last.current, ...page.items.map((item) => item.sequence));
        }
        if (!holdOlderWindow && incremental && page.hasMore) refreshPending.current = true;
        if (active.current) { setLoading(false); if (!sendLock.current) setError(null); setReadRevision((n) => n + 1); }
        } while (refreshPending.current && active.current && visibleRef.current && foreground()
                 && (atBottomRef.current || messagesRef.current.length < 300));
      } catch (err) { if (!abort.signal.aborted) fail(err); }
      finally { running.current = false; if (active.current) { setLoading(false); setRefreshing(false); } }
    };
    const event = (value: Event) => {
      const detail = (value as CustomEvent<{ userId: string; circleId: string }>).detail;
      if (detail?.userId === session.userId && detail.circleId === session.circleId) {
        void refresh();
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener(CIRCLE_CHAT_CHANGED, event); window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void refresh(); });
    return () => { active.current = false; abort.abort(); clearInterval(timer); removeLifecycle();
      window.removeEventListener(CIRCLE_CHAT_CHANGED, event); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [session, append, decrypt, fail, mergeMembershipEvents, reconcile, cacheTargets]);

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
    }, { root: transcript.current, threshold: 0 });
    observer.observe(bottom.current);
    const viewportObserver = new IntersectionObserver(([entry]) => {
      bottomInViewport.current = Boolean(entry?.isIntersecting);
      if (entry?.isIntersecting) setReadRevision((n) => n + 1);
    }, { threshold: 0 });
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
      if (reading.current || anchored.current || actionRequest || !visibleRef.current || !active.current || !element || element.scrollHeight - element.scrollTop - element.clientHeight > 8
          || !atBottomRef.current || !bottomInViewport.current || !document.hasFocus() || !foreground() || sequence <= readThrough.current
          || readingBlocked || viewers.size > 0 || chatReadIsBlocked(element)) return;
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
    const removeLayers = subscribeChatLayerChanges(() => { void read(); });
    return () => { removeLifecycle(); removeLayers(); window.removeEventListener("focus", read); document.removeEventListener("visibilitychange", read); };
  }, [session, readRevision, messages, fail, visible, readingBlocked, viewers, blockingLayer, actionRequest]);

  const showWindow = async (target?: OpenMessage) => {
    if (!active.current || jumping) return;
    const generation = ++historyGeneration.current;
    anchored.current = Boolean(target); atBottomRef.current = !target;
    setJumping(true); setError(null);
    try {
      const page = await CircleChatService.messages(session, target ? { before: target.sequence + 1 } : {});
      const opened = await decrypt(page.items);
      if (!active.current || generation !== historyGeneration.current) return;
      await reconcile();
      await cacheTargets(page.replyTargets);
      if (!active.current || generation !== historyGeneration.current) return;
      const refreshed = new Map([...targetsRef.current, ...messagesRef.current.map((item) => [item.id, item] as const)]);
      messagesRef.current = opened.map((item) => {
        const current = refreshed.get(item.id);
        return current && (current.revision ?? 0) > (item.revision ?? 0) ? current : item;
      }).filter(accepts);
      setMessages(messagesRef.current); setHasOlder(page.hasMore);
      mergeMembershipEvents(page.events); last.current = messagesRef.current.at(-1)?.sequence ?? 0;
      setAtBottom(!target);
      requestAnimationFrame(() => {
        if (!active.current || generation !== historyGeneration.current) return;
        const row = target ? Array.from(messageList.current?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? []).find((item) => item.dataset.chatMessage === target.id) : null;
        if (row) { row.tabIndex = -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: "center", behavior: "instant" }); }
        else if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      });
    } catch (caught) { fail(caught); }
    finally { if (active.current && generation === historyGeneration.current) setJumping(false); }
  };
  const jump = (target: OpenMessage) => {
    const row = Array.from(messageList.current?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? []).find((item) => item.dataset.chatMessage === target.id);
    if (row) { row.tabIndex = -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: "center", behavior: "instant" }); }
    else void showWindow(target);
  };
  const mutationResult = async (result: ChatMutationResult) => {
    if (!active.current) return;
    if (result.hiddenId) applyStates([{ id: result.hiddenId, revision: versions.current.get(result.hiddenId)?.revision ?? 0, hidden: true, deletedForEveryoneAt: null }]);
    const items = result.items ?? [];
    applyStates(items.map((item) => ({ id: item.id, revision: item.revision ?? 0, hidden: false, deletedForEveryoneAt: item.deletedForEveryoneAt ?? null })));
    append(await decrypt(items));
    await cacheTargets(items);
    dispatchCircleChatChanged(session.userId, session.circleId);
  };

  const send = async () => {
    if (sendLock.current || !active.current || loading || jumping || (!pending && file && validFile !== file) || (!pending && !text.trim() && !file)) return;
    sendLock.current = true; setSending(true); setError(null);
    let sealed = pending;
    let local = outgoingRef.current;
    if (file?.type.startsWith("image/")) {
      local = local ? { ...local, delivery: "sending" } : {
        id: crypto.randomUUID(), clientMessageId: "", senderUserId: session.userId, senderName: "You",
        createdAt: new Date().toISOString(), content: { text: text.trim(), attachment: { kind: "photo", type: file.type, name: file.name.slice(0, 160) } },
        failed: false, localImage: file, delivery: "sending",
      };
      local.clientMessageId ||= local.id;
      outgoingRef.current = local; setOutgoing(local);
      atBottomRef.current = true; setAtBottom(true);
      requestAnimationFrame(() => { if (active.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; });
    }
    const attempt = { id: sealed?.clientMessageId ?? local?.clientMessageId ?? null, confirmed: false };
    sendAttempt.current = attempt;
    try {
      sealed ??= await CircleChatService.prepare(session, text, file, { ...(local ? { clientMessageId: local.clientMessageId,
        thumbnail: thumbnailRef.current?.file === file ? thumbnailRef.current.thumbnail : undefined } : {}), ...(reply ? { replyToMessageId: reply.id } : {}) });
      if (!active.current) return;
      attempt.id = sealed.clientMessageId;
      if (local && local.clientMessageId !== sealed.clientMessageId) {
        local = { ...local, id: sealed.clientMessageId, clientMessageId: sealed.clientMessageId };
        outgoingRef.current = local; setOutgoing(local);
      }
      setPending(sealed);
      const sent = await CircleChatService.send(session, sealed);
      if (!active.current) return;
      if (anchored.current) await showWindow();
      atBottomRef.current = true;
      setAtBottom(true);
      append(await decrypt([sent]));
      setPending(null); setText(""); setReply(null); setFile(null); setValidFile(null); thumbnailRef.current = null;
      outgoingRef.current = null; setOutgoing(null); setPickerDismissSignal((value) => value + 1);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      if (!active.current) return;
      // The transcript can confirm delivery before an uncertain POST settles.
      if (!unavailable(err) && attempt.confirmed) return;
      fail(err);
      // A definite roster refusal never committed; reseal only on the person's next Send.
      if (["CIRCLE_CHAT_ROSTER_CHANGED", "CIRCLE_CHAT_RETRY_CONFLICT"].includes(apiErrorCode(err) ?? "")
          || err instanceof ApiError && [413, 422].includes(err.status) || !sealed) {
        setPending(null); outgoingRef.current = null; setOutgoing(null);
      } else if (active.current && local) {
        const uncertain: OutgoingChatMessage = { ...local, delivery: "unconfirmed" };
        outgoingRef.current = uncertain; setOutgoing(uncertain);
      }
    } finally { if (sendAttempt.current === attempt) sendAttempt.current = null; sendLock.current = false; if (active.current) setSending(false); }
  };
  return <div className={`${file ? "[--chat-preview-height:5rem]" : "[--chat-preview-height:0px]"} ${chatLane ? "flex h-full min-h-0 flex-col" : ""}`}>
    <div ref={transcript} tabIndex={0} aria-label="Circle messages" style={chatLane ? { height: "auto", minHeight: 0, flex: "1 1 0", paddingBottom: "10rem" } : undefined}
      className={chatLane
        ? "overflow-y-auto overscroll-contain bg-transparent px-3 py-4 sm:px-6 sm:py-5"
        : "h-[min(36rem,max(10rem,calc(50dvh-var(--kb-height,0px)-var(--chat-preview-height))))] overflow-y-auto overscroll-contain bg-muted/30 px-3 py-4 sm:h-[min(36rem,max(10rem,calc(48dvh-var(--kb-height,0px)-var(--chat-preview-height))))] sm:px-5 sm:py-5"}>
      {hasOlder ? <Button variant="ghost" size="sm" className={`min-h-11 ${chatLane ? quietStyles.action : ""}`} disabled={loadingOlder || refreshing || jumping} onClick={async () => {
        if (!messages.length || loadingOlder || running.current) return;
        running.current = true;
        setLoadingOlder(true);
        const height = transcript.current?.scrollHeight ?? 0;
        const generation = historyGeneration.current;
        try {
          const page = await CircleChatService.messages(session, { before: messages[0]!.sequence });
          await cacheTargets(page.replyTargets);
          mergeMembershipEvents(page.events);
          const older = await decrypt(page.items);
          const receipts = new Map(page.receipts?.map((receipt) => [receipt.id, receipt]));
          for (const item of older) {
            const receipt = receipts.get(item.id);
            if (receipt) item.receipt = { recipientCount: receipt.recipientCount, readCount: receipt.readCount };
          }
          if (!active.current || generation !== historyGeneration.current) return;
          const window = [...new Map([...older.filter(accepts), ...messagesRef.current].map((item) => [item.id, item])).values()].sort((a, b) => a.sequence - b.sequence).slice(0, 300);
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
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading messages…</p> : !messages.length && !membershipEvents.length && !outgoing ? <p className="py-8 text-center text-sm text-muted-foreground">Start the conversation. Say hello or share a file.</p> : null}
      <div role="log" aria-label="Circle message history" aria-live={atBottom && visible ? "polite" : "off"} aria-relevant="additions" aria-busy={loading || loadingOlder}><ol ref={messageList}>{[
        ...messages.map((message, index) => ({ kind: "message" as const, id: `${message.senderUserId}:${message.clientMessageId ?? message.id}`, createdAt: message.createdAt, message, previous: messages[index - 1] })),
        ...(outgoing ? [{ kind: "message" as const, id: `${outgoing.senderUserId}:${outgoing.clientMessageId}`, createdAt: outgoing.createdAt, message: outgoing, previous: messages.at(-1) }] : []),
        ...groupCircleMembershipEvents(membershipEvents).map((events) => ({ kind: "event" as const, id: events[0]!.id, createdAt: events.at(-1)!.createdAt, events })),
      ].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
        .map((item) => item.kind === "event" ? <CircleMembershipEventPill key={`event:${item.id}`} events={item.events} /> : <CircleChatMessage key={`message:${item.id}`}
          message={item.message} previous={item.previous} session={session} visible={visible} layoutBlocked={readingBlocked} scrollRoot={transcript} messagesLane={chatLane}
          onReply={(message) => { if (!pending && !sending) { setReply(message); composerEditor.current?.focus(); } }}
          replyDisabled={Boolean(pending) || sending}
          onAction={(message, action) => setActionRequest({ message, action })}
          replyTarget={"replyToMessageId" in item.message && item.message.replyToMessageId ? messages.find((row) => row.id === item.message.replyToMessageId) ?? replyTargets.get(item.message.replyToMessageId) : undefined}
          onJump={jump}
          onViewerChange={viewerChanged} onMediaError={(error) => { if (unavailable(error)) fail(error); }} />)}</ol></div>
      <div ref={bottom} className="h-1" />
    </div>
    <AgentDockPortal enabled={chatLane} visible={visible}>
    <div className={chatLane ? laneStyles.composer : "relative space-y-2 border-t border-border/60 p-3 sm:px-5 sm:py-4"} data-theme={chatLane ? chatLaneTheme : undefined} data-circle-chat-composer data-messages-type-scale={chatLane || undefined}>
    {anchored.current || !atBottom && messages.length ? <Button variant="ghost" size="sm" disabled={jumping} className={`absolute bottom-full left-1/2 -translate-x-1/2 z-10 mb-3 min-h-11 rounded-full border border-border bg-card shadow-sm ${chatLane ? quietStyles.action : ""}`} onClick={() => {
      if (anchored.current) { void showWindow(); return; }
      atBottomRef.current = true;
      if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      window.dispatchEvent(new CustomEvent(CIRCLE_CHAT_CHANGED, { detail: { userId: session.userId, circleId: session.circleId } }));
    }}><ArrowDown className="size-4" aria-hidden="true" />Go to latest messages</Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {jumping ? <p role="status" className="text-sm text-muted-foreground">Loading messages…</p> : null}
    {reply ? <div className="flex min-w-0 items-center gap-2 rounded-lg border-l-2 border-primary bg-muted/50 px-3 py-2" aria-label="Replying to message">
      <div className="min-w-0 flex-1 text-sm"><p className="font-semibold"><bdi>{connectPersonName({ displayName: reply.senderName })}</bdi></p><p dir="auto" className="line-clamp-2 break-words">{messages.find((item) => item.id === reply.id)?.content?.text ?? reply.content?.text ?? "Attachment"}</p></div>
      <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Cancel reply" disabled={sending || Boolean(pending)} onClick={() => setReply(null)}><X aria-hidden="true" className="size-4" /></Button>
    </div> : null}
    {file && !outgoing ? file.type.startsWith("image/") ? <ImageAttachmentPreview key={`${file.name}:${file.lastModified}`} file={file} disabled={sending || Boolean(pending)} onThumbnail={(previewFile, thumbnail) => { if (previewFile === file) thumbnailRef.current = { file: previewFile, thumbnail }; }} onValidity={(previewFile, valid) => { if (previewFile === file) setValidFile(valid ? previewFile : null); }} onRemove={() => { setFile(null); setValidFile(null); thumbnailRef.current = null; if (fileInput.current) fileInput.current.value = ""; }} />
      : <FileAttachmentPreview file={file} disabled={sending || Boolean(pending)} onRemove={() => { setFile(null); setValidFile(null); if (fileInput.current) fileInput.current.value = ""; }} /> : null}
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" className="hidden" tabIndex={-1} aria-label="Attach photo, video, or document" disabled={sending || Boolean(pending)} onChange={async (event) => {
        const next = event.target.files?.[0];
        if (!next) return;
        if (!next.size || next.size > MAX_CHAT_IMAGE_BYTES) { setError("Choose a file up to 5 MB."); event.target.value = ""; return; }
        setValidFile(null); setError(null);
        try {
          const kind = validateChatAttachmentBytes(new Uint8Array(await next.arrayBuffer()), next.type);
          if (event.target.files?.[0] !== next) return;
          setFile(next);
          if (kind !== "photo") setValidFile(next);
        } catch (caught) {
          setError(errorText(caught)); event.target.value = "";
        }
      }} />
    <ConversationComposer placeholder={chatLane ? `Message ${circleName}` : undefined} value={text} onChange={setText} onSend={() => void send()} maxLength={MAX_CHAT_TEXT} visible={visible} editorRef={composerEditor}
      busy={sending} locked={Boolean(pending)} sendLabel={pending ? "Retry message" : "Send message"}
      sendDisabled={loading || jumping || (!pending && Boolean(file) && validFile !== file) || (!text.trim() && !file && !pending)}
      showSend={!chatLane || Boolean(text.trim() || file || pending || sending)}
      trailingAction={chatLane ? <DirectMessageEmojiPicker messagesLane restoreTriggerFocusOnSelect={false} disabled={sending || Boolean(pending)} dismissSignal={pickerDismissSignal} onEmojiSelect={(emoji) => {
        const editor = composerEditor.current;
        const start = editor?.selectionStart ?? text.length;
        const end = editor?.selectionEnd ?? start;
        setText((current) => `${current.slice(0, start)}${emoji}${current.slice(end)}`);
        requestAnimationFrame(() => { editor?.focus(); editor?.setSelectionRange(start + emoji.length, start + emoji.length); });
      }} /> : undefined}
      emptyAction={chatLane ? <ChatLaneMicAction /> : undefined}
      leadingAction={<ShellActionSurface className="size-11" aria-label="Attach photo, video, or document" disabled={sending || Boolean(pending)} onClick={() => fileInput.current?.click()}>{chatLane ? <Plus aria-hidden="true" className="size-5" /> : <ImageIcon aria-hidden="true" className="size-5" />}</ShellActionSurface>} />
    {pending && !sending ? <p className="text-xs text-muted-foreground">Delivery is unconfirmed. Retry sends the same message safely.</p> : null}
    </div>
    </AgentDockPortal>
    {actionRequest && visible && !readingBlocked ? <CircleChatMessageActionDialog key={`${actionRequest.message.id}:${actionRequest.action}`} session={session} messagesLane={chatLane} {...actionRequest}
      onClose={() => setActionRequest(null)} onResult={mutationResult} onAccessError={(error) => { if (unavailable(error)) fail(error); }}
      onRestoreFocus={() => { const id = actionRequest.message.id; requestAnimationFrame(() => {
        if (!active.current || !visibleRef.current) return;
        const row = Array.from(messageList.current?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? []).find((item) => item.dataset.chatMessage === id);
        (row?.querySelector<HTMLButtonElement>('[aria-label="Message options"]') ?? transcript.current)?.focus({ preventScroll: true });
      }); }} /> : null}
  </div>;
}
