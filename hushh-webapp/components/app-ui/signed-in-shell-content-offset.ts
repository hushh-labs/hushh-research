"use client";

import type { CSSProperties } from "react";
import type { AppRouteLayoutMode } from "@/lib/navigation/app-route-layout";

export type SignedInShellContentOffsetMode =
  | "hidden-shell"
  | "standard"
  | "fullscreen-flow";

export interface SignedInShellContentOffset {
  mode: SignedInShellContentOffsetMode;
  shellVisible: boolean;
  localOffset: string;
  style: CSSProperties;
}

/**
 * Safely normalizes offset values to ensure they are valid CSS lengths.
 * If a unitless number is passed, it appends 'px'.
 */
function normalizeLocalOffset(value?: string | number | null): string {
  if (value === null || value === undefined) return "0px";
  const strValue = String(value).trim();
  if (strValue.length === 0) return "0px";

  // If it's a number but missing units, default to px
  return isNaN(Number(strValue)) ? strValue : `${strValue}px`;
}

const STANDARD_PAGE_TOP_START = "32px";

/**
 * Resolves the CSS variables required to position page content relative to the 
 * top navigation shell and safe areas.
 */
export function resolveSignedInShellContentOffset(params: {
  shellVisible: boolean;
  routeLayoutMode: AppRouteLayoutMode;
  localOffset?: string | number | null;
}): SignedInShellContentOffset {
  const localOffset = normalizeLocalOffset(params.localOffset);

  const isFlow = params.routeLayoutMode === "flow";
  const mode: SignedInShellContentOffsetMode = !params.shellVisible
    ? "hidden-shell"
    : isFlow
      ? "fullscreen-flow"
      : "standard";

  // Base logic: standard mode needs the extra 32px start gap.
  const pageStart = mode === "standard" ? STANDARD_PAGE_TOP_START : "0px";

  return {
    mode,
    shellVisible: params.shellVisible,
    localOffset,
    style: {
      "--page-top-local-offset": localOffset,
      "--page-top-start": pageStart,

      // We use CSS variable references here to maintain reactivity in the DOM
      "--app-top-mask-tail-clearance": "calc(var(--page-top-start) + var(--page-top-local-offset, 0px))",

      // If shell is hidden, offset is just the local gap. 
      // If flow, it handles shell height but doesn't push content.
      "--app-top-content-offset":
        mode === "standard"
          ? "calc(var(--top-shell-reserved-height, 0px) + var(--app-top-mask-tail-clearance))"
          : localOffset,

      "--app-fullscreen-flow-content-offset": params.shellVisible
        ? "calc(var(--top-shell-reserved-height, 0px) + var(--app-top-mask-tail-clearance))"
        : localOffset,
    } as CSSProperties,
  };
}