"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";

import { AgentBar } from "@/components/agent/agent-bar";
import { Navbar } from "@/components/navbar";
import { AmbientChromeMask } from "@/components/app-ui/ambient-chrome-mask";
import { useKaiBottomChromeElementTranslation } from "@/lib/navigation/kai-bottom-chrome-visibility";

export type BottomShellModel = {
  ambientEnabled: boolean;
  navigationHidden: boolean;
};

const BOTTOM_SCROLL_TRANSFORM =
  "translate3d(0, calc((var(--kb-height, 0px) * -1) + (var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance))), 0)";

/** Shared persistent bottom chrome: one material/motion owner, separate controls. */
export function AppBottomShell({ model }: { model: BottomShellModel }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  useKaiBottomChromeElementTranslation(
    shellRef,
    model.ambientEnabled && !model.navigationHidden,
  );

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const root = document.documentElement;
    const publishHeight = () => {
      const height = `${Math.ceil(shell.getBoundingClientRect().height)}px`;
      root.style.setProperty("--app-bottom-shell-height", height);
      root.style.setProperty("--bottom-chrome-hide-distance", height);
      root.style.setProperty(
        "--bottom-chrome-full-height",
        `calc(${height} + var(--bottom-chrome-fade-overscan))`,
      );
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [model.navigationHidden]);

  const maskStyle = {
    transform: BOTTOM_SCROLL_TRANSFORM,
    height:
      "calc(var(--bottom-chrome-full-height) + var(--bottom-chrome-fade-tail))",
  } as CSSProperties;

  return (
    <>
      {model.ambientEnabled ? (
        <AmbientChromeMask
          edge="bottom"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[108]"
          style={maskStyle}
        />
      ) : null}
      <div
        ref={shellRef}
        data-app-bottom-shell
        data-bottom-shell-navigation-hidden={
          model.navigationHidden || undefined
        }
        data-ambient-chrome-ignore
        className="fixed inset-x-0 bottom-0 z-[118] flex flex-col items-center gap-1.5 px-3 pb-[max(0.75rem,var(--app-safe-area-bottom-effective))] transform-gpu"
      >
        <AgentBar layout="slot" />
        <Navbar shellNavigationHidden={model.navigationHidden} layout="slot" />
      </div>
    </>
  );
}
