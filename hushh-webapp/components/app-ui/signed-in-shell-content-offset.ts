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

function normalizeLocalOffset(value?: string | null): string {
  const next = String(value ?? "").trim();
  return next.length > 0 ? next : "0px";
}

const STANDARD_PAGE_TOP_START = "32px";

/**
 * The top shell paints further down the screen than it reserves: the mask runs
 * to `--top-shell-reserved-height` and then dissolves over `--top-fade-active`.
 * A fullscreen flow used to start its body at the RESERVED height, so its first
 * line always landed inside that dissolve and read as the header sitting on top
 * of the page. Clearing the fade too puts the body exactly at the mask's last
 * visible pixel -- the smallest offset that leaves nothing underneath the
 * header, and 10px tighter than the standard body gap so hero flows stay
 * vertically composed.
 */
const FULLSCREEN_FLOW_PAGE_TOP_START = "var(--top-fade-active)";

/**
 * How far the top mask dissolves past its solid edge, published by the route
 * shell in `app/providers.tsx`.
 *
 * The `:root` fallback in `globals.css` is a much smaller 8px, so anything that
 * reproduces the shell outside the app -- notably
 * `e2e/app-shell-top-clearance.layout.spec.ts` -- must use these values or it
 * measures a header 14px shorter than the one that ships, and clearance bugs
 * pass. Exported from here so the shell and its contract read one source.
 */
export const TOP_SHELL_FADE_ACTIVE_PX = {
  withTabs: "20px",
  withoutTabs: "22px",
} as const;

/**
 * The top shell's derived geometry, declared at ROUTE-SHELL scope.
 *
 * These cannot live only in `:root`. CSS substitutes a custom property using
 * the values present where it is DECLARED, so a `:root` definition of
 * `--top-shell-mask-visible-height` bakes in `:root`'s own `--top-fade-active`
 * (8px) and keeps that computed value as it inherits down, no matter what the
 * shell sets below it. Re-declaring here is what makes the mask 82px instead of
 * 68px on a real route -- and re-declaring is also the reason anything
 * reproducing the shell outside the app must use this function rather than
 * hand-copying a subset.
 */
export function resolveTopShellGeometryStyle(params: {
  hasTabs: boolean;
}): CSSProperties {
  return {
    "--top-tabs-gap": "var(--kai-route-tabs-content-gap)",
    "--top-tabs-total": params.hasTabs
      ? "calc(var(--top-tabs-h) + var(--top-tabs-gap))"
      : "0px",
    "--top-subnav-total": "0px",
    "--top-systembar-row-gap": "4px",
    "--top-shell-reserved-height":
      "calc(var(--top-inset) + var(--top-systembar-row-gap) + var(--top-bar-h) + var(--top-tabs-total))",
    "--top-shell-visual-height":
      "calc(var(--top-shell-reserved-height) + var(--top-fade-active))",
    "--top-shell-live-height":
      "calc(var(--top-shell-visual-height) - var(--top-chrome-collapse-px, 0px))",
    "--top-shell-mask-tabs-gap": "0px",
    "--top-shell-mask-solid-height":
      "calc(var(--top-shell-reserved-height) - var(--top-shell-mask-tabs-gap) - var(--top-chrome-collapse-px, 0px))",
    "--top-shell-mask-visible-height":
      "calc(var(--top-shell-mask-solid-height) + var(--top-fade-active))",
    "--top-shell-h": "var(--top-shell-reserved-height)",
    "--top-glass-h": "var(--top-shell-visual-height)",
    "--top-fade-active": params.hasTabs
      ? TOP_SHELL_FADE_ACTIVE_PX.withTabs
      : TOP_SHELL_FADE_ACTIVE_PX.withoutTabs,
    "--top-content-pad":
      "calc(var(--top-shell-visual-height) + var(--top-subnav-total, 0px) + var(--top-content-safe-gap))",
  } as CSSProperties;
}

export function resolveSignedInShellContentOffset(params: {
  shellVisible: boolean;
  routeLayoutMode: AppRouteLayoutMode;
  localOffset?: string | null;
}): SignedInShellContentOffset {
  const localOffset = normalizeLocalOffset(params.localOffset);
  const mode: SignedInShellContentOffsetMode = !params.shellVisible
    ? "hidden-shell"
    : params.routeLayoutMode === "flow"
      ? "fullscreen-flow"
      : "standard";

  return {
    mode,
    shellVisible: params.shellVisible,
    localOffset,
    style: {
      "--page-top-local-offset": localOffset,
      "--page-top-start":
        mode === "standard"
          ? STANDARD_PAGE_TOP_START
          : mode === "fullscreen-flow"
            ? FULLSCREEN_FLOW_PAGE_TOP_START
            : "0px",
      "--app-top-mask-tail-clearance":
        "calc(var(--page-top-start) + var(--page-top-local-offset, 0px))",
      "--app-top-content-offset":
        mode === "standard"
          ? "calc(var(--top-shell-reserved-height) + var(--app-top-mask-tail-clearance))"
          : "0px",
      "--app-fullscreen-flow-content-offset": params.shellVisible
        ? "calc(var(--top-shell-reserved-height) + var(--app-top-mask-tail-clearance))"
        : "0px",
    } as CSSProperties,
  };
}
