"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import { Bot, Grip, Maximize2, Minimize2, Minus, X } from "lucide-react";

import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { AgentVoiceFloatingIndicator } from "@/components/agent/agent-voice-floating-indicator";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  AGENT_POPOVER_DEFAULT_SIZE_MODE,
  AGENT_POPOVER_PRESET_SIZES,
  AGENT_POPOVER_STORAGE_KEYS,
  clampAgentTriggerPosition,
  clampAgentPopoverSize,
  getDefaultAgentTriggerPosition,
  isAgentPopoverSizeMode,
  resolveAgentPopoverSize,
  type AgentPopoverSize,
  type AgentPopoverSizeMode,
  type AgentTriggerBounds,
  type AgentTriggerPosition,
} from "@/lib/agent/agent-popover-layout";
import { ROUTES, isRiaActionBarRoute } from "@/lib/navigation/routes";
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
const AGENT_TRIGGER_FALLBACK_SIZE = 44;
const AGENT_TRIGGER_DRAG_THRESHOLD_PX = 5;
const AGENT_TRIGGER_TOP_GUARD_PX = 88;

const AgentPopoverContext = createContext<AgentPopoverContextValue | null>(null);

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
  return isAgentPopoverSizeMode(stored) ? stored : AGENT_POPOVER_DEFAULT_SIZE_MODE;
}

function readStoredCustomSize(): AgentPopoverSize {
  if (typeof window === "undefined") return DEFAULT_CUSTOM_SIZE;
  const stored = window.localStorage.getItem(AGENT_POPOVER_STORAGE_KEYS.customSize);
  if (!stored) return DEFAULT_CUSTOM_SIZE;
  try {
    const parsed = JSON.parse(stored) as Partial<AgentPopoverSize>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      return DEFAULT_CUSTOM_SIZE;
    }
    const viewport = getViewportSize();
    return clampAgentPopoverSize(parsed as AgentPopoverSize, viewport.width, viewport.height);
  } catch {
    return DEFAULT_CUSTOM_SIZE;
  }
}

function readStoredTriggerPosition(): AgentTriggerPosition | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(AGENT_POPOVER_STORAGE_KEYS.triggerPosition);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<AgentTriggerPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
      return null;
    }
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) {
      return null;
    }
    return {
      x: parsed.x,
      y: parsed.y,
    };
  } catch {
    return null;
  }
}

function resolveCssLength(anchor: HTMLElement | null, value: string): number {
  if (typeof document === "undefined") return 0;
  const container = anchor?.parentElement ?? document.body;
  if (!container) return 0;

  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.left = "0";
  probe.style.top = "0";
  probe.style.height = value;
  probe.style.width = "1px";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.contain = "strict";
  container.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();

  return Number.isFinite(px) ? Math.max(0, px) : 0;
}

function measureVisibleReservedBottom(selector: string): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  const viewportHeight = window.innerHeight;
  let reservedBottom = 0;

  document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.bottom <= 0 || rect.top >= viewportHeight) return;
    reservedBottom = Math.max(reservedBottom, viewportHeight - rect.top);
  });

  return reservedBottom;
}

function getAgentTriggerBounds(trigger: HTMLElement | null): AgentTriggerBounds {
  const rect = trigger?.getBoundingClientRect();
  const reservedBottomFromChrome = Math.max(
    measureVisibleReservedBottom('[data-tour-id="kai-command-bar"]'),
    measureVisibleReservedBottom('[data-testid="ria-action-bar"]'),
    measureVisibleReservedBottom('[aria-label="Main navigation"]')
  );
  const reservedBottomFromCss = Math.max(
    resolveCssLength(trigger, "var(--bottom-chrome-full-height, 0px)"),
    resolveCssLength(trigger, "var(--bottom-chrome-stack-height, 0px)"),
    resolveCssLength(
      trigger,
      "calc(var(--app-bottom-fixed-ui, 76px) + var(--kai-command-fixed-ui, 82px) + var(--bottom-chrome-fade-overscan, 18px))"
    )
  );

  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    triggerWidth: Math.max(AGENT_TRIGGER_FALLBACK_SIZE, rect?.width ?? 0),
    triggerHeight: Math.max(AGENT_TRIGGER_FALLBACK_SIZE, rect?.height ?? 0),
    reservedBottom: Math.max(reservedBottomFromChrome, reservedBottomFromCss),
    reservedTop: AGENT_TRIGGER_TOP_GUARD_PX,
    safeTop: resolveCssLength(trigger, "var(--app-safe-area-top-effective, 0px)"),
    margin: 16,
  };
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
  const [sizeMode, setSizeModeState] = useState<AgentPopoverSizeMode>(readStoredSizeMode);
  const [customSize, setCustomSize] = useState<AgentPopoverSize>(readStoredCustomSize);
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
    [expanded, hasOpened, minimizeAgent, motionState, openAgent, setSizeMode, sizeMode]
  );

  useEffect(() => {
    window.localStorage.setItem(AGENT_POPOVER_STORAGE_KEYS.mode, sizeMode);
  }, [sizeMode]);

  useEffect(() => {
    window.localStorage.setItem(
      AGENT_POPOVER_STORAGE_KEYS.customSize,
      JSON.stringify(customSize)
    );
  }, [customSize]);

  useEffect(() => {
    const handleResize = () => {
      const viewport = getViewportSize();
      setCustomSize((current) =>
        clampAgentPopoverSize(current, viewport.width, viewport.height)
      );
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <AgentPopoverContext.Provider value={value}>
      {children}
      <AgentPopoverSurface customSize={customSize} setCustomSize={setCustomSize} />
    </AgentPopoverContext.Provider>
  );
}

type AgentPopoverSurfaceProps = {
  customSize: AgentPopoverSize;
  setCustomSize: Dispatch<SetStateAction<AgentPopoverSize>>;
};

function AgentPopoverSurface({ customSize, setCustomSize }: AgentPopoverSurfaceProps) {
  const { isAuthenticated } = useAuth();
  const pathname = usePathname();
  const { expanded, hasOpened, motionState, sizeMode, setSizeMode, openAgent, minimizeAgent } =
    useAgentPopover();
  const isLegacyAgentRoute = pathname === ROUTES.AGENT;
  const canShowAgent = isAuthenticated && !isLegacyAgentRoute;
  const useRiaActionBarTrigger = isRiaActionBarRoute(pathname);
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerDragStartRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPosition: AgentTriggerPosition;
    moved: boolean;
  } | null>(null);
  const skipTriggerClickRef = useRef(false);
  const [triggerPosition, setTriggerPosition] =
    useState<AgentTriggerPosition | null>(readStoredTriggerPosition);

  const resolvedPanelSize = useMemo(() => {
    const viewport = getViewportSize();
    return clampAgentPopoverSize(
      resolveAgentPopoverSize(sizeMode, customSize),
      viewport.width,
      viewport.height
    );
  }, [customSize, sizeMode]);

  const panelStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--agent-popover-width": `${resolvedPanelSize.width}px`,
        "--agent-popover-height": `${resolvedPanelSize.height}px`,
      }) as CSSProperties,
    [resolvedPanelSize.height, resolvedPanelSize.width]
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
    [isFullscreen, resolvedPanelSize.height, resolvedPanelSize.width, setSizeMode]
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
          viewport.height
        )
      );
    },
    [setCustomSize]
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
    []
  );

  const clampTriggerPosition = useCallback((position: AgentTriggerPosition) => {
    return clampAgentTriggerPosition(position, getAgentTriggerBounds(triggerRef.current));
  }, []);

  const clampStoredTriggerPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    setTriggerPosition((current) => {
      const bounds = getAgentTriggerBounds(triggerRef.current);
      const next = current
        ? clampAgentTriggerPosition(current, bounds)
        : getDefaultAgentTriggerPosition(bounds);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    if (!canShowAgent || useRiaActionBarTrigger) return;
    clampStoredTriggerPosition();

    window.addEventListener("resize", clampStoredTriggerPosition);
    window.addEventListener("orientationchange", clampStoredTriggerPosition);
    return () => {
      window.removeEventListener("resize", clampStoredTriggerPosition);
      window.removeEventListener("orientationchange", clampStoredTriggerPosition);
    };
  }, [canShowAgent, clampStoredTriggerPosition, useRiaActionBarTrigger]);

  useEffect(() => {
    if (!triggerPosition) return;
    window.localStorage.setItem(
      AGENT_POPOVER_STORAGE_KEYS.triggerPosition,
      JSON.stringify(triggerPosition)
    );
  }, [triggerPosition]);

  const handleTriggerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const startPosition = clampTriggerPosition(
        triggerPosition ?? {
          x: rect.left,
          y: rect.top,
        }
      );

      event.currentTarget.setPointerCapture(event.pointerId);
      triggerDragStartRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPosition,
        moved: false,
      };
    },
    [clampTriggerPosition, triggerPosition]
  );

  const handleTriggerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = triggerDragStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - start.startClientX;
      const deltaY = event.clientY - start.startClientY;
      const moved =
        start.moved ||
        Math.hypot(deltaX, deltaY) >= AGENT_TRIGGER_DRAG_THRESHOLD_PX;
      if (!moved) return;

      event.preventDefault();
      start.moved = true;
      setTriggerPosition(
        clampTriggerPosition({
          x: start.startPosition.x + deltaX,
          y: start.startPosition.y + deltaY,
        })
      );
    },
    [clampTriggerPosition]
  );

  const handleTriggerPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = triggerDragStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;

      triggerDragStartRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (start.moved) {
        event.preventDefault();
        skipTriggerClickRef.current = true;
      }
    },
    []
  );

  const handleTriggerClick = useCallback(() => {
    if (skipTriggerClickRef.current) {
      skipTriggerClickRef.current = false;
      return;
    }
    openAgent();
  }, [openAgent]);

  if (!isAuthenticated) {
    return null;
  }

  if (!canShowAgent) {
    return <AgentVoiceFloatingIndicator onClick={openAgent} />;
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
              "pointer-events-auto fixed flex min-h-0 origin-bottom-right flex-col overflow-hidden border border-border/70 bg-background/95 shadow-2xl backdrop-blur-xl transition-[border-radius,filter,height,opacity,transform,width] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transform-none motion-reduce:transition-none",
              isFullscreen
                ? "inset-0 rounded-none"
                : "bottom-[calc(max(var(--app-safe-area-bottom-effective),0.5rem)+0.5rem)] right-2 h-[min(var(--agent-popover-height),calc(100dvh-1rem))] w-[min(var(--agent-popover-width),calc(100vw-1rem))] rounded-lg max-sm:inset-0 max-sm:h-auto max-sm:w-auto max-sm:rounded-none sm:right-4 sm:h-[min(var(--agent-popover-height),calc(100dvh-2rem))] sm:w-[min(var(--agent-popover-width),calc(100vw-2rem))]",
              expanded
                ? "translate-x-0 translate-y-0 scale-100 opacity-100 blur-0"
                : "pointer-events-none translate-x-3 translate-y-[calc(100%-5.75rem)] scale-[0.2] opacity-0 blur-sm",
              isCollapsing && "rounded-2xl ring-1 ring-primary/25"
            )}
            style={panelStyle}
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
                aria-label="Resize Agent"
                title="Drag to resize Agent"
              >
                <Grip className="h-3.5 w-3.5" />
              </Button>
            ) : null}
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
          </section>
        </div>
      ) : null}

      {!useRiaActionBarTrigger ? (
        <Button
          ref={triggerRef}
          type="button"
          variant="secondary"
          className={cn(
            "fixed z-[130] h-11 touch-none select-none gap-2 rounded-full border border-primary/55 bg-primary px-4 text-primary-foreground shadow-lg shadow-primary/20 backdrop-blur-md transition-[box-shadow,opacity,transform,background-color,border-color] duration-300 ease-out hover:border-primary/70 hover:bg-primary/90 hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-primary/60 motion-reduce:transform-none motion-reduce:transition-none",
            "cursor-grab active:cursor-grabbing",
            expanded && !isCollapsing
              ? "pointer-events-none translate-y-3 scale-95 opacity-0"
              : "translate-y-0 scale-100 opacity-100",
            isCollapsing && "ring-1 ring-primary/30 shadow-primary/20"
          )}
          style={
            triggerPosition
              ? {
                  left: `${triggerPosition.x}px`,
                  top: `${triggerPosition.y}px`,
                }
              : {
                  bottom:
                    "calc(var(--bottom-chrome-full-height, calc(var(--app-bottom-fixed-ui, 76px) + var(--kai-command-fixed-ui, 82px) + 18px)) + 0.75rem)",
                  right: "1rem",
                }
          }
          onPointerDown={handleTriggerPointerDown}
          onPointerMove={handleTriggerPointerMove}
          onPointerUp={handleTriggerPointerEnd}
          onPointerCancel={handleTriggerPointerEnd}
          onClick={handleTriggerClick}
          aria-label="Open Agent"
          title="Drag to reposition Agent, tap to open"
        >
          <Bot className="h-4 w-4" />
          <span className="hidden text-sm font-medium sm:inline">Agent</span>
        </Button>
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
      className="hidden h-8 overflow-hidden rounded-md border border-white/10 bg-white/[0.03] sm:flex"
      aria-label="Agent window controls"
      role="group"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="h-8 w-10 rounded-none text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-primary/60"
        onClick={onMinimize}
        aria-label="Minimize Agent"
        title="Minimize Agent"
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="h-8 w-10 rounded-none text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-primary/60"
        onClick={() => setSizeMode(isFullscreen ? "large" : "fullscreen")}
      aria-label={isFullscreen ? "Restore Agent" : "Maximize Agent"}
      title={isFullscreen ? "Restore Agent" : "Maximize Agent"}
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
        className="h-8 w-10 rounded-none text-zinc-400 hover:bg-red-500/85 hover:text-white focus-visible:ring-2 focus-visible:ring-red-400/70"
        onClick={onClose}
        aria-label="Close Agent"
        title="Close Agent"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
