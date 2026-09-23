"use client";

import { MenuIcon, XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export interface AnimatedMenuCrossIconProps {
  isOpen: boolean;
  className?: string;
}

/** Crossfade canonical glyphs; never draw a separate host-specific icon. */
export function AnimatedMenuCrossIcon({ isOpen, className }: AnimatedMenuCrossIconProps) {
  return (
    <span className={cn("pointer-events-none relative inline-flex size-4", className)} aria-hidden="true">
      <MenuIcon className={cn("absolute inset-0 size-4 transition-opacity duration-100 motion-reduce:transition-none", isOpen ? "opacity-0" : "opacity-100")} />
      <XIcon className={cn("absolute inset-0 size-4 transition-opacity duration-100 motion-reduce:transition-none", isOpen ? "opacity-100" : "opacity-0")} />
    </span>
  );
}
