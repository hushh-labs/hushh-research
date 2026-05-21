"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { Bot } from "lucide-react";

import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type AgentPopoverContextValue = {
  expanded: boolean;
  hasOpened: boolean;
  openAgent: () => void;
  minimizeAgent: () => void;
};

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

  const openAgent = useCallback(() => {
    setHasOpened(true);
    setExpanded(true);
  }, []);

  const minimizeAgent = useCallback(() => {
    setExpanded(false);
  }, []);

  const value = useMemo<AgentPopoverContextValue>(
    () => ({
      expanded,
      hasOpened,
      openAgent,
      minimizeAgent,
    }),
    [expanded, hasOpened, minimizeAgent, openAgent]
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
  const { expanded, hasOpened, openAgent, minimizeAgent } = useAgentPopover();
  const isLegacyAgentRoute = pathname === ROUTES.AGENT;
  const canShowAgent = isAuthenticated && !isLegacyAgentRoute;

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
            "pointer-events-none fixed inset-0 z-[460] transition-opacity duration-200",
            expanded ? "opacity-100" : "opacity-0"
          )}
          aria-hidden={!expanded}
        >
          <section
            className={cn(
              "pointer-events-auto fixed bottom-[calc(max(var(--app-safe-area-bottom-effective),0.5rem)+0.5rem)] left-2 right-2 top-[calc(max(var(--app-safe-area-top-effective),0.5rem)+0.5rem)] flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 shadow-2xl backdrop-blur-xl transition-[opacity,transform] duration-200 sm:left-4 sm:right-4 lg:left-auto lg:right-4 lg:w-[min(72rem,calc(100vw-2rem))]",
              expanded
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-6 scale-[0.98] opacity-0"
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

      <Button
        type="button"
        variant="secondary"
        className={cn(
          "fixed right-4 z-[130] h-11 gap-2 rounded-full border border-border/70 bg-background/90 px-4 shadow-lg backdrop-blur-md transition-[opacity,transform] duration-200",
          expanded
            ? "pointer-events-none translate-y-2 opacity-0"
            : "translate-y-0 opacity-100"
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
    </>
  );
}
