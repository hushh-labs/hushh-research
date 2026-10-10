"use client";

import type { RefObject } from "react";
import { OneChatTimeSeparator } from "@/components/agent/chat-message-styles";
import { ConversationMessage, conversationDayLabel, messagesFormGroup } from "@/components/app-ui/conversation-message";
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
  const grouped = messagesFormGroup(previous, message, previous?.senderUserId === message.senderUserId);
  const receipt = message.receipt;
  const seen = Boolean(receipt && receipt.recipientCount !== null && receipt.recipientCount > 0 && receipt.readCount === receipt.recipientCount);
  const status = seen ? "Seen by everyone" : receipt?.recipientCount ? `Sent · Read by ${receipt.readCount} of ${receipt.recipientCount}` : "Sent";
  return <li data-chat-message={message.id} className={`min-w-0 ${grouped ? "mt-1.5" : "mt-4"}`}>
    {showDay ? <div className="pb-4 pt-1"><OneChatTimeSeparator dateTime={message.createdAt} label={conversationDayLabel(message.createdAt)} /></div> : null}
    <ConversationMessage own={own} createdAt={message.createdAt} senderName={message.senderName} senderPhotoUrl={message.senderPhotoUrl}
      grouped={grouped} receipt={status} seen={seen}>
          {message.failed ? <p className="text-sm text-muted-foreground">This message could not be opened on this device.</p> : <>
            {message.content?.image ? <ChatImage session={session} message={message} type={message.content.image.type}
              visible={visible} layoutBlocked={layoutBlocked} scrollRoot={scrollRoot} onError={onMediaError} onViewerChange={(open) => onViewerChange(message.id, open)} /> : null}
            {message.content?.text ? <p dir="auto" className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${message.content.image ? "mt-2" : ""}`}>{message.content.text}</p> : null}
          </>}
    </ConversationMessage>
  </li>;
}
