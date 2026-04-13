"use client";

import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export function KaiControlSurface({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  children,
  footer,
  bodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
}) {
  const isMobile = useIsMobile();

  const body = (
    <div
      className={cn(
        "relative flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 sm:px-5 sm:pt-5",
        bodyClassName
      )}
    >
      {children}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[85dvh] rounded-t-[var(--app-card-radius-feature)] border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-feature)]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-36 rounded-t-[var(--app-card-radius-feature)] bg-[radial-gradient(120%_100%_at_50%_0%,rgba(99,102,241,0.09)_0%,rgba(59,130,246,0.05)_38%,transparent_72%),linear-gradient(180deg,rgba(255,255,255,0.08)_0%,transparent_100%)] dark:bg-[radial-gradient(120%_100%_at_50%_0%,rgba(96,165,250,0.14)_0%,rgba(14,165,233,0.07)_38%,transparent_72%),linear-gradient(180deg,rgba(255,255,255,0.04)_0%,transparent_100%)]"
          />
          <DrawerHeader className="relative z-10 border-b border-[color:var(--app-card-border-standard)] px-4 py-4 text-left">
            {eyebrow ? (
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            <DrawerTitle className="text-base font-semibold tracking-tight">{title}</DrawerTitle>
            {description ? (
              <DrawerDescription className="text-sm leading-6">{description}</DrawerDescription>
            ) : null}
          </DrawerHeader>
          {body}
          {footer ? (
            <DrawerFooter className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-4">
              {footer}
            </DrawerFooter>
          ) : null}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        showCloseButton
        className="max-h-[calc(100dvh-3rem)] gap-0 overflow-hidden border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-0 sm:max-w-[560px]"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(99,102,241,0.1)_0%,rgba(59,130,246,0.05)_42%,transparent_74%),linear-gradient(180deg,rgba(255,255,255,0.08)_0%,transparent_100%)] dark:bg-[radial-gradient(120%_100%_at_50%_0%,rgba(96,165,250,0.12)_0%,rgba(14,165,233,0.06)_42%,transparent_74%),linear-gradient(180deg,rgba(255,255,255,0.04)_0%,transparent_100%)]"
        />
        <DialogHeader className="relative z-10 border-b border-[color:var(--app-card-border-standard)] px-6 py-5 text-left">
          {eyebrow ? (
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <div className="space-y-1">
            <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-sm leading-6 text-muted-foreground">
                {description}
              </DialogDescription>
            ) : null}
          </div>
        </DialogHeader>
        {body}
        {footer ? (
          <DialogFooter className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-6 py-4 sm:justify-end">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
