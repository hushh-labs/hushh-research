"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";

import { AgentBar } from "@/components/agent/agent-bar";
import { Navbar } from "@/components/navbar";
import { AmbientChromeMask } from "@/components/app-ui/ambient-chrome-mask";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";

export type BottomShellModel = {
  ambientEnabled: boolean;
  navigationHidden: boolean;
  /** An immersive route owns the full viewport and has no persistent chrome. */
  hidden?: boolean;
};

const BOTTOM_SCROLL_TRANSFORM =
  "translate3d(0, calc((var(--kb-height, 0px) * -1) + (var(--bottom-chrome-progress, 0) * var(--bottom-nav-travel, 0px))), 0)";

/** Shared persistent bottom chrome: one material/motion owner, separate controls. */
export function AppBottomShell({ model }: { model: BottomShellModel }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const navigationSlotRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (model.hidden) {
      const root = document.documentElement;
      root.style.setProperty("--app-bottom-shell-height", "0px");
      root.style.setProperty("--bottom-nav-travel", "0px");
      root.style.setProperty("--bottom-chrome-hide-distance", "0px");
      return;
    }
    const shell = shellRef.current;
    if (!shell) return;
    const root = document.documentElement;
    const publishHeight = () => {
      const height = `${Math.ceil(shell.getBoundingClientRect().height)}px`;
      const navigationHeight = navigationSlotRef.current
        ? Math.ceil(navigationSlotRef.current.getBoundingClientRect().height)
        : 0;
      const navigationTravel = `${navigationHeight + 6}px`;
      root.style.setProperty("--app-bottom-shell-height", height);
      root.style.setProperty("--bottom-nav-travel", navigationTravel);
      root.style.setProperty("--bottom-chrome-hide-distance", navigationTravel);
      root.style.setProperty(
        "--bottom-chrome-full-height",
        `calc(${height} + var(--bottom-chrome-fade-overscan))`,
      );
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(shell);
    if (navigationSlotRef.current) observer.observe(navigationSlotRef.current);
    return () => observer.disconnect();
  }, [model.hidden, model.navigationHidden]);

  if (model.hidden) return null;

  const maskStyle = {
    height:
      "calc(var(--bottom-chrome-full-height) - (var(--bottom-chrome-progress, 0) * var(--bottom-nav-travel, 0px)) + var(--bottom-chrome-fade-tail))",
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
        onPointerDownCapture={
          model.navigationHidden ? undefined : snapKaiBottomChromeVisible
        }
        className="fixed inset-x-0 bottom-0 z-[118] px-3 pb-[max(0.75rem,var(--app-safe-area-bottom-effective))]"
      >
        <div
          data-bottom-shell-motion-stack
          className="flex flex-col items-center gap-1.5 transform-gpu will-change-transform"
          style={{
            transform: model.navigationHidden
              ? undefined
              : BOTTOM_SCROLL_TRANSFORM,
          }}
        >
          <div
            data-bottom-shell-agent-slot
            className="flex w-full justify-center"
          >
            <AgentBar layout="slot" />
          </div>
          <div
            ref={navigationSlotRef}
            data-bottom-shell-navigation-slot
            className="flex w-full justify-center"
          >
            <Navbar
              shellNavigationHidden={model.navigationHidden}
              layout="slot"
            />
          </div>
        </div>
      </div>
    </>
  );
}
