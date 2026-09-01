"use client";

export const KAI_COMMAND_BAR_OPEN_EVENT = "kai:command-bar:open";
export const KAI_COMMAND_BAR_TOGGLE_EVENT = "kai:command-bar:toggle";

export type KaiCommandBarIntent = "finance_stock_analysis";

export type KaiCommandBarOpenRequest = {
  intent?: KaiCommandBarIntent;
  initialQuery?: string;
};

export function openKaiCommandBar(request: KaiCommandBarOpenRequest = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<KaiCommandBarOpenRequest>(KAI_COMMAND_BAR_OPEN_EVENT, {
      detail: request,
    }),
  );
}

export function toggleKaiCommandBar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(KAI_COMMAND_BAR_TOGGLE_EVENT));
}
