"use client";

import type { User } from "firebase/auth";

import { VaultFlow } from "@/components/vault/vault-flow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

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
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!dismissible && !nextOpen) return;
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="left-1/2 top-[calc(var(--top-shell-reserved-height,0px)+0.75rem)] z-[520] w-[calc(100%-1rem)] max-h-[calc(100svh-1rem)] -translate-x-1/2 translate-y-0 border-none bg-transparent p-0 shadow-none sm:top-[50%] sm:max-w-md sm:-translate-y-1/2"
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <VaultFlow
          user={user}
          enableGeneratedDefault={enableGeneratedDefault}
          onSuccess={onSuccess}
        />
      </DialogContent>
    </Dialog>
  );
}
