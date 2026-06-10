"use client";

import { AlertTriangle, RefreshCcw } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";

type ApiRetryStateProps = {
  title?: string;
  description?: string;
  variant?: "full" | "compact";
  onRetry: () => void;
};

export function ApiRetryState({
  title = "Unable to load data",
  description = "The request took too long or failed. Try again to refresh this section.",
  variant = "full",
  onRetry,
}: ApiRetryStateProps) {
  if (variant === "compact") {
    return (
      <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-amber-500/20 bg-amber-500/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button variant="none" effect="fade" size="sm" onClick={onRetry}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="rounded-[var(--app-card-radius-compact)] border border-amber-500/20 bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-amber-500/15 p-2">
          <AlertTriangle className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>

          <Button variant="none" effect="fade" size="sm" onClick={onRetry}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
