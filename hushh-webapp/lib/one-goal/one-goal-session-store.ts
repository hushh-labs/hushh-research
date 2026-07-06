"use client";

import { create } from "zustand";

import type { OneGoalEvent, OneGoalSession, OneGoalState } from "@/lib/one-goal/one-goal-types";

type OneGoalSessionStore = {
  sessions: OneGoalSession[];
  activeSessionId: string | null;
  startSession: (input: {
    goalId: string;
    actionId: string;
    slots: Record<string, unknown>;
  }) => OneGoalSession;
  appendEvent: (sessionId: string, event: Omit<OneGoalEvent, "id" | "createdAtMs">) => void;
  updateSession: (
    sessionId: string,
    patch: Partial<Pick<OneGoalSession, "state" | "result">>
  ) => void;
  clearCompleted: () => void;
};

function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

function nowMs(): number {
  return Date.now();
}

export const useOneGoalSessionStore = create<OneGoalSessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  startSession: ({ goalId, actionId, slots }) => {
    const timestamp = nowMs();
    const session: OneGoalSession = {
      id: createId("one_goal"),
      goalId,
      actionId,
      state: "started",
      slots,
      events: [],
      result: null,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    };
    set((state) => ({
      activeSessionId: session.id,
      sessions: [...state.sessions, session].slice(-20),
    }));
    return session;
  },
  appendEvent: (sessionId, event) => {
    const timestamp = nowMs();
    const normalized: OneGoalEvent = {
      ...event,
      id: createId("goal_event"),
      createdAtMs: timestamp,
    };
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              state: event.state as OneGoalState,
              events: [...session.events, normalized].slice(-80),
              updatedAtMs: timestamp,
            }
          : session
      ),
    }));
  },
  updateSession: (sessionId, patch) => {
    const timestamp = nowMs();
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              ...patch,
              updatedAtMs: timestamp,
            }
          : session
      ),
    }));
  },
  clearCompleted: () => {
    set((state) => ({
      sessions: state.sessions.filter(
        (session) => !["completed", "failed", "blocked"].includes(session.state)
      ),
    }));
  },
}));
