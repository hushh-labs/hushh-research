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
  SegmentedTabs,
} from "@/components/app-ui/settings-ui";
import type {
  PortfolioFreshness,
  PortfolioSource,
  StatementSnapshotOption,
} from "@/lib/kai/brokerage/portfolio-sources";
import {
  Building2,
  RefreshCw,
  ScrollText,
  Trash2,
  Upload,
  X,
} from "@/components/icons";

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

/**
 * The Portfolio source screen: what the portfolio reads from now, every way
 * to add a source, and removal last. Durable source selection stays in the
 * hook; this component only renders confirmed state and disables competing
 * actions while a selection is settling. One title per idea: the route
 * header already says "Portfolio source", so no row repeats it, and the
 * bank door is on this screen whatever is active.
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

  const statementTitle = activeStatement?.label || "Saved statement";
  const brokerageCount = freshness?.itemCount || 0;
  const brokerageTitle = `${brokerageCount} connected ${brokerageCount === 1 ? "brokerage" : "brokerages"}`;
  const nowUsingDescription = selectionBusy
    ? "Saving your choice."
    : !canChangePortfolioSource
      ? "Unlock your Vault to change the active portfolio."
      : activeSource === "plaid"
        ? `Read-only, synced ${formatRelativeTimestamp(freshness?.lastSyncedAt || null)}.`
        : "Editable, from a statement you uploaded.";
  const showRemove =
    Boolean(onDeletePortfolio) ||
    Boolean(activeSource === "statement" && activeStatementId && onDeleteStatementSnapshot);

  return (
    <section
      className="w-full space-y-5"
      aria-busy={interactionBusy || undefined}
      aria-label="Portfolio source settings"
      data-testid="portfolio-source-switcher"
    >
      {/* What the portfolio reads from right now: one row that names it,
          the switch only when there is something to switch to. */}
      <SettingsGroup title="Now using" separatorInset testId="portfolio-source-active-group">
        <SettingsRow
          icon={activeSource === "plaid" ? Building2 : ScrollText}
          iconTone={activeSource === "plaid" ? "blue" : "accent"}
          title={activeSource === "plaid" ? brokerageTitle : statementTitle}
          description={nowUsingDescription}
          stackTrailingOnMobile
          trailing={
            sourceOptions.length > 1 ? (
              <SegmentedTabs
                value={activeSource}
                onValueChange={requestSourceChange}
                options={sourceOptions}
                disabled={interactionBusy || !canChangePortfolioSource}
                className="w-full sm:w-[18rem]"
              />
            ) : undefined
          }
          testId="portfolio-source-active-row"
        />
        {activeSource === "statement" && hasMultipleStatements ? (
          <SettingsRow
            icon={ScrollText}
            iconTone="accent"
            title="Switch statement"
            stackTrailingOnMobile
            trailing={
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
            }
            testId="portfolio-source-selected-statement"
          />
        ) : null}
        {activeSource === "plaid" && hasPlaidSource ? (
          isRefreshing && onCancelRefreshPlaid ? (
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
          ) : null
        ) : null}
      </SettingsGroup>

      {/* Every way in, on this screen, whatever is active. */}
      {onManageConnections || onImportStatement ? (
        <SettingsGroup title="Add a source" separatorInset testId="portfolio-source-add-group">
          {onManageConnections ? (
            <SettingsRow
              icon={Building2}
              iconTone="blue"
              title={hasPlaidSource ? "Manage connections" : "Connect a bank or brokerage"}
              description="Read-only sync through Plaid."
              onClick={onManageConnections}
              disabled={interactionBusy}
              chevron
              testId="portfolio-source-manage-connections"
            />
          ) : null}
          {onImportStatement ? (
            <SettingsRow
              icon={Upload}
              iconTone="accent"
              title={activeSource === "statement" && hasStatementSnapshots ? "Import another statement" : "Upload a statement"}
              description="PDF or CSV from your brokerage; editable once imported."
              onClick={onImportStatement}
              disabled={interactionBusy}
              chevron
              voiceControlId="import_portfolio"
              testId="portfolio-source-import-statement"
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {showRemove ? (
        <SettingsGroup title="Remove" separatorInset testId="portfolio-source-remove-group">
          {activeSource === "statement" && activeStatementId && onDeleteStatementSnapshot ? (
            <SettingsRow
              icon={Trash2}
              title="Delete this statement"
              description={statementTitle}
              onClick={() => onDeleteStatementSnapshot(activeStatementId)}
              disabled={interactionBusy}
              tone="destructive"
              chevron
              voiceControlId="delete_statement_snapshot"
              testId="portfolio-source-delete-statement"
            />
          ) : null}
          {onDeletePortfolio ? (
            <SettingsRow
              icon={Trash2}
              title="Delete active portfolio"
              description="Asks before anything is removed."
              onClick={onDeletePortfolio}
              disabled={interactionBusy}
              tone="destructive"
              chevron
              voiceControlId="delete_imported_data"
              testId="portfolio-source-delete-portfolio"
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </section>
  );
}
