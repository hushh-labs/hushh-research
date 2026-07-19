"use client";

import { useSyncExternalStore } from "react";

export type InteractionIntentSource =
  | "tap"
  | "voice"
  | "search"
  | "native_back"
  | "programmatic";

export type InteractionIntentKind =
  | "navigation"
  | "action"
  | "goal"
  | "voice_session";

export type InteractionIntentStatus =
  | "accepted"
  | "committing"
  | "settling"
  | "settled"
  | "superseded"
  | "cancelled"
  | "rejected";

export type InteractionIntent = {
  id: string;
  source: InteractionIntentSource;
  kind: InteractionIntentKind;
  target: string | null;
  routeRevision: number | null;
  status: InteractionIntentStatus;
  createdAtMs: number;
  completedAtMs: number | null;
  reason: string | null;
};

export type VoiceSessionLease = {
  id: string;
  owner: string;
  isCurrent: () => boolean;
  release: (reason?: string) => void;
};

export type DirectiveLeaseResult =
  | { state: "new" }
  | { state: "duplicate" }
  | { state: "conflict" };

type VoiceLeaseRecord = {
  id: string;
  owner: string;
  intentId: string;
  onRevoked: (reason: string) => void;
};

type DirectiveRecord = {
  fingerprint: string;
  settledAtMs: number | null;
};

type NavigationRecord = {
  intent: InteractionIntent;
  cancel: (reason: string) => void;
};

const MAX_DIRECTIVES_PER_SESSION = 96;
const MAX_FINISHED_INTENTS = 40;

function createId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

function immutableSnapshot(intents: InteractionIntent[]): readonly InteractionIntent[] {
  return Object.freeze(intents.map((intent) => Object.freeze({ ...intent })));
}

/**
 * The interaction coordinator is deliberately not an action router. One/ADK
 * remains the semantic authority; this owns only ownership, cancellation, and
 * observable settlement across React, browser history, and Capacitor events.
 */
export class InteractionIntentCoordinator {
  private activeNavigation: NavigationRecord | null = null;
  private activeVoiceLease: VoiceLeaseRecord | null = null;
  private directivesBySession = new Map<string, Map<string, DirectiveRecord>>();
  private intents: InteractionIntent[] = [];
  private listeners = new Set<() => void>();
  private snapshot: readonly InteractionIntent[] = immutableSnapshot([]);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly InteractionIntent[] => this.snapshot;

  requestNavigation(input: {
    target: string;
    source: InteractionIntentSource;
    routeRevision?: number | null;
    start: (intent: InteractionIntent) => (reason: string) => void;
  }): InteractionIntent {
    const active = this.activeNavigation;
    if (
      active &&
      active.intent.target === input.target &&
      (active.intent.status === "accepted" || active.intent.status === "committing")
    ) {
      return active.intent;
    }

    if (active) {
      active.cancel("superseded_by_newer_navigation");
      this.finish(active.intent.id, "superseded", "superseded_by_newer_navigation");
    }

    const intent = this.addIntent({
      source: input.source,
      kind: "navigation",
      target: input.target,
      routeRevision: input.routeRevision ?? null,
      status: "accepted",
    });
    const cancel = input.start(intent);
    this.activeNavigation = { intent, cancel };
    return intent;
  }

  markNavigationCommitting(intentId: string): void {
    this.transition(intentId, "committing");
  }

  isCurrentNavigation(intentId: string): boolean {
    return this.activeNavigation?.intent.id === intentId;
  }

  settleNavigation(intentId: string, reason: string | null = null): void {
    if (this.activeNavigation?.intent.id === intentId) {
      this.activeNavigation = null;
    }
    this.finish(intentId, "settled", reason);
  }

  cancelNavigation(intentId: string, reason: string): void {
    if (this.activeNavigation?.intent.id === intentId) {
      const active = this.activeNavigation;
      this.activeNavigation = null;
      active.cancel(reason);
    }
    this.finish(intentId, "cancelled", reason);
  }

  acquireVoiceLease(input: {
    owner: string;
    onRevoked: (reason: string) => void;
  }): VoiceSessionLease {
    const previous = this.activeVoiceLease;
    if (previous) {
      this.activeVoiceLease = null;
      this.finish(previous.intentId, "superseded", "superseded_by_newer_voice_session");
      previous.onRevoked("superseded_by_newer_voice_session");
    }
    const intent = this.addIntent({
      source: "voice",
      kind: "voice_session",
      target: input.owner,
      routeRevision: null,
      status: "accepted",
    });
    const record: VoiceLeaseRecord = {
      id: createId("voice"),
      owner: input.owner,
      intentId: intent.id,
      onRevoked: input.onRevoked,
    };
    this.activeVoiceLease = record;
    return {
      id: record.id,
      owner: record.owner,
      isCurrent: () => this.activeVoiceLease?.id === record.id,
      release: (reason = "released") => {
        if (this.activeVoiceLease?.id === record.id) {
          this.activeVoiceLease = null;
          this.finish(record.intentId, "cancelled", reason);
        }
      },
    };
  }

  releaseActiveVoiceLease(reason: string): void {
    const active = this.activeVoiceLease;
    if (!active) return;
    this.activeVoiceLease = null;
    this.finish(active.intentId, "cancelled", reason);
    active.onRevoked(reason);
  }

  handleLifecycle(state: "active" | "background"): void {
    if (state === "active") return;
    if (this.activeNavigation) {
      this.cancelNavigation(this.activeNavigation.intent.id, "app_backgrounded");
    }
    // VaultProvider remains the security authority. Backgrounding only ends
    // active capture/playback; it never persists or clears vault material.
    this.releaseActiveVoiceLease("app_backgrounded");
  }

  beginDirective(input: {
    sessionId: string;
    directiveId: string;
    fingerprint: string;
  }): DirectiveLeaseResult {
    let ledger = this.directivesBySession.get(input.sessionId);
    if (!ledger) {
      ledger = new Map();
      this.directivesBySession.set(input.sessionId, ledger);
    }
    const existing = ledger.get(input.directiveId);
    if (existing) {
      return existing.fingerprint === input.fingerprint
        ? { state: "duplicate" }
        : { state: "conflict" };
    }
    ledger.set(input.directiveId, { fingerprint: input.fingerprint, settledAtMs: null });
    while (ledger.size > MAX_DIRECTIVES_PER_SESSION) {
      const oldest = ledger.keys().next().value;
      if (!oldest) break;
      ledger.delete(oldest);
    }
    return { state: "new" };
  }

  settleDirective(sessionId: string, directiveId: string): void {
    const record = this.directivesBySession.get(sessionId)?.get(directiveId);
    if (record) record.settledAtMs = Date.now();
  }

  private addIntent(input: Omit<InteractionIntent, "id" | "createdAtMs" | "completedAtMs" | "reason">): InteractionIntent {
    const intent: InteractionIntent = {
      ...input,
      id: createId(input.kind),
      createdAtMs: Date.now(),
      completedAtMs: null,
      reason: null,
    };
    this.intents = [...this.intents, intent].slice(-MAX_FINISHED_INTENTS);
    this.publish();
    return intent;
  }

  private transition(intentId: string, status: InteractionIntentStatus): void {
    this.intents = this.intents.map((intent) =>
      intent.id === intentId ? { ...intent, status } : intent,
    );
    this.publish();
  }

  private finish(intentId: string, status: Extract<InteractionIntentStatus, "settled" | "superseded" | "cancelled" | "rejected">, reason: string | null): void {
    this.intents = this.intents.map((intent) =>
      intent.id === intentId
        ? { ...intent, status, reason, completedAtMs: Date.now() }
        : intent,
    );
    this.publish();
  }

  private publish(): void {
    this.snapshot = immutableSnapshot(this.intents);
    for (const listener of this.listeners) listener();
  }
}

export const appInteractionCoordinator = new InteractionIntentCoordinator();

export function useInteractionIntents(): readonly InteractionIntent[] {
  return useSyncExternalStore(
    appInteractionCoordinator.subscribe,
    appInteractionCoordinator.getSnapshot,
    appInteractionCoordinator.getSnapshot,
  );
}
