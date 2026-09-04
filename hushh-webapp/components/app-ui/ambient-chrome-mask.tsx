"use client";

import { useLayoutEffect } from "react";

import {
  AMBIENT_CHROME_IGNORE_ATTR,
  ambientChromeMaskAttr,
  createAmbientChromeEngine,
  type AmbientChromeEdge,
} from "@/lib/morphy-ux/ambient-chrome";
import { cn } from "@/lib/utils";

export function AmbientChromeController({ enabled }: { enabled: boolean }) {
  useLayoutEffect(() => createAmbientChromeEngine(enabled), [enabled]);
  return null;
}

export function AmbientChromeMask({
  edge,
  className,
  style,
}: {
  edge: AmbientChromeEdge;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      {...{ [AMBIENT_CHROME_IGNORE_ATTR]: "" }}
      {...ambientChromeMaskAttr(edge)}
      className={cn(
        "ambient-chrome-mask",
        `ambient-chrome-mask--${edge}`,
        className,
      )}
      style={style}
    />
  );
}
