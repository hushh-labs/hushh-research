export type AgentChatDedupeMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  specialistDirective?: unknown | null;
  streamEvents?: readonly unknown[];
};

export type AgentTurnSubmitLock = {
  current: boolean;
};

function normalizeAgentMessageText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function isAdjacentDuplicateAgentMessage(
  previous: AgentChatDedupeMessage | undefined,
  next: AgentChatDedupeMessage
): boolean {
  if (!previous) return false;
  if (previous.role !== next.role || previous.timestamp !== next.timestamp) return false;
  if (previous.specialistDirective || next.specialistDirective) return false;
  if ((previous.streamEvents?.length ?? 0) > 0 || (next.streamEvents?.length ?? 0) > 0) {
    return false;
  }
  const previousText = normalizeAgentMessageText(previous.text);
  const nextText = normalizeAgentMessageText(next.text);
  return previousText.length > 0 && previousText === nextText;
}

export function dedupeAdjacentAgentMessages<T extends AgentChatDedupeMessage>(
  messages: readonly T[]
): T[] {
  return messages.filter((message, index, current) => {
    return !isAdjacentDuplicateAgentMessage(current[index - 1], message);
  });
}

export function tryAcquireAgentTurnSubmitLock(lock: AgentTurnSubmitLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseAgentTurnSubmitLock(lock: AgentTurnSubmitLock): void {
  lock.current = false;
}
