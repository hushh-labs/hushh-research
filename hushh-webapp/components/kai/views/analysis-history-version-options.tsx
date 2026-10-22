"use client";

import type * as React from "react";
import { TrendingUp, TrendingDown, Minus, Trash2 } from "@/components/icons";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";
import type { HistoryEntryWithVersion } from "./columns";

/** Map decision string to display color classes */
function decisionStyles(decision: string, ownsPosition?: boolean | null): {
  bg: string;
  text: string;
  border: string;
  icon: React.ReactNode;
  label: string;
} {
  const presentation = toInvestorDecisionLabel(decision, ownsPosition);
  if (presentation.tone === "positive") {
    return {
      bg: "bg-emerald-500/10",
      text: "text-emerald-600 dark:text-emerald-400",
      border: "border-emerald-500/30",
      icon: <Icon icon={TrendingUp} size={12} aria-hidden="true" />,
      label: presentation.label,
    };
  }
  if (presentation.tone === "negative") {
    return {
      bg: "bg-red-500/10",
      text: "text-red-600 dark:text-red-400",
      border: "border-red-500/30",
      icon: <Icon icon={TrendingDown} size={12} aria-hidden="true" />,
      label: presentation.label,
    };
  }
  return {
    bg:
      presentation.label === "WATCH"
        ? "bg-[var(--app-card-surface-compact)]"
        : "bg-amber-500/10",
    text:
      presentation.label === "WATCH"
        ? "text-muted-foreground"
        : "text-amber-600 dark:text-amber-400",
    border:
      presentation.label === "WATCH"
        ? "border-[color:var(--app-card-border-standard)]"
        : "border-amber-500/30",
    icon: <Icon icon={Minus} size={12} aria-hidden="true" />,
    label: presentation.label,
  };
}

export function VersionOptions({
  entries,
  onOpen,
  onDelete,
}: {
  entries: HistoryEntryWithVersion[];
  onOpen: (entry: HistoryEntryWithVersion) => void;
  onDelete: (entry: HistoryEntryWithVersion) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No saved versions found.</p>;
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const rawCard =
          entry.raw_card && typeof entry.raw_card === "object"
            ? (entry.raw_card as Record<string, unknown>)
            : null;
        const ownsPosition =
          typeof rawCard?.owns_position === "boolean"
            ? rawCard.owns_position
            : typeof rawCard?.is_position_owned === "boolean"
              ? rawCard.is_position_owned
              : null;
        const styles = decisionStyles(entry.decision, ownsPosition);
        const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;

        return (
          <div key={`${entry.ticker}-${entry.timestamp}`} className="flex items-center gap-2">
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="sm"
              className="h-auto min-w-0 flex-1 justify-between border border-transparent px-3 py-3 hover:border-border/40"
              onClick={() => onOpen(entry)}
            >
              <div className="flex min-w-0 flex-col items-start gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">v{entry.version}</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      styles.bg,
                      styles.text,
                      styles.border,
                    )}
                  >
                    {styles.icon}
                    {styles.label}
                  </span>
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {timestamp ? format(timestamp, "PPpp") : ""}
                  {rawCard?.analysis_degraded ? " · Limited analysis" : ""}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">Open</span>
            </Button>
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="icon-sm"
              className="h-9 w-9 shrink-0 border border-transparent text-red-600 hover:border-red-500/30 hover:bg-red-500/10 dark:text-red-400"
              onClick={() => onDelete(entry)}
              title="Delete this version"
              aria-label="Delete this version"
            >
              <Icon icon={Trash2} size="sm" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

