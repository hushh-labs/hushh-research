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
import { useIsMobile } from "@/hooks/use-mobile";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ConnectionsDrawerMode;
  externalModalOpen: boolean;
  chats: ReactNode;
  connections: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const drawer = useRef<HTMLDivElement>(null);
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
  useLayoutEffect(() => {
    modeAtOpen.current = mode;
  }, [mode]);
  useLayoutEffect(() => {
    if (!open) return;
    // WebKit pointer activation doesn't focus buttons; an explicit trigger
    // reference restores focus reliably for both pointer and keyboard users.
    returnFocus.current = triggerRef.current;
    // The transcript becomes inert in this commit. Move focus now so an
    // immediate Escape cannot land on the old, inert trigger before a RAF.
    if (modeAtOpen.current === "chats") focused()[0]?.focus({ preventScroll: true });
  }, [open, triggerRef]);
  useEffect(() => {
    if (open) return;
    // Passive closed-state effect runs after sibling inert attributes clear.
    restoreFocus();
    returnFocus.current = null;
  }, [open, restoreFocus]);
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
      {connectorHost && createPortal(connections, connectorHost)}
      {presentationReady && (isMobile ? (
        <Sheet open={connectorsOpen} onOpenChange={onOpenChange} modal={!externalModalOpen}>
          <SheetContent {...connectorContentProps} side="bottom" contentDragDismiss={false} className="h-[85dvh] gap-0 overflow-hidden p-0">
            <SheetTitle className="sr-only">Connectors</SheetTitle>
            <div ref={attachConnectorHost} className="min-h-0 flex-1 overflow-hidden" inert={externalModalOpen} />
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={connectorsOpen} onOpenChange={onOpenChange} modal={!externalModalOpen}>
          <DialogContent {...connectorContentProps} className="h-[min(42rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-md" srDescription="Manage your connected apps.">
            <DialogTitle className="sr-only">Connectors</DialogTitle>
            <div ref={attachConnectorHost} className="min-h-0 flex-1 overflow-hidden" inert={externalModalOpen} />
          </DialogContent>
        </Dialog>
      ))}
      <div
        aria-hidden="true"
        className={cn(
          "fixed inset-0 bg-black/35 transition-opacity duration-150 motion-reduce:transition-none dark:bg-black/55",
          "z-[520]",
          historyOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => {
          if (!externalModalOpen) onOpenChange(false);
        }}
      />
      <div
        ref={drawer}
        role="dialog"
        aria-modal={externalModalOpen ? undefined : true}
        aria-label="Agent chat history"
        aria-hidden={!historyOpen || externalModalOpen}
        inert={!historyOpen || externalModalOpen}
        onKeyDown={keyDown}
        className={cn(
          "absolute bottom-0 transform transition-transform duration-150 motion-reduce:transition-none ease-out",
          "left-0 top-[var(--agent-chat-header-height)] z-[530] w-[min(88vw,320px)]",
          historyOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          hidden={mode !== "chats"}
          inert={mode !== "chats"}
          className="h-full min-h-0"
        >
          {chats}
        </div>
      </div>
    </>
  );
}
