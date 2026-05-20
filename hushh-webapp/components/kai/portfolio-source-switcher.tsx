"use client";

import {
  SurfaceCard,
  SurfaceCardContent,
} from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedPill } from "@/lib/morphy-ux/ui/segmented-pill";
import type {
  PortfolioFreshness,
  PortfolioSource,
  StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";
import {
  Building2,
  Loader2,
  Link2,
  RefreshCw,
  ScrollText,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";

interface PortfolioSourceSwitcherProps {
  activeSource: PortfolioSource;
  availableSources: PortfolioSource[];
  freshness?: PortfolioFreshness | null;
  onSourceChange: (source: PortfolioSource) => void;
  statementSnapshots?: StatementSnapshotOption[];
  activeStatementSnapshotId?: string | null;
  onStatementSnapshotChange?: (snapshotId: string) => void;
  onDeleteStatementSnapshot?: (snapshotId: string) => void;
  onRefreshPlaid?: () => void;
  onCancelRefreshPlaid?: () => void;
  onManageConnections?: () => void;
  onImportStatement?: () => void;
  onDeletePortfolio?: () => void;
  isRefreshing?: boolean;
  isDeletingPortfolio?: boolean;
  isDeletingStatementSnapshot?: boolean;
}

function formatRelativeTimestamp(value: string | null | undefined): string {
  if (!value) return "Not synced yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not synced yet";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PortfolioSourceSwitcher({
  activeSource,
  availableSources,
  freshness,
  onSourceChange,
  statementSnapshots = [],
  activeStatementSnapshotId = null,
  onStatementSnapshotChange,
  onDeleteStatementSnapshot,
  onRefreshPlaid,
  onCancelRefreshPlaid,
  onManageConnections,
  onImportStatement,
  onDeletePortfolio,
  isRefreshing = false,
  isDeletingPortfolio = false,
  isDeletingStatementSnapshot = false,
}: PortfolioSourceSwitcherProps) {
  const options = [
    {
      value: "statement",
      label: "Statement",
      icon: ScrollText,
      disabled: !availableSources.includes("statement"),
    },
    {
      value: "plaid",
      label: "Plaid",
      icon: Link2,
      disabled: !availableSources.includes("plaid"),
      tone: "accent" as const,
    },
  ];
  const showStatementPicker =
    activeSource === "statement" &&
    statementSnapshots.length > 1 &&
    typeof onStatementSnapshotChange === "function";
  const activeStatementId = activeStatementSnapshotId || statementSnapshots[0]?.id || null;
  const showStatementControls = activeSource === "statement" && statementSnapshots.length > 0;
  const showDeleteStatement =
    showStatementControls && activeStatementId && typeof onDeleteStatementSnapshot === "function";
  const showImportStatement =
    activeSource === "statement" && typeof onImportStatement === "function";
  const showPlaidActions = activeSource === "plaid" && availableSources.includes("plaid");

  return (
    <SurfaceCard>
      <SurfaceCardContent className="space-y-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Portfolio Source
            </p>
            <SegmentedPill
              value={activeSource}
              options={options}
              onValueChange={(value) => onSourceChange(value as PortfolioSource)}
              ariaLabel="Portfolio source selector"
              size="compact"
              className="w-full max-w-md"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showImportStatement ? (
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={onImportStatement}
                data-voice-control-id="import_portfolio"
              >
                <Upload className="mr-2 h-3.5 w-3.5" />
                Import Portfolio
              </Button>
            ) : null}
            {showPlaidActions ? (
              <>
                <Badge variant="outline" className="gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  {freshness?.itemCount || 0} item{(freshness?.itemCount || 0) === 1 ? "" : "s"}
                </Badge>
                <Badge variant="outline">
                  Synced {formatRelativeTimestamp(freshness?.lastSyncedAt || null)}
                </Badge>
                {onRefreshPlaid ? (
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={onRefreshPlaid}
                    disabled={isRefreshing}
                  >
                    <RefreshCw
                      className={`mr-2 h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </Button>
                ) : null}
                {onCancelRefreshPlaid && isRefreshing ? (
                  <Button variant="none" effect="fade" size="sm" onClick={onCancelRefreshPlaid}>
                    Cancel
                  </Button>
                ) : null}
                {onManageConnections ? (
                  <Button variant="none" effect="fade" size="sm" onClick={onManageConnections}>
                    {(freshness?.itemCount || 0) > 0 ? "Connect Another Brokerage" : "Connect Plaid"}
                  </Button>
                ) : null}
              </>
            ) : null}
            {onDeletePortfolio ? (
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={onDeletePortfolio}
                disabled={isDeletingPortfolio}
                className="text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                data-voice-control-id="delete_imported_data"
              >
                {isDeletingPortfolio ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                )}
                Delete Portfolio
              </Button>
            ) : null}
          </div>
        </div>
        {showStatementControls ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Saved Statements
              </p>
              <p className="text-xs text-muted-foreground">
                Choose which saved statement drives the editable portfolio.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {showStatementPicker ? (
                <Select
                  value={activeStatementId || undefined}
                  onValueChange={onStatementSnapshotChange}
                  disabled={isDeletingStatementSnapshot}
                >
                  <SelectTrigger size="sm" className="w-full min-w-0 sm:w-[260px]">
                    <SelectValue placeholder="Select statement" />
                  </SelectTrigger>
                  <SelectContent>
                    {statementSnapshots.map((snapshot) => (
                      <SelectItem key={snapshot.id} value={snapshot.id}>
                        {snapshot.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="outline" className="w-fit max-w-full truncate">
                  {statementSnapshots[0]?.label || "Statement"}
                </Badge>
              )}
              {showDeleteStatement ? (
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => onDeleteStatementSnapshot(activeStatementId)}
                  disabled={isDeletingStatementSnapshot}
                  className="justify-start text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                  data-voice-control-id="delete_statement_snapshot"
                >
                  {isDeletingStatementSnapshot ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                  )}
                  Delete Statement
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
