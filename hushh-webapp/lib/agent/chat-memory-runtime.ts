"use client";

import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { SecureDurableResourceService, type DurableVersion } from "@/lib/services/secure-durable-resource-service";
import { DurableResourceError } from "@/lib/services/durable-resource-error";
import { loadMarkdownMemory, replaceChatMarkdownMemory, type ChatMemoryCheckpoint } from "@/lib/pkm/markdown-memory";
import { omitCredentialsFromMemory } from "@/lib/pkm/secret-span-guard";
import { AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT } from "./agent-pkm-auto-save-policy";

export type ChatMemoryMessage = {
  id: string; conversationId: string; role: "user" | "assistant"; content: string;
  /** A whole invocation that used somebody else's grant is ineligible. */
  consentDerived?: boolean;
};
export type ChatMemorySession = {
  userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent?: () => boolean;
};
export type ChatMemoryTrigger = "tokens" | "remember" | "idle" | "new_chat" | "switch";
export type ChatMemoryRewriteInput = {
  currentMarkdown: string; messages: ChatMemoryMessage[]; maxTokens: number;
  signal?: AbortSignal;
};
type Pending = {
  version: 1; editGeneration: number; messages: ChatMemoryMessage[];
  requests: Array<{ requestId: string; inputTokens: number }>;
  /** Source windows withdrawn by an owner edit cannot be reoffered by a snapshot. */
  withdrawn: string[];
};
const RESOURCE = "one_chat_memory_pending.v1";
const MAX_BATCH_CHARS = 192_000;
const MAX_BATCH_MESSAGES = 2048;
const MAX_PENDING_CHARS = 1_000_000;
const key = (message: Pick<ChatMemoryMessage, "conversationId" | "id">) => JSON.stringify([message.conversationId, message.id]);
const emptyCheckpoint = (): ChatMemoryCheckpoint => ({ version: 1, editGeneration: 0, conversations: {}, requests: [] });
const emptyPending = (): Pending => ({ version: 1, editGeneration: 0, messages: [], requests: [], withdrawn: [] });

/** Exact fragments; the id retains their common source and incomplete-source order. */
function sourceParts(message: ChatMemoryMessage, content: string): ChatMemoryMessage[] {
  if (content.length > MAX_PENDING_CHARS) throw new Error("A memory source exceeds the pending storage limit.");
  const parts: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + MAX_BATCH_CHARS);
    // Keep a Unicode character whole when the UTF-16 boundary meets a pair.
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end -= 1;
    parts.push(content.slice(start, end)); start = end;
  }
  return parts.map((part, index) => ({ id: parts.length === 1 ? message.id : `${message.id}:part:${index + 1}/${parts.length}`,
    conversationId: message.conversationId, role: message.role, content: part }));
}

/** One instance per unlocked owner. clear() retires effects and aborts owned preparation. */
export function createChatMemoryRuntime(deps: {
  getSession: () => ChatMemorySession | null;
  rewrite: (input: ChatMemoryRewriteInput) => Promise<{ markdown: string }>;
  tokenThreshold?: number; idleMs?: number; maxTokens?: number;
}) {
  let pending = emptyPending();
  let bound: { session: ChatMemorySession; epoch: number; generation: number } | null = null;
  let generation = 0;
  let loaded = false;
  let version: DurableVersion = { generation: 0, revision: 0 };
  let serial: Promise<unknown> = Promise.resolve();
  let running: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rerun = false;
  let disposed = false;
  let rewriteAbort: AbortController | null = null;
  let inFlightConversations = new Set<string>();
  const withdrawnConversations = new Set<string>();

  const activeSession = (): ChatMemorySession | null => {
    if (disposed || !bound || bound.generation !== generation) return null;
    if (snapshotValidatedAuthSessionOwner()?.userId !== bound.session.userId) return null;
    if (!isVaultSessionEpochCurrent(bound.epoch)) return null;
    const live = deps.getSession();
    if (!live || live.userId !== bound.session.userId || live.vaultKey !== bound.session.vaultKey || !live.vaultOwnerToken) {
      return null;
    }
    if (!(live.isCurrent?.() ?? bound.session.isCurrent?.() ?? true)) return null;
    return live;
  };
  const current = () => activeSession() !== null;
  const assertCurrent = async () => {
    if (!current()) throw new DOMException("Memory session changed.", "AbortError");
  };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const retry = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try { return await work(); }
        catch (error) {
          if (!(error instanceof DurableResourceError) || error.code !== "stale_version" || attempt >= 2) throw error;
          loaded = false;
        }
      }
    };
    const next = serial.catch(() => undefined).then(retry);
    serial = next;
    return next;
  };
  const writePending = async () => {
    const session = activeSession();
    if (!session) throw new DOMException("Memory session changed.", "AbortError");
    // Snapshot before encryption; concurrent arrivals are serialized separately.
    version = await SecureDurableResourceService.write({ ...session, resourceKey: RESOURCE,
      value: structuredClone(pending), expected: version, isCurrent: current });
    await assertCurrent();
  };
  const initialize = async () => {
    if (disposed) throw new DOMException("Memory runtime retired.", "AbortError");
    if (!bound) {
      const session = deps.getSession();
      if (!session) throw new DOMException("Unlock memory first.", "AbortError");
      bound = { session, epoch: snapshotVaultSessionEpoch(), generation };
    }
    const session = activeSession();
    if (!session) throw new DOMException("Memory session changed.", "AbortError");
    if (loaded) return;
    const stored = await SecureDurableResourceService.read<Pending>(session.userId, RESOURCE, session.vaultKey, current);
    await assertCurrent();
    if (stored) {
      const value = stored.value;
      if (value.version !== 1 || !Array.isArray(value.messages) || !Array.isArray(value.requests) ||
        !Array.isArray(value.withdrawn) || !Number.isSafeInteger(value.editGeneration))
        throw new Error("Encrypted memory checkpoint is invalid.");
      pending = value;
      if (withdrawnConversations.size > 0) {
        const removed = pending.messages.filter(m => withdrawnConversations.has(m.conversationId));
        if (removed.length > 0) {
          pending.withdrawn = [...new Set([...pending.withdrawn, ...removed.map(key)])];
          pending.messages = pending.messages.filter(m => !withdrawnConversations.has(m.conversationId));
        }
      }
      version = { generation: stored.generation, revision: stored.revision };
    } else version = await SecureDurableResourceService.version(session.userId, RESOURCE);
    loaded = true;
    if (pending.messages.length > 0 && !timer && !running) {
      scheduleIdle();
    }
  };
  const loadMemory = async (forceRefresh = false) => {
    const session = activeSession();
    if (!session) throw new DOMException("Memory session changed.", "AbortError");
    const memory = await loadMarkdownMemory({ ...session, forceRefresh });
    await assertCurrent();
    if (!memory) throw new Error("Private memory is unavailable.");
    return memory;
  };
  const reconcile = (checkpoint: ChatMemoryCheckpoint) => {
    const messageCount = pending.messages.length, requestCount = pending.requests.length;
    const previousGeneration = pending.editGeneration;
    if (pending.editGeneration !== checkpoint.editGeneration) {
      pending.withdrawn = [...new Set([...pending.withdrawn, ...pending.messages.map(key)])];
      pending.messages = [];
      pending.editGeneration = checkpoint.editGeneration;
    }
    pending.messages = pending.messages.filter(message =>
      !checkpoint.conversations[message.conversationId]?.includes(message.id));
    pending.requests = pending.requests.filter(request => !checkpoint.requests.includes(request.requestId));
    return previousGeneration !== pending.editGeneration || messageCount !== pending.messages.length || requestCount !== pending.requests.length;
  };
  const tokenCount = () => pending.requests.reduce((sum, request) => sum + request.inputTokens, 0);
  const scheduleIdle = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void trigger("idle").catch(() => undefined); }, deps.idleMs ?? 300_000);
  };

  async function registerSnapshot(input: { conversationId: string; messages: readonly ChatMemoryMessage[] }): Promise<void> {
    if (!input.conversationId || withdrawnConversations.has(input.conversationId)) return;
    const added = await enqueue(async () => {
      await initialize();
      if (withdrawnConversations.has(input.conversationId)) return false;
      const memory = await loadMemory();
      const checkpoint = memory.chatMemoryCheckpoint ?? emptyCheckpoint();
      const reconciled = reconcile(checkpoint);
      const seen = new Set([...pending.withdrawn, ...pending.messages.map(key)]);
      const messages = [...pending.messages];
      const previousCount = messages.length;
      for (const message of input.messages) {
        if (message.conversationId !== input.conversationId || withdrawnConversations.has(message.conversationId) ||
          !message.id || message.consentDerived ||
          (message.role !== "user" && message.role !== "assistant") ||
          checkpoint.conversations[message.conversationId]?.includes(message.id) || seen.has(key(message))) continue;
        const content = omitCredentialsFromMemory(message.content).trim();
        if (!content) continue;
        for (const part of sourceParts(message, content)) {
          if (seen.has(key(part)) || checkpoint.conversations[part.conversationId]?.includes(part.id)) continue;
          messages.push(part); seen.add(key(part));
        }
      }
      if (messages.reduce((sum, message) => sum + message.content.length, 0) > MAX_PENDING_CHARS)
        throw new Error("Pending memory is full. Let the current update finish.");
      pending.messages = messages;
      if (messages.length > previousCount || reconciled) await writePending();
      return messages.length > previousCount;
    });
    if (added) {
      scheduleIdle();
      if (tokenCount() >= (deps.tokenThreshold ?? 12_000)) void trigger("tokens").catch(() => undefined);
    }
  }

  async function withdrawConversation(conversationId: string): Promise<void> {
    if (!conversationId || disposed) return;
    withdrawnConversations.add(conversationId);
    const immediateRemoved = pending.messages.filter(message => message.conversationId === conversationId);
    if (immediateRemoved.length > 0) {
      pending.withdrawn = [...new Set([...pending.withdrawn, ...immediateRemoved.map(key)])];
      pending.messages = pending.messages.filter(message => message.conversationId !== conversationId);
      if (pending.messages.length === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    if (inFlightConversations.has(conversationId)) {
      rerun = pending.messages.length > 0;
      rewriteAbort?.abort();
    }
    await enqueue(async () => {
      await initialize();
      const hydratedRemoved = pending.messages.filter(message => message.conversationId === conversationId);
      if (hydratedRemoved.length > 0) {
        pending.withdrawn = [...new Set([...pending.withdrawn, ...hydratedRemoved.map(key)])];
        pending.messages = pending.messages.filter(message => message.conversationId !== conversationId);
      }
      if (immediateRemoved.length > 0 || hydratedRemoved.length > 0) {
        await writePending();
      }
      if (pending.messages.length === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
  }

  function peekPendingMessages(excludeConversationId?: string): readonly ChatMemoryMessage[] {
    if (!current()) return [];
    return pending.messages.filter(message =>
      !withdrawnConversations.has(message.conversationId) &&
      (!excludeConversationId || message.conversationId !== excludeConversationId),
    );
  }

  async function recordUsage(input: { requestId: string; inputTokens: number }): Promise<void> {
    if (!input.requestId || !Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0) return;
    await enqueue(async () => {
      await initialize();
      const memory = await loadMemory();
      const checkpoint = memory.chatMemoryCheckpoint ?? emptyCheckpoint();
      const reconciled = reconcile(checkpoint);
      if (checkpoint.requests.includes(input.requestId)) { if (reconciled) await writePending(); return; }
      const prior = pending.requests.find(request => request.requestId === input.requestId);
      if (prior?.inputTokens === input.inputTokens && !reconciled) return;
      if (prior) prior.inputTokens = input.inputTokens;
      else pending.requests.push({ ...input });
      await writePending();
    });
    if (tokenCount() >= (deps.tokenThreshold ?? 12_000)) void trigger("tokens").catch(() => undefined);
  }

  async function consolidate(): Promise<boolean> {
    // Each retry runs the model against the latest exact document. No stale append.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await enqueue(async () => {
        await initialize();
        const memory = await loadMemory(true);
        const checkpoint = memory.chatMemoryCheckpoint ?? emptyCheckpoint();
        if (reconcile(checkpoint)) await writePending();
        let chars = 0;
        const messages: ChatMemoryMessage[] = [];
        for (const message of pending.messages) {
          if (messages.length >= MAX_BATCH_MESSAGES || chars + message.content.length > MAX_BATCH_CHARS) break;
          messages.push({ ...message }); chars += message.content.length;
        }
        return { memory, checkpoint: structuredClone(checkpoint), messages,
          requests: structuredClone(pending.requests), coversWindow: messages.length === pending.messages.length };
      });
      if (!snapshot.messages.length) return false;
      rewriteAbort = new AbortController();
      inFlightConversations = new Set(snapshot.messages.map(message => message.conversationId));
      let proposed: { markdown: string };
      try {
        proposed = await deps.rewrite({ currentMarkdown: snapshot.memory.markdown,
          messages: snapshot.messages, maxTokens: deps.maxTokens ?? 24_000, signal: rewriteAbort.signal });
      } finally {
        rewriteAbort = null;
        inFlightConversations = new Set();
      }
      await assertCurrent();
      if (snapshot.messages.some(message => withdrawnConversations.has(message.conversationId))) {
        continue;
      }
      if (!proposed || typeof proposed.markdown !== "string" || !proposed.markdown.trim())
        throw new Error("Memory preparation returned no document.");
      const checkpoint = structuredClone(snapshot.checkpoint);
      for (const message of snapshot.messages) checkpoint.conversations[message.conversationId] =
        [...new Set([...(checkpoint.conversations[message.conversationId] ?? []), message.id])];
      // Token progress covers only this successful source batch. If another
      // source batch remains, retain its accounting until it is processed too.
      if (snapshot.coversWindow) checkpoint.requests = [...new Set([...checkpoint.requests, ...snapshot.requests.map(request => request.requestId)])];
      const session = activeSession();
      if (!session) throw new DOMException("Memory session changed.", "AbortError");
      const result = await replaceChatMarkdownMemory({ ...session, markdown: proposed.markdown,
        expectedMarkdown: snapshot.memory.markdown, expectedPersisted: snapshot.memory.persisted,
        expectedCheckpoint: snapshot.checkpoint, checkpoint,
        confirmation: { authorizationMode: "product_default_auto_save_policy", surface: "chat",
          source: "agent_chat_product_default_auto_save", autoSavePolicyVersion: 1,
          productDefaultEffectiveAt: AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT },
        beforeEffect: assertCurrent });
      await assertCurrent();
      if (result.conflict) continue;
      if (!result.success) return false;
      await enqueue(async () => {
        const latest = await loadMemory(true);
        reconcile(latest.chatMemoryCheckpoint ?? emptyCheckpoint());
        await writePending();
      });
      // Bounded prefixes drain without another UI or timer trigger.
      rerun ||= !snapshot.coversWindow;
      return true;
    }
    return false;
  }

  function trigger(_reason: ChatMemoryTrigger): Promise<boolean> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) { rerun = true; return running; }
    running = (async () => {
      let wrote = false;
      do { rerun = false; wrote = await consolidate() || wrote; } while (rerun && current());
      return wrote;
    })().catch((error: unknown) => {
      if (current()) console.warn("[ChatMemory] rewrite_not_committed");
      throw error;
    }).finally(() => {
      running = null;
      // A failed explicit/token run must not consume its one idle retry.
      if (current() && pending.messages.length && !timer) scheduleIdle();
    });
    return running;
  }

  function clear(): void {
    disposed = true;
    rewriteAbort?.abort(); rewriteAbort = null;
    inFlightConversations = new Set();
    withdrawnConversations.clear();
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = undefined; bound = null; loaded = false; pending = emptyPending(); rerun = false;
  }
  return { registerSnapshot, withdrawConversation, peekPendingMessages, recordUsage, trigger, activity: scheduleIdle, clear };
}
