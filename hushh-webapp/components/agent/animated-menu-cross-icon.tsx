"use client";

import { XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export interface AnimatedMenuCrossIconProps {
  isOpen: boolean;
  className?: string;
}

/** Modern asymmetric staggered menu glyph that crossfades cleanly to close. */
export function AnimatedMenuCrossIcon({ isOpen, className }: AnimatedMenuCrossIconProps) {
  return (
    <span className={cn("pointer-events-none relative inline-flex size-[20px] items-center justify-center", className)} aria-hidden="true">
      <svg
        viewBox="0 0 20 20"
        fill="none"
        className={cn(
          "absolute inset-0 size-[20px] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          isOpen ? "scale-90 opacity-0" : "scale-100 opacity-100",
        )}
      >
        <path
          d="M3.5 6.75H16.5M3.5 13.25H12.25"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
      <XIcon
        className={cn(
          "absolute inset-0 size-[20px] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          isOpen ? "scale-100 opacity-100" : "scale-90 opacity-0",
        )}
      />
    </span>
  );
}
