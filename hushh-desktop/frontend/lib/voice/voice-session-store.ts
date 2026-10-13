import { create } from "zustand";
import type {
  VoiceCancelActiveAnalysisCall,
  VoiceExecuteKaiCommandCall,
  VoiceResumeActiveAnalysisCall,
  VoiceSwitchPersonaCall,
} from "@/lib/voice/voice-types";

export type VoiceDebugStage =
  | "turn"
  | "mic"
  | "stt"
  | "planner"
  | "dispatch"
  | "tts"
  | "ui_fsm";

export type VoiceDebugEvent = {
  id: string;
  turnId: string;
  sessionId: string | null;
  stage: VoiceDebugStage;
  event: string;
  timestamp: string;
  payload?: Record<string, unknown>;
};

export type PendingVoiceConfirmation =
  | {
      kind:
        | "cancel_active_analysis"
        | "execute_kai_command"
        | "resume_active_analysis"
        | "switch_persona";
      toolCall:
        | VoiceCancelActiveAnalysisCall
        | VoiceExecuteKaiCommandCall
        | VoiceResumeActiveAnalysisCall
        | VoiceSwitchPersonaCall;
      prompt: string;
      transcript: string;
      turnId: string | null;
      responseId: string | null;
    }
  | null;

export interface VoiceSessionState {
  lastTranscript: string | null;
  lastToolName: string | null;
  lastTicker: string | null;
  lastResponseKind: string | null;
  lastResponseMessage: string | null;
  lastTurnId: string | null;
  debugEvents: VoiceDebugEvent[];
  pendingConfirmation: PendingVoiceConfirmation;
  setLastVoiceTurn: (payload: {
    transcript: string;
    toolName: string | null;
    ticker?: string | null;
    responseKind?: string | null;
    turnId?: string | null;
  }) => void;
  setLastAssistantReply: (payload: {
    message: string;
    kind?: string | null;
    turnId?: string | null;
  }) => void;
  appendDebugEvent: (event: Omit<VoiceDebugEvent, "id" | "timestamp"> & { timestamp?: string }) => void;
  clearDebugEvents: () => void;
  setPendingConfirmation: (payload: PendingVoiceConfirmation) => void;
  clearVoiceSession: () => void;
}

export const useVoiceSession = create<VoiceSessionState>((set) => ({
  lastTranscript: null,
  lastToolName: null,
  lastTicker: null,
  lastResponseKind: null,
  lastResponseMessage: null,
  lastTurnId: null,
  debugEvents: [],
  pendingConfirmation: null,
  setLastVoiceTurn: ({ transcript, toolName, ticker, responseKind, turnId }) =>
    set({
      lastTranscript: transcript,
      lastToolName: toolName,
      lastTicker: ticker ?? null,
      lastResponseKind: responseKind ?? null,
      lastTurnId: turnId ?? null,
    }),
  setLastAssistantReply: ({ message, kind, turnId }) =>
    set({
      lastResponseMessage: String(message || "").trim() || null,
      lastResponseKind: kind ?? null,
      lastTurnId: turnId ?? null,
    }),
  appendDebugEvent: (event) =>
    set((state) => {
      const timestamp = event.timestamp || new Date().toISOString();
      const next: VoiceDebugEvent = {
        ...event,
        id: `${event.turnId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        timestamp,
      };
      const merged = [...state.debugEvents, next];
      const capped = merged.length > 500 ? merged.slice(merged.length - 500) : merged;
      return {
        debugEvents: capped,
      };
    }),
  clearDebugEvents: () =>
    set({
      debugEvents: [],
    }),
  setPendingConfirmation: (payload) =>
    set({
      pendingConfirmation: payload,
    }),
  clearVoiceSession: () =>
    set({
      lastTranscript: null,
      lastToolName: null,
      lastTicker: null,
      lastResponseKind: null,
      lastResponseMessage: null,
      lastTurnId: null,
      debugEvents: [],
      pendingConfirmation: null,
    }),
}));
