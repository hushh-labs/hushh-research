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

// =============================================================================
// INTERACTIVE STRUCTURAL SIZE PRESETS
// =============================================================================

export type ControlSurfaceSize = "sm" | "md" | "lg" | "xl" | "full";

const MODAL_SIZE_MAP: Record<ControlSurfaceSize, string> = {
  sm: "sm:max-w-[min(32rem,calc(100vw-4.5rem))]",
  md: "sm:max-w-[min(42rem,calc(100vw-4.5rem))] lg:max-w-[min(46rem,calc(100vw-8rem))]",
  lg: "sm:max-w-[min(52rem,calc(100vw-4.5rem))] lg:max-w-[min(64rem,calc(100vw-8rem))]",
  xl: "sm:max-w-[min(64rem,calc(100vw-4.5rem))] lg:max-w-[min(80rem,calc(100vw-8rem))]",
  full: "sm:max-w-[calc(100vw-2rem)] h-[calc(100dvh-2rem)]",
};

export interface KaiControlSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: ControlSurfaceSize; // New Feature: Dynamic size mapping controls
  bodyClassName?: string;
  contentClassName?: string;
}

// =============================================================================
// MAIN POLISHED INTERACTIVE CONTROL SURFACE COMPONENT
// =============================================================================

export function KaiControlSurface({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  children,
  footer,
  size = "md",
  bodyClassName,
  contentClassName,
}: KaiControlSurfaceProps) {
  const isMobile = useIsMobile();

  // Unified body content container with flex parameters to handle safe-scrolling fields
  const renderedBody = (
    <div
      className={cn(
        "relative flex-1 overflow-y-auto outline-none min-h-0",
        "px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-4 sm:px-6 sm:pt-5 sm:pb-6",
        bodyClassName
      )}
      tabIndex={-1} // Ensures screen reader focus jumps smoothly to long scrollable blocks
    >
      {children}
    </div>
  );

  // ===========================================================================
  // 1. MOBILE BOTTOM DRAWER IMPLEMENTATION
  // ===========================================================================
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent 
          className={cn(
            "max-h-[85dvh] flex flex-col overflow-hidden outline-none",
            "rounded-t-[var(--app-card-radius-feature,24px)] border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-feature)]",
            contentClassName
          )}
        >
          {/* Assistive visual grab handle bar slot */}
          <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-muted/60" />

          <DrawerHeader className="relative z-10 border-b border-[color:var(--app-card-border-standard)] px-4 pb-4 pt-2 text-left shrink-0">
            {eyebrow && (
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-1">
                {eyebrow}
              </p>
            )}
            <DrawerTitle className="text-base font-bold tracking-tight text-foreground">{title}</DrawerTitle>
            {description ? (
              <DrawerDescription className="text-xs leading-5 text-muted-foreground mt-0.5">
                {description}
              </DrawerDescription>
            ) : (
              <span className="sr-only">Description omitted.</span> // Satisfies strict aria-describedby accessibility tree flags
            )}
          </DrawerHeader>

          {renderedBody}

          {footer && (
            <DrawerFooter className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-4 shrink-0">
              {footer}
            </DrawerFooter>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  // ===========================================================================
  // 2. DESKTOP CENTERED MODAL DIALOG IMPLEMENTATION
  // ===========================================================================
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        showCloseButton
        className={cn(
          "max-h-[calc(100dvh-4rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)]",
          "flex flex-col gap-0 overflow-hidden p-0 outline-none shadow-2xl rounded-[var(--app-card-radius-feature,24px)]",
          "border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]",
          MODAL_SIZE_MAP[size],
          contentClassName
        )}
      >
        <DialogHeader className="relative z-10 border-b border-[color:var(--app-card-border-standard)] px-6 py-5 text-left shrink-0">
          {eyebrow && (
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-1">
              {eyebrow}
            </p>
          )}
          <div className="space-y-0.5">
            <DialogTitle className="text-base font-bold tracking-tight text-foreground">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-xs leading-5 text-muted-foreground">
                {description}
              </DialogDescription>
            ) : (
              <span className="sr-only">Description omitted.</span>
            )}
          </div>
        </DialogHeader>

        {renderedBody}

        {footer && (
          <DialogFooter className="border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-6 py-4 shrink-0 sm:justify-end">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}