"use client";

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AgentBar } from "@/components/agent/agent-bar";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import { useOptionalLocationCommand } from "@/components/agent/location-command-provider";
import { Navbar } from "@/components/navbar";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";

export type BottomShellModel = {
  navigationHidden: boolean;
  /** Chat owns the primary text composer, so its idle voice launcher is omitted. */
  agentBarHidden?: boolean;
  /** An immersive route owns the full viewport and has no persistent chrome. */
  hidden?: boolean;
};

// The stack rides the scroll progress only. It used to add a keyboard lift
// (-1 * --kb-height) too, but the shell is hidden on every route while the
// keyboard is up (html.kb-open fades it), so the lift only produced a ghost
// of the navigation jumping to above the keyboard for the frames of the fade,
// over the spot the chat composer was rising into. It fades where it stands.
const BOTTOM_SCROLL_TRANSFORM =
  "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-nav-travel, 0px)), 0)";

/** Shared persistent bottom chrome: separate voice and navigation bars. */
export const AppBottomShell = memo(function AppBottomShell({ model }: { model: BottomShellModel }) {
  const command = useOptionalLocationCommand();
  const voiceActive = useAgentVoiceState((state) => state.active);
  const hidden = model.hidden && !command?.active && !voiceActive;
  // A route may hide the idle launcher without interrupting a command already
  // in progress. Active capture remains visible and cancellable.
  const agentBarVisible =
    !model.agentBarHidden || Boolean(command?.active) || voiceActive;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const navigationSlotRef = useRef<HTMLDivElement | null>(null);
  // AgentBar reads client-only auth and location-command state. Rendering its
  // markup only after the first client commit keeps the server and hydration
  // trees identical while preserving the shared shell slot.
  const [agentBarMounted, setAgentBarMounted] = useState(false);

  useEffect(() => {
    setAgentBarMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (hidden) {
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
      // Keep the hide transform clear of the navigation pill's outer border.
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
  }, [hidden, model.agentBarHidden, model.navigationHidden]);

  if (hidden) return null;

  return (
    <>
      {/* The fixed wrapper keeps its original hit box while the chrome
          inside it rides the scroll transform. Let taps pass through that
          empty area to content (especially Chat's composer); the actual nav
          controls opt back into pointer events in Navbar. */}
      <div
        ref={shellRef}
        data-app-bottom-shell
        data-command-active={command?.active || undefined}
        data-ui-role="bottom-shell"
        data-bottom-shell-navigation-hidden={
          model.navigationHidden || undefined
        }
        data-ambient-chrome-ignore
        data-bottom-chrome-progress-consumer=""
        onPointerDownCapture={
          model.navigationHidden ? undefined : snapKaiBottomChromeVisible
        }
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[118] px-3 pb-[max(0.75rem,var(--app-safe-area-bottom-effective))]"
      >
        <div
          data-bottom-shell-motion-stack
          className="flex flex-col items-center gap-1.5 transform-gpu"
          style={{
            transform: model.navigationHidden
              ? undefined
              : BOTTOM_SCROLL_TRANSFORM,
          }}
        >
          {agentBarVisible ? (
            <div
              data-bottom-shell-agent-slot
              className="flex w-full justify-center"
            >
              {agentBarMounted ? <AgentBar layout="slot" /> : null}
            </div>
          ) : null}
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
});
