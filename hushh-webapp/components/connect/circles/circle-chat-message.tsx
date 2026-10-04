"use client";

import type { RefObject } from "react";
import { Check, CheckCheck } from "@/components/icons";
import { OneChatBubble, OneChatTimeSeparator } from "@/components/agent/chat-message-styles";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ChatImage } from "./circle-chat-media";
import type { ChatContent, ChatMessage } from "@/lib/circle-chat/crypto";
import type { CircleChatSession } from "@/lib/services/circle-chat-service";

export type OpenChatMessage = ChatMessage & { content: ChatContent | null; failed: boolean };

export function CircleChatMessage({ message, previous, session, visible, layoutBlocked, scrollRoot, onMediaError, onViewerChange }: {
  message: OpenChatMessage; previous?: OpenChatMessage; session: CircleChatSession;
  visible: boolean; layoutBlocked: boolean; scrollRoot: RefObject<HTMLDivElement | null>; onMediaError: (error: unknown) => void;
  onViewerChange: (id: string, open: boolean) => void;
}) {
  const own = message.senderUserId === session.userId;
  const date = new Date(message.createdAt);
  const day = date.toDateString();
  const showDay = !previous || day !== new Date(previous.createdAt).toDateString();
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dayLabel = day === today.toDateString() ? "Today" : day === yesterday.toDateString() ? "Yesterday" :
    date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  const receipt = message.receipt;
  const seen = Boolean(receipt && receipt.recipientCount !== null && receipt.recipientCount > 0 && receipt.readCount === receipt.recipientCount);
  const status = seen ? "Seen by everyone" : receipt?.recipientCount ? `Sent · Read by ${receipt.readCount} of ${receipt.recipientCount}` : "Sent";
  const avatar = <ConnectionPersonAvatar size="comfortable" className="!size-8" label={message.senderName} photoUrl={message.senderPhotoUrl} />;
  return <li data-chat-message={message.id} className="min-w-0">
    {showDay ? <div className="pb-4 pt-1"><OneChatTimeSeparator dateTime={message.createdAt} label={dayLabel} /></div> : null}
    <div className={`flex items-start gap-2 ${own ? "justify-end" : "justify-start"}`}>
      {!own ? avatar : null}
      <div className="min-w-0 max-w-[calc(100%-2.5rem)] sm:max-w-[76%]">
        <p className={`mb-1.5 break-words text-xs font-semibold leading-4 text-[color:var(--app-accent-deep)] [overflow-wrap:anywhere] ${own ? "text-right" : ""}`}>
          <bdi>{message.senderName}</bdi>{own ? <span className="font-normal text-muted-foreground"> · You</span> : null}
        </p>
        <OneChatBubble tone="plain" className={`overflow-hidden rounded-2xl px-3 py-2.5 text-[15px] leading-[1.45] ${own ? "rounded-tr-md bg-[color:var(--app-accent-tint)]" : "rounded-tl-md border border-border/50 bg-card"}`}>
          {message.failed ? <p className="text-sm text-muted-foreground">This message could not be opened on this device.</p> : <>
            {message.content?.image ? <ChatImage session={session} message={message} type={message.content.image.type}
              visible={visible} layoutBlocked={layoutBlocked} scrollRoot={scrollRoot} onError={onMediaError} onViewerChange={(open) => onViewerChange(message.id, open)} /> : null}
            {message.content?.text ? <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${message.content.image ? "mt-2" : ""}`}>{message.content.text}</p> : null}
          </>}
          <div className="mt-1.5 flex items-center justify-end gap-1 text-[11px] leading-4 text-muted-foreground">
            <time dateTime={message.createdAt} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
            {own ? <span aria-label={status} title={status} className={`inline-flex ${seen ? "text-[color:var(--app-accent)]" : "text-muted-foreground"}`}>
              {seen ? <CheckCheck aria-hidden="true" className="size-4" /> : <Check aria-hidden="true" className="size-4" />}
            </span> : null}
          </div>
        </OneChatBubble>
      </div>
      {own ? avatar : null}
    </div>
  </li>;
}
