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

// 1. Extracted props into an explicit interface for better type reusability and clean export
export interface KaiControlSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  contentClassName?: string;
}

export function KaiControlSurface({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  children,
  footer,
  bodyClassName,
  contentClassName,
}: KaiControlSurfaceProps) {
  const isMobile = useIsMobile();

  // 2. Renamed to PascalCase to denote it returns JSX, and aligned desktop horizontal padding (sm:px-6) with the DialogHeader padding
  const ContentBody = (
    <div
      className={cn(
        "relative flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 sm:px-6 sm:pt-5",
        bodyClassName
      )}
    >
      {children}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {/* 3. Applied the missing `contentClassName` to the DrawerContent */}
        <DrawerContent
          className={cn(
            "max-h-[85dvh] rounded-t-[var(--app-card-radius-feature)] border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-feature)]",
            contentClassName
          )}
        >
          <DrawerHeader className="relative z-10 border-b border-[color:var(--app-card-border-standard)] px-4 py-4 text-left">
            {/* 4. Used && logical operators instead of ternary ? ... : null for cleaner JSX */}
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {eyebrow}
              </p>
            )}
            <DrawerTitle className="text-base font-semibold tracking-tight">{title}</DrawerTitle>
            {description && (
              <DrawerDescription className="text-sm leading-6">{description}</DrawerDescription>
            )}
          </DrawerHeader>

          {ContentBody}

          {footer && (
            <DrawerFooter className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-4">
              {footer}
            </DrawerFooter>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        showCloseButton
        className={cn(
          "max-h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-0 sm:max-w-[min(42rem,calc(100vw-4.5rem))] lg:max-w-[min(46rem,calc(100vw-8rem))]",
          contentClassName
        )}
      >
        <DialogHeader className="relative z-10 border-b border-[color:var(--app-card-border-standard)] px-6 py-5 text-left">
          {eyebrow && (
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <div className="space-y-1">
            <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
              {title}
            </DialogTitle>
            {description && (
              <DialogDescription className="text-sm leading-6 text-muted-foreground">
                {description}
              </DialogDescription>
            )}
          </div>
        </DialogHeader>

        {ContentBody}

        {footer && (
          <DialogFooter className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-6 py-4 sm:justify-end">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}