"use client";

import React from "react";
import { cn } from "@/lib/utils";

export interface AnimatedMenuCrossIconProps {
  isOpen: boolean;
  className?: string;
}

/**
 * Animated icon that smoothly transitions between a 3-bar hamburger menu and a cross (X).
 * Used for chat history drawer toggle across desktop and mobile surfaces.
 */
export function AnimatedMenuCrossIcon({
  isOpen,
  className,
}: AnimatedMenuCrossIconProps) {
  return (
    <span
      className={cn(
        "relative flex h-4 w-4 items-center justify-center pointer-events-none select-none",
        className
      )}
      aria-hidden="true"
    >
      {/* Top line */}
      <span
        className={cn(
          "absolute h-[2px] w-4 rounded-full bg-current transition-all duration-150 ease-in-out transform origin-center",
          isOpen ? "translate-y-0 rotate-45" : "-translate-y-[5px] rotate-0"
        )}
      />
      {/* Middle line */}
      <span
        className={cn(
          "absolute h-[2px] w-4 rounded-full bg-current transition-all duration-150 ease-in-out transform origin-center",
          isOpen ? "opacity-0 scale-x-0" : "opacity-100 scale-x-100"
        )}
      />
      {/* Bottom line */}
      <span
        className={cn(
          "absolute h-[2px] w-4 rounded-full bg-current transition-all duration-150 ease-in-out transform origin-center",
          isOpen ? "translate-y-0 -rotate-45" : "translate-y-[5px] rotate-0"
        )}
      />
    </span>
  );
}
