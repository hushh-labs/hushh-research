"use client";

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePathname } from "next/navigation";
import { Grip, Maximize2, Minimize2, Minus, X } from "lucide-react";

import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { AgentVoiceFloatingIndicator } from "@/components/agent/agent-voice-floating-indicator";
import { Button } from "@/components/ui/button";
import {
  AGENT_POPOVER_DEFAULT_SIZE_MODE,
  AGENT_POPOVER_PRESET_SIZES,
  AGENT_POPOVER_STORAGE_KEYS,
  clampAgentPopoverSize,
  isAgentPopoverSizeMode,
  resolveAgentPopoverSize,
  type AgentPopoverSize,
  type AgentPopoverSizeMode,
} from "@/lib/agent/agent-popover-layout";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type AgentPopoverContextValue = {
  expanded: boolean;
  hasOpened: boolean;
  motionState: AgentPopoverMotionState;
  sizeMode: AgentPopoverSizeMode;
  openAgent: () => void;
  minimizeAgent: () => void;
  setSizeMode: (mode: AgentPopoverSizeMode) => void;
};

type AgentPopoverMotionState = "idle" | "opening" | "closing";

const AGENT_POPOVER_TRANSITION_MS = 360;
const DEFAULT_CUSTOM_SIZE: AgentPopoverSize = AGENT_POPOVER_PRESET_SIZES.large;

const AgentPopoverContext = createContext<AgentPopoverContextValue | null>(
  null,
);

function getViewportSize() {
  if (typeof window === "undefined") {
    return { width: 1280, height: 800 };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function readStoredSizeMode(): AgentPopoverSizeMode {
  if (typeof window === "undefined") return AGENT_POPOVER_DEFAULT_SIZE_MODE;
  const stored = window.localStorage.getItem(AGENT_POPOVER_STORAGE_KEYS.mode);
  return isAgentPopoverSizeMode(stored)
    ? stored
    : AGENT_POPOVER_DEFAULT_SIZE_MODE;
}

function readStoredCustomSize(): AgentPopoverSize {
  if (typeof window === "undefined") return DEFAULT_CUSTOM_SIZE;
  const stored = window.localStorage.getItem(
    AGENT_POPOVER_STORAGE_KEYS.customSize,
  );
  if (!stored) return DEFAULT_CUSTOM_SIZE;
  try {
    const parsed = JSON.parse(stored) as Partial<AgentPopoverSize>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      return DEFAULT_CUSTOM_SIZE;
    }
    const viewport = getViewportSize();
    return clampAgentPopoverSize(
      parsed as AgentPopoverSize,
      viewport.width,
      viewport.height,
    );
  } catch {
    return DEFAULT_CUSTOM_SIZE;
  }
}

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
  const [sizeMode, setSizeModeState] = useState<AgentPopoverSizeMode>(
    AGENT_POPOVER_DEFAULT_SIZE_MODE,
  );
  const [customSize, setCustomSize] =
    useState<AgentPopoverSize>(DEFAULT_CUSTOM_SIZE);

  useEffect(() => {
    setSizeModeState(readStoredSizeMode());
    setCustomSize(readStoredCustomSize());
  }, []);
  const animationFrameRef = useRef<number | null>(null);
  const motionTimerRef = useRef<number | null>(null);

  const setSizeMode = useCallback((mode: AgentPopoverSizeMode) => {
    setSizeModeState(mode);
  }, []);

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
      sizeMode,
      openAgent,
      minimizeAgent,
      setSizeMode,
    }),
    [
      expanded,
      hasOpened,
      minimizeAgent,
      motionState,
      openAgent,
      setSizeMode,
      sizeMode,
    ],
  );

  useEffect(() => {
    window.localStorage.setItem(AGENT_POPOVER_STORAGE_KEYS.mode, sizeMode);
  }, [sizeMode]);

  useEffect(() => {
    window.localStorage.setItem(
      AGENT_POPOVER_STORAGE_KEYS.customSize,
      JSON.stringify(customSize),
    );
  }, [customSize]);

  useEffect(() => {
    const handleResize = () => {
      const viewport = getViewportSize();
      setCustomSize((current) =>
        clampAgentPopoverSize(current, viewport.width, viewport.height),
      );
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <AgentPopoverContext.Provider value={value}>
      {children}
      <AgentPopoverSurface
        customSize={customSize}
        setCustomSize={setCustomSize}
      />
    </AgentPopoverContext.Provider>
  );
}

type AgentPopoverSurfaceProps = {
  customSize: AgentPopoverSize;
  setCustomSize: Dispatch<SetStateAction<AgentPopoverSize>>;
};

function AgentPopoverSurface({
  customSize,
  setCustomSize,
}: AgentPopoverSurfaceProps) {
  const pathname = usePathname();
  const {
    expanded,
    hasOpened,
    motionState,
    sizeMode,
    setSizeMode,
    openAgent,
    minimizeAgent,
  } = useAgentPopover();
  const isLegacyAgentRoute = pathname === ROUTES.AGENT;
  const isPhoneMandateRoute = pathname?.startsWith(ROUTES.PHONE_MANDATE);
  // The agent is a SINGLE surface present everywhere, including onboarding and
  // for anonymous (pre-sign-in) users. It degrades gracefully by auth/vault
  // level rather than unmounting, so it intentionally does NOT gate on
  // isAuthenticated or on the Kai command-bar's hideCommandBar (which is a
  // different surface). We only suppress it where an agent window must not exist
  // at all: the legacy dedicated agent route, phone mandate, the appearance lab,
  // the developers page, and the auth/landing transitions where the app shell
  // itself is not the right host.
  const path = pathname ?? "";
  const isAgentSuppressedRoute =
    isLegacyAgentRoute ||
    isPhoneMandateRoute ||
    path.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    path === ROUTES.DEVELOPERS ||
    path === ROUTES.HOME ||
    path.startsWith(ROUTES.LOGIN) ||
    path.startsWith(ROUTES.LOGOUT);
  const canShowAgent = !isAgentSuppressedRoute;
  const isCollapsing = motionState === "closing";
  const surfaceVisible = expanded || motionState !== "idle";
  const isFullscreen = sizeMode === "fullscreen";
  const resizeStartRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  const resolvedPanelSize = useMemo(() => {
    const viewport = getViewportSize();
    return clampAgentPopoverSize(
      resolveAgentPopoverSize(sizeMode, customSize),
      viewport.width,
      viewport.height,
    );
  }, [customSize, sizeMode]);

  const panelStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--agent-popover-width": `${resolvedPanelSize.width}px`,
        "--agent-popover-height": `${resolvedPanelSize.height}px`,
      }) as CSSProperties,
    [resolvedPanelSize.height, resolvedPanelSize.width],
  );

  const handleNavigationActionComplete = useCallback(() => {
    window.setTimeout(() => {
      minimizeAgent();
    }, 120);
  }, [minimizeAgent]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (isFullscreen) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStartRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: resolvedPanelSize.width,
        startHeight: resolvedPanelSize.height,
      };
      setSizeMode("custom");
    },
    [
      isFullscreen,
      resolvedPanelSize.height,
      resolvedPanelSize.width,
      setSizeMode,
    ],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = resizeStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      event.preventDefault();
      const viewport = getViewportSize();
      setCustomSize(
        clampAgentPopoverSize(
          {
            width: start.startWidth + start.startX - event.clientX,
            height: start.startHeight + start.startY - event.clientY,
          },
          viewport.width,
          viewport.height,
        ),
      );
    },
    [setCustomSize],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = resizeStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      resizeStartRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  if (!canShowAgent) {
    return null;
  }

  return (
    <>
      {hasOpened ? (
        <div
          className={cn(
            "pointer-events-none fixed inset-0 z-[460] transition-opacity duration-300 motion-reduce:transition-none",
            surfaceVisible ? "opacity-100" : "opacity-0",
          )}
          aria-hidden={!expanded}
        >
          <section
            className={cn(
              "pointer-events-auto fixed flex min-h-0 origin-bottom-right flex-col overflow-hidden bg-white/95 text-[#1d1d1f] shadow-2xl backdrop-blur-xl transition-[border-radius,filter,height,opacity,transform,width] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transform-none motion-reduce:transition-none dark:bg-[#1c1c1e]/95 dark:text-[#f5f5f7]",
              isFullscreen
                ? "inset-0 rounded-none border-0"
                : // On phones the Agent window is a full immersive sheet: edge to
                  // edge across the entire dynamic viewport (incl. safe areas),
                  // no rounded corners and no hairline border. On >=sm it is a
                  // floating, rounded, inset card with a hairline border.
                  "bottom-[calc(max(var(--app-safe-area-bottom-effective),0.5rem)+0.5rem)] right-2 h-[min(var(--agent-popover-height),calc(100dvh-1rem))] w-[min(var(--agent-popover-width),calc(100vw-1rem))] rounded-lg border border-black/10 max-sm:inset-0 max-sm:h-[100dvh] max-sm:w-screen max-sm:rounded-none max-sm:border-0 sm:right-4 sm:h-[min(var(--agent-popover-height),calc(100dvh-2rem))] sm:w-[min(var(--agent-popover-width),calc(100vw-2rem))] dark:border-white/10",
              expanded
                ? "translate-x-0 translate-y-0 scale-100 opacity-100 blur-0"
                : // Closed/closing motion. On phones the sheet simply slides down
                  // and fades (no corner-scale), so it never collapses into the
                  // agent bar's spot and fights its fade-in. On >=sm it keeps the
                  // genie-style shrink toward the bottom-right launcher.
                  "pointer-events-none opacity-0 max-sm:translate-y-full max-sm:scale-100 max-sm:blur-0 sm:translate-x-3 sm:translate-y-[calc(100%-5.75rem)] sm:scale-[0.2] sm:blur-sm",
              isCollapsing && "sm:rounded-2xl sm:ring-1 sm:ring-primary/25",
            )}
            style={panelStyle}
            role="dialog"
            aria-label="One"
            aria-modal={false}
            aria-hidden={!expanded}
            inert={!expanded}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              minimizeAgent();
            }}
          >
            {!isFullscreen ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="absolute left-2 top-2 z-20 hidden cursor-nwse-resize touch-none rounded-md border border-border/70 bg-background/90 text-muted-foreground shadow-sm backdrop-blur sm:inline-flex"
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerEnd}
                onPointerCancel={handleResizePointerEnd}
                aria-label="Resize One"
                title="Drag to resize One"
              >
                <Grip className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <Suspense fallback={null}>
              <AgentChatWorkspace
                variant="popover"
                windowControls={
                  <AgentPopoverWindowControls
                    sizeMode={sizeMode}
                    setSizeMode={setSizeMode}
                    onMinimize={minimizeAgent}
                    onClose={minimizeAgent}
                  />
                }
                onMinimize={minimizeAgent}
                onNavigationActionComplete={handleNavigationActionComplete}
              />
            </Suspense>
          </section>
        </div>
      ) : null}

      <AgentVoiceFloatingIndicator onClick={openAgent} />
    </>
  );
}

function AgentPopoverWindowControls({
  sizeMode,
  setSizeMode,
  onMinimize,
  onClose,
}: {
  sizeMode: AgentPopoverSizeMode;
  setSizeMode: (mode: AgentPopoverSizeMode) => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const isFullscreen = sizeMode === "fullscreen";

  return (
    <div
      className="hidden h-8 overflow-hidden rounded-md border border-black/10 bg-black/[0.035] dark:border-white/10 dark:bg-white/[0.03] sm:flex"
      aria-label="One window controls"
      role="group"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="h-8 w-10 rounded-none text-[rgba(0,0,0,0.50)] hover:bg-black/[0.05] hover:text-[#1d1d1f] focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
        onClick={onMinimize}
        aria-label="Minimize One"
        title="Minimize One"
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="h-8 w-10 rounded-none text-[rgba(0,0,0,0.50)] hover:bg-black/[0.05] hover:text-[#1d1d1f] focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
        onClick={() => setSizeMode(isFullscreen ? "large" : "fullscreen")}
        aria-label={isFullscreen ? "Restore One" : "Maximize One"}
        title={isFullscreen ? "Restore One" : "Maximize One"}
      >
        {isFullscreen ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="h-8 w-10 rounded-none text-[rgba(0,0,0,0.50)] hover:bg-red-500/85 hover:text-white focus-visible:ring-2 focus-visible:ring-red-400/70 dark:text-zinc-400"
        onClick={onClose}
        aria-label="Close One"
        title="Close One"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
