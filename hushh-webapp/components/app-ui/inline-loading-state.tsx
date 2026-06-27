"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface InlineLoadingStateProps {
  label?: string;
  className?: string;
  iconClassName?: string;
  size?: "sm" | "default" | "lg";
}

const sizeStyles = {
  sm: "gap-1.5 text-xs py-2 px-2",
  default: "gap-2 text-sm py-5 px-4",
  lg: "gap-3 text-base py-8 px-6",
};

const iconSizes = {
  sm: "h-3 w-3",
  default: "h-4 w-4",
  lg: "h-5 w-5",
};

export function InlineLoadingState({
  label = "Loading…",
  className,
  iconClassName,
  size = "default",
}: InlineLoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "flex items-center justify-center text-muted-foreground animate-in fade-in duration-500",
        sizeStyles[size],
        className
      )}
    >
      <Loader2
        aria-hidden="true"
        className={cn(
          "shrink-0 motion-safe:animate-spin",
          iconSizes[size],
          iconClassName
        )}
      />
      {label && <span className="font-medium">{label}</span>}
    </div>
  );
}