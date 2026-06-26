// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A single sleek bar that spans across just above the bottom navbar + search on
// every authenticated screen. It replaces the old draggable floating "Agent"
// pill so the agent is always present and context-aware: the hint text adapts to
// the current screen so the bar can guide the user from onboarding to any part
// of the app. The bar itself opens Agent; voice controls live inside Agent.

"use client";

import React, { useMemo, type CSSProperties } from "react";
import { usePathname } from "next/navigation";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { useAuth } from "@/hooks/use-auth";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

// Screen-aware hint copy. First matching prefix wins, so order longest/most
// specific routes before their parents. Falls back to a generic prompt.
const AGENT_BAR_HINTS: ReadonlyArray<{ prefix: string; hint: string }> = [
  { prefix: ROUTES.KAI_ANALYSIS, hint: "Ask about this analysis" },
  { prefix: ROUTES.KAI_PORTFOLIO, hint: "Ask about your portfolio" },
  { prefix: ROUTES.KAI_HOME, hint: "Ask about the markets" },
  { prefix: ROUTES.LEGACY_KAI_ANALYSIS, hint: "Ask about this analysis" },
  { prefix: ROUTES.LEGACY_KAI_PORTFOLIO, hint: "Ask about your portfolio" },
  { prefix: ROUTES.LEGACY_KAI_HOME, hint: "Ask about the markets" },
  { prefix: ROUTES.RIA_HOME, hint: "Ask about your practice" },
  { prefix: ROUTES.PKM, hint: "Ask about your memories" },
  { prefix: ROUTES.PROFILE_PKM, hint: "Ask about your memories" },
  { prefix: ROUTES.CONSENTS, hint: "Ask about your consents" },
  { prefix: ROUTES.PROFILE, hint: "Ask about your account" },
  { prefix: ROUTES.ONE_HOME, hint: "Ask your agent anything" },
];

const AGENT_BAR_DEFAULT_HINT = "Ask your agent anything";

function resolveAgentBarHint(pathname: string | null): string {
  if (!pathname) return AGENT_BAR_DEFAULT_HINT;
  for (const { prefix, hint } of AGENT_BAR_HINTS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return hint;
    }
  }
  return AGENT_BAR_DEFAULT_HINT;
}

export function AgentBar() {
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();
  const agentPopover = useOptionalAgentPopover();

  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  const useOnboardingChrome = chromeState.useOnboardingChrome;

  // Hide/show in lockstep with the rest of the bottom chrome (nav + search).
  const allowScrollHide = !useOnboardingChrome;
  const { progress: hideBottomChromeProgress } =
    useKaiBottomChromeVisibility(allowScrollHide);

  const hint = useMemo(() => resolveAgentBarHint(pathname), [pathname]);

  // The agent window owns its own open/close animation. Keep the bar visually
  // hidden across the FULL lifecycle (opening, expanded, and the closing
  // animation) so it never remounts abruptly mid-close. Crucially, "closing"
  // must be treated as hidden too: on minimize the provider sets
  // expanded=false + motionState="closing" simultaneously, so checking only
  // `expanded || opening` would flip the bar back on instantly and make it
  // snap above the bottom bar before the popover finished animating out.
  const agentWindowActive =
    agentPopover?.expanded ||
    agentPopover?.motionState === "opening" ||
    agentPopover?.motionState === "closing";

  // Hard unmount gates: route/auth contexts where the bar must not exist at all.
  const unmountBar =
    !isAuthenticated ||
    useOnboardingChrome ||
    !agentPopover ||
    pathname?.startsWith(ROUTES.PHONE_MANDATE) ||
    pathname?.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.AGENT;

  if (unmountBar) {
    return null;
  }

  const openAgent = () => agentPopover.openAgent();

  // While the agent window is active, keep the bar mounted but visually faded
  // and non-interactive. When the window finishes closing it eases back in over
  // the same envelope instead of popping in from a fresh mount.
  const barHidden = Boolean(agentWindowActive);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[118] flex justify-center px-4 transform-gpu"
      style={
        {
          // Sit just above the visible bottom nav inset (not the full Kai
          // command-bar reservation) and ride the same scroll-hide translation
          // as the rest of the bottom chrome. Floor the nav reservation with the
          // static fallback so a transiently-zero --app-bottom-fixed-ui (e.g.
          // before the navbar re-measures after the agent window closes) can
          // never collapse this bar down onto the nav.
          bottom:
            "calc(max(var(--app-bottom-inset), var(--bottom-nav-offset, 88px)) + max(var(--app-safe-area-bottom-effective), 0.25rem) + 0.5rem)",
          transform:
            "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)",
          "--bottom-chrome-progress": String(hideBottomChromeProgress),
        } as CSSProperties
      }
      aria-hidden={barHidden}
    >
      <div
        className={cn(
          "pointer-events-auto flex w-full max-w-[min(calc(100vw-2rem),30rem)] items-center",
          "h-11 rounded-full px-4",
          // Flat surface matching the top app bar controls and bottom nav.
          "bg-black/[0.05] text-[#1d1d1f] dark:bg-white/[0.07] dark:text-[#f5f5f7]",
          // Single, consolidated transition covering surface color plus the
          // open/close fade+lift. Smoothly eases the bar in/out with the agent
          // window lifecycle so it never snaps back into place after closing.
          "transition-[opacity,transform,background-color] duration-300 ease-[cubic-bezier(0.16,0.84,0.28,1)] will-change-[opacity,transform]",
          barHidden
            ? "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
            : "translate-y-0 scale-100 opacity-100",
        )}
      >
        <button
          type="button"
          onClick={openAgent}
          aria-label={hint}
          className="flex h-full min-w-0 flex-1 items-center rounded-full text-left transition-transform duration-200 active:scale-[0.99]"
        >
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/70">
            {hint}
          </span>
        </button>
      </div>
    </div>
  );
}
