"use client";

import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { isKaiCommandBarOpen, SEARCH_OPEN_QUERY_KEY } from "@/lib/navigation/search-route";

export const KAI_COMMAND_BAR_OPEN_EVENT = "kai:command-bar:open";
export const KAI_COMMAND_BAR_TOGGLE_EVENT = "kai:command-bar:toggle";

export type KaiCommandBarIntent = "finance_stock_analysis";

export type KaiCommandBarOpenRequest = {
  intent?: KaiCommandBarIntent;
  initialQuery?: string;
};

export function setKaiCommandBarOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (isKaiCommandBarOpen(url.searchParams) === open) return;
  if (open) url.searchParams.set(SEARCH_OPEN_QUERY_KEY, "1");
  else url.searchParams.delete(SEARCH_OPEN_QUERY_KEY);
  // Persist visibility only. Search text and action intent stay in memory.
  requestInternalAppNavigation({
    href: `${url.pathname}${url.search}${url.hash}`,
    replace: !open,
    scroll: false,
    source: "search",
    transitionMode: "contextual",
  });
}

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
