"use client";

export const KAI_COMMAND_BAR_OPEN_EVENT = "kai:command-bar:open";

export function openKaiCommandBar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(KAI_COMMAND_BAR_OPEN_EVENT));
}

