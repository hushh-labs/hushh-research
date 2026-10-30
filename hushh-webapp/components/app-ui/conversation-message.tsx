"use client";

import type { ReactNode } from "react";
import { Check, CheckCheck } from "@/components/icons";
import { OneChatBubble } from "@/components/agent/chat-message-styles";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { cn } from "@/lib/utils";

export function conversationDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString() ? "Today" : date.toDateString() === yesterday.toDateString() ? "Yesterday" :
    date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function messagesFormGroup(previous: { createdAt: string } | undefined, current: { createdAt: string }, sameSender: boolean): boolean {
  if (!previous || !sameSender) return false;
  const gap = Date.parse(current.createdAt) - Date.parse(previous.createdAt);
  return gap >= 0 && gap <= 5 * 60_000 && new Date(current.createdAt).toDateString() === new Date(previous.createdAt).toDateString();
}

/** Presentation only. Receipt labels always come from the owning chat service. */
export function ConversationMessage({ own, createdAt, children, senderName, senderPhotoUrl, grouped = false, receipt, seen = false }: {
  own: boolean; createdAt: string; children: ReactNode; senderName?: string; senderPhotoUrl?: string | null;
  grouped?: boolean; receipt?: string; seen?: boolean;
}) {
  const date = new Date(createdAt);
  return <div data-message-role={own ? "user" : "peer"} className={cn("flex min-w-0 items-end gap-2", own ? "justify-end" : "justify-start")}>
    {!own && senderName ? <div className="w-8 shrink-0 self-start">
      {!grouped ? <ConnectionPersonAvatar size="comfortable" className="!size-8" label={senderName} photoUrl={senderPhotoUrl} /> : null}
    </div> : null}
    <OneChatBubble tone="plain" className={cn("min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-[1.5] [overflow-wrap:anywhere] sm:max-w-[min(76%,36rem)]",
      senderName && !own && "max-w-[calc(100%-2.5rem)]",
      own ? "rounded-br-md bg-[color:var(--app-accent-tint)]" : "rounded-bl-md border border-border/50 bg-card")}>
      {!own && senderName && !grouped ? <p className="mb-1 text-xs font-semibold leading-4 text-[color:var(--app-accent-deep)]"><bdi>{senderName}</bdi></p> : null}
      {children}
      <div className="mt-1 flex items-center justify-end gap-1 text-[11px] leading-4 text-muted-foreground">
        <time dateTime={createdAt} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
        {own && receipt ? <span aria-label={receipt} title={receipt} className={cn("inline-flex", seen && "text-[color:var(--app-accent)]")}>
          {seen ? <CheckCheck aria-hidden="true" className="size-4" /> : <Check aria-hidden="true" className="size-4" />}
        </span> : null}
      </div>
    </OneChatBubble>
  </div>;
}
