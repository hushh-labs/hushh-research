"use client";

import {
  getAgentChatHistory,
  listAgentChatConversations,
  type AgentChatConversation,
  type AgentChatMessage,
} from "@/lib/services/agent-chat-client";
import {
  trackCacheResourceResolved,
  trackWarmupCompleted,
} from "@/lib/observability/client";

const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const CONVERSATION_LIMIT = 20;
const MESSAGE_LIMIT = 50;

type AgentChatHistoryCacheEntry = {
  conversations: AgentChatConversation[];
  messagesByConversation: Map<string, AgentChatMessage[]>;
  cachedAt: number;
};

export type AgentChatHistorySnapshot = {
  conversations: AgentChatConversation[];
  latestConversationId: string | null;
  latestMessages: AgentChatMessage[];
  isFresh: boolean;
};

const entriesByUser = new Map<string, AgentChatHistoryCacheEntry>();
const warmupsByUser = new Map<string, Promise<AgentChatHistorySnapshot>>();
const historyLoadsByKey = new Map<string, Promise<AgentChatMessage[]>>();
const generationByUser = new Map<string, number>();
let globalGeneration = 0;

function generationFor(userId: string): string {
  return `${globalGeneration}:${generationByUser.get(userId) || 0}`;
}

function assertCurrentGeneration(userId: string, generation: string): void {
  if (generationFor(userId) !== generation) {
    throw new Error("Agent chat history cache was invalidated.");
  }
}

function snapshot(entry: AgentChatHistoryCacheEntry): AgentChatHistorySnapshot {
  const latestConversationId = entry.conversations[0]?.id || null;
  return {
    conversations: [...entry.conversations],
    latestConversationId,
    latestMessages: latestConversationId
      ? [...(entry.messagesByConversation.get(latestConversationId) || [])]
      : [],
    isFresh: Date.now() - entry.cachedAt <= HISTORY_CACHE_TTL_MS,
  };
}

export function peekAgentChatHistoryCache(
  userId: string,
): AgentChatHistorySnapshot | null {
  const entry = entriesByUser.get(userId);
  return entry ? snapshot(entry) : null;
}

export function clearAgentChatHistoryCache(userId?: string): void {
  if (userId) {
    generationByUser.set(userId, (generationByUser.get(userId) || 0) + 1);
    entriesByUser.delete(userId);
    warmupsByUser.delete(userId);
    for (const key of historyLoadsByKey.keys()) {
      if (key.startsWith(`${userId}:`)) historyLoadsByKey.delete(key);
    }
    return;
  }
  globalGeneration += 1;
  entriesByUser.clear();
  warmupsByUser.clear();
  historyLoadsByKey.clear();
}

export function warmAgentChatHistoryCache(input: {
  userId: string;
  vaultOwnerToken: string;
  force?: boolean;
}): Promise<AgentChatHistorySnapshot> {
  const cached = entriesByUser.get(input.userId);
  if (!input.force && cached && snapshot(cached).isFresh) {
    trackCacheResourceResolved({
      result: "success",
      resourceClass: "realtime_stream",
      cacheTier: "memory",
      freshness: "fresh",
      durationMs: 0,
    });
    return Promise.resolve(snapshot(cached));
  }

  const existing = warmupsByUser.get(input.userId);
  if (existing) return existing;

  const startedAt = Date.now();
  const generation = generationFor(input.userId);
  const warmup = listAgentChatConversations({
    userId: input.userId,
    vaultOwnerToken: input.vaultOwnerToken,
    limit: CONVERSATION_LIMIT,
  })
    .then(async (conversations) => {
      assertCurrentGeneration(input.userId, generation);
      const previous = entriesByUser.get(input.userId);
      const messagesByConversation = new Map(previous?.messagesByConversation || []);
      const validIds = new Set(conversations.map((conversation) => conversation.id));
      for (const conversationId of messagesByConversation.keys()) {
        if (!validIds.has(conversationId)) messagesByConversation.delete(conversationId);
      }

      const latestConversationId = conversations[0]?.id;
      if (latestConversationId) {
        const latestMessages = await getAgentChatHistory({
          conversationId: latestConversationId,
          vaultOwnerToken: input.vaultOwnerToken,
          limit: MESSAGE_LIMIT,
        });
        assertCurrentGeneration(input.userId, generation);
        messagesByConversation.set(latestConversationId, latestMessages);
      }

      const next: AgentChatHistoryCacheEntry = {
        conversations,
        messagesByConversation,
        cachedAt: Date.now(),
      };
      entriesByUser.set(input.userId, next);
      trackWarmupCompleted({
        result: "success",
        resourceClass: "realtime_stream",
        cacheTier: "memory",
        warmPriority: "agent_chat_history",
        durationMs: Date.now() - startedAt,
      });
      return snapshot(next);
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

export async function loadAgentChatConversationHistory(input: {
  userId: string;
  conversationId: string;
  vaultOwnerToken: string;
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
    limit: MESSAGE_LIMIT,
  })
    .then((messages) => {
      assertCurrentGeneration(input.userId, generation);
      const current = entriesByUser.get(input.userId) || {
        conversations: [],
        messagesByConversation: new Map<string, AgentChatMessage[]>(),
        cachedAt: Date.now(),
      };
      current.messagesByConversation.set(input.conversationId, messages);
      entriesByUser.set(input.userId, current);
      return [...messages];
    })
    .finally(() => {
      if (historyLoadsByKey.get(loadKey) === request) historyLoadsByKey.delete(loadKey);
    });
  historyLoadsByKey.set(loadKey, request);
  return request;
}
