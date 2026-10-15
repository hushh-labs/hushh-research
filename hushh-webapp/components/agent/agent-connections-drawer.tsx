"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useNativeNavigationBlockedUntilSettled } from "@/lib/capacitor/native-navigation";
import { useNativeFullWindowOverlayReady } from "@/lib/capacitor/native-presentation-regions";
import { AppChatHistoryEdgeGesture } from "@/components/app-ui/app-chat-history-edge-gesture";
import { useNativePanelPresentation } from "@/lib/capacitor/native-panel-presentation";

const selector =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export type ConnectionsDrawerMode = "chats" | "connections";

export type ConnectionsDrawerState = {
  open: boolean;
  mode: ConnectionsDrawerMode;
};

/** Closing resets to chats; the hamburger always targets chat navigation. */
export function transitionConnectionsDrawer(
  state: ConnectionsDrawerState,
  action: { type: "set-open"; open: boolean } | { type: "toggle-chats" },
): ConnectionsDrawerState {
  if (action.type === "toggle-chats")
    return { open: !state.open, mode: "chats" };
  return { open: action.open, mode: action.open ? state.mode : "chats" };
}

/** History and its connector child stay in the same leading pane.
 * Neither surface replaces the transcript or its unsent draft. */
export function AgentConnectionsDrawer({
  open,
  onOpenChange,
  mode,
  externalModalOpen,
  chats,
  connections,
  triggerRef,
  fallbackFocusRef,
  gestureSurfaceRef,
  gestureEnabled = false,
  presentationKey,
  onGestureOpen,
  onRestoreHistoryFocus,
  historyRenderer = "web",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ConnectionsDrawerMode;
  externalModalOpen: boolean;
  chats: ReactNode;
  connections: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>;
  gestureSurfaceRef?: RefObject<HTMLElement | null>;
  gestureEnabled?: boolean;
  presentationKey?: string;
  onGestureOpen?: () => void;
  /** Owning Chat chrome handles native/DOM return exactly once. */
  onRestoreHistoryFocus?: () => void;
  historyRenderer?: "web" | "preparing" | "native" | "blocked";
}) {
  const drawer = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const [presentationReady, setPresentationReady] = useState(false);
  const [connectorHost, setConnectorHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = document.createElement("div");
    host.className = "h-full min-h-0";
    setConnectorHost(host);
    setPresentationReady(true);
    return () => host.remove();
  }, []);
  // Radix replaces its content implementation when an external Picker takes
  // modal ownership. Keep the stateful panel in one stable portal so that
  // handoff (or a breakpoint change) cannot abort OAuth/Picker or lose drafts.
  const attachConnectorHost = useCallback((node: HTMLDivElement | null) => {
    if (node && connectorHost) node.appendChild(connectorHost);
  }, [connectorHost]);
  const historyOpen = open && historyRenderer === "web";
  const historyReady = useNativeFullWindowOverlayReady(historyOpen);
  const historyDisplayed = historyOpen && historyReady;
  const attachNativePanel = useNativePanelPresentation("history", presentationKey ?? null, drawer, historyOpen);
  useNativeNavigationBlockedUntilSettled(historyOpen, "chat-history", drawer);
  const returnFocus = useRef<HTMLElement | null>(null);
  const modalActive = useRef(externalModalOpen);
  const restoreFocus = useCallback(() => {
    const target = [returnFocus.current, triggerRef.current, fallbackFocusRef?.current]
      .find((element) => element?.isConnected && !element.closest("[inert], [hidden]"));
    target?.focus({ preventScroll: true });
  }, [triggerRef, fallbackFocusRef]);
  useLayoutEffect(() => {
    modalActive.current = externalModalOpen;
  }, [externalModalOpen]);
  const focused = () =>
    Array.from(
      drawer.current?.querySelectorAll<HTMLElement>(selector) ?? [],
    ).filter(
      (element) =>
        !element.closest("[hidden], [inert]") && element.offsetParent !== null,
    );
  // Read at open time only: switching views while open must not move focus.
  const modeAtOpen = useRef(mode);
  const wasHistoryOpen = useRef(false);
  useLayoutEffect(() => {
    modeAtOpen.current = mode;
  }, [mode]);
  useLayoutEffect(() => {
    if (!open || historyRenderer !== "web") return;
    wasHistoryOpen.current = modeAtOpen.current === "chats";
    // WebKit pointer activation doesn't focus buttons; an explicit trigger
    // reference restores focus reliably for both pointer and keyboard users.
    returnFocus.current = triggerRef.current;
    // The transcript becomes inert in this commit. Move focus now so an
    // immediate Escape cannot land on the old, inert trigger before a RAF.
    if (modeAtOpen.current === "chats") focused()[0]?.focus({ preventScroll: true });
  }, [open, triggerRef, historyRenderer]);
  useLayoutEffect(() => {
    if (!historyDisplayed || mode !== "chats" || externalModalOpen) return;
    const active = document.activeElement;
    // Returning from Connectors makes its focused Back control inert in this
    // commit. Transfer focus before paint, not after a later animation frame,
    // so a second Escape cannot be delivered to the retired child.
    if (active instanceof HTMLElement && active.closest("[hidden], [inert]")) {
      focused()[0]?.focus({ preventScroll: true });
    }
  }, [historyDisplayed, mode, externalModalOpen]);
  useEffect(() => {
    if (open) return;
    if (modeAtOpen.current === "chats" && onRestoreHistoryFocus) {
      // Do not race native focus return with an independent DOM focus path.
      if (returnFocus.current !== null || wasHistoryOpen.current) onRestoreHistoryFocus();
      wasHistoryOpen.current = false; returnFocus.current = null; return;
    }
    // Passive closed-state effect runs after sibling inert attributes clear.
    restoreFocus();
    returnFocus.current = null;
  }, [open, restoreFocus, onRestoreHistoryFocus]);
  useEffect(() => {
    if (!historyDisplayed || modalActive.current) return;
    let current = true;
    const initialFocus = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const body = drawer.current;
      // The whole panel translates. Focusing its footer while clipped can
      // be refused (or scroll the panel).
      // Only finite entry motion owns this wait, never child loading spinners.
      const entry = body?.getAnimations?.().filter(animation =>
        (animation.effect as KeyframeEffect | null)?.target === body &&
        animation.effect?.getComputedTiming().iterations !== Infinity,
      ) ?? [];
      void Promise.allSettled(entry.map(animation => animation.finished)).then(() => {
        if (!current || body !== drawer.current || modalActive.current || drawer.current?.closest("[inert]") ||
            document.activeElement !== initialFocus) return;
        drawer.current?.querySelector<HTMLElement>('[aria-label="Open Connectors"]')
          ?.focus({ preventScroll: true });
      });
    });
    return () => { current = false; cancelAnimationFrame(frame); };
  }, [mode, historyDisplayed]);
  useEffect(() => {
    if (!historyOpen) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      // Recover only the brief focus gap while entering/switching views. Some
      // engines retain the authored trigger until the body's entry completes.
      // An Escape originating in a provider/Radix portal must not also close
      // this drawer when that portal disposes itself during the same event.
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !modalActive.current &&
        (event.target === document.body ||
          event.target === document.documentElement ||
          event.target === triggerRef.current ||
          event.target === returnFocus.current)
      )
        onOpenChange(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [historyOpen, onOpenChange, triggerRef]);
  const keyDown = (event: KeyboardEvent) => {
    if (externalModalOpen || event.defaultPrevented) return;
    if (event.key === "Escape") {
      // A dialog opened from the drawer is a separate top layer. React portal
      // events still bubble through this tree; leave its Escape to Radix.
      if (event.target instanceof Element && event.target.closest('[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"]')) return;
      event.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focused();
    const first = elements[0];
    const last = elements.at(-1);
    if (!first) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <>
      {gestureSurfaceRef ? <AppChatHistoryEdgeGesture
        enabled={historyRenderer === "web" && presentationReady && gestureEnabled && mode === "chats" && !externalModalOpen}
        open={historyOpen}
        presentationKey={presentationKey}
        surfaceRef={gestureSurfaceRef} drawerRef={drawer} motionRef={drawer} scrimRef={scrim}
        onOpen={onGestureOpen ?? (() => onOpenChange(true))}
        onClose={() => onOpenChange(false)} /> : null}
      {connectorHost && createPortal(connections, connectorHost)}
      {presentationReady && createPortal(
        <>
          <div
            aria-hidden="true"
            data-agent-history-scrim
            ref={scrim}
            className={cn(
              // A modal side drawer (founder direction, 2026-09-28): the scrim covers
              // the whole viewport, the chat header and the bottom bar included, so
              // everything behind recedes uniformly. It is portalled to <body> with
              // the panel below: inside the workspace it shared that subtree's
              // stacking context, and the fixed bottom bar (a separate one) could
              // never be out-z'd from there. At the body it takes the same sheet
              // tier as SheetOverlay, above chrome and the header.
              "fixed inset-0",
              // The shared modal scrim, token for token with SheetOverlay, so the chat
              // recedes exactly as it does behind a sheet or dialog (the coarse-pointer
              // and native Android downgrades in globals.css apply here too). Only
              // opacity animates; the blur radius is fixed. Closed, it is invisible, so
              // no backdrop filter stays composited while the drawer is shut.
              "z-(--z-sheet-overlay) touch-none bg-[color:var(--app-scrim-color)] [backdrop-filter:var(--app-scrim-filter)] [-webkit-backdrop-filter:var(--app-scrim-filter)]",
              "transition-[opacity,visibility] motion-reduce:transition-none",
              historyDisplayed
                ? "pointer-events-auto visible opacity-100 duration-(--motion-sheet-enter-duration) ease-(--motion-sheet-enter-ease)"
                : "pointer-events-none invisible opacity-0 duration-(--motion-sheet-exit-duration) ease-(--motion-sheet-exit-ease)",
            )}
            onClick={() => {
              if (!externalModalOpen) onOpenChange(false);
            }}
          />
          <div
            ref={attachNativePanel}
            role="dialog"
            data-agent-history-drawer
            data-native-panel-group="history"
            data-state={historyOpen ? "open" : "closed"}
            data-app-side-pane
            aria-modal={externalModalOpen ? undefined : true}
            aria-label={mode === "connections" ? "Chat connectors" : "Agent chat history"}
            aria-hidden={!historyDisplayed || externalModalOpen}
            inert={!historyDisplayed || externalModalOpen}
            onKeyDown={keyDown}
            className={cn(
              // Match Profile's bounded inset card at the leading edge. The
              // shared CSS owns geometry; this owner retains focus and motion.
              "pointer-events-none fixed z-(--z-sheet) touch-pan-y transform transition-[transform,translate,visibility] motion-reduce:transition-none",
              historyDisplayed
                ? "visible translate-x-0 duration-(--motion-sheet-enter-duration) ease-(--motion-sheet-enter-ease)"
                : "invisible translate-x-[calc(-100%_-_var(--agent-history-shadow-clearance)_-_var(--app-side-pane-left-inset))] duration-(--motion-sheet-exit-duration) ease-(--motion-sheet-exit-ease)",
            )}
          >
            <div
              hidden={mode !== "chats"}
              inert={mode !== "chats"}
              className="pointer-events-auto h-full min-h-0"
            >
              {historyRenderer === "web" ? chats : null}
            </div>
            <div ref={attachConnectorHost} data-connector-host hidden={mode !== "connections" || historyRenderer !== "web"}
              inert={mode !== "connections" || externalModalOpen || historyRenderer !== "web"}
              className="pointer-events-auto h-full min-h-0 overflow-hidden" />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
