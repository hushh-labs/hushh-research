"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/app-ui/settings-ui";
import type {
  PortfolioFreshness,
  PortfolioSource,
  StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";
import {
  Building2,
  Link2,
  RefreshCw,
  ScrollText,
  Trash2,
  Upload,
  X,
} from "lucide-react";

interface PortfolioSourceSwitcherProps {
  activeSource: PortfolioSource;
  availableSources: PortfolioSource[];
  freshness?: PortfolioFreshness | null;
  onSourceChange: (source: PortfolioSource) => Promise<void>;
  statementSnapshots?: StatementSnapshotOption[];
  activeStatementSnapshotId?: string | null;
  onStatementSnapshotChange?: (snapshotId: string) => Promise<void>;
  onDeleteStatementSnapshot?: (snapshotId: string) => void;
  onRefreshPlaid?: () => void;
  onCancelRefreshPlaid?: () => void;
  onManageConnections?: () => void;
  onImportStatement?: () => void;
  onDeletePortfolio?: () => void;
  canChangePortfolioSource?: boolean;
  isChangingSource?: boolean;
  isChangingStatementSnapshot?: boolean;
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

function sourceLabel(source: PortfolioSource): string {
  return source === "plaid" ? "Connected brokerage" : "Statement";
}

/**
 * A compact source manager for the Portfolio detail route. Durable source
 * selection stays in the hook; this component only renders confirmed state and
 * disables competing actions while a selection is settling.
 */
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
  canChangePortfolioSource = true,
  isChangingSource = false,
  isChangingStatementSnapshot = false,
  isRefreshing = false,
  isDeletingPortfolio = false,
  isDeletingStatementSnapshot = false,
}: PortfolioSourceSwitcherProps) {
  const sourceOptions = availableSources.map((source) => ({
    value: source,
    label: source === "plaid" ? "Brokerage" : "Statement",
  }));
  const activeStatementId =
    activeStatementSnapshotId || statementSnapshots[0]?.id || null;
  const activeStatement = statementSnapshots.find(
    (snapshot) => snapshot.id === activeStatementId,
  );
  const hasStatementSnapshots = statementSnapshots.length > 0;
  const hasMultipleStatements =
    statementSnapshots.length > 1 &&
    typeof onStatementSnapshotChange === "function";
  const hasPlaidSource = availableSources.includes("plaid");
  const selectionBusy = isChangingSource || isChangingStatementSnapshot;
  const interactionBusy =
    selectionBusy ||
    isRefreshing ||
    isDeletingPortfolio ||
    isDeletingStatementSnapshot;

  const requestSourceChange = (value: string) => {
    void onSourceChange(value as PortfolioSource).catch(() => undefined);
  };

  const requestStatementChange = (snapshotId: string) => {
    if (!onStatementSnapshotChange) return;
    void onStatementSnapshotChange(snapshotId).catch(() => undefined);
  };

  return (
    <section
      className="w-full space-y-5"
      aria-busy={interactionBusy || undefined}
      aria-label="Portfolio source settings"
      data-testid="portfolio-source-switcher"
    >
      <SettingsGroup
        title="Active portfolio"
        description={
          selectionBusy
            ? "Saving your portfolio choice."
            : !canChangePortfolioSource
              ? "Unlock to change the active portfolio."
            : "Choose the holdings you want to review."
        }
        separatorInset
        testId="portfolio-source-active-group"
      >
        <SettingsRow
          icon={activeSource === "plaid" ? Building2 : ScrollText}
          iconTone={activeSource === "plaid" ? "blue" : "accent"}
          title="Portfolio source"
          description={
            activeSource === "plaid"
              ? "Connected brokerage holdings are read-only."
              : "Saved-statement holdings are editable."
          }
          stackTrailingOnMobile={sourceOptions.length > 1}
          trailing={
            sourceOptions.length > 1 ? (
              <SettingsSegmentedTabs
                value={activeSource}
                onValueChange={requestSourceChange}
                options={sourceOptions}
                disabled={interactionBusy || !canChangePortfolioSource}
                className="w-full sm:w-[18rem]"
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                {sourceLabel(activeSource)}
              </span>
            )
          }
          testId="portfolio-source-active-row"
        />
      </SettingsGroup>

      {activeSource === "statement" && hasStatementSnapshots ? (
        <SettingsGroup
          title="Saved statements"
          description="Choose the statement that drives your editable portfolio."
          separatorInset
          testId="portfolio-source-statements-group"
        >
          <SettingsRow
            icon={ScrollText}
            iconTone="accent"
            title="Selected statement"
            description="This statement drives your editable holdings."
            stackTrailingOnMobile={hasMultipleStatements}
            trailing={
              hasMultipleStatements ? (
                <Select
                  value={activeStatementId || undefined}
                  onValueChange={requestStatementChange}
                  disabled={interactionBusy || !canChangePortfolioSource}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0 sm:w-[18rem]"
                    aria-label="Selected statement"
                  >
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
                <span className="text-sm text-muted-foreground">
                  {activeStatement?.label || "Current"}
                </span>
              )
            }
            testId="portfolio-source-selected-statement"
          />
          {onImportStatement ? (
            <SettingsRow
              icon={Upload}
              iconTone="accent"
              title="Import another statement"
              description="Add a PDF or CSV from your brokerage."
              onClick={onImportStatement}
              disabled={interactionBusy}
              chevron
              voiceControlId="import_portfolio"
              testId="portfolio-source-import-statement"
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {activeSource === "plaid" && hasPlaidSource ? (
        <SettingsGroup
          title="Connected brokerage"
          description="Brokerage holdings stay read-only here."
          separatorInset
          testId="portfolio-source-plaid-group"
        >
          <SettingsRow
            icon={Building2}
            iconTone="blue"
            title={`${freshness?.itemCount || 0} connected ${
              (freshness?.itemCount || 0) === 1 ? "brokerage" : "brokerages"
            }`}
            description={`Last synced ${formatRelativeTimestamp(
              freshness?.lastSyncedAt || null,
            )}.`}
            testId="portfolio-source-plaid-status"
          />
          {isRefreshing && onCancelRefreshPlaid ? (
            <SettingsRow
              icon={X}
              title="Refresh in progress"
              description="Stop this update if you need to make a change."
              onClick={onCancelRefreshPlaid}
              chevron
              testId="portfolio-source-cancel-refresh"
            />
          ) : onRefreshPlaid ? (
            <SettingsRow
              icon={RefreshCw}
              title="Refresh brokerage"
              description="Get the latest available holdings."
              onClick={onRefreshPlaid}
              disabled={interactionBusy}
              chevron
              testId="portfolio-source-refresh-plaid"
            />
          ) : null}
          {onManageConnections ? (
            <SettingsRow
              icon={Link2}
              title="Manage connections"
              description="Connect or update a brokerage."
              onClick={onManageConnections}
              disabled={interactionBusy}
              chevron
              testId="portfolio-source-manage-connections"
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {activeSource !== "statement" && onImportStatement ? (
        <SettingsGroup title="Statements" separatorInset testId="portfolio-source-add-statement-group">
          <SettingsRow
            icon={Upload}
            iconTone="accent"
            title="Add a statement"
            description="Import a PDF or CSV for an editable portfolio."
            onClick={onImportStatement}
            disabled={interactionBusy}
            chevron
            voiceControlId="import_portfolio"
            testId="portfolio-source-add-statement"
          />
        </SettingsGroup>
      ) : null}

      {onDeletePortfolio || (activeSource === "statement" && activeStatementId && onDeleteStatementSnapshot) ? (
        <SettingsGroup title="Remove data" separatorInset testId="portfolio-source-remove-group">
          {onDeletePortfolio ? (
            <SettingsRow
              icon={Trash2}
              title="Delete active portfolio"
              description="This opens a confirmation before anything is removed."
              onClick={onDeletePortfolio}
              disabled={interactionBusy}
              tone="destructive"
              chevron
              voiceControlId="delete_imported_data"
              testId="portfolio-source-delete-portfolio"
            />
          ) : null}
          {activeSource === "statement" && activeStatementId && onDeleteStatementSnapshot ? (
            <SettingsRow
              icon={Trash2}
              title="Delete selected statement"
              description={activeStatement?.label || "Remove this saved statement."}
              onClick={() => onDeleteStatementSnapshot(activeStatementId)}
              disabled={interactionBusy}
              tone="destructive"
              chevron
              voiceControlId="delete_statement_snapshot"
              testId="portfolio-source-delete-statement"
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </section>
  );
}
