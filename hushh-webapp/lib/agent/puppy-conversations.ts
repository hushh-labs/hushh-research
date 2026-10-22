"use client";

import { useEffect, useState } from "react";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";

/** Private conversation metadata lives only in the authenticated workspace. */
export function usePuppyConversations(ownerId: string | null, active = false) {
  useEffect(() => {
    // Discard only the obsolete, unowned title index. It contained no transcript
    // or recoverable Hermes session and must never be adopted by another owner.
    try {
      window.localStorage.removeItem("hushh_puppy_conversations");
    } catch {}
  }, []);
  const [state, setState] = useState<{
    ownerId: string | null;
    conversations: AgentChatConversation[];
    activeId: string | null;
  }>({ ownerId, conversations: [], activeId: null });
  // Reset before committing a render; effects would briefly expose old rows.
  if (state.ownerId !== ownerId) {
    setState({ ownerId, conversations: [], activeId: null });
  }
  const current =
    state.ownerId === ownerId
      ? state
      : {
          ownerId,
          conversations: [],
          activeId: null,
        };
  // Opening Puppy starts its own empty chat, just as opening One does. Retain
  // the keyed panel across agent switches, and recover after the last deletion.
  useEffect(() => {
    if (!active || !ownerId || current.conversations.length) return;
    const conversation = newConversation();
    setState(previous => previous.ownerId === ownerId && !previous.conversations.length
      ? { ...previous, conversations: [conversation], activeId: conversation.id }
      : previous);
  }, [active, ownerId, current.conversations.length]);
  return {
    conversations: current.conversations,
    activeId: current.activeId,
    create: () => {
      if (!ownerId) return;
      const conversation = newConversation();
      setState((previous) =>
        previous.ownerId === ownerId
          ? {
              ...previous,
              conversations: [conversation, ...previous.conversations],
              activeId: conversation.id,
            }
          : previous,
      );
    },
    select: (id: string) =>
      setState((previous) =>
        previous.ownerId === ownerId &&
        previous.conversations.some((c) => c.id === id)
          ? { ...previous, activeId: id }
          : previous,
      ),
    rename: (id: string, title: string) =>
      setState((previous) =>
        previous.ownerId === ownerId
          ? {
              ...previous,
              conversations: previous.conversations.map((c) =>
                c.id === id ? { ...c, title } : c,
              ),
            }
          : previous,
      ),
    remove: (id: string) =>
      setState((previous) => {
        if (previous.ownerId !== ownerId) return previous;
        const conversations = previous.conversations.filter((c) => c.id !== id);
        return {
          ...previous,
          conversations,
          activeId:
            previous.activeId === id
              ? (conversations[0]?.id ?? null)
              : previous.activeId,
        };
      }),
  };
}

function newConversation(): AgentChatConversation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: "New chat", status: "active",
    message_count: 0, created_at: now, updated_at: now };
}
