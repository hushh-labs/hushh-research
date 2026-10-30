"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw } from "lucide-react";

type AsyncActionStatusState = "idle" | "loading" | "success" | "error" | "retrying";

type AsyncActionStatusProps = {
  state: AsyncActionStatusState;
  label?: string;
  compact?: boolean;
};

const STATUS_COPY: Record<Exclude<AsyncActionStatusState, "idle">, string> = {
  loading: "Working…",
  retrying: "Retrying…",
  success: "Completed",
  error: "Action failed",
};

export function AsyncActionStatus({
  state,
  label,
  compact = false,
}: AsyncActionStatusProps) {
  if (state === "idle") return null;

  const text = label || STATUS_COPY[state];

  const Icon =
    state === "success"
      ? CheckCircle2
      : state === "error"
        ? AlertTriangle
        : state === "retrying"
          ? RefreshCcw
          : Loader2;

  return (
    <div
      role="status"
      aria-live={state === "error" ? "assertive" : "polite"}
      className={
        compact
          ? "inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs font-medium text-muted-foreground"
          : "flex items-center gap-2 rounded-[var(--app-card-radius-compact)] border border-border/60 bg-background/70 px-3 py-2 text-sm font-medium text-muted-foreground"
      }
    >
      <Icon
        aria-hidden="true"
        className={
          state === "loading" || state === "retrying"
            ? "h-4 w-4 animate-spin"
            : state === "success"
              ? "h-4 w-4 text-emerald-600"
              : state === "error"
                ? "h-4 w-4 text-amber-600"
                : "h-4 w-4"
        }
      />
      <span>{text}</span>
    </div>
  );
}