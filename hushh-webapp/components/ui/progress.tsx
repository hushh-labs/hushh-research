"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  indicatorClassName,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string
}) {
  const safeValue =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : undefined

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className
      )}
      value={safeValue}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("bg-primary h-full transition-all", indicatorClassName)}
        style={{ width: `${safeValue ?? 0}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
