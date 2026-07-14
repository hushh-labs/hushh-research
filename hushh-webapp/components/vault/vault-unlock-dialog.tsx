"use client";

import { useEffect, useId } from "react";
import type { User } from "firebase/auth";

import { VaultFlow } from "@/components/vault/vault-flow";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";

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

// A vault sheet is an exclusive credential interaction. Keep the shell chrome
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

  useEffect(() => {
    if (!open) return;

    activeVaultUnlockSurfaces.set(surfaceId, surfaceVariant);
    syncVaultUnlockSurfaceDataset();

    return () => {
      activeVaultUnlockSurfaces.delete(surfaceId);
      syncVaultUnlockSurfaceDataset();
    };
  }, [open, surfaceId, surfaceVariant]);

  // Presented as a native iOS bottom sheet (vaul Drawer): anchored to the
  // bottom, rounded top, grabber handle, slide-up, with a modal blur scrim that
  // blocks the app underneath. When it is the hard vault gate (dismissible
  // false) vaul disables swipe/scrim/escape dismissal; the onOpenChange guard is
  // a belt-and-suspenders backstop.
  return (
    <Drawer
      open={open}
      modal
      dismissible={dismissible}
      // Let the native iOS/Capacitor webview own keyboard avoidance. vaul's own
      // input-repositioning shifts the whole sheet UP when the autofocused vault
      // key field gains focus — on a device/simulator where no software keyboard
      // is shown that leaves the sheet detached from the bottom with a gap below.
      repositionInputs={false}
      onOpenChange={(nextOpen) => {
        if (!dismissible && !nextOpen) return;
        onOpenChange?.(nextOpen);
      }}
    >
      <DrawerContent
        data-vault-unlock-surface={surfaceVariant}
        overlayClassName={
          surfaceVariant === "hard_gate"
            ? "!animate-none !backdrop-blur-none [-webkit-backdrop-filter:none]"
            : undefined
        }
        // The hard gate cannot rely on a generated utility class to override
        // the shared translucent drawer scrim. It must be an opaque canvas at
        // render time so no persistent shell chrome can show through.
        overlayStyle={
          surfaceVariant === "hard_gate"
            ? {
                backgroundColor: "var(--background)",
                backdropFilter: "none",
                WebkitBackdropFilter: "none",
                opacity: 1,
                animation: "none",
                transition: "none",
              }
            : undefined
        }
        className={[
          // The form remains one calm, opaque sheet. A hard gate swaps only the
          // backdrop to the opaque theme canvas above; contextual unlock
          // prompts keep the shared modal scrim.
          "mx-auto max-h-[92svh] overflow-hidden rounded-t-[34px] border-0 bg-white shadow-[0_-16px_50px_rgba(0,0,0,0.45)] outline-none focus:outline-none focus-visible:outline-none sm:max-w-md dark:bg-[#141416]",
        ].join(" ")}
      >
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{description}</DrawerDescription>
        <VaultFlow
          user={user}
          enableGeneratedDefault={enableGeneratedDefault}
          onSuccess={onSuccess}
          onSignOut={onSignOut}
        />
      </DrawerContent>
    </Drawer>
  );
}
