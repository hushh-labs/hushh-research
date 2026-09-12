"use client";

import { create } from "zustand";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";
import type { GmailInformationRequestWorkflow } from "@/lib/services/gmail-information-requests-service";

export type OneConversationMirrorEvent = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  source: "location_command" | "agent_chat";
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
  | "delegated_action"
  | "pkm_memory_candidate";

export type GmailInformationRequestHandoff = Pick<
  GmailInformationRequestWorkflow,
  | "workflow_id"
  | "requested_field_labels"
  | "candidate_scopes"
  | "attachment_review_required"
>;

export type AgentChatHandoff = {
  id: string;
  reason: AgentChatHandoffReason;
  transcript?: string | null;
  /** A user-initiated Gmail draft request. It never authorizes delivery. */
  emailDraftInstruction?: string | null;
  /**
   * An active personal-Gmail KYC workflow that must retain its original
   * reply context. This is metadata only; private PKM values and Gmail bodies
   * never travel in the handoff.
   */
  gmailInformationRequest?: GmailInformationRequestHandoff | null;
  assistantText?: string | null;
  actionId?: string | null;
  resultSummary?: string | null;
  specialistDirective?: SpecialistDirectiveEvent | null;
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
