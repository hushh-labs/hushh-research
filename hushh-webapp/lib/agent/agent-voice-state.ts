"use client";

import { create } from "zustand";

import {
  createOneVoiceTransition,
  mapAgentVoiceStatusToOneVoiceState,
  type OneVoiceTransition,
  type OneVoiceUiState,
} from "@/lib/voice/voice-ui-state-machine";

export type AgentVoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "muted"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type AgentVoiceEventOptions = {
  sessionId?: string | null;
  sourceId?: string | null;
  sourceSeq?: number | null;
};

type AgentVoiceState = {
  active: boolean;
  status: AgentVoiceStatus;
  oneVoiceState: OneVoiceUiState;
  lastTransition: OneVoiceTransition | null;
  sessionId: string | null;
  transitionSeq: number;
  sourceSeqById: Record<string, number>;
  level: number;
  message: string | null;
  setActive: (active: boolean, options?: AgentVoiceEventOptions) => void;
  setStatus: (
    status: AgentVoiceStatus,
    message?: string | null,
    options?: AgentVoiceEventOptions
  ) => void;
  setLevel: (level: number) => void;
  reset: () => void;
};

function normalizeSourceId(sourceId: string | null | undefined): string | null {
  const clean = sourceId?.trim();
  return clean || null;
}

function shouldAcceptVoiceEvent(
  state: AgentVoiceState,
  options: AgentVoiceEventOptions | undefined
): boolean {
  const incomingSessionId = options?.sessionId || null;
  if (incomingSessionId && state.sessionId && incomingSessionId !== state.sessionId) {
    return false;
  }

  const sourceId = normalizeSourceId(options?.sourceId);
  const sourceSeq =
    typeof options?.sourceSeq === "number" && Number.isFinite(options.sourceSeq)
      ? options.sourceSeq
      : null;
  if (sourceId && sourceSeq !== null) {
    const lastSeq = state.sourceSeqById[sourceId];
    if (typeof lastSeq === "number" && sourceSeq <= lastSeq) {
      return false;
    }
  }

  return true;
}

function nextSourceSeqById(
  state: AgentVoiceState,
  options: AgentVoiceEventOptions | undefined
): Record<string, number> {
  const sourceId = normalizeSourceId(options?.sourceId);
  const sourceSeq =
    typeof options?.sourceSeq === "number" && Number.isFinite(options.sourceSeq)
      ? options.sourceSeq
      : null;
  if (!sourceId || sourceSeq === null) {
    return state.sourceSeqById;
  }
  return {
    ...state.sourceSeqById,
    [sourceId]: sourceSeq,
  };
}

export const useAgentVoiceState = create<AgentVoiceState>((set) => ({
  active: false,
  status: "idle",
  oneVoiceState: "idle",
  lastTransition: null,
  sessionId: null,
  transitionSeq: 0,
  sourceSeqById: {},
  level: 0,
  message: null,
  setActive: (active, options) =>
    set((state) => {
      if (!shouldAcceptVoiceEvent(state, options)) {
        return state;
      }
      const transitionSeq = state.transitionSeq + 1;
      const nextOneVoiceState = active
        ? state.status === "idle"
          ? "listening"
          : state.oneVoiceState
        : "idle";
      const nextSessionId = active ? options?.sessionId || state.sessionId : null;
      return {
        active,
        status: active ? (state.status === "idle" ? "listening" : state.status) : "idle",
        oneVoiceState: nextOneVoiceState,
        lastTransition: createOneVoiceTransition(
          state.oneVoiceState,
          nextOneVoiceState,
          active ? "voice_active" : "voice_inactive",
          Date.now(),
          {
            transitionSeq,
            sessionId: nextSessionId,
            sourceId: normalizeSourceId(options?.sourceId),
          }
        ),
        sessionId: nextSessionId,
        transitionSeq,
        sourceSeqById: active ? nextSourceSeqById(state, options) : {},
        level: active ? state.level : 0,
        message: active ? state.message : null,
      };
    }),
  setStatus: (status, message = null, options) =>
    set((state) => {
      if (!shouldAcceptVoiceEvent(state, options)) {
        return state;
      }
      const nextOneVoiceState = mapAgentVoiceStatusToOneVoiceState(status);
      const transitionSeq = state.transitionSeq + 1;
      const nextSessionId =
        status === "idle" ? null : options?.sessionId || state.sessionId;
      return {
        status,
        oneVoiceState: nextOneVoiceState,
        lastTransition: createOneVoiceTransition(
          state.oneVoiceState,
          nextOneVoiceState,
          message,
          Date.now(),
          {
            transitionSeq,
            sessionId: nextSessionId,
            sourceId: normalizeSourceId(options?.sourceId),
          }
        ),
        sessionId: nextSessionId,
        transitionSeq,
        sourceSeqById:
          status === "idle" ? {} : nextSourceSeqById(state, options),
        active: status !== "idle",
        message,
        level: status === "idle" ? 0 : state.level,
      };
    }),
  setLevel: (level) => set({ level: Math.max(0, Math.min(1, level)) }),
  reset: () =>
    set((state) => ({
      active: false,
      status: "idle",
      oneVoiceState: "idle",
      lastTransition: createOneVoiceTransition(
        state.oneVoiceState,
        "idle",
        "reset",
        Date.now(),
        {
          transitionSeq: state.transitionSeq + 1,
          sessionId: null,
        }
      ),
      sessionId: null,
      transitionSeq: state.transitionSeq + 1,
      sourceSeqById: {},
      level: 0,
      message: null,
    })),
}));

export function getAgentVoiceStatusLabel(status: AgentVoiceStatus): string {
  switch (status) {
    case "listening":
      return "Listening";
    case "connecting":
      return "Voice connecting";
    case "muted":
      return "Muted";
    case "transcribing":
      return "Transcribing";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "error":
      return "Voice error";
    case "idle":
    default:
      return "Voice idle";
  }
}
