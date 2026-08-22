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

/** A screen change crossfades; a query-owned workspace selection commits in place. */
export type NavigationTransitionMode = "full" | "contextual";

/**
 * The sole app-shell lifecycle signal shared by React consumers. This carries
 * no route, credential, vault, or transcript information.
 */
export type AppLifecycleState = "active" | "background";

export type AppLifecycleSnapshot = {
  state: AppLifecycleState;
  revision: number;
  occurredAtMs: number;
};

export type InteractionIntent = {
  id: string;
  source: InteractionIntentSource;
  kind: InteractionIntentKind;
  target: string | null;
  transitionMode: NavigationTransitionMode | null;
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
  | { state: "duplicate"; settlement: DirectiveSettlement | null }
  | { state: "conflict" };

/**
 * A public, user-facing action lifecycle. This deliberately carries only
 * product status supplied by deterministic client events. It is never a
 * representation of a model's private reasoning or unredacted action slots.
 */
export type ActionRunPhase =
  | "acknowledged"
  | "preparing"
  | "navigating"
  | "executing"
  | "awaiting_confirmation"
  | "completed"
  | "blocked"
  | "cancelled"
  | "failed";

export type ActionRun = {
  id: string;
  actionId: string;
  label: string;
  source: InteractionIntentSource;
  directiveId: string | null;
  /**
   * The authored journey/goal this run belongs to, when the directive that
   * started it named one. Two runs sharing a `goalId` are steps of the same
   * multi-action task (e.g. a navigate step and the local-handler step it
   * escorts) -- this is the only thing that ties them together, since each
   * step still arrives as its own directive and its own run.
   */
  goalId: string | null;
  phase: ActionRunPhase;
  message: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
};

export type DirectiveSettlement = {
  status: "succeeded" | "started" | "failed" | "blocked" | "invalid" | "noop";
  summary: string;
  reason?: string | null;
  routeAfter?: string | null;
  screenAfter?: string | null;
  /**
   * Redacted destination-screen snapshot acknowledged on this voice session
   * before the directive settlement was sent. It is never raw route context.
   */
  destinationContextId?: string | null;
};

type VoiceLeaseRecord = {
  id: string;
  owner: string;
  intentId: string;
  onRevoked: (reason: string) => void;
};

type DirectiveRecord = {
  fingerprint: string;
  settledAtMs: number | null;
  settlement: DirectiveSettlement | null;
};

type NavigationRecord = {
  intent: InteractionIntent;
  cancel: (reason: string) => void;
};

const MAX_DIRECTIVES_PER_SESSION = 96;
const MAX_FINISHED_INTENTS = 40;

/**
 * How long a repeat request for the same destination counts as a duplicate of
 * the one already in flight.
 *
 * Coalescing exists so a double-tap schedules one commit rather than two, and
 * that is all it is for. It used to have no bound, which turned it into a
 * permanent lock: a navigation only clears itself when the app reports the new
 * route has settled, and if that report never arrived the record stayed active
 * forever and silently swallowed every later tap to the same destination — the
 * "back button does nothing, no matter how many times I press it" deadlock.
 *
 * Past this window a repeat request is not a stutter, it is the person telling
 * us the first attempt did not happen. Answer it.
 */
const NAVIGATION_COALESCE_WINDOW_MS = 400;

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
  private actionRuns: ActionRun[] = [];
  private listeners = new Set<() => void>();
  private lifecycleListeners = new Set<() => void>();
  private snapshot: readonly InteractionIntent[] = immutableSnapshot([]);
  private actionRunSnapshot: readonly ActionRun[] = Object.freeze([]);
  private lifecycleSnapshot: Readonly<AppLifecycleSnapshot> = Object.freeze({
    state: "active",
    revision: 0,
    occurredAtMs: 0,
  });

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly InteractionIntent[] => this.snapshot;

  getActionRunsSnapshot = (): readonly ActionRun[] => this.actionRunSnapshot;

  subscribeLifecycle = (listener: () => void): (() => void) => {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  };

  getLifecycleSnapshot = (): Readonly<AppLifecycleSnapshot> =>
    this.lifecycleSnapshot;

  getActiveActionRun = (): ActionRun | null => {
    for (let index = this.actionRuns.length - 1; index >= 0; index -= 1) {
      const run = this.actionRuns[index];
      if (run && !isTerminalActionRunPhase(run.phase)) return run;
    }
    return null;
  };

  startActionRun(input: {
    actionId: string;
    label: string;
    source: InteractionIntentSource;
    directiveId?: string | null;
    goalId?: string | null;
    phase?: Extract<ActionRunPhase, "acknowledged" | "preparing">;
    message?: string;
  }): ActionRun {
    const existing = input.directiveId
      ? this.actionRuns.find(
          (run) =>
            run.directiveId === input.directiveId &&
            !isTerminalActionRunPhase(run.phase),
        )
      : null;
    if (existing) return existing;
    const phase = input.phase ?? "acknowledged";
    const now = Date.now();
    const run: ActionRun = {
      id: createId("action_run"),
      actionId: input.actionId,
      label: input.label,
      source: input.source,
      directiveId: input.directiveId ?? null,
      goalId: input.goalId ?? null,
      phase,
      message: input.message ?? actionRunMessage(phase, input.label),
      createdAtMs: now,
      updatedAtMs: now,
      completedAtMs: null,
    };
    this.actionRuns = [...this.actionRuns, run].slice(-MAX_FINISHED_INTENTS);
    this.publish();
    return run;
  }

  updateActionRun(
    runId: string,
    input: {
      phase: ActionRunPhase;
      message?: string;
    },
  ): ActionRun | null {
    let updated: ActionRun | null = null;
    this.actionRuns = this.actionRuns.map((run) => {
      if (run.id !== runId || isTerminalActionRunPhase(run.phase)) return run;
      const terminal = isTerminalActionRunPhase(input.phase);
      updated = {
        ...run,
        phase: input.phase,
        message: input.message ?? actionRunMessage(input.phase, run.label),
        updatedAtMs: Date.now(),
        completedAtMs: terminal ? Date.now() : null,
      };
      return updated;
    });
    if (updated) this.publish();
    return updated;
  }

  finishActionRunFromSettlement(
    runId: string,
    settlement: DirectiveSettlement,
  ): ActionRun | null {
    const phase: Extract<ActionRunPhase, "completed" | "blocked" | "failed"> =
      settlement.status === "succeeded" || settlement.status === "started"
        ? "completed"
        : settlement.status === "blocked" || settlement.status === "noop"
          ? "blocked"
          : "failed";
    return this.updateActionRun(runId, {
      phase,
      message: settlement.summary,
    });
  }

  /**
   * Test-only. `cancelActiveActionRuns` marks runs terminal but keeps them in
   * the rolling history for grouping (e.g. `VoiceWalkthroughPanel`), so a
   * suite that starts real runs against the shared singleton needs a genuine
   * wipe between tests -- otherwise a later test's runs land inside the
   * still-recent grouping window of an earlier test's.
   */
  resetActionRunsForTests(): void {
    this.actionRuns = [];
    this.publish();
  }

  cancelActiveActionRuns(message = "Action cancelled"): void {
    let changed = false;
    const now = Date.now();
    this.actionRuns = this.actionRuns.map((run) => {
      if (isTerminalActionRunPhase(run.phase)) return run;
      changed = true;
      return {
        ...run,
        phase: "cancelled",
        message,
        updatedAtMs: now,
        completedAtMs: now,
      };
    });
    if (changed) this.publish();
  }

  requestNavigation(input: {
    target: string;
    source: InteractionIntentSource;
    routeRevision?: number | null;
    transitionMode?: NavigationTransitionMode;
    start: (intent: InteractionIntent) => (reason: string) => void;
  }): InteractionIntent {
    const active = this.activeNavigation;
    if (active && this.canCoalesceNavigation(active, input.target)) {
      return active.intent;
    }

    if (active) {
      active.cancel("superseded_by_newer_navigation");
      this.finish(active.intent.id, "superseded", "superseded_by_newer_navigation");
      this.activeNavigation = null;
    }

    const intent = this.addIntent({
      source: input.source,
      kind: "navigation",
      target: input.target,
      transitionMode: input.transitionMode ?? "full",
      routeRevision: input.routeRevision ?? null,
      status: "accepted",
    });
    // Publish the record BEFORE start() runs. Callers mark the navigation
    // committing from inside start(), and a record installed afterwards would
    // carry a stale "accepted" that the coalescing guard above then reads.
    const record: NavigationRecord = { intent, cancel: () => undefined };
    this.activeNavigation = record;
    try {
      record.cancel = input.start(intent);
    } catch (error) {
      if (this.activeNavigation === record) this.activeNavigation = null;
      this.finish(intent.id, "rejected", "navigation_start_failed");
      throw error;
    }
    return intent;
  }

  /**
   * A repeat request folds into the one in flight only while that one is still
   * a live, pre-commit attempt at the same destination. Once it has committed,
   * or once the window has passed, the request is a retry and must navigate.
   */
  private canCoalesceNavigation(
    active: NavigationRecord,
    target: string,
  ): boolean {
    if (active.intent.target !== target) return false;
    if (active.intent.status !== "accepted") return false;
    return Date.now() - active.intent.createdAtMs <= NAVIGATION_COALESCE_WINDOW_MS;
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
      transitionMode: null,
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

  handleLifecycle(state: AppLifecycleState): void {
    if (this.lifecycleSnapshot.state === state) return;
    this.lifecycleSnapshot = Object.freeze({
      state,
      revision: this.lifecycleSnapshot.revision + 1,
      occurredAtMs: Date.now(),
    });
    for (const listener of this.lifecycleListeners) listener();

    if (state === "active") return;
    if (this.activeNavigation) {
      this.cancelNavigation(this.activeNavigation.intent.id, "app_backgrounded");
    }
    // VaultProvider remains the security authority. Backgrounding only ends
    // active capture/playback; it never persists or clears vault material.
    this.cancelActiveActionRuns("Action cancelled because the app was backgrounded");
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
        ? { state: "duplicate", settlement: existing.settlement }
        : { state: "conflict" };
    }
    ledger.set(input.directiveId, {
      fingerprint: input.fingerprint,
      settledAtMs: null,
      settlement: null,
    });
    while (ledger.size > MAX_DIRECTIVES_PER_SESSION) {
      const oldest = ledger.keys().next().value;
      if (!oldest) break;
      ledger.delete(oldest);
    }
    return { state: "new" };
  }

  settleDirective(
    sessionId: string,
    directiveId: string,
    settlement: DirectiveSettlement,
  ): void {
    const record = this.directivesBySession.get(sessionId)?.get(directiveId);
    if (!record || record.settlement) return;
    record.settledAtMs = Date.now();
    record.settlement = Object.freeze({ ...settlement });
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
    // The active record holds its own copy of the intent, and the coalescing
    // guard reads the status off that copy. Rebuilding only the ledger left the
    // record frozen at "accepted" for the whole life of the navigation.
    const active = this.activeNavigation;
    if (active?.intent.id === intentId) {
      active.intent = { ...active.intent, status };
    }
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
    this.actionRunSnapshot = Object.freeze(
      this.actionRuns.map((run) => Object.freeze({ ...run })),
    );
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

export function useActionRuns(): readonly ActionRun[] {
  return useSyncExternalStore(
    appInteractionCoordinator.subscribe,
    appInteractionCoordinator.getActionRunsSnapshot,
    appInteractionCoordinator.getActionRunsSnapshot,
  );
}

export function useActiveActionRun(): ActionRun | null {
  const runs = useActionRuns();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run && !isTerminalActionRunPhase(run.phase)) return run;
  }
  return null;
}

export function isTerminalActionRunPhase(phase: ActionRunPhase): boolean {
  return (
    phase === "completed" ||
    phase === "blocked" ||
    phase === "cancelled" ||
    phase === "failed"
  );
}

function actionRunMessage(phase: ActionRunPhase, label: string): string {
  switch (phase) {
    case "acknowledged":
      return `Preparing ${label}`;
    case "preparing":
      return `Preparing ${label}`;
    case "navigating":
      return `Opening ${label}`;
    case "executing":
      return `Running ${label}`;
    case "awaiting_confirmation":
      return `Confirm ${label}`;
    case "completed":
      return `${label} completed`;
    case "blocked":
      return `${label} needs attention`;
    case "cancelled":
      return `${label} cancelled`;
    case "failed":
      return `${label} could not complete`;
  }
}
