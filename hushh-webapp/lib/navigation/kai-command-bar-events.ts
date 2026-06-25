"use client";

export const KAI_COMMAND_BAR_OPEN_EVENT = "kai:command-bar:open";
export const KAI_COMMAND_BAR_TOGGLE_EVENT = "kai:command-bar:toggle";

export function openKaiCommandBar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(KAI_COMMAND_BAR_OPEN_EVENT));
}

export function toggleKaiCommandBar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(KAI_COMMAND_BAR_TOGGLE_EVENT));
}

