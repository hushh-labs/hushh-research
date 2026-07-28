"use client";

import { useEffect, useId, useState } from "react";
import type { User } from "firebase/auth";
import { Dialog as DialogPrimitive } from "radix-ui";

import { VaultFlow } from "@/components/vault/vault-flow";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type VaultUnlockDialogProps = {
  user: User;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onSuccess: (meta?: { mode: "passphrase" | "generated_default_native_biometric" | "generated_default_web_prf" | "generated_default_native_passkey_prf" }) => void;
  title: string;
  description: string;
  enableGeneratedDefault?: boolean;
  dismissible?: boolean;
  /**
   * A non-dismissible route gate is a focused credential surface, not a
   * floating prompt. It replaces visible app chrome with an opaque theme canvas
   * while preserving the same vault-unlock flow and focus trap.
   */
  surfaceVariant?: "standard" | "hard_gate";
  /**
   * When provided, VaultFlow shows a subtle "Sign out" escape on the unlock /
   * recovery steps. Passed only by the HARD vault gate (VaultLockGuard), where a
   * user who forgot their vault password would otherwise be trapped. Omitted by
   * the dismissible top-bar unlock (the user can just close that sheet).
   */
  onSignOut?: () => void | Promise<void>;
};

// A vault surface is an exclusive credential interaction. Keep the shell chrome
// out of the accessibility and visual stack for its entire lifetime, including
// the short close animation. A ref-counted registry makes nested or overlapping
// vault callers safe: one unmount cannot restore chrome while another vault
// sheet is still open.
const activeVaultUnlockSurfaces = new Map<string, "standard" | "hard_gate">();

function syncVaultUnlockSurfaceDataset() {
  if (typeof document === "undefined") return;

  const active = activeVaultUnlockSurfaces.size > 0;
  const hardGate = Array.from(activeVaultUnlockSurfaces.values()).includes("hard_gate");

  // `html` owns theme variables; `body` is also marked because the shell
  // components are mounted below it and some native/webview layouts scope
  // their chrome styles from the body rather than the root element.
  for (const target of [document.documentElement, document.body]) {
    target?.toggleAttribute("data-vault-unlock-active", active);
    target?.toggleAttribute("data-vault-unlock-hard-gate", hardGate);
  }
}

export function VaultUnlockDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
  title,
  description,
  enableGeneratedDefault = false,
  dismissible = true,
  surfaceVariant = "standard",
  onSignOut,
}: VaultUnlockDialogProps) {
  const surfaceId = useId();
  const [recoveryKeyDisclosureActive, setRecoveryKeyDisclosureActive] =
    useState(false);
  const effectiveDismissible =
    dismissible && !recoveryKeyDisclosureActive;

  useEffect(() => {
    if (!open) return;

    activeVaultUnlockSurfaces.set(surfaceId, surfaceVariant);
    syncVaultUnlockSurfaceDataset();

    return () => {
      activeVaultUnlockSurfaces.delete(surfaceId);
      syncVaultUnlockSurfaceDataset();
    };
  }, [open, surfaceId, surfaceVariant]);

  useEffect(() => {
    if (!open) {
      setRecoveryKeyDisclosureActive(false);
    }
  }, [open]);

  // The unlock flow is a stable upper-viewport credential layout, never a
  // bottom sheet. This prevents a native keyboard from moving the entire vault
  // surface; VaultFlow scrolls its own form content when needed.
  return (
    <Dialog
      open={open}
      modal
      onOpenChange={(nextOpen) => {
        if (!effectiveDismissible && !nextOpen) return;
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "!z-[711] !backdrop-blur-none [-webkit-backdrop-filter:none]",
            surfaceVariant === "hard_gate" && "!animate-none",
          )}
          style={{
            backgroundColor: "var(--background)",
            backdropFilter: "none",
            WebkitBackdropFilter: "none",
            opacity: 1,
            ...(surfaceVariant === "hard_gate"
              ? {
                  animation: "none",
                  transition: "none",
                }
              : {}),
          }}
        />
        <DialogPrimitive.Content
          data-vault-unlock-surface={surfaceVariant}
          data-vault-layout="top-centered-flat"
          data-vault-dismissible={effectiveDismissible}
          style={{
            position: "fixed",
            zIndex: 712,
            top: "max(calc(env(safe-area-inset-top, 0px) + 1.5rem), 6svh)",
            left: "50%",
            width: "calc(100% - 2rem)",
            maxWidth: "28rem",
            maxHeight: "min(58svh, 640px)",
            transform: "translateX(-50%)",
            overflow: "visible",
            background: "transparent",
            border: 0,
            borderRadius: 0,
            boxShadow: "none",
            padding: 0,
          }}
          className="outline-none focus:outline-none focus-visible:outline-none"
          onEscapeKeyDown={(event) => {
            if (!effectiveDismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!effectiveDismissible) event.preventDefault();
          }}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          <VaultFlow
            user={user}
            enableGeneratedDefault={enableGeneratedDefault}
            onSuccess={onSuccess}
            onRecoveryKeyDisclosureChange={
              setRecoveryKeyDisclosureActive
            }
            onSignOut={onSignOut}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
