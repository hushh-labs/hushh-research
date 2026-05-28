"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { Bot } from "lucide-react";

import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES, isRiaActionBarRoute } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type AgentPopoverContextValue = {
  expanded: boolean;
  hasOpened: boolean;
  motionState: AgentPopoverMotionState;
  openAgent: () => void;
  minimizeAgent: () => void;
};

type AgentPopoverMotionState = "idle" | "opening" | "closing";

const AGENT_POPOVER_TRANSITION_MS = 360;

const AgentPopoverContext = createContext<AgentPopoverContextValue | null>(null);

export function useAgentPopover() {
  const value = useContext(AgentPopoverContext);
  if (!value) {
    throw new Error("useAgentPopover must be used inside AgentPopoverProvider");
  }
  return value;
}

export function useOptionalAgentPopover() {
  return useContext(AgentPopoverContext);
}

export function AgentPopoverProvider({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [motionState, setMotionState] =
    useState<AgentPopoverMotionState>("idle");
  const animationFrameRef = useRef<number | null>(null);
  const motionTimerRef = useRef<number | null>(null);

  const clearMotionHandles = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (motionTimerRef.current !== null) {
      window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearMotionHandles, [clearMotionHandles]);

  const openAgent = useCallback(() => {
    if (expanded && motionState !== "closing") return;

    clearMotionHandles();
    setHasOpened(true);
    setMotionState("opening");

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      setExpanded(true);
      motionTimerRef.current = window.setTimeout(() => {
        motionTimerRef.current = null;
        setMotionState("idle");
      }, AGENT_POPOVER_TRANSITION_MS);
    });
  }, [clearMotionHandles, expanded, motionState]);

  const minimizeAgent = useCallback(() => {
    if (!expanded && motionState !== "opening") return;

    clearMotionHandles();
    setMotionState("closing");
    setExpanded(false);
    motionTimerRef.current = window.setTimeout(() => {
      motionTimerRef.current = null;
      setMotionState("idle");
    }, AGENT_POPOVER_TRANSITION_MS);
  }, [clearMotionHandles, expanded, motionState]);

  const value = useMemo<AgentPopoverContextValue>(
    () => ({
      expanded,
      hasOpened,
      motionState,
      openAgent,
      minimizeAgent,
    }),
    [expanded, hasOpened, minimizeAgent, motionState, openAgent]
  );

  return (
    <AgentPopoverContext.Provider value={value}>
      {children}
      <AgentPopoverSurface />
    </AgentPopoverContext.Provider>
  );
}

function AgentPopoverSurface() {
  const { isAuthenticated } = useAuth();
  const pathname = usePathname();
  const { expanded, hasOpened, motionState, openAgent, minimizeAgent } =
    useAgentPopover();
  const isLegacyAgentRoute = pathname === ROUTES.AGENT;
  const canShowAgent = isAuthenticated && !isLegacyAgentRoute;
  const useRiaActionBarTrigger = isRiaActionBarRoute(pathname);
  const isCollapsing = motionState === "closing";
  const surfaceVisible = expanded || motionState !== "idle";

  const handleNavigationActionComplete = useCallback(() => {
    window.setTimeout(() => {
      minimizeAgent();
    }, 120);
  }, [minimizeAgent]);

  if (!canShowAgent) {
    return null;
  }

  return (
    <>
      {hasOpened ? (
        <div
          className={cn(
            "pointer-events-none fixed inset-0 z-[460] transition-opacity duration-300 motion-reduce:transition-none",
            surfaceVisible ? "opacity-100" : "opacity-0"
          )}
          aria-hidden={!expanded}
        >
          <section
            className={cn(
              "pointer-events-auto fixed bottom-[calc(max(var(--app-safe-area-bottom-effective),0.5rem)+0.5rem)] left-2 right-2 top-[calc(max(var(--app-safe-area-top-effective),0.5rem)+0.5rem)] flex min-h-0 origin-bottom-right flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 shadow-2xl backdrop-blur-xl transition-[border-radius,filter,opacity,transform] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transform-none motion-reduce:transition-none sm:left-4 sm:right-4 lg:left-auto lg:right-4 lg:w-[min(72rem,calc(100vw-2rem))]",
              expanded
                ? "translate-x-0 translate-y-0 scale-100 opacity-100 blur-0"
                : "pointer-events-none translate-x-3 translate-y-[calc(100%-5.75rem)] scale-[0.2] opacity-0 blur-sm",
              isCollapsing && "rounded-2xl ring-1 ring-primary/25"
            )}
            role="dialog"
            aria-label="Agent"
            aria-modal={false}
            aria-hidden={!expanded}
            inert={!expanded}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              minimizeAgent();
            }}
          >
            <AgentChatWorkspace
              variant="popover"
              onMinimize={minimizeAgent}
              onNavigationActionComplete={handleNavigationActionComplete}
            />
          </section>
        </div>
      ) : null}

      {!useRiaActionBarTrigger ? (
        <Button
          type="button"
          variant="secondary"
          className={cn(
            "fixed right-4 z-[130] h-11 gap-2 rounded-full border border-border/70 bg-background/90 px-4 shadow-lg backdrop-blur-md transition-[box-shadow,opacity,transform] duration-300 ease-out motion-reduce:transform-none motion-reduce:transition-none",
            expanded && !isCollapsing
              ? "pointer-events-none translate-y-3 scale-95 opacity-0"
              : "translate-y-0 scale-100 opacity-100",
            isCollapsing && "ring-1 ring-primary/30 shadow-primary/20"
          )}
          style={{
            bottom:
              "calc(var(--app-bottom-fixed-ui, 76px) + max(var(--app-safe-area-bottom-effective), 0.75rem) + 0.75rem)",
          }}
          onClick={openAgent}
          aria-label="Open Agent"
          title="Open Agent"
        >
          <Bot className="h-4 w-4" />
          <span className="hidden text-sm font-medium sm:inline">Agent</span>
        </Button>
      ) : null}
    </>
  );
}
