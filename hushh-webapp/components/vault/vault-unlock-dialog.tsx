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
      onOpenChange={(nextOpen) => {
        if (!dismissible && !nextOpen) return;
        onOpenChange?.(nextOpen);
      }}
    >
      <DrawerContent
        className={[
          "mx-auto max-h-[92svh] overflow-hidden rounded-t-[26px] sm:max-w-md",
          // Liquid Glass material: a highly translucent surface + heavy
          // background blur + saturation/brightness boost so the app behind
          // reads through as frosted glass, with a bright specular top rim, a
          // hairline light edge, and a deep lifted shadow.
          "border-t border-white/60 bg-background/40 dark:border-white/15 dark:bg-background/30",
          "backdrop-blur-[34px] backdrop-saturate-[2] backdrop-brightness-[1.06] [-webkit-backdrop-filter:blur(34px)_saturate(2)_brightness(1.06)]",
          "shadow-[0_-16px_64px_rgba(15,23,42,0.30),inset_0_1px_0_rgba(255,255,255,0.75),inset_0_0_0_0.5px_rgba(255,255,255,0.30)] dark:shadow-[0_-16px_64px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.20)]",
        ].join(" ")}
      >
        {/* Specular sheen — the top-edge highlight that gives Liquid Glass its lift. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-white/40 via-white/10 to-transparent dark:from-white/[0.12] dark:via-white/[0.03]"
        />
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{description}</DrawerDescription>
        <VaultFlow
          user={user}
          enableGeneratedDefault={enableGeneratedDefault}
          onSuccess={onSuccess}
        />
      </DrawerContent>
    </Drawer>
  );
}
