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

const STANDARD_PAGE_TOP_START = "75px";

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
      "--page-top-start": mode === "standard" ? STANDARD_PAGE_TOP_START : "0px",
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
