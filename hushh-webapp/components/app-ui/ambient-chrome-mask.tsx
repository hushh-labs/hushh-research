"use client";

import { useEffect, useLayoutEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import {
  AMBIENT_CHROME_IGNORE_ATTR,
  ambientChromeMaskAttr,
  createAmbientChromeEngine,
  requestAmbientChromeSample,
  type AmbientChromeEdge,
} from "@/lib/morphy-ux/ambient-chrome";
import { cn } from "@/lib/utils";

export function AmbientChromeController({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";

  useLayoutEffect(() => createAmbientChromeEngine(enabled), [enabled]);

  // A route settle is the one moment the painted surface under the chrome
  // can change without a scroll, resize or theme flip. The engine used to
  // learn this from a MutationObserver on the whole document body, which
  // also fired on every streamed chat token and every map marker move.
  useEffect(() => {
    if (!enabled) return;
    requestAmbientChromeSample();
  }, [enabled, pathname, search]);

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
