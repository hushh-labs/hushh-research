// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A single sleek bar that spans across just above the bottom navbar + search on
// every authenticated screen. It replaces the old draggable floating "Agent"
// pill so the agent is always present and context-aware: the hint text adapts to
// the current screen so the bar can guide the user from onboarding to any part
// of the app. For now it keeps the existing behavior (tap or mic both open the
// agent); richer per-screen actions are a planned follow-up.

"use client";

import React, { useMemo, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { AudioLines, Mic } from "lucide-react";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { requestAgentConversation } from "@/lib/agent/agent-voice-settings";
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

  const agentWindowOpen =
    agentPopover?.expanded || agentPopover?.motionState === "opening";

  const hideBar =
    !isAuthenticated ||
    useOnboardingChrome ||
    agentWindowOpen ||
    !agentPopover ||
    pathname?.startsWith(ROUTES.PHONE_MANDATE) ||
    pathname?.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    pathname === ROUTES.DEVELOPERS ||
    pathname === ROUTES.AGENT;

  if (hideBar) {
    return null;
  }

  const openAgent = () => agentPopover.openAgent();

  const startConversation = () => {
    agentPopover.openAgent();
    requestAgentConversation();
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[118] flex justify-center px-4 transform-gpu"
      style={
        {
          // Sit just above the visible bottom nav inset (not the full Kai
          // command-bar reservation) and ride the same scroll-hide translation
          // as the rest of the bottom chrome.
          bottom:
            "calc(var(--app-bottom-inset) + max(var(--app-safe-area-bottom-effective), 0.25rem) + 0.5rem)",
          transform:
            "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)",
          "--bottom-chrome-progress": String(hideBottomChromeProgress),
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "pointer-events-auto flex w-full max-w-[min(calc(100vw-2rem),34rem)] items-center gap-2",
          "h-11 rounded-full pl-3 pr-1.5",
          // Flat surface matching the top app bar controls and bottom nav.
          "bg-black/[0.05] text-[#1d1d1f] dark:bg-white/[0.07] dark:text-[#f5f5f7]",
          "transition-[background-color,transform] duration-200",
        )}
      >
        <button
          type="button"
          onClick={openAgent}
          aria-label={hint}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-full pl-1 text-left",
            "transition-colors duration-200 active:scale-[0.99]",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/70">
            {hint}
          </span>
        </button>
        <button
          type="button"
          onClick={openAgent}
          aria-label="Talk to your agent"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            "bg-black/[0.05] text-foreground/70 dark:bg-white/[0.07]",
            "transition-[background-color,transform] duration-200",
            "hover:bg-black/[0.08] hover:text-primary dark:hover:bg-white/[0.1] active:scale-90",
          )}
        >
          <Mic className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={startConversation}
          aria-label="Start a conversational session"
          title="Conversational mode"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            "bg-black/[0.05] text-foreground/70 dark:bg-white/[0.07]",
            "transition-[background-color,transform] duration-200",
            "hover:bg-black/[0.08] hover:text-primary dark:hover:bg-white/[0.1] active:scale-90",
          )}
        >
          <AudioLines className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
