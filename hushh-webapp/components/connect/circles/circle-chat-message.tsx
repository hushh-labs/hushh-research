"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, CheckCheck } from "@/components/icons";
import { OneChatTimeSeparator } from "@/components/agent/chat-message-styles";
import { conversationDayLabel, messagesFormGroup } from "@/components/app-ui/conversation-message";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { CircleChatService, type CircleChatSession } from "@/lib/services/circle-chat-service";
import type { ChatContent, ChatMessage } from "@/lib/circle-chat/crypto";
import { ChatImage, ChatSharedFile } from "./circle-chat-media";
import styles from "./circle-chat-message.module.css";

export type OpenChatMessage = ChatMessage & { content: ChatContent | null; failed: boolean };
type Reaction = NonNullable<ChatMessage["reactions"]>[number];
const REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🙏"] as const;

function senderColor(userId: string): number {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 6;
}

function toggleReaction(current: Reaction[], emoji: string, active: boolean): Reaction[] {
  const existing = current.find((item) => item.emoji === emoji);
  const count = (existing?.count ?? 0) + (active ? 1 : -1);
  if (count <= 0) return current.filter((item) => item.emoji !== emoji);
  if (!existing) return [...current, { emoji, count, reactedByViewer: active }];
  return current.map((item) => item.emoji === emoji ? { ...item, count, reactedByViewer: active } : item);
}

export function CircleChatMessage({ message, previous, session, visible, layoutBlocked, scrollRoot, onMediaError, onViewerChange }: {
  message: OpenChatMessage; previous?: OpenChatMessage; session: CircleChatSession;
  visible: boolean; layoutBlocked: boolean; scrollRoot: RefObject<HTMLDivElement | null>; onMediaError: (error: unknown) => void;
  onViewerChange: (id: string, open: boolean) => void;
}) {
  const own = message.senderUserId === session.userId;
  const showDay = !previous || new Date(message.createdAt).toDateString() !== new Date(previous.createdAt).toDateString();
  const grouped = messagesFormGroup(previous, message, previous?.senderUserId === message.senderUserId);
  const receipt = message.receipt;
  const seen = Boolean(receipt && receipt.recipientCount !== null && receipt.recipientCount > 0 && receipt.readCount === receipt.recipientCount);
  const status = seen ? "Seen by everyone" : receipt?.recipientCount ? `Sent · Read by ${receipt.readCount} of ${receipt.recipientCount}` : "Sent";
  const [reactions, setReactions] = useState<Reaction[]>(message.reactions ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reactionError, setReactionError] = useState(false);
  const pickerRoot = useRef<HTMLDivElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOpened = useRef(false);
  useEffect(() => setReactions(message.reactions ?? []), [message.reactions]);
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!pickerRoot.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [pickerOpen]);
  useEffect(() => () => { if (hold.current) clearTimeout(hold.current); }, []);

  const react = async (emoji: string) => {
    if (busy) return;
    const previousReactions = reactions;
    const active = !reactions.some((item) => item.emoji === emoji && item.reactedByViewer);
    setReactions(toggleReaction(reactions, emoji, active));
    setPickerOpen(false);
    setReactionError(false);
    setBusy(true);
    try {
      const result = await CircleChatService.react(session, message, emoji, active);
      setReactions(result.reactions);
    } catch {
      setReactions(previousReactions);
      setReactionError(true);
    } finally { setBusy(false); }
  };
  const attachment = message.content?.attachment;
  const image = message.content?.image ?? (attachment?.kind === "photo" ? attachment : null);
  const file = attachment?.kind === "video" || attachment?.kind === "document" ? attachment : null;
  const time = new Date(message.createdAt);

  return <li data-chat-message={message.id} className={`${styles.item} ${grouped ? styles.grouped : ""}`}>
    {showDay ? <div className="pb-4 pt-1"><OneChatTimeSeparator dateTime={message.createdAt} label={conversationDayLabel(message.createdAt)} /></div> : null}
    <div className={`${styles.row} ${own ? styles.own : ""}`} data-message-role={own ? "user" : "peer"}>
      {!own ? <div className={styles.avatar}>{!grouped ? <ConnectionPersonAvatar size="comfortable" className="!size-8" label={message.senderName} photoUrl={message.senderPhotoUrl} /> : null}</div> : null}
      <div className={styles.stack}>
        <div className={styles.bubbleWrap}>
          <div className={`${styles.bubble} ${own ? styles.outgoing : styles.incoming}`}>
            {!own && !grouped ? <p className={`${styles.sender} ${styles[`sender${senderColor(message.senderUserId)}`]}`}><bdi>{message.senderName}</bdi></p> : null}
            {message.failed ? <p className={styles.failed}>This message could not be opened on this device.</p> : <>
              {image ? <ChatImage session={session} message={message} type={image.type}
                visible={visible} layoutBlocked={layoutBlocked} scrollRoot={scrollRoot} onError={onMediaError} onViewerChange={(open) => onViewerChange(message.id, open)} /> : null}
              {file ? <ChatSharedFile session={session} message={message} type={file.type} name={file.name} onError={onMediaError} /> : null}
              {message.content?.text ? <p dir="auto" className={`${styles.text} ${image || file ? styles.caption : ""}`}>{message.content.text}</p> : null}
            </>}
            <div className={styles.meta}>
              <time dateTime={message.createdAt} title={time.toLocaleString()}>{time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
              {own ? <span aria-label={status} title={status} className={seen ? styles.seen : ""}>{seen ? <CheckCheck aria-hidden="true" className="size-4" /> : <Check aria-hidden="true" className="size-4" />}</span> : null}
            </div>
          </div>
          <div ref={pickerRoot} className={styles.reactionControl}>
            <button type="button" className={styles.addReaction} aria-label="React to message" aria-expanded={pickerOpen} disabled={busy}
              onClick={() => { if (holdOpened.current) { holdOpened.current = false; return; } setPickerOpen((open) => !open); }}
              onPointerDown={(event) => { if (event.pointerType === "touch") { holdOpened.current = false; hold.current = setTimeout(() => { holdOpened.current = true; setPickerOpen(true); }, 420); } }}
              onPointerUp={() => { if (hold.current) clearTimeout(hold.current); }}
              onPointerCancel={() => { if (hold.current) clearTimeout(hold.current); holdOpened.current = false; }}>☺</button>
            {pickerOpen ? <div className={styles.picker} role="group" aria-label="Choose a reaction">
              {REACTIONS.map((emoji) => <button key={emoji} type="button" aria-label={`React with ${emoji}`} onClick={() => void react(emoji)}>{emoji}</button>)}
            </div> : null}
          </div>
        </div>
        {reactions.length ? <div className={styles.pills}>{reactions.map((reaction) => <button key={reaction.emoji} type="button"
          className={`${styles.pill} ${reaction.reactedByViewer ? styles.mine : ""}`} aria-label={`${reaction.emoji}, ${reaction.count} reactions${reaction.reactedByViewer ? ", you reacted" : ""}`}
          disabled={busy} onClick={() => void react(reaction.emoji)}><span aria-hidden="true">{reaction.emoji}</span><span>{reaction.count}</span></button>)}</div> : null}
        {reactionError ? <p role="alert" className={styles.reactionError}>Reaction could not be saved. Try again.</p> : null}
      </div>
    </div>
  </li>;
}
