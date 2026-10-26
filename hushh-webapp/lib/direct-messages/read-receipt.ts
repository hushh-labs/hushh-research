export type DirectMessageReadResult = {
  readCount: number;
  readAt: string | null;
};

type ReadReceiptPayload = {
  readCount?: unknown;
  readAt?: unknown;
  readThroughCreatedAt?: unknown;
  readThroughMessageId?: string;
  chatBadgeCount?: number;
  chatBadgeVersion?: number;
};

/** Verify persistence before the caller clears unread state or notifications. */
export function parseDirectMessageReadReceipt(
  payload: ReadReceiptPayload,
): ReadReceiptPayload & DirectMessageReadResult {
  if (!payload || !Number.isSafeInteger(payload.readCount) || Number(payload.readCount) < 0) {
    throw new Error("Read status could not be verified.");
  }
  return {
    ...payload,
    readCount: Number(payload.readCount),
    readAt: typeof payload.readAt === "string" && payload.readAt.trim() ? payload.readAt.trim() : null,
  };
}
