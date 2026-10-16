"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, CheckCheck } from "@/components/icons";
import { DirectMessageEmojiPicker } from "@/components/direct-messages/direct-message-emoji-picker";
import { OneChatTimeSeparator } from "@/components/agent/chat-message-styles";
import { conversationDayLabel, messagesFormGroup } from "@/components/app-ui/conversation-message";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { CircleChatService, type CircleChatSession } from "@/lib/services/circle-chat-service";
import type { ChatContent, ChatMessage } from "@/lib/circle-chat/crypto";
import { ChatImage, ChatSharedFile } from "./circle-chat-media";
import styles from "./circle-chat-message.module.css";

export type OpenChatMessage = ChatMessage & { content: ChatContent | null; failed: boolean; localImage?: File };
export type OutgoingChatMessage = Pick<ChatMessage, "id" | "clientMessageId" | "senderUserId" | "senderName" | "createdAt"> & {
  content: ChatContent; failed: false; localImage: File; delivery: "sending" | "unconfirmed";
  receipt?: never; reactions?: never; senderPhotoUrl?: never;
};
type Reaction = NonNullable<ChatMessage["reactions"]>[number];

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
  message: OpenChatMessage | OutgoingChatMessage; previous?: OpenChatMessage; session: CircleChatSession;
  visible: boolean; layoutBlocked: boolean; scrollRoot: RefObject<HTMLDivElement | null>; onMediaError: (error: unknown) => void;
  onViewerChange: (id: string, open: boolean) => void;
}) {
  const own = message.senderUserId === session.userId;
  const confirmed = "sequence" in message;
  const viewerId = `${message.senderUserId}:${message.clientMessageId ?? message.id}`;
  const showDay = !previous || new Date(message.createdAt).toDateString() !== new Date(previous.createdAt).toDateString();
  const grouped = messagesFormGroup(previous, message, previous?.senderUserId === message.senderUserId);
  const receipt = message.receipt;
  const seen = Boolean(receipt && receipt.recipientCount !== null && receipt.recipientCount > 0 && receipt.readCount === receipt.recipientCount);
  const status = seen ? "Seen by everyone" : receipt?.recipientCount ? `Sent · Read by ${receipt.readCount} of ${receipt.recipientCount}` : "Sent";
  const [reactions, setReactions] = useState<Reaction[]>(message.reactions ?? []);
  const [busy, setBusy] = useState(false);
  const [reactionError, setReactionError] = useState(false);
  const saving = useRef(false);
  useEffect(() => setReactions(message.reactions ?? []), [message.reactions]);

  const react = async (emoji: string) => {
    if (saving.current || !confirmed || !visible || layoutBlocked) return;
    saving.current = true;
    const previousReactions = reactions;
    const active = !reactions.some((item) => item.emoji === emoji && item.reactedByViewer);
    setReactions(toggleReaction(reactions, emoji, active));
    setReactionError(false);
    setBusy(true);
    try {
      const result = await CircleChatService.react(session, message, emoji, active);
      setReactions(result.reactions);
    } catch {
      setReactions(previousReactions);
      setReactionError(true);
    } finally { saving.current = false; setBusy(false); }
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
              {image ? <ChatImage session={session} message={confirmed ? message : undefined} type={image.type} localImage={message.localImage} thumbnail={image.thumbnail}
                visible={visible} layoutBlocked={layoutBlocked} scrollRoot={scrollRoot} onError={onMediaError} onViewerChange={(open) => onViewerChange(viewerId, open)} /> : null}
              {file && confirmed ? <ChatSharedFile session={session} message={message} type={file.type} name={file.name} onError={onMediaError} /> : null}
              {message.content?.text ? <p dir="auto" className={`${styles.text} ${image || file ? styles.caption : ""}`}>{message.content.text}</p> : null}
            </>}
            <div className={styles.meta}>
              <time dateTime={message.createdAt} title={time.toLocaleString()}>{time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
              {own ? confirmed ? <span aria-label={status} title={status} className={seen ? styles.seen : ""}>{seen ? <CheckCheck aria-hidden="true" className="size-4" /> : <Check aria-hidden="true" className="size-4" />}</span>
                : <span role="status">{message.delivery === "sending" ? "Sending…" : "Delivery unconfirmed"}</span> : null}
            </div>
          </div>
          {confirmed ? <DirectMessageEmojiPicker label="React to message" disabled={busy || !visible || layoutBlocked}
            triggerClassName={styles.addReaction}
            dismissSignal={layoutBlocked || !visible ? 1 : 0} onEmojiSelect={(emoji) => void react(emoji)} /> : null}
        </div>
        {confirmed && reactions.length > 0 ? <div className={styles.pills}>{reactions.map((reaction) => <button key={reaction.emoji} type="button"
          className={`${styles.pill} ${reaction.reactedByViewer ? styles.mine : ""}`} aria-label={`${reaction.emoji}, ${reaction.count} reactions${reaction.reactedByViewer ? ", you reacted" : ""}`}
          disabled={busy || !visible || layoutBlocked} onClick={() => void react(reaction.emoji)}><span className={styles.badge}><span aria-hidden="true">{reaction.emoji}</span><span>{reaction.count}</span></span></button>)}
        </div> : null}
        {reactionError ? <p role="alert" className={styles.reactionError}>Reaction could not be saved. Try again.</p> : null}
      </div>
    </div>
  </li>;
}
