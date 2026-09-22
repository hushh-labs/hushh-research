"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

const selector =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export type ConnectionsDrawerMode = "chats" | "connections";

/** The production drawer, also mounted unchanged in browser contracts. Both
 * views stay mounted so switching preserves history search/scroll and drafts. */
export function AgentConnectionsDrawer({
  open,
  onOpenChange,
  mode,
  externalModalOpen,
  chats,
  connections,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ConnectionsDrawerMode;
  externalModalOpen: boolean;
  chats: ReactNode;
  connections: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const drawer = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const modalActive = useRef(externalModalOpen);
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
  useEffect(() => {
    if (!open) return;
    // WebKit pointer activation doesn't focus buttons; an explicit trigger
    // reference restores focus reliably for both pointer and keyboard users.
    returnFocus.current = triggerRef.current;
    const frame = requestAnimationFrame(() => focused()[0]?.focus());
    return () => {
      cancelAnimationFrame(frame);
      returnFocus.current?.focus();
      returnFocus.current = null;
    };
  }, [open, triggerRef]);
  useEffect(() => {
    if (!open || modalActive.current) return;
    const frame = requestAnimationFrame(() => {
      if (mode === "chats")
        drawer.current
          ?.querySelector<HTMLElement>('[aria-label="Open Connections"]')
          ?.focus();
      else focused()[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, open]);
  useEffect(() => {
    if (!open) return;
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
  }, [open, onOpenChange]);
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
  return (
    <>
      <div
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-[520] bg-black/35 transition-opacity duration-150 motion-reduce:transition-none dark:bg-black/55",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => {
          if (!externalModalOpen) onOpenChange(false);
        }}
      />
      <div
        ref={drawer}
        role="dialog"
        aria-modal={externalModalOpen ? undefined : true}
        aria-label={mode === "chats" ? "Agent chat history" : "Connections"}
        aria-hidden={!open || externalModalOpen}
        inert={!open || externalModalOpen}
        onKeyDown={keyDown}
        className={cn(
          "absolute bottom-0 left-0 top-[var(--agent-chat-header-height)] z-[530] w-[min(88vw,320px)] transform transition-transform duration-150 motion-reduce:transition-none ease-out",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          hidden={mode !== "chats"}
          inert={mode !== "chats"}
          className="h-full min-h-0"
        >
          {chats}
        </div>
        <div
          hidden={mode !== "connections"}
          inert={mode !== "connections"}
          className="h-full min-h-0"
        >
          {connections}
        </div>
      </div>
    </>
  );
}
