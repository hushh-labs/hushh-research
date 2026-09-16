"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * Security-only host for an unsettled session, not a general product modal.
 * A browser-modal dialog enters the top layer: body portals remain mounted,
 * but cannot paint above it, receive focus, or be operated while it is open.
 */
export function SessionPrivacyGate({
  children,
  onModalUnavailable,
}: {
  children: ReactNode;
  onModalUnavailable: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [fallback, setFallback] = useState(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || fallback) return;
    // Retained Radix modals listen for Escape at document capture. Intercept
    // one level earlier so a recovery keystroke cannot dismiss private state.
    const containEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dialog.open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", containEscape, true);
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      // Legacy/unsupported hosts cannot safely preserve portaled route state.
      // Drop those descendants before painting the ordinary modal fallback.
      onModalUnavailable();
      setFallback(true);
    }
    return () => {
      window.removeEventListener("keydown", containEscape, true);
      if (dialog.open) dialog.close();
    };
  }, [fallback, onModalUnavailable]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog?.open && !dialog.contains(document.activeElement)) dialog.focus();
  }, [children]);

  if (fallback) {
    return <Dialog open modal>
      <DialogContent
        showCloseButton={false}
        srDescription="Your private content remains hidden until access is verified."
        overlayClassName="z-[711] !bg-background !opacity-100 !backdrop-blur-none !animate-none"
        className="z-[712] inset-0 left-0 top-0 m-0 h-dvh w-screen max-w-none max-h-none translate-x-0 translate-y-0 rounded-none border-0 bg-background p-0 !animate-none sm:max-w-none"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Verifying access</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>;
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="Verifying access"
      aria-modal="true"
      tabIndex={-1}
      data-session-privacy-gate="true"
      onCancel={(event) => event.preventDefault()}
      // Recovery interactions are not outside-click/focus events for a
      // retained route modal. Keep its open state and draft intact.
      onPointerDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (event.key === "Tab") {
          const dialog = event.currentTarget;
          const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
            "a[href],button,input,select,textarea,[tabindex]",
          )).filter((element) => element.tabIndex >= 0 &&
            !element.hasAttribute("disabled") && element.getClientRects().length > 0);
          const first = controls[0];
          event.preventDefault();
          if (!first) {
            dialog.focus();
          } else {
            // Safari's default Tab policy may skip buttons. Explicitly cycle
            // this small safe action set instead of handing focus to browser
            // chrome or a retained modal's older focus scope.
            const current = controls.indexOf(document.activeElement as HTMLElement);
            const next = current < 0
              ? (event.shiftKey ? controls.length - 1 : 0)
              : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
            (controls[next] ?? first).focus();
          }
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
      }}
      className="backdrop:bg-background"
      style={{
        position: "fixed", inset: 0, margin: 0, width: "100vw", height: "100dvh",
        maxWidth: "none", maxHeight: "none", border: 0, padding: 0,
        background: "var(--background)", color: "var(--foreground)", overflow: "auto",
        // An already-open Radix modal can leave body pointer-events:none.
        pointerEvents: "auto",
      }}
    >
      <div className="flex min-h-full w-full items-center justify-center [&>main]:w-full">
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
