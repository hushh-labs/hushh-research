import { Badge } from "@/components/ui/badge"

import { cn } from "@/lib/utils"

export type StatusTone = "success" | "warning" | "critical" | "neutral" | "info"

const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  success:
    "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning:
    "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical:
    "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  neutral:
    "border-border/70 bg-background/80 text-muted-foreground",
  info:
    "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
}

export function statusToneFromString(status?: string | null): StatusTone {
  switch (status) {
    case "active":
    case "verified":
    case "approved":
      return "success"
    case "submitted":
    case "request_pending":
    case "pending":
      return "warning"
    case "rejected":
    case "revoked":
    case "expired":
    case "disconnected":
      return "critical"
    default:
      return "neutral"
  }
}

export function formatStatusLabel(status?: string | null): string {
  return String(status || "pending").replaceAll("_", " ")
}

interface StatusBadgeProps {
  status?: string | null
  tone?: StatusTone
  label?: string
  className?: string
}

export function StatusBadge({
  status,
  tone,
  label,
  className,
}: StatusBadgeProps) {
  const resolvedTone = tone ?? statusToneFromString(status)
  const resolvedLabel = label ?? formatStatusLabel(status)

  return (
    <Badge
      className={cn(
        "w-fit capitalize",
        STATUS_TONE_CLASSES[resolvedTone],
        className
      )}
    >
      {resolvedLabel}
    </Badge>
  )
}