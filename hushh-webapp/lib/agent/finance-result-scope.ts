/** Browser-local authority for a selected result; never an owner credential. */
export type FinanceResultScope = {
  ownerId: string | null;
  conversationId: string | null;
  vaultEpoch: number;
  chatEpoch: number;
  messageId: string | undefined;
};

export function isCurrentFinanceResultScope(
  captured: FinanceResultScope,
  current: FinanceResultScope,
): boolean {
  return captured.ownerId !== null && captured.messageId !== undefined &&
    captured.ownerId === current.ownerId &&
    captured.conversationId === current.conversationId &&
    captured.vaultEpoch === current.vaultEpoch &&
    captured.chatEpoch === current.chatEpoch &&
    captured.messageId === current.messageId;
}

/** A new vault epoch may resume only a confirmed unexecuted request. */
export function canRetryFinanceResult(
  retrySafe: boolean,
  ownerId: string,
  task: { userId: string; status: string; completedAt?: string | null; finalDecision?: { finalStatement?: string | null } | null } | null | undefined,
): boolean {
  return retrySafe && Boolean(task && task.userId === ownerId && task.status === "completed" &&
    task.completedAt && task.finalDecision?.finalStatement);
}
