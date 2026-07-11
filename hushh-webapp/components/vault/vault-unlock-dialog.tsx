"use client";

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
   * When provided, VaultFlow shows a subtle "Sign out" escape on the unlock /
   * recovery steps. Passed only by the HARD vault gate (VaultLockGuard), where a
   * user who forgot their vault password would otherwise be trapped. Omitted by
   * the dismissible top-bar unlock (the user can just close that sheet).
   */
  onSignOut?: () => void | Promise<void>;
};

export function VaultUnlockDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
  title,
  description,
  enableGeneratedDefault = false,
  dismissible = true,
  onSignOut,
}: VaultUnlockDialogProps) {
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
        className={[
          // 16b / design.md §5.8: a solid action sheet (white in light, dark
          // surface in dark) that rises over the immersive hero — top radius
          // 34px + a deep lifted shadow. No translucency: the sheet is the calm
          // white form surface, the dark hero sits behind the scrim.
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
