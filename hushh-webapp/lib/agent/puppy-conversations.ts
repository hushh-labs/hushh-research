import type { AgentChatConversation } from "@/lib/services/agent-chat-client";

const PUPPY_CONVERSATIONS_KEY = "hushh_puppy_conversations";

export function getStoredPuppyConversations(): AgentChatConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PUPPY_CONVERSATIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore storage parse errors
  }
  return [];
}

export function saveStoredPuppyConversations(
  conversations: AgentChatConversation[],
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PUPPY_CONVERSATIONS_KEY,
      JSON.stringify(conversations),
    );
  } catch {
    // Ignore storage write errors
  }
}
