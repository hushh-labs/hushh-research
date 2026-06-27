"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils"; // Assumed utility

type AsyncActionStatusState = "idle" | "loading" | "success" | "error" | "retrying";

type AsyncActionStatusProps = {
  state: AsyncActionStatusState;
  label?: string;
  compact?: boolean;
};

const STATUS_CONFIG: Record<Exclude<AsyncActionStatusState, "idle">, {
  label: string;
  icon: LucideIcon;
  iconClass: string
}> = {
  loading: { label: "Working…", icon: Loader2, iconClass: "animate-spin" },
  retrying: { label: "Retrying…", icon: RefreshCcw, iconClass: "animate-spin" },
  success: { label: "Completed", icon: CheckCircle2, iconClass: "text-emerald-600" },
  error: { label: "Action failed", icon: AlertTriangle, iconClass: "text-amber-600" },
};

export function AsyncActionStatus({ state, label, compact = false }: AsyncActionStatusProps) {
  if (state === "idle") return null;

  const config = STATUS_CONFIG[state];
  const Icon = config.icon;

  return (
    <div
      role="status"
      aria-live={state === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 font-medium text-muted-foreground",
        compact ? "px-2.5 py-1 text-xs" : "px-3 py-2 text-sm rounded-[var(--app-card-radius-compact)]"
      )}
    >
      <Icon aria-hidden="true" className={cn("h-4 w-4", config.iconClass)} />
      <span>{label || config.label}</span>
    </div>
  );
}