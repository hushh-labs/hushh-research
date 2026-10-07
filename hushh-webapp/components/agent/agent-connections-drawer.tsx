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
import { useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AppChatHistoryEdgeGesture } from "@/components/app-ui/app-chat-history-edge-gesture";

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

/** History stays mounted on the left; connectors use the shared modal/sheet.
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
}) {
  const drawer = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
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
  const historyOpen = open && mode === "chats";
  useNativeNavigationBlocked(historyOpen, "chat-history");
  const connectorsOpen = open && mode === "connections";
  const connectorActive = useRef(connectorsOpen);
  useLayoutEffect(() => { connectorActive.current = connectorsOpen; }, [connectorsOpen]);
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
    if (!open) return;
    wasHistoryOpen.current = modeAtOpen.current === "chats";
    // WebKit pointer activation doesn't focus buttons; an explicit trigger
    // reference restores focus reliably for both pointer and keyboard users.
    returnFocus.current = triggerRef.current;
    // The transcript becomes inert in this commit. Move focus now so an
    // immediate Escape cannot land on the old, inert trigger before a RAF.
    if (modeAtOpen.current === "chats") focused()[0]?.focus({ preventScroll: true });
  }, [open, triggerRef]);
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
    if (!historyOpen || modalActive.current) return;
    const frame = requestAnimationFrame(() => {
      if (mode === "chats")
        drawer.current
          ?.querySelector<HTMLElement>('[aria-label="Open Connectors"]')
          ?.focus({ preventScroll: true });
      else focused()[0]?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, historyOpen]);
  useEffect(() => {
    if (!historyOpen) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      // Recover only the brief body-focus gap while switching nested views.
      // An Escape originating in a provider/Radix portal must not also close
      // this drawer when that portal disposes itself during the same event.
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !modalActive.current &&
        (event.target === document.body ||
          event.target === document.documentElement)
      )
        onOpenChange(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [historyOpen, onOpenChange]);
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
  const connectorContentProps = {
    showCloseButton: false,
    onOpenAutoFocus: (event: Event) => {
      if (modalActive.current) event.preventDefault();
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (connectorActive.current || modalActive.current) return;
      restoreFocus();
    },
    onInteractOutside: (event: Event) => {
      if (externalModalOpen) event.preventDefault();
    },
    onEscapeKeyDown: (event: Event) => {
      if (externalModalOpen) event.preventDefault();
    },
  };
  return (
    <>
      {gestureSurfaceRef ? <AppChatHistoryEdgeGesture
        enabled={presentationReady && gestureEnabled && mode === "chats" && !externalModalOpen}
        open={historyOpen}
        presentationKey={presentationKey}
        surfaceRef={gestureSurfaceRef} drawerRef={drawer} scrimRef={scrim}
        onOpen={onGestureOpen ?? (() => onOpenChange(true))}
        onClose={() => onOpenChange(false)} /> : null}
      {connectorHost && createPortal(connections, connectorHost)}
      {presentationReady && (isMobile ? (
        <Sheet open={connectorsOpen} onOpenChange={onOpenChange} modal={!externalModalOpen}>
          <SheetContent {...connectorContentProps} side="bottom" contentDragDismiss={false} className="h-[85dvh] gap-0 overflow-hidden p-0">
            <SheetTitle className="sr-only">Connectors</SheetTitle>
            <div ref={attachConnectorHost} data-connector-host className="min-h-0 flex-1 overflow-hidden" inert={externalModalOpen} />
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={connectorsOpen} onOpenChange={onOpenChange} modal={!externalModalOpen}>
          <DialogContent {...connectorContentProps} className="agent-connections-dialog h-[min(42rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-md" srDescription="Manage your connected apps.">
            <DialogTitle className="sr-only">Connectors</DialogTitle>
            <div ref={attachConnectorHost} data-connector-host className="min-h-0 flex-1 overflow-hidden" inert={externalModalOpen} />
          </DialogContent>
        </Dialog>
      ))}
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
              historyOpen
                ? "pointer-events-auto visible opacity-100 duration-140 ease-[cubic-bezier(0.16,1,0.3,1)]"
                : "pointer-events-none invisible opacity-0 duration-100 ease-[cubic-bezier(0.4,0,1,1)]",
            )}
            onClick={() => {
              if (!externalModalOpen) onOpenChange(false);
            }}
          />
          <div
            ref={drawer}
            role="dialog"
            data-agent-history-drawer
            aria-modal={externalModalOpen ? undefined : true}
            aria-label="Agent chat history"
            aria-hidden={!historyOpen || externalModalOpen}
            inert={!historyOpen || externalModalOpen}
            onKeyDown={keyDown}
            className={cn(
              // Full height, flush to the leading edge, on the sheet tier: the panel
              // runs over the chat header and the bottom bar, and its surface pads
              // the safe areas itself (so the notch is surface, not a gap). Phones
              // get a nearly full-width panel that leaves a strip of scrim to tap
              // closed; from md up it keeps the drawer's 336px. Closed, it also
              // clears its own shadow. Motion uses the shared sheet tier.
              "pointer-events-none fixed inset-y-0 left-0 z-(--z-sheet) touch-pan-y transform transition-transform motion-reduce:transition-none",
              "w-[min(88vw,360px)] md:w-[336px]",
              historyOpen
                ? "translate-x-0 duration-(--motion-sheet-enter-duration) ease-(--motion-sheet-enter-ease)"
                : "translate-x-[calc(-100%_-_3rem)] duration-(--motion-sheet-exit-duration) ease-(--motion-sheet-exit-ease)",
            )}
          >
            <div
              hidden={mode !== "chats"}
              inert={mode !== "chats"}
              className="pointer-events-auto h-full min-h-0"
            >
              {chats}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
