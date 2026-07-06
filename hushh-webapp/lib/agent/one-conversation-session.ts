"use client";

import { create } from "zustand";

export type OneConversationMirrorEvent = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  source: "gemini_live" | "one_voice_orchestrator" | "agent_chat";
  turnId?: string | null;
  actionId?: string | null;
  resultSummary?: string | null;
  createdAtMs: number;
};

export type AgentChatHandoffReason =
  | "user_requested"
  | "action_requires_chat"
  | "sensitive_action"
  | "long_running"
  | "manual_only"
  | "delegated_action";

export type AgentChatHandoff = {
  id: string;
  reason: AgentChatHandoffReason;
  transcript?: string | null;
  assistantText?: string | null;
  actionId?: string | null;
  resultSummary?: string | null;
  createdAtMs: number;
};

type OneConversationSessionState = {
  sessionId: string;
  events: OneConversationMirrorEvent[];
  pendingHandoff: AgentChatHandoff | null;
  appendMirrorEvent: (event: Omit<OneConversationMirrorEvent, "id" | "createdAtMs"> & {
    id?: string;
    createdAtMs?: number;
  }) => void;
  createHandoff: (handoff: Omit<AgentChatHandoff, "id" | "createdAtMs"> & {
    id?: string;
    createdAtMs?: number;
  }) => AgentChatHandoff;
  consumeHandoff: (id: string) => void;
  clearSession: () => void;
};

function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

function createSessionId(): string {
  return createId("one_conv");
}

export const useOneConversationSession = create<OneConversationSessionState>((set, get) => ({
  sessionId: createSessionId(),
  events: [],
  pendingHandoff: null,
  appendMirrorEvent: (event) => {
    const text = event.text.trim();
    if (!text) return;
    set((state) => ({
      events: [
        ...state.events,
        {
          ...event,
          text,
          id: event.id ?? createId("mirror"),
          createdAtMs: event.createdAtMs ?? Date.now(),
        },
      ].slice(-40),
    }));
  },
  createHandoff: (handoff) => {
    const next: AgentChatHandoff = {
      ...handoff,
      id: handoff.id ?? createId("handoff"),
      createdAtMs: handoff.createdAtMs ?? Date.now(),
    };
    set({ pendingHandoff: next });
    return next;
  },
  consumeHandoff: (id) => {
    if (get().pendingHandoff?.id !== id) return;
    set({ pendingHandoff: null });
  },
  clearSession: () => {
    set({
      sessionId: createSessionId(),
      events: [],
      pendingHandoff: null,
    });
  },
}));
