"use client";

import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

// Variant mapping for dynamic styling
const VARIANTS = {
  default: "bg-primary",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
};

interface ProgressProps extends React.ComponentProps<typeof ProgressPrimitive.Root> {
  indicatorClassName?: string;
  showLabel?: boolean;
  variant?: keyof typeof VARIANTS;
}

function Progress({
  className,
  indicatorClassName,
  value,
  showLabel = false,
  variant = "default",
  ...props
}: ProgressProps) {
  const safeValue = typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;

  return (
    <div className="w-full space-y-1">
      <ProgressPrimitive.Root
        data-slot="progress"
        className={cn(
          "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
          className
        )}
        value={safeValue}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={safeValue}
        {...props}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full w-full flex-1 transition-all duration-500 ease-in-out",
            VARIANTS[variant],
            indicatorClassName
          )}
          style={{ transform: `translateX(-${100 - safeValue}%)` }}
        />
      </ProgressPrimitive.Root>

      {showLabel && (
        <p className="text-right text-[10px] font-medium text-muted-foreground">
          {Math.round(safeValue)}%
        </p>
      )}
    </div>
  );
}

export { Progress };