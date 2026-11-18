"use client";

import * as sessionOwnerModule from "@/lib/auth/session-owner";
import * as vaultEpochModule from "@/lib/vault/session-epoch";

export type ActiveAgentTurnSession<TMessage = unknown> = {
  ownerId: string;
  vaultEpoch: number;
  turnToken: symbol;
  conversationId: string | null;
  messages: TMessage[];
  isChatLoading: boolean;
  isStreaming: boolean;
  stoppableTurn: boolean;
  startedAtMs: number;
  abort: ((reason?: string) => void) | null;
  stop: (() => Promise<void>) | null;
};

const sessionsByOwner = new Map<string, ActiveAgentTurnSession<unknown>>();
const listenersByOwner = new Map<string, Set<() => void>>();
let sessionListenersRegistered = false;

function ensureSessionListeners(): void {
  if (sessionListenersRegistered || typeof window === "undefined") return;
  sessionListenersRegistered = true;
  try {
    if (
      Object.prototype.hasOwnProperty.call(
        vaultEpochModule,
        "subscribeVaultSessionEpoch",
      ) &&
      typeof vaultEpochModule.subscribeVaultSessionEpoch === "function"
    ) {
      vaultEpochModule.subscribeVaultSessionEpoch(() => {
        clearActiveAgentTurnSession(undefined, { reason: "vault_epoch_changed" });
      });
    }
  } catch {
    // Ignore partial test mocks of vault epoch module.
  }
  try {
    if (
      Object.prototype.hasOwnProperty.call(
        sessionOwnerModule,
        "subscribeAuthSessionGeneration",
      ) &&
      typeof sessionOwnerModule.subscribeAuthSessionGeneration === "function" &&
      typeof sessionOwnerModule.snapshotValidatedAuthSessionOwner === "function"
    ) {
      sessionOwnerModule.subscribeAuthSessionGeneration(() => {
        const owner = sessionOwnerModule.snapshotValidatedAuthSessionOwner();
        if (!owner?.userId) {
          clearActiveAgentTurnSession(undefined, { reason: "auth_signed_out" });
          return;
        }
        for (const [ownerId] of [...sessionsByOwner.entries()]) {
          if (ownerId !== owner.userId) {
            clearActiveAgentTurnSession(ownerId, { reason: "auth_owner_switched" });
          }
        }
      });
    }
  } catch {
    // Ignore partial test mocks of auth session owner module.
  }
}

function notify(ownerId: string): void {
  const listeners = listenersByOwner.get(ownerId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function peekActiveAgentTurnSession<TMessage = unknown>(
  ownerId: string | null | undefined,
  vaultEpoch: number,
): ActiveAgentTurnSession<TMessage> | null {
  if (!ownerId) return null;
  const entry = sessionsByOwner.get(ownerId);
  if (!entry || entry.ownerId !== ownerId || entry.vaultEpoch !== vaultEpoch) {
    return null;
  }
  return entry as ActiveAgentTurnSession<TMessage>;
}

export function setActiveAgentTurnSession<TMessage = unknown>(
  session: ActiveAgentTurnSession<TMessage>,
): void {
  ensureSessionListeners();
  const previous = sessionsByOwner.get(session.ownerId);
  if (
    previous &&
    previous.turnToken !== session.turnToken &&
    (previous.isChatLoading || previous.isStreaming)
  ) {
    try {
      previous.abort?.("superseded");
    } catch {
      // Ignore abort errors from retired turns.
    }
  }
  sessionsByOwner.set(session.ownerId, session as ActiveAgentTurnSession<unknown>);
  notify(session.ownerId);
}

export function patchActiveAgentTurnSession<TMessage = unknown>(
  ownerId: string,
  turnToken: symbol,
  patch: Partial<
    Omit<ActiveAgentTurnSession<TMessage>, "ownerId" | "vaultEpoch" | "turnToken">
  >,
): void {
  const current = sessionsByOwner.get(ownerId);
  if (!current || current.turnToken !== turnToken) return;
  sessionsByOwner.set(ownerId, {
    ...current,
    ...(patch as Partial<ActiveAgentTurnSession<unknown>>),
  });
  notify(ownerId);
}

export function applyActiveAgentTurnMessages<TMessage = unknown>(
  ownerId: string,
  turnToken: symbol,
  updater: (messages: TMessage[]) => TMessage[],
): TMessage[] | null {
  const current = sessionsByOwner.get(ownerId) as
    | ActiveAgentTurnSession<TMessage>
    | undefined;
  if (!current || current.turnToken !== turnToken) return null;
  const nextMessages = updater(current.messages);
  sessionsByOwner.set(ownerId, {
    ...current,
    messages: nextMessages,
  } as ActiveAgentTurnSession<unknown>);
  notify(ownerId);
  return nextMessages;
}

export function subscribeActiveAgentTurnSession(
  ownerId: string,
  listener: () => void,
): () => void {
  const set = listenersByOwner.get(ownerId) ?? new Set<() => void>();
  set.add(listener);
  listenersByOwner.set(ownerId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listenersByOwner.delete(ownerId);
    }
  };
}

export function clearActiveAgentTurnSession(
  ownerId?: string,
  options: { abort?: boolean; reason?: string } = {},
): void {
  const shouldAbort = options.abort !== false;
  if (ownerId) {
    const entry = sessionsByOwner.get(ownerId);
    if (!entry) return;
    if (shouldAbort && (entry.isChatLoading || entry.isStreaming)) {
      try {
        entry.abort?.(options.reason);
      } catch {
        // Ignore abort errors when clearing turn state.
      }
    }
    sessionsByOwner.delete(ownerId);
    notify(ownerId);
    return;
  }

  for (const [id, entry] of [...sessionsByOwner.entries()]) {
    if (shouldAbort && (entry.isChatLoading || entry.isStreaming)) {
      try {
        entry.abort?.(options.reason);
      } catch {
        // Ignore abort errors when clearing turn state.
      }
    }
    sessionsByOwner.delete(id);
    notify(id);
  }
}

