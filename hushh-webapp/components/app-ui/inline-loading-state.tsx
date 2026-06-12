import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

interface InlineLoadingStateProps {
  label?: string
  className?: string
  iconClassName?: string
}

export function InlineLoadingState({
  label = "Loading…",
  className,
  iconClassName,
}: InlineLoadingStateProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground",
        className
      )}
    >
      <Loader2
        aria-hidden="true"
        className={cn("h-4 w-4 shrink-0 motion-safe:animate-spin", iconClassName)}
      />
      <span>{label}</span>
    </div>
  )
}