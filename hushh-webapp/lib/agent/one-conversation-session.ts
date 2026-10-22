"use client";

import type { CalendarInvitationHandoff, CalendarAttendanceHandoff } from "@/lib/calendar/calendar-invitation-handoff";
import type { CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import { create } from "zustand";
import { useCallback, useLayoutEffect, useState, type SetStateAction } from "react";
import type { PendingTextAttachment } from "@/lib/agent/large-text-attachment";
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
  calendarSlot?: CalendarSlotHandoff;
  calendarInvitation?: CalendarInvitationHandoff;
  calendarAttendance?: CalendarAttendanceHandoff;
  calendarRequest?: { ownerId: string; request: string; meeting?: { calendar_id: string; event_id: string; expected_account_email: string } };
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

export type OneEntryWelcomeMarker = {
  userId: string;
  kind: "post_setup";
};

type OneConversationSessionState = {
  sessionId: string;
  events: OneConversationMirrorEvent[];
  pendingHandoff: AgentChatHandoff | null;
  pendingEntryWelcome: OneEntryWelcomeMarker | null;
  /** One authoritative, process-only Chat draft; never a native or disk copy. */
  composerDraft: OneComposerDraft | null;
  ensureComposerDraft: (ownerId: string) => void;
  updateComposerDraft: (ownerId: string, context: string, update: (draft: OneComposerDraft) => OneComposerDraft) => void;
  clearComposerDraft: () => void;
  appendMirrorEvent: (event: Omit<OneConversationMirrorEvent, "id" | "createdAtMs"> & {
    id?: string;
    createdAtMs?: number;
  }) => void;
  createHandoff: (handoff: Omit<AgentChatHandoff, "id" | "createdAtMs"> & {
    id?: string;
    createdAtMs?: number;
  }) => AgentChatHandoff;
  consumeHandoff: (id: string) => void;
  queueEntryWelcome: (userId: string) => void;
  consumeEntryWelcome: (userId: string) => void;
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

type OneComposerDraft = {
  ownerId: string;
  context: string;
  input: string;
  attachment: PendingTextAttachment | null;
  expanded: boolean;
};
function emptyComposerDraft(ownerId: string): OneComposerDraft {
  return { ownerId, context: createId("composer"), input: "", attachment: null, expanded: false };
}

export const useOneConversationSession = create<OneConversationSessionState>((set, get) => ({
  sessionId: createSessionId(),
  events: [],
  pendingHandoff: null,
  pendingEntryWelcome: null,
  composerDraft: null,
  ensureComposerDraft: ownerId => {
    if (!ownerId || get().composerDraft?.ownerId === ownerId) return;
    set({ composerDraft: emptyComposerDraft(ownerId) });
  },
  updateComposerDraft: (ownerId, context, update) => {
    const draft = get().composerDraft;
    if (!draft || draft.ownerId !== ownerId || draft.context !== context) return;
    set({ composerDraft: { ...update(draft), ownerId, context } });
  },
  clearComposerDraft: () => set({ composerDraft: null }),
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
  queueEntryWelcome: (userId) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) return;
    set({
      pendingEntryWelcome: { userId: normalizedUserId, kind: "post_setup" },
    });
  },
  consumeEntryWelcome: (userId) => {
    if (get().pendingEntryWelcome?.userId !== userId) return;
    set({ pendingEntryWelcome: null });
  },
  clearSession: () => {
    set({
      sessionId: createSessionId(),
      events: [],
      pendingHandoff: null,
      pendingEntryWelcome: null,
      composerDraft: null,
        });
  },
}));

/** Route remounts use the existing session authority, not a mirrored draft.
 * Embedded and pre-vault intro chats remain local. A withdrawn owner reads no
 * retained contents; local intro editing never admits a native private editor. */
export function useOneComposerDraft(canonical: boolean, unlockedOwnerId: string | null) {
  const retained = useOneConversationSession(state => state.composerDraft);
  const [local, setLocal] = useState(() => emptyComposerDraft("embedded"));
  const owned = canonical && retained?.ownerId === unlockedOwnerId ? retained : null;
  useLayoutEffect(() => {
    if (!canonical) return;
    setLocal(emptyComposerDraft("embedded"));
    const session = useOneConversationSession.getState();
    if (unlockedOwnerId) session.ensureComposerDraft(unlockedOwnerId);
    else session.clearComposerDraft();
    // Route unmount does not retire the authenticated vault session.
  }, [canonical, unlockedOwnerId]);
  const retainsOwnerDraft = canonical && !!unlockedOwnerId;
  const context = retainsOwnerDraft ? owned?.context : local.context;
  const change = useCallback(<K extends "input" | "attachment" | "expanded">(key: K, value: SetStateAction<OneComposerDraft[K]>) => {
    const update = (draft: OneComposerDraft): OneComposerDraft => ({ ...draft,
      [key]: typeof value === "function" ? (value as (previous: OneComposerDraft[K]) => OneComposerDraft[K])(draft[key]) : value });
    if (!canonical || !unlockedOwnerId) {
      setLocal(previous => previous.context === context ? update(previous) : previous);
      return;
    }
    if (unlockedOwnerId && context) useOneConversationSession.getState().updateComposerDraft(unlockedOwnerId, context, update);
  }, [canonical, unlockedOwnerId, context]);
  const setInput = useCallback((value: SetStateAction<string>) => change("input", value), [change]);
  const setAttachment = useCallback((value: SetStateAction<PendingTextAttachment | null>) => change("attachment", value), [change]);
  const setExpanded = useCallback((value: SetStateAction<boolean>) => change("expanded", value), [change]);
  const draft = retainsOwnerDraft ? owned : local;
  return { ready: !canonical || !!owned, context, input: draft?.input ?? "", setInput,
    attachment: draft?.attachment ?? null, setAttachment, expanded: draft?.expanded ?? false, setExpanded };
}
