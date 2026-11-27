import { useLayoutEffect, useRef, useState } from "react";
import type { LocationConversationReply } from "@/lib/agent/main-chat-location-conversation";

export type LocationConversationProps = {
  onConversationReply?: (handler: LocationConversationReply | null) => void;
  onConversationText?: (text: string) => void;
};

/** Register only the reply for the visible owner-scoped question. History has no handler. */
export function useLocationConversationTurn(
  { onConversationReply, onConversationText }: LocationConversationProps,
  text: string | null,
  respond: LocationConversationReply | null,
) {
  const active = useRef<{ text: string | null; respond: LocationConversationReply | null } | null>(null);
  const [replyNumber, setReplyNumber] = useState(0);
  useLayoutEffect(() => {
    active.current = { text, respond };
    return () => { active.current = null; };
  });
  const canReply = Boolean(respond && text);
  useLayoutEffect(() => {
    if (!onConversationReply || !canReply) return;
    onConversationReply((message, displayedQuestion) => {
      const current = active.current;
      if (!current?.respond || displayedQuestion !== current.text) return false;
      if (!current.respond(message, displayedQuestion)) return false;
      // A retry or an unchanged duration still opens a new answer in the transcript.
      setReplyNumber((previous) => previous + 1);
      return true;
    });
    return () => onConversationReply(null);
  }, [canReply, onConversationReply]);
  useLayoutEffect(() => {
    if (text) onConversationText?.(text);
  }, [onConversationText, replyNumber, text]);
}
