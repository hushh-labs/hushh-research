"use client";

import { ColumnDef } from "@tanstack/react-table";
import { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, ArrowRight, Trash2, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, isValid, parseISO } from "date-fns";
import { Icon } from "@/lib/morphy-ux/ui";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";

// Extended type to include version number computed at runtime
export type HistoryEntryWithVersion = AnalysisHistoryEntry & {
  version: number;
  companyName?: string;
  searchText?: string;
};

interface ColumnsProps {
  onView: (entry: AnalysisHistoryEntry) => void;
  onDelete: (entry: AnalysisHistoryEntry) => void;
  onDeleteTicker: (ticker: string) => void;
  onViewVersions?: (ticker: string) => void;
}

function formatHistoryTimestamp(value: unknown): string {
  if (value instanceof Date && isValid(value)) {
    return format(value, "MMM d, h:mm a");
  }

  if (typeof value === "number") {
    const fromEpoch = new Date(value);
    if (isValid(fromEpoch)) {
      return format(fromEpoch, "MMM d, h:mm a");
    }
    return "n/a";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "n/a";
    }

    const parsedIso = parseISO(trimmed);
    if (isValid(parsedIso)) {
      return format(parsedIso, "MMM d, h:mm a");
    }

    const parsedDate = new Date(trimmed);
    if (isValid(parsedDate)) {
      return format(parsedDate, "MMM d, h:mm a");
    }

    return "n/a";
  }

  return "n/a";
}

export const getColumns = ({
  onView,
  onDelete,
  onDeleteTicker,
  onViewVersions,
}: ColumnsProps): ColumnDef<HistoryEntryWithVersion>[] => [
  {
    id: "actions",
    header: "",
    cell: ({ row }) => {
      const entry = row.original;

          return (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="none"
                  effect="fade"
                  size="icon-sm"
                  showRipple={false}
                  className="h-8 w-8 p-0 border border-transparent hover:border-border/40"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="sr-only">Open menu</span>
                  <Icon icon={MoreHorizontal} size="sm" />
            </Button>
          </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onView(entry)}>
              <Icon icon={Eye} size="sm" className="mr-2" />
              View Analysis
            </DropdownMenuItem>
            {onViewVersions && (
              <DropdownMenuItem onSelect={() => onViewVersions(entry.ticker)}>
                <Icon icon={ArrowRight} size="sm" className="mr-2" />
                View Previous Versions
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onDelete(entry)}
              className="text-red-600 dark:text-red-400 focus:text-red-600 focus:bg-red-500/10"
            >
              <Icon icon={Trash2} size="sm" className="mr-2" />
              Delete Entry
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDeleteTicker(entry.ticker)}
              className="text-red-600 dark:text-red-400 focus:text-red-600 focus:bg-red-500/10"
            >
              <Icon icon={Trash2} size="sm" className="mr-2" />
              Delete All {entry.ticker}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  },
  {
    accessorKey: "ticker",
    header: "Ticker",
    cell: ({ row }) => {
      const entry = row.original;
      return (
        <div className="flex flex-col">
          <span className="font-bold text-base">{entry.ticker}</span>
          <span className="text-xs text-muted-foreground">
            {entry.companyName ? entry.companyName : `Version ${entry.version}`}
          </span>
          {entry.companyName ? (
            <span className="text-[11px] text-muted-foreground/80">v{entry.version}</span>
          ) : null}
        </div>
      );
    },
  },
  {
    accessorKey: "decision",
    header: "Decision",
    cell: ({ row }) => {
      const rawCard =
        row.original.raw_card && typeof row.original.raw_card === "object"
          ? (row.original.raw_card as Record<string, unknown>)
          : null;
      const ownsPosition =
        typeof rawCard?.owns_position === "boolean"
          ? rawCard.owns_position
          : typeof rawCard?.is_position_owned === "boolean"
            ? rawCard.is_position_owned
            : null;
      const decisionPresentation = toInvestorDecisionLabel(
        row.original.decision,
        ownsPosition
      );
      let colorClass = "bg-muted text-muted-foreground border-border";
      
      if (decisionPresentation.tone === "positive") {
        colorClass = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
      } else if (decisionPresentation.tone === "negative") {
        colorClass = "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30";
      } else if (decisionPresentation.label === "HOLD") {
        colorClass = "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30";
      } else if (decisionPresentation.label === "WATCH") {
        colorClass = "bg-[var(--app-card-surface-compact)] text-muted-foreground border-[color:var(--app-card-border-standard)]";
      }

      return (
        <Badge variant="outline" className={cn("font-bold", colorClass)}>
          {decisionPresentation.label}
        </Badge>
      );
    },
  },
  {
    accessorKey: "confidence",
    header: "Confidence",
    cell: ({ row }) => {
      const val = row.original.confidence;
      const percent = val >= 1 ? val : Math.round(val * 100);
      return (
        <div className="flex items-center gap-2">
           <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/[0.08]">
             <div 
               className="h-full rounded-full bg-foreground/70" 
               style={{ width: `${percent}%` }}
             />
           </div>
           <span className="text-xs font-medium">{percent}%</span>
        </div>
      );
    },
  },
  {
    accessorKey: "timestamp",
    header: "Date",
    cell: ({ row }) => {
      return (
        <span className="text-sm text-muted-foreground">
          {formatHistoryTimestamp(row.original.timestamp)}
        </span>
      );
    },
  },
];
