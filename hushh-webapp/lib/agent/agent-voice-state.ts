"use client";

import { create } from "zustand";

export type AgentVoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "muted"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

type AgentVoiceState = {
  active: boolean;
  status: AgentVoiceStatus;
  level: number;
  message: string | null;
  setActive: (active: boolean) => void;
  setStatus: (status: AgentVoiceStatus, message?: string | null) => void;
  setLevel: (level: number) => void;
  reset: () => void;
};

export const useAgentVoiceState = create<AgentVoiceState>((set) => ({
  active: false,
  status: "idle",
  level: 0,
  message: null,
  setActive: (active) =>
    set((state) => ({
      active,
      status: active ? (state.status === "idle" ? "listening" : state.status) : "idle",
      level: active ? state.level : 0,
      message: active ? state.message : null,
    })),
  setStatus: (status, message = null) =>
    set((state) => ({
      status,
      active: status !== "idle",
      message,
      level: status === "idle" ? 0 : state.level,
    })),
  setLevel: (level) => set({ level: Math.max(0, Math.min(1, level)) }),
  reset: () => set({ active: false, status: "idle", level: 0, message: null }),
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
