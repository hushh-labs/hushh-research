"use client";

/** Cross-owner signal for invalidating the in-memory Chat history snapshot. */
export const AGENT_CHAT_HISTORY_INVALIDATED_EVENT =
  "agent-chat-history-invalidated";

export function dispatchAgentChatHistoryInvalidated(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  window.dispatchEvent(
    new CustomEvent(AGENT_CHAT_HISTORY_INVALIDATED_EVENT, {
      detail: { userId },
    }),
  );
}
