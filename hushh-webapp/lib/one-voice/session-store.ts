"use client";

/**
 * Shared session store for One Live Voice.
 *
 * Holds the reducer state (see session-types.ts) and a registry of screen
 * effect handlers. The VoiceSessionProvider dispatches server frames into the
 * store; screens subscribe with `useVoiceToolEffects` to react to tool
 * results, resolved confirmations, UI directives, and client steps.
 *
 * Success in the UI is driven ONLY by `tool.result ok:true` and
 * `pending_action.resolved executed`; transcript text never sets state.
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useAgentVoiceState, type AgentVoiceStatus } from "@/lib/agent/agent-voice-state";
import type { ServerFrame, ToolResultPublic } from "@/lib/one-voice/protocol";
import { reduceVoiceSession } from "@/lib/one-voice/session-reducer";
import {
  INITIAL_VOICE_SESSION_STATE,
  type ClientStepView,
  type VoicePhase,
  type VoiceSessionEvent,
  type VoiceSessionState,
  type VoiceToolEffectHandlers,
} from "@/lib/one-voice/session-types";

type EffectRegistry = Map<symbol, VoiceToolEffectHandlers>;

type VoiceSessionStore = {
  state: VoiceSessionState;
  dispatch: (event: VoiceSessionEvent) => void;
  reset: () => void;
  // Effect fan-out (called by the provider after it handles a frame itself).
  effects: EffectRegistry;
  emitToolResult: (tool: string, result: ToolResultPublic) => void;
  emitPendingResolved: (pendingActionId: string, status: string, result: ToolResultPublic | null) => void;
  emitDirective: (
    directiveId: string,
    kind: string,
    payload: Record<string, unknown>,
    settle: (status: "opened" | "failed" | "ignored") => void,
  ) => boolean;
  emitClientStep: (
    step: ClientStepView,
    report: (status: "ok" | "failed", payload?: Record<string, unknown>) => void,
  ) => boolean;
};

const PHASE_TO_STATUS: Record<VoicePhase, AgentVoiceStatus> = {
  idle: "idle",
  connecting: "connecting",
  listening: "listening",
  understanding: "thinking",
  asking: "speaking",
  confirming: "listening",
  executing: "thinking",
  complete: "speaking",
  error: "error",
  paused: "muted",
};

function mirrorToAgentVoiceState(previous: VoiceSessionState, next: VoiceSessionState) {
  const agent = useAgentVoiceState.getState();
  const active = next.phase !== "idle";
  const wasActive = previous.phase !== "idle";
  if (active !== wasActive || active !== agent.active) {
    agent.setActive(active, { sessionId: next.sessionId });
  }
  let status = PHASE_TO_STATUS[next.phase];
  if (next.phase === "listening" && next.muted) status = "muted";
  if ((next.phase === "asking" || next.phase === "complete") && !next.speaking) status = "listening";
  if (status !== agent.status || next.error?.message !== agent.message) {
    agent.setStatus(status, next.error?.message ?? null, { sessionId: next.sessionId });
  }
  if (next.level !== previous.level) agent.setLevel(next.level);
  if (!active && agent.active) agent.reset();
}

export const useVoiceSessionStore = create<VoiceSessionStore>((set, get) => ({
  state: INITIAL_VOICE_SESSION_STATE,
  effects: new Map(),
  dispatch: (event) => {
    const previous = get().state;
    const next = reduceVoiceSession(previous, event);
    if (next === previous) return;
    set({ state: next });
    mirrorToAgentVoiceState(previous, next);
  },
  reset: () => {
    const previous = get().state;
    set({ state: INITIAL_VOICE_SESSION_STATE });
    mirrorToAgentVoiceState(previous, INITIAL_VOICE_SESSION_STATE);
  },
  emitToolResult: (tool, result) => {
    for (const handlers of get().effects.values()) handlers.onToolResult?.(tool, result);
  },
  emitPendingResolved: (pendingActionId, status, result) => {
    for (const handlers of get().effects.values()) handlers.onPendingResolved?.(pendingActionId, status, result);
  },
  emitDirective: (directiveId, kind, payload, settle) => {
    let handled = false;
    for (const handlers of get().effects.values()) {
      if (!handlers.onDirective) continue;
      handled = true;
      handlers.onDirective(directiveId, kind, payload, settle);
    }
    return handled;
  },
  emitClientStep: (step, report) => {
    let handled = false;
    for (const handlers of get().effects.values()) {
      if (!handlers.onClientStep) continue;
      handled = true;
      handlers.onClientStep(step, report);
    }
    return handled;
  },
}));

/** Read the whole session state (re-renders on every change). */
export function useVoiceSessionState(): VoiceSessionState {
  return useVoiceSessionStore((store) => store.state);
}

/** Select a slice of the session state. */
export function useVoiceSessionSelector<T>(selector: (state: VoiceSessionState) => T): T {
  return useVoiceSessionStore((store) => selector(store.state));
}

/**
 * Subscribe a screen to voice effects. Handlers are read through a ref so
 * callers can pass inline closures without re-registering every render.
 */
export function useVoiceToolEffects(handlers: VoiceToolEffectHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const key = Symbol("voice-effects");
    const proxy: VoiceToolEffectHandlers = {
      onToolResult: (tool, result) => ref.current.onToolResult?.(tool, result),
      onPendingResolved: (id, status, result) => ref.current.onPendingResolved?.(id, status, result),
      onDirective: (id, kind, payload, settle) => ref.current.onDirective?.(id, kind, payload, settle),
      onClientStep: (step, report) => ref.current.onClientStep?.(step, report),
    };
    const effects = useVoiceSessionStore.getState().effects;
    effects.set(key, proxy);
    return () => {
      effects.delete(key);
    };
  }, []);
}

/** Convenience for the provider: dispatch one server frame. */
export function dispatchServerFrame(frame: ServerFrame, now = Date.now()): void {
  useVoiceSessionStore.getState().dispatch({ type: "server", frame, now });
}
