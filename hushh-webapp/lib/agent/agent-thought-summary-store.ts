import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

const MAX_THOUGHT_SUMMARY_CHARS = 16_384;
const MAX_STORED_ENTRIES = 200;

type ThoughtSummaryEntry = {
  ownerId: string;
  vaultEpoch: number;
  conversationId: string;
  text: string;
  updatedAtMs: number;
};

const entriesByKey = new Map<string, ThoughtSummaryEntry>();
let resetSubscribed = false;

function ensureResetSubscription(): void {
  if (resetSubscribed) return;
  resetSubscribed = true;
  subscribeDurableOwnerReset(() => {
    entriesByKey.clear();
  });
}

function makeKey(conversationId: string, messageId: string): string {
  return `${conversationId}::${messageId}`;
}

function pruneIfNeeded(): void {
  while (entriesByKey.size > MAX_STORED_ENTRIES) {
    const oldestKey = entriesByKey.keys().next().value;
    if (typeof oldestKey !== "string") break;
    entriesByKey.delete(oldestKey);
  }
}

/**
 * Append a provider-authored thought summary chunk without gluing multi-step
 * markdown headings onto the end of a previous sentence.
 */
export function appendThinkingSummaryChunk(
  existing: string,
  delta: string,
): string {
  if (!delta) return existing;
  if (!existing) return delta.slice(0, MAX_THOUGHT_SUMMARY_CHARS);
  const needsParagraphBreak =
    !/\s$/.test(existing) &&
    /^\*\*[A-Z0-9]/.test(delta) &&
    /[.!?)]$/.test(existing);
  const combined = needsParagraphBreak
    ? `${existing}\n\n${delta}`
    : `${existing}${delta}`;
  return combined.slice(0, MAX_THOUGHT_SUMMARY_CHARS);
}

export function setAgentThoughtSummary(input: {
  ownerId: string | null | undefined;
  vaultEpoch: number;
  conversationId: string | null | undefined;
  messageId: string | null | undefined;
  serverMessageId?: string | null;
  text: string;
}): void {
  ensureResetSubscription();
  const ownerId = input.ownerId?.trim() ?? "";
  const conversationId = input.conversationId?.trim() ?? "";
  const messageId = input.messageId?.trim() ?? "";
  const cleanText = input.text.slice(0, MAX_THOUGHT_SUMMARY_CHARS);
  if (!ownerId || !conversationId || !messageId || !cleanText.trim()) return;
  const entry: ThoughtSummaryEntry = {
    ownerId,
    vaultEpoch: input.vaultEpoch,
    conversationId,
    text: cleanText,
    updatedAtMs: Date.now(),
  };
  const primaryKey = makeKey(conversationId, messageId);
  entriesByKey.delete(primaryKey);
  entriesByKey.set(primaryKey, entry);
  const serverId = input.serverMessageId?.trim() ?? "";
  if (serverId && serverId !== messageId) {
    const serverKey = makeKey(conversationId, serverId);
    entriesByKey.delete(serverKey);
    entriesByKey.set(serverKey, entry);
  }
  pruneIfNeeded();
}

export function aliasAgentThoughtSummaryServerId(input: {
  conversationId: string | null | undefined;
  messageId: string | null | undefined;
  serverMessageId: string | null | undefined;
}): void {
  ensureResetSubscription();
  const conversationId = input.conversationId?.trim() ?? "";
  const messageId = input.messageId?.trim() ?? "";
  const serverMessageId = input.serverMessageId?.trim() ?? "";
  if (!conversationId || !messageId || !serverMessageId || messageId === serverMessageId) {
    return;
  }
  const existing = entriesByKey.get(makeKey(conversationId, messageId));
  if (!existing) return;
  const serverKey = makeKey(conversationId, serverMessageId);
  entriesByKey.delete(serverKey);
  entriesByKey.set(serverKey, existing);
  pruneIfNeeded();
}

export function deleteAgentThoughtSummary(input: {
  conversationId: string | null | undefined;
  messageId: string | null | undefined;
  serverMessageId?: string | null;
}): void {
  const conversationId = input.conversationId?.trim() ?? "";
  if (!conversationId) return;
  const messageId = input.messageId?.trim() ?? "";
  if (messageId) entriesByKey.delete(makeKey(conversationId, messageId));
  const serverId = input.serverMessageId?.trim() ?? "";
  if (serverId) entriesByKey.delete(makeKey(conversationId, serverId));
}

export function getAgentThoughtSummary(input: {
  conversationId: string | null | undefined;
  messageId: string | null | undefined;
  serverMessageId?: string | null;
}): string | undefined {
  ensureResetSubscription();
  const conversationId = input.conversationId?.trim() ?? "";
  if (!conversationId) return undefined;
  const activeOwner = snapshotValidatedAuthSessionOwner();
  const activeEpoch = snapshotVaultSessionEpoch();
  const candidates = [
    input.serverMessageId?.trim() ?? "",
    input.messageId?.trim() ?? "",
  ].filter(Boolean);

  for (const id of candidates) {
    const key = makeKey(conversationId, id);
    const entry = entriesByKey.get(key);
    if (!entry) continue;
    const ownerMatches = activeOwner
      ? activeOwner.userId === entry.ownerId &&
        isValidatedAuthSessionOwnerCurrent(activeOwner)
      : false;
    if (!ownerMatches || !isVaultSessionEpochCurrent(entry.vaultEpoch) || entry.vaultEpoch !== activeEpoch) {
      entriesByKey.delete(key);
      continue;
    }
    return entry.text;
  }
  return undefined;
}

export function clearAgentThoughtSummariesForTests(): void {
  entriesByKey.clear();
}
