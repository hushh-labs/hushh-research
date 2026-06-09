"use client";

import type { LucideIcon } from "lucide-react";
import { SearchX } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";

type EmptyStateProps = {
  title: string;
  description: string;
  icon?: LucideIcon;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
};

export function EmptyState({
  title,
  description,
  icon: Icon = SearchX,
  actionLabel,
  onAction,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={
        compact
          ? "rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)]/50 bg-[color:var(--app-card-surface-compact)]/55 px-4 py-5 text-center"
          : "rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)]/50 bg-[color:var(--app-card-surface-compact)]/55 px-6 py-8 text-center"
      }
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-4">
        <div className="rounded-full bg-muted p-3">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>

        {actionLabel && onAction ? (
          <Button variant="none" effect="fade" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}