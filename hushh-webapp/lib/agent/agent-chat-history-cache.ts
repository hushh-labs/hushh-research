"use client";

import {
  getAgentChatHistory,
  listAgentChatConversations,
  type AgentChatConversation,
  type AgentChatHistoryList,
  type AgentChatMessage,
} from "@/lib/services/agent-chat-client";
import {
  trackCacheResourceResolved,
  trackWarmupCompleted,
} from "@/lib/observability/client";
import { AGENT_CHAT_HISTORY_INVALIDATED_EVENT } from "@/lib/agent/agent-chat-history-events";
import {
  snapshotValidatedAuthSessionOwner,
  subscribeAuthSessionGeneration,
} from "@/lib/auth/session-owner";
import {
  canSealOwnerUiCache,
  deleteEncryptedOwnerUiRecords,
  deleteEncryptedOwnerUiRecordsExceptOwner,
  readEncryptedOwnerUiRecord,
  writeEncryptedOwnerUiRecord,
} from "@/lib/storage/encrypted-owner-ui-cache";

const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const CONVERSATION_LIMIT = 20;
const MESSAGE_LIMIT = 30;
const PERSISTED_MESSAGE_CAP = MESSAGE_LIMIT * 2;
const CHAT_HISTORY_IDB_NAMESPACE = "chat-history:v1";

type ConversationPaginationState = {
  hasMore: boolean;
  oldestCursor: string | null;
};

type AgentChatHistoryCacheEntry = {
  conversations: AgentChatConversation[];
  messagesByConversation: Map<string, AgentChatMessage[]>;
  paginationByConversation?: Map<string, ConversationPaginationState>;
  locationRepliesByConversation?: Map<string, AgentChatMessage[]>;
  cachedAt: number;
};

type PersistedAgentChatHistoryEntry = {
  conversations: AgentChatConversation[];
  messagesByConversation: Record<string, AgentChatMessage[]>;
  paginationByConversation?: Record<string, ConversationPaginationState>;
  locationRepliesByConversation?: Record<string, AgentChatMessage[]>;
};

export type AgentChatHistorySnapshot = {
  ownerId: string;
  cacheGeneration: string;
  conversations: AgentChatConversation[];
  latestConversationId: string | null;
  latestMessages: AgentChatMessage[];
  isFresh: boolean;
};

const entriesByUser = new Map<string, AgentChatHistoryCacheEntry>();
const warmupsByUser = new Map<string, Promise<AgentChatHistorySnapshot>>();
const hydrationsByUser = new Map<string, Promise<AgentChatHistorySnapshot | null>>();
const historyLoadsByKey = new Map<string, Promise<AgentChatMessage[]>>();
const generationByUser = new Map<string, number>();
let globalGeneration = 0;

if (typeof window !== "undefined") {
  window.addEventListener(AGENT_CHAT_HISTORY_INVALIDATED_EVENT, (event) => {
    const detail = (event as CustomEvent<{ userId?: unknown }>).detail;
    const userId = typeof detail?.userId === "string" ? detail.userId : "";
    if (userId) clearAgentChatHistoryCache(userId, { includeDevice: false });
  });
  subscribeAuthSessionGeneration(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner?.userId) {
      // Pending auth or reload before principal validation clears only RAM.
      clearAgentChatHistoryCache(undefined, { includeDevice: false });
      return;
    }
    const staleOwners = new Set([
      ...entriesByUser.keys(),
      ...warmupsByUser.keys(),
    ]);
    for (const userId of staleOwners) {
      if (userId !== owner.userId) {
        clearAgentChatHistoryCache(userId, { includeDevice: true });
      }
    }
    void deleteEncryptedOwnerUiRecordsExceptOwner(owner.userId);
  });
}

function generationFor(userId: string): string {
  return `${globalGeneration}:${generationByUser.get(userId) || 0}`;
}

function assertCurrentGeneration(userId: string, generation: string): void {
  if (generationFor(userId) !== generation) {
    throw new Error("Agent chat history cache was invalidated.");
  }
}

function snapshot(entry: AgentChatHistoryCacheEntry, userId: string): AgentChatHistorySnapshot {
  const latestConversationId = entry.conversations[0]?.id || null;
  return {
    ownerId: userId,
    cacheGeneration: generationFor(userId),
    conversations: [...entry.conversations],
    latestConversationId,
    latestMessages: latestConversationId
      ? [...(entry.messagesByConversation.get(latestConversationId) || [])]
      : [],
    isFresh: Date.now() - entry.cachedAt <= HISTORY_CACHE_TTL_MS,
  };
}

function persistEntryToEncryptedCache(
  userId: string,
  vaultKey: string | undefined,
  entry: AgentChatHistoryCacheEntry,
): void {
  if (!userId || !canSealOwnerUiCache(vaultKey)) return;
  const boundedConversations = entry.conversations.slice(0, CONVERSATION_LIMIT);
  const allowedIds = new Set(boundedConversations.map((item) => item.id));
  const messagesByConversation: Record<string, AgentChatMessage[]> = {};
  for (const [convId, msgs] of entry.messagesByConversation.entries()) {
    if (!allowedIds.has(convId) && boundedConversations.length > 0) continue;
    messagesByConversation[convId] = msgs.slice(-PERSISTED_MESSAGE_CAP);
  }
  const paginationByConversation: Record<string, ConversationPaginationState> = {};
  if (entry.paginationByConversation) {
    for (const [convId, state] of entry.paginationByConversation.entries()) {
      if (convId in messagesByConversation) {
        paginationByConversation[convId] = state;
      }
    }
  }
  const payload: PersistedAgentChatHistoryEntry = {
    conversations: boundedConversations,
    messagesByConversation,
    paginationByConversation,
    ...(entry.locationRepliesByConversation?.size ? { locationRepliesByConversation: Object.fromEntries(
      [...entry.locationRepliesByConversation].filter(([id]) => allowedIds.has(id)).slice(0, CONVERSATION_LIMIT),
    ) } : {}),
  };
  void writeEncryptedOwnerUiRecord({
    ownerId: userId,
    vaultKey,
    namespace: CHAT_HISTORY_IDB_NAMESPACE,
    value: payload,
    updatedAt: entry.cachedAt,
  });
}

export function hydrateAgentChatHistoryFromEncryptedCache(input: {
  userId: string;
  vaultKey: string;
}): Promise<AgentChatHistorySnapshot | null> {
  const existingMem = entriesByUser.get(input.userId);
  if (existingMem) {
    return Promise.resolve(snapshot(existingMem, input.userId));
  }
  if (!input.userId || !canSealOwnerUiCache(input.vaultKey)) {
    return Promise.resolve(null);
  }
  const inFlight = hydrationsByUser.get(input.userId);
  if (inFlight) return inFlight;

  const generation = generationFor(input.userId);
  const task = readEncryptedOwnerUiRecord<PersistedAgentChatHistoryEntry>({
    ownerId: input.userId,
    vaultKey: input.vaultKey,
    namespace: CHAT_HISTORY_IDB_NAMESPACE,
  })
    .then((stored) => {
      if (generationFor(input.userId) !== generation) {
        return peekAgentChatHistoryCache(input.userId);
      }
      const alreadyWarm = entriesByUser.get(input.userId);
      if (alreadyWarm) {
        return snapshot(alreadyWarm, input.userId);
      }
      if (!stored?.value || !Array.isArray(stored.value.conversations)) {
        return null;
      }
      const messagesMap = new Map<string, AgentChatMessage[]>();
      const rawMessages = stored.value.messagesByConversation ?? {};
      for (const [convId, msgs] of Object.entries(rawMessages)) {
        if (Array.isArray(msgs)) {
          messagesMap.set(convId, msgs);
        }
      }
      const paginationMap = new Map<string, ConversationPaginationState>();
      const rawPagination = stored.value.paginationByConversation ?? {};
      for (const [convId, pageState] of Object.entries(rawPagination)) {
        if (pageState && typeof pageState.hasMore === "boolean") {
          paginationMap.set(convId, pageState);
        }
      }
      const hydrated: AgentChatHistoryCacheEntry = {
        conversations: stored.value.conversations,
        messagesByConversation: messagesMap,
        paginationByConversation: paginationMap,
        locationRepliesByConversation: new Map(Object.entries(stored.value.locationRepliesByConversation ?? {})
          .filter(([id, rows]) => messagesMap.has(id) && Array.isArray(rows))
          .map(([id, rows]) => [id, collectLocationReplies(id, [], rows)])),
        // Mark hydrated replica stale so UI renders in <10ms while background
        // pod revalidation silently reconciles any new turns or proactive briefs.
        cachedAt: 0,
      };
      entriesByUser.set(input.userId, hydrated);
      return snapshot(hydrated, input.userId);
    })
    .finally(() => {
      if (hydrationsByUser.get(input.userId) === task) {
        hydrationsByUser.delete(input.userId);
      }
    });

  hydrationsByUser.set(input.userId, task);
  return task;
}

export function peekAgentChatHistoryCache(
  userId: string,
): AgentChatHistorySnapshot | null {
  const entry = entriesByUser.get(userId);
  return entry ? snapshot(entry, userId) : null;
}

export function peekAgentChatConversationMessages(
  userId: string,
  conversationId: string,
): AgentChatMessage[] | null {
  const messages = entriesByUser.get(userId)?.messagesByConversation.get(conversationId);
  return messages ? [...messages] : null;
}

export function upsertAgentChatHistoryConversation(input: {
  userId: string;
  conversationId: string;
  messages: AgentChatMessage[];
  title?: string;
  vaultKey?: string;
}): void {
  const existing = entriesByUser.get(input.userId) ?? {
    conversations: [],
    messagesByConversation: new Map<string, AgentChatMessage[]>(),
    cachedAt: Date.now(),
  };
  const nowIso = new Date().toISOString();
  const prior = existing.conversations.find((item) => item.id === input.conversationId);
  const firstUserTitle = input.messages
    .find((msg) => msg.role === "user" && msg.content.trim().length > 0)
    ?.content.trim()
    .slice(0, 64);
  const updated: AgentChatConversation = {
    id: input.conversationId,
    title: input.title?.trim() || prior?.title || firstUserTitle || "Conversation",
    status: prior?.status || "active",
    model: prior?.model ?? null,
    message_count: input.messages.length,
    created_at: prior?.created_at ?? nowIso,
    updated_at: nowIso,
    last_message_at: nowIso,
  };
  const nextConversations = [
    updated,
    ...existing.conversations.filter((item) => item.id !== input.conversationId),
  ];
  const nextMessagesByConversation = new Map(existing.messagesByConversation);
  nextMessagesByConversation.set(input.conversationId, [...input.messages]);
  const locationRepliesByConversation = new Map(existing.locationRepliesByConversation);
  const replies = collectLocationReplies(input.conversationId, locationRepliesByConversation.get(input.conversationId) ?? [], input.messages);
  if (replies.length) locationRepliesByConversation.set(input.conversationId, replies);
  const nextEntry: AgentChatHistoryCacheEntry = {
    conversations: nextConversations,
    messagesByConversation: nextMessagesByConversation,
    locationRepliesByConversation,
    paginationByConversation: existing.paginationByConversation,
    cachedAt: Date.now(),
  };
  entriesByUser.set(input.userId, nextEntry);
  persistEntryToEncryptedCache(input.userId, input.vaultKey, nextEntry);
}

/** Presentation liveness only; cached history never grants request authority. */
export function isAgentChatHistorySnapshotCurrent(userId: string, value: AgentChatHistorySnapshot): boolean {
  return value.ownerId === userId && value.cacheGeneration === generationFor(userId);
}

export function clearAgentChatHistoryCache(
  userId?: string,
  options?: { includeDevice?: boolean },
): void {
  const includeDevice = options?.includeDevice !== false;
  if (userId) {
    generationByUser.set(userId, (generationByUser.get(userId) || 0) + 1);
    entriesByUser.delete(userId);
    warmupsByUser.delete(userId);
    hydrationsByUser.delete(userId);
    for (const key of historyLoadsByKey.keys()) {
      if (key.startsWith(`${userId}:`)) historyLoadsByKey.delete(key);
    }
    if (includeDevice) {
      void deleteEncryptedOwnerUiRecords(userId, "chat-history:");
    }
    return;
  }
  globalGeneration += 1;
  entriesByUser.clear();
  warmupsByUser.clear();
  hydrationsByUser.clear();
  historyLoadsByKey.clear();
  if (includeDevice) {
    void deleteEncryptedOwnerUiRecords(undefined, "chat-history:");
  }
}

/** Test-only helper simulating tab reload by dropping RAM maps without wiping encrypted storage. */
export function evictInMemoryAgentChatHistoryForTests(userId?: string): void {
  if (userId) {
    entriesByUser.delete(userId);
    warmupsByUser.delete(userId);
    hydrationsByUser.delete(userId);
    return;
  }
  entriesByUser.clear();
  warmupsByUser.clear();
  hydrationsByUser.clear();
}

export function warmAgentChatHistoryCache(input: {
  userId: string;
  vaultOwnerToken: string;
  /** Unlocked vault key; only its derived chat key is sent. */
  vaultKey: string;
  force?: boolean;
}): Promise<AgentChatHistorySnapshot> {
  const cached = entriesByUser.get(input.userId);
  if (!input.force && cached && snapshot(cached, input.userId).isFresh) {
    trackCacheResourceResolved({
      result: "success",
      resourceClass: "realtime_stream",
      cacheTier: "memory",
      freshness: "fresh",
      durationMs: 0,
    });
    return Promise.resolve(snapshot(cached, input.userId));
  }

  const existing = warmupsByUser.get(input.userId);
  if (existing) return existing;

  const startedAt = Date.now();
  const generation = generationFor(input.userId);
  const hydrationPromise =
    !entriesByUser.has(input.userId) && canSealOwnerUiCache(input.vaultKey)
      ? hydrateAgentChatHistoryFromEncryptedCache({
          userId: input.userId,
          vaultKey: input.vaultKey,
        }).catch(() => null)
      : Promise.resolve(null);
  const warmup = listAgentChatConversations({
    userId: input.userId,
    vaultOwnerToken: input.vaultOwnerToken,
    vaultKey: input.vaultKey,
    limit: CONVERSATION_LIMIT,
  })
    .then(async (conversations) => {
      await hydrationPromise;
      assertCurrentGeneration(input.userId, generation);
      const previous = entriesByUser.get(input.userId);
      const messagesByConversation = new Map(previous?.messagesByConversation || []);
      const validIds = new Set(conversations.map((conversation) => conversation.id));
      for (const conversationId of messagesByConversation.keys()) {
        if (!validIds.has(conversationId)) messagesByConversation.delete(conversationId);
      }

      const next: AgentChatHistoryCacheEntry = {
        conversations,
        messagesByConversation,
        paginationByConversation: previous?.paginationByConversation,
        locationRepliesByConversation: new Map([...previous?.locationRepliesByConversation ?? []].filter(([id]) => validIds.has(id))),
        cachedAt: Date.now(),
      };
      entriesByUser.set(input.userId, next);
      persistEntryToEncryptedCache(input.userId, input.vaultKey, next);
      trackWarmupCompleted({
        result: "success",
        resourceClass: "realtime_stream",
        cacheTier: "memory",
        warmPriority: "agent_chat_history",
        durationMs: Date.now() - startedAt,
      });
      // Prefetch at most the single primary conversation on cold cache only.
      // Force-refreshes (for example after a settled turn) must never fire
      // parallel GET /history storms against a single-worker personal pod.
      const primaryConversation =
        conversations.find((item) => item.title.trim().toLowerCase() === "one") ??
        conversations[0];
      if (primaryConversation && !messagesByConversation.has(primaryConversation.id)) {
        // The list is usable as soon as it arrives. Slow transcripts must not
        // hold the entire sidebar in its loading state.
        void loadAgentChatConversationHistory({
          userId: input.userId,
          conversationId: primaryConversation.id,
          vaultOwnerToken: input.vaultOwnerToken,
          vaultKey: input.vaultKey,
          force: false,
        }).catch(() => undefined);
      }
      return snapshot(next, input.userId);
    })
    .catch((error) => {
      trackWarmupCompleted({
        result: "error",
        resourceClass: "realtime_stream",
        cacheTier: "memory",
        warmPriority: "agent_chat_history",
        durationMs: Date.now() - startedAt,
        footprintBucket: "none",
      });
      throw error;
    })
    .finally(() => {
      if (warmupsByUser.get(input.userId) === warmup) {
        warmupsByUser.delete(input.userId);
      }
    });

  warmupsByUser.set(input.userId, warmup);
  return warmup;
}

// Local approvals have no server message ID. Retain a bounded, encrypted
// presentation beside the loaded page, never as a source of execution authority.
function collectLocationReplies(conversationId: string, previous: AgentChatMessage[], latest: AgentChatMessage[]) {
  const retained = new Map<string, AgentChatMessage>();
  for (const row of [...previous, ...latest]) {
    const origin = row.metadata?.locationChatProposal;
    const reply = row.metadata?.locationReplyFor;
    if (row.conversation_id !== conversationId || row.metadata?.consentAccessEnded ||
        (!reply && (!origin || !row.metadata?.locationConversationText))) continue;
    retained.set(origin ? `origin:${origin.id}` : row.id, {
      id: row.id, conversation_id: conversationId, role: row.role, status: row.status, content: row.content,
      ...(row.created_at ? { created_at: row.created_at } : {}), ...(row.completed_at ? { completed_at: row.completed_at } : {}),
      metadata: { ...(origin ? { locationChatProposal: origin } : {}), ...(reply ? { locationReplyFor: reply } : {}),
        ...(row.metadata?.locationConversationText ? { locationConversationText: true } : {}) },
    });
  }
  return [...retained.values()].slice(-PERSISTED_MESSAGE_CAP);
}

// Device permissions and encrypted Location writes settle on the owner's device.
// Preserve its transcript only while this exact proposal still exists in the
// authoritative conversation. Removed or redacted server turns stay removed.
function restoreLocationReplies(server: AgentChatMessage[], local: AgentChatMessage[]) {
  const reviews = new Map(local.flatMap(message => message.metadata?.locationConversationText &&
    message.metadata.locationChatProposal ? [[message.metadata.locationChatProposal.id, message] as const] : []));
  if (!reviews.size) return server;
  return server.flatMap(message => {
    const id = message.metadata?.locationChatProposal?.id;
    const review = id && reviews.get(id);
    if (!review || message.role !== "assistant" || message.metadata?.consentAccessEnded) return [message];
    const replies = local.filter(reply => reply.conversation_id === message.conversation_id && reply.metadata?.locationReplyFor === id);
    return [{ ...message, content: review.content, metadata: { ...message.metadata, locationConversationText: true } }, ...replies];
  });
}

function discardRedactedLocationReplies(local: AgentChatMessage[], page: AgentChatMessage[]) {
  const redactedIds = new Set(page.filter(row => row.metadata?.consentAccessEnded).map(row => row.id));
  if (!redactedIds.size) return local;
  const origins = new Set(local.flatMap(row => redactedIds.has(row.id) && row.metadata?.locationChatProposal
    ? [row.metadata.locationChatProposal.id] : []));
  for (const row of page) {
    if (redactedIds.has(row.id) && row.metadata?.locationChatProposal) origins.add(row.metadata.locationChatProposal.id);
  }
  return local.filter(row => !origins.has(row.metadata?.locationChatProposal?.id ?? row.metadata?.locationReplyFor ?? ""));
}

export async function loadAgentChatConversationHistory(input: {
  userId: string;
  conversationId: string;
  vaultOwnerToken: string;
  /** Unlocked vault key; only its derived chat key is sent. */
  vaultKey: string;
  force?: boolean;
}): Promise<AgentChatMessage[]> {
  const entry = entriesByUser.get(input.userId);
  const cached = entry?.messagesByConversation.get(input.conversationId);
  if (!input.force && cached) return [...cached];

  const loadKey = `${input.userId}:${input.conversationId}`;
  const existing = historyLoadsByKey.get(loadKey);
  if (existing) return existing;

  const generation = generationFor(input.userId);
  const request = getAgentChatHistory({
    conversationId: input.conversationId,
    vaultOwnerToken: input.vaultOwnerToken,
    vaultKey: input.vaultKey,
    limit: MESSAGE_LIMIT,
  })
    .then((messages: AgentChatHistoryList) => {
      assertCurrentGeneration(input.userId, generation);
      const current = entriesByUser.get(input.userId) || {
        conversations: [],
        messagesByConversation: new Map<string, AgentChatMessage[]>(),
        paginationByConversation: new Map<string, ConversationPaginationState>(),
        cachedAt: Date.now(),
      };
      const overlays = current.locationRepliesByConversation ?? new Map<string, AgentChatMessage[]>();
      const local = discardRedactedLocationReplies(collectLocationReplies(input.conversationId,
        overlays.get(input.conversationId) ?? [], current.messagesByConversation.get(input.conversationId) ?? []), messages);
      const transcript = restoreLocationReplies(messages, local);
      current.messagesByConversation.set(input.conversationId, transcript);
      const pageMeta = messages._pageMeta ?? null;
      const paginationMap =
        current.paginationByConversation ?? new Map<string, ConversationPaginationState>();
      paginationMap.set(
        input.conversationId,
        pageMeta ?? {
          hasMore: messages.length >= MESSAGE_LIMIT,
          oldestCursor: messages[0]?.id ?? null,
        },
      );
      current.paginationByConversation = paginationMap;
      const hasOlder = paginationMap.get(input.conversationId)?.hasMore;
      overlays.set(input.conversationId, hasOlder ? local : collectLocationReplies(input.conversationId, [], transcript));
      current.locationRepliesByConversation = overlays;
      entriesByUser.set(input.userId, current);
      persistEntryToEncryptedCache(input.userId, input.vaultKey, current);
      return [...transcript];
    })
    .finally(() => {
      if (historyLoadsByKey.get(loadKey) === request) historyLoadsByKey.delete(loadKey);
    });
  historyLoadsByKey.set(loadKey, request);
  return request;
}

export function peekAgentChatConversationHasMore(
  userId: string,
  conversationId: string,
): boolean {
  const entry = entriesByUser.get(userId);
  const state = entry?.paginationByConversation?.get(conversationId);
  return Boolean(state?.hasMore && state?.oldestCursor);
}

export async function loadOlderAgentChatConversationHistory(input: {
  userId: string;
  conversationId: string;
  vaultOwnerToken: string;
  vaultKey: string;
}): Promise<AgentChatMessage[]> {
  const entry = entriesByUser.get(input.userId);
  const pagination = entry?.paginationByConversation?.get(input.conversationId);
  if (!pagination?.hasMore || !pagination.oldestCursor) {
    return [];
  }
  const before = pagination.oldestCursor;
  const loadKey = `${input.userId}:${input.conversationId}:before:${before}`;
  const existing = historyLoadsByKey.get(loadKey);
  if (existing) return existing;

  const generation = generationFor(input.userId);
  const request = getAgentChatHistory({
    conversationId: input.conversationId,
    vaultOwnerToken: input.vaultOwnerToken,
    vaultKey: input.vaultKey,
    limit: MESSAGE_LIMIT,
    before,
  })
    .then((older: AgentChatHistoryList) => {
      assertCurrentGeneration(input.userId, generation);
      const current = entriesByUser.get(input.userId);
      if (!current) return [];
      const existingMessages = current.messagesByConversation.get(input.conversationId) || [];
      const seenIds = new Set(existingMessages.map((m) => m.id));
      const local = discardRedactedLocationReplies(current.locationRepliesByConversation?.get(input.conversationId) ?? [], older);
      current.locationRepliesByConversation?.set(input.conversationId, local);
      const restored = restoreLocationReplies(older, local);
      const uniqueOlder = restored.filter((m) => !seenIds.has(m.id));
      const combined = [...uniqueOlder, ...existingMessages];
      current.messagesByConversation.set(input.conversationId, combined);

      const pageMeta = older._pageMeta ?? null;
      const paginationMap =
        current.paginationByConversation ?? new Map<string, ConversationPaginationState>();
      paginationMap.set(
        input.conversationId,
        uniqueOlder.length === 0
          ? { hasMore: false, oldestCursor: null }
          : (pageMeta ?? {
              hasMore: older.length >= MESSAGE_LIMIT,
              oldestCursor: uniqueOlder[0]?.id ?? null,
            }),
      );
      current.paginationByConversation = paginationMap;
      if (!paginationMap.get(input.conversationId)?.hasMore) {
        current.locationRepliesByConversation?.set(input.conversationId, collectLocationReplies(input.conversationId, [], combined));
      }
      entriesByUser.set(input.userId, current);
      persistEntryToEncryptedCache(input.userId, input.vaultKey, current);
      return uniqueOlder;
    })
    .finally(() => {
      if (historyLoadsByKey.get(loadKey) === request) historyLoadsByKey.delete(loadKey);
    });
  historyLoadsByKey.set(loadKey, request);
  return request;
}
