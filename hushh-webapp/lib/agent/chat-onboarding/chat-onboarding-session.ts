"use client";

/**
 * The session-only store behind One's conversational onboarding.
 *
 * It lives apart from the host hook (`use-chat-onboarding.ts`) so a surface
 * that only reads it, such as One's name label, does not import the setup
 * record or the encrypted-memory writer. `use-chat-onboarding.ts` re-exports it
 * for existing callers.
 */
import { create } from "zustand";

import {
  pickedPreferredName,
  reduceChatOnboarding,
  type ChatOnboardingState,
} from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import type { OneChatOnboardingState } from "@/lib/services/pre-vault-user-state-service";

export type ChatOnboardingSession = {
  userId: string | null;
  /** `undefined` until the durable record was read; `null` means never started. */
  durable: OneChatOnboardingState | null | undefined;
  machine: ChatOnboardingState | null;
  /**
   * Turns already shown, with the time label they were first shown at, so a
   * remount (leaving chat for a connect flow and returning) never re-types a
   * turn or re-stamps it with the wrong time.
   */
  shownTurns: ReadonlyMap<string, string>;
  /**
   * When each turn was first shown (epoch ms). Drives the transcript's
   * centered time separators; kept beside the label so the label stays the
   * exact string the person saw.
   */
  shownTurnTimes: ReadonlyMap<string, number>;
  /**
   * The conversation onboarding happened in, once it has an id. A finished
   * onboarding stays in that conversation; a new chat starts clean.
   */
  homeConversationId: string | null;
  nameRequestId: string | null;
};

const EMPTY_SESSION: ChatOnboardingSession = {
  userId: null,
  durable: undefined,
  machine: null,
  shownTurns: new Map(),
  shownTurnTimes: new Map(),
  homeConversationId: null,
  nameRequestId: null,
};

export const useChatOnboardingSession = create<
  ChatOnboardingSession & {
    reset: (userId: string | null) => void;
    patch: (next: Partial<ChatOnboardingSession>) => void;
    markShown: (turnId: string, timeLabel: string, shownAtMs?: number) => void;
  }
>((set) => ({
  ...EMPTY_SESSION,
  reset: (userId) =>
    set({ ...EMPTY_SESSION, shownTurns: new Map(), shownTurnTimes: new Map(), userId }),
  patch: (next) => set(next),
  markShown: (turnId, timeLabel, shownAtMs) =>
    set((state) =>
      state.shownTurns.has(turnId)
        ? state
        : {
            shownTurns: new Map([...state.shownTurns, [turnId, timeLabel]]),
            shownTurnTimes:
              typeof shownAtMs === "number"
                ? new Map([...state.shownTurnTimes, [turnId, shownAtMs]])
                : state.shownTurnTimes,
          },
    ),
}));

/**
 * The name this owner picked in onboarding that memory does not hold yet.
 * Session-only and owner-scoped, for labels that should not wait for the
 * confirmation at the end; never read it as the saved preferred name.
 */
export function useChatOnboardingPickedName(userId: string | null): string | null {
  return useChatOnboardingSession((session) =>
    userId && session.userId === userId ? pickedPreferredName(session.machine) : null,
  );
}

/** One semantic choice, shared with setup so its later Save cannot undo it. */
export function reconcileChatOnboardingNameChoice(userId: string, name: string): boolean {
  const session = useChatOnboardingSession.getState();
  if (session.userId !== userId || !session.machine) return true;
  if (session.machine.step === "saving" || session.machine.step === "saving_name") return false;
  const next = reduceChatOnboarding(session.machine, { type: "preferred_name_chosen", name });
  if (next.state !== session.machine) session.patch({ machine: next.state });
  return true;
}
