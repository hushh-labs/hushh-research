"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Grid2X2, List, Search, X } from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { PageTitle } from "@/components/app-ui/typography";
import {
  getOneSetupCapability,
  isOneCapabilityEnabled,
  ONE_CAPABILITIES,
  type OneCapabilityIcon,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import {
  getCapabilityStatusDisplay,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { buildOneSetupCapabilityRoute } from "@/lib/navigation/routes";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import type { OneLocationState } from "@/lib/one-location/types";
import type { KaiHomeInsightsV2, KaiHomeMover } from "@/lib/services/api-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import type { PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";
import type { RiaHomeResponse } from "@/lib/services/ria-service";
import { cn } from "@/lib/utils";

type OneAgentMode = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: OneCapabilityIcon;
  statusTone: CapabilityStatusTone;
  primaryMetric: {
    value: string;
    label: string;
  };
  paletteIndex: number;
  tone: OneCapabilityTone;
  isExploreOnly: boolean;
};

type AgentMetric = OneAgentMode["primaryMetric"];
type AgentRosterView = "grid" | "list";
type AgentMetricTone = "default" | "positive" | "accent" | "warning" | "muted";

const AGENT_ROSTER_VIEW_STORAGE_KEY = "hushh:one-agent-roster-view";

/**
 * The roster only ever mounts client-side (its `/one` route renders a loader
 * until auth resolves, so it never server-renders with content). Reading the
 * persisted preference synchronously in the state initializer therefore has
 * no hydration-mismatch risk and lets the very first paint already be the
 * remembered view - eliminating a brief default-view flip on every return to
 * `/one`.
 */
function readPersistedRosterView(): AgentRosterView {
  if (typeof window === "undefined") return "grid";
  try {
    const persisted = window.localStorage.getItem(
      AGENT_ROSTER_VIEW_STORAGE_KEY,
    );
    return persisted === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatWinnerPercent(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const percent = value;
  const digits = Math.abs(percent) >= 10 ? 1 : 2;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(digits)}%`;
}

function countCollection(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  return positiveNumber(value);
}

function canonicalMarketPayload(userId: string): KaiHomeInsightsV2 | null {
  const cache = CacheService.getInstance();
  // The roster describes the overall market leader, not the newest arbitrary
  // symbol-scoped Finance response. A holdings/analysis cache can arrive after
  // the baseline and contain a different, partial universe; choosing by last
  // write made the `/one` KPI jump or show an unrelated percentage.
  return (
    cache.peek<KaiHomeInsightsV2>(
      CACHE_KEYS.KAI_MARKET_HOME_BASELINE(userId, 7),
    )?.data ??
    cache.peek<KaiHomeInsightsV2>(
      CACHE_KEYS.KAI_MARKET_HOME(userId, "default", 7),
    )?.data ??
    null
  );
}

function isPositiveMover(
  row: KaiHomeMover,
): row is KaiHomeMover & { change_pct: number } {
  return (
    typeof row?.symbol === "string" &&
    /^[A-Z][A-Z0-9.-]{0,9}$/i.test(row.symbol.trim()) &&
    typeof row.change_pct === "number" &&
    Number.isFinite(row.change_pct) &&
    row.change_pct > 0
  );
}

/**
 * Read-only cache metrics for the One roster. These never trigger a fetch and
 * only expose existing, non-sensitive workspace summaries.
 */
export function resolveCachedAgentMetrics(
  userId: string | null | undefined,
): Record<string, AgentMetric> {
  if (!userId) return {};
  const cache = CacheService.getInstance();
  const metrics: Record<string, AgentMetric> = {};

  const market = canonicalMarketPayload(userId);
  const topMover = (market?.movers?.gainers ?? [])
    .filter(isPositiveMover)
    .sort(
      (left, right) => right.change_pct - left.change_pct,
    )[0];
  const moverSymbol = String(topMover?.symbol ?? "")
    .trim()
    .toUpperCase();
  if (moverSymbol) {
    metrics.finance = {
      value: moverSymbol,
      label: formatWinnerPercent(topMover?.change_pct) ?? "top mover",
    };
  }

  const riaHome = cache.peek<RiaHomeResponse>(
    CACHE_KEYS.RIA_HOME(userId),
  )?.data;
  const activeClients = positiveNumber(riaHome?.counts?.active_clients);
  if (activeClients !== null) {
    metrics.ria = {
      value: String(activeClients),
      label: activeClients === 1 ? "active client" : "active clients",
    };
  }

  const pendingConsents = cache.peek<unknown[]>(
    CACHE_KEYS.PENDING_CONSENTS(userId),
  )?.data;
  if (Array.isArray(pendingConsents)) {
    const label =
      pendingConsents.length === 1 ? "approval waiting" : "approvals waiting";
    metrics.email = { value: String(pendingConsents.length), label };
    metrics.consent = {
      value: String(pendingConsents.length),
      label: pendingConsents.length === 1 ? "request" : "requests",
    };
  }

  const location = cache.peek<OneLocationState>(
    CACHE_KEYS.ONE_LOCATION_STATE(userId),
  )?.data;
  if (location) {
    const liveShares = [
      ...location.ownerGrants,
      ...location.receivedGrants,
    ].filter((grant) =>
      /active|approved|shared|granted/i.test(String(grant.status)),
    ).length;
    metrics.location = {
      value: String(liveShares),
      label: liveShares === 1 ? "live" : "live",
    };
  }

  const metadata = cache.peek<PersonalKnowledgeModelMetadata>(
    CACHE_KEYS.PKM_METADATA(userId),
  )?.data;
  const attributes = positiveNumber(metadata?.totalAttributes);
  if (attributes !== null) {
    metrics.pkm = {
      value: String(attributes),
      label: attributes === 1 ? "saved" : "saved",
    };
  }

  const access = cache.peek<Record<string, unknown>>(
    CACHE_KEYS.DEVELOPER_ACCESS(userId),
  )?.data;
  const connectedSystems =
    countCollection(access?.connections) ??
    countCollection(access?.systems) ??
    countCollection(access?.items);
  if (connectedSystems !== null) {
    metrics["connected-systems"] = {
      value: String(connectedSystems),
      label: connectedSystems === 1 ? "connected" : "connected",
    };
  }

  return metrics;
}

function useCachedAgentMetrics(
  userId?: string | null,
): Record<string, AgentMetric> {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!userId) return;
    return CacheService.getInstance().subscribe((event) => {
      const keys =
        event.type === "set"
          ? [event.key]
          : event.type === "invalidate" || event.type === "invalidate_user"
            ? event.keys
            : [];
      if (event.type === "clear" || keys.some((key) => key.includes(userId))) {
        setRevision((current) => current + 1);
      }
    });
  }, [userId]);

  // `revision` is deliberately read so cache events cause a fresh, read-only
  // projection without introducing a second cache mirror for this list.
  void revision;
  return resolveCachedAgentMetrics(userId);
}

function buildModes(
  statusById: Record<string, CapabilityStatus>,
  cachedMetrics: Record<string, AgentMetric>,
  setupDismissed: boolean,
): OneAgentMode[] {
  return ONE_CAPABILITIES.filter(
    (capability) =>
      capability.isVisibleOnRoster !== false &&
      isOneCapabilityEnabled(capability),
  ).map((capability, paletteIndex) => {
    const setupCapability = getOneSetupCapability(capability.id);
    const status = statusById[capability.id];
    const copy = setupCapability
      ? getCapabilitySetupCopy(capability.id)
      : undefined;
    const display =
      setupCapability && copy
        ? status
          ? getCapabilityStatusDisplay(status, {
              isExploreOnly: capability.isExploreOnly,
              actionLabel: copy.actionLabel,
              resumeActionLabel: copy.resumeActionLabel,
            })
          : { label: copy.actionLabel, tone: "action" as CapabilityStatusTone }
        : {
            label: capability.isExploreOnly ? "Explore" : "Open",
            tone: "action" as CapabilityStatusTone,
          };

    const isActionable =
      "isActionable" in display ? (display as any).isActionable : true;
    const opensSetup = Boolean(
      setupCapability &&
        isActionable &&
        (!setupDismissed || capability.id === "finance"),
    );

    const primaryMetric =
      cachedMetrics[capability.id] ??
      resolvePrimaryMetric({
        capabilityId: capability.id,
        status,
      });

    return {
      id: capability.id,
      title: capability.title,
      description: capability.description,
      // Root onboarding dismissal normally opens the product workspace.
      // Finance remains an exception while its own resolver says setup is
      // actionable: root completion or Skip is not Finance completion.
      href: opensSetup
        ? buildOneSetupCapabilityRoute(capability.id)
        : capability.href,
      icon: capability.icon,
      statusTone: display.tone,
      primaryMetric,
      paletteIndex,
      tone: capability.tone,
      isExploreOnly: capability.isExploreOnly === true,
    };
  });
}

/**
 * The roster's compact KPI is deliberately derived from an already-resolved
 * capability state. Cache-backed workspace summaries take precedence when
 * available; this fallback never invents product activity.
 */
function resolvePrimaryMetric({
  capabilityId,
  status,
}: {
  capabilityId: string;
  status?: CapabilityStatus;
}): OneAgentMode["primaryMetric"] {
  if (capabilityId === "consent") {
    if (!status || status.state === "unknown") {
      return { value: "—", label: "checking" };
    }
    const pendingConsentCount = status.pendingCount;
    return {
      value: String(pendingConsentCount),
      label: pendingConsentCount === 1 ? "request" : "requests",
    };
  }

  if (!status || status.state === "unknown") {
    return { value: "—", label: "status not loaded" };
  }

  if (status.pendingCount > 0) {
    return {
      value: String(status.pendingCount),
      label: status.pendingCount === 1 ? "review" : "reviews",
    };
  }

  const actionsDue =
    status.state === "completed" || status.state === "skipped" ? 0 : 1;
  return {
    value: String(actionsDue),
    label: actionsDue === 1 ? "action" : "actions",
  };
}

function isZeroMetric(metric: AgentMetric): boolean {
  return Number(metric.value) === 0;
}

function positiveIntegerMetricValue(metric: AgentMetric): number | null {
  const number = Number(metric.value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isUnavailableMetric(metric: AgentMetric): boolean {
  return metric.value === "—" || /status not loaded|checking/i.test(metric.label);
}

const ACTION_METRIC_LABELS = new Set([
  "action",
  "actions",
  "review",
  "reviews",
  "request",
  "requests",
  "approval waiting",
  "approvals waiting",
]);

function actionBadgeValue(mode: OneAgentMode): number | null {
  const value = positiveIntegerMetricValue(mode.primaryMetric);
  if (value === null) return null;
  return ACTION_METRIC_LABELS.has(mode.primaryMetric.label.toLowerCase())
    ? value
    : null;
}

function locationLiveValue(mode: OneAgentMode): number | null {
  if (mode.id !== "location") return null;
  const value = positiveIntegerMetricValue(mode.primaryMetric);
  return value === null ? null : value;
}

function shouldShowGridMetric(mode: OneAgentMode): boolean {
  if (isUnavailableMetric(mode.primaryMetric)) return false;
  if (actionBadgeValue(mode) !== null) return false;
  if (mode.id === "location") return locationLiveValue(mode) !== null;
  if (mode.id === "finance") return mode.primaryMetric.label.endsWith("%");
  if (mode.id === "pkm") return !isZeroMetric(mode.primaryMetric);
  if (mode.primaryMetric.label.includes("client")) {
    return !isZeroMetric(mode.primaryMetric);
  }
  return false;
}

function shouldShowListMetric(mode: OneAgentMode): boolean {
  if (isUnavailableMetric(mode.primaryMetric)) return false;
  if (isZeroMetric(mode.primaryMetric)) return false;
  if (actionBadgeValue(mode) !== null) return false;
  return true;
}

function formatBadgeValue(value: number): string {
  return value > 99 ? "99+" : String(value);
}

function formatA11yMetric(mode: OneAgentMode): string {
  const badge = actionBadgeValue(mode);
  if (badge !== null) {
    return `, ${formatBadgeValue(badge)} ${mode.primaryMetric.label}`;
  }
  const live = locationLiveValue(mode);
  if (live !== null) {
    return `, ${live} live ${live === 1 ? "share" : "shares"}`;
  }
  if (isUnavailableMetric(mode.primaryMetric) || isZeroMetric(mode.primaryMetric)) {
    return "";
  }
  if (mode.id === "finance" && mode.primaryMetric.label.endsWith("%")) {
    const direction = mode.primaryMetric.label.startsWith("-") ? "down" : "up";
    const percent = mode.primaryMetric.label
      .replace(/^[+-]/, "")
      .replace("%", " percent");
    return `, ${mode.primaryMetric.value} ${direction} ${percent}`;
  }
  return `, ${mode.primaryMetric.value} ${mode.primaryMetric.label}`;
}

function resolveMetricTone(mode: OneAgentMode): AgentMetricTone {
  const metric = mode.primaryMetric;
  const isZero = isZeroMetric(metric);

  if (metric.value === "—") return "muted";

  if (mode.id === "finance") {
    return metric.label.endsWith("%") ? "default" : "muted";
  }

  if (mode.id === "location") {
    return isZero ? "muted" : "accent";
  }

  if (mode.id === "pkm") {
    return "default";
  }

  if (
    mode.id === "ria" ||
    mode.id === "email" ||
    mode.id === "consent" ||
    mode.id === "connected-systems"
  ) {
    return isZero ? "muted" : "warning";
  }

  return mode.statusTone === "muted" ? "muted" : "default";
}

function metricValueClassName(tone: AgentMetricTone): string {
  if (tone === "positive") return "text-[#34C759]";
  if (tone === "accent") return "text-[color:var(--app-accent-deep)]";
  if (tone === "warning") return "text-[#FF9500]";
  if (tone === "muted") return "text-[#8E8E93]";
  return "text-[#1D1D1F] dark:text-[#F5F5F7]";
}

function metricLabelClassName(tone: AgentMetricTone): string {
  if (tone === "positive") return "text-[#34C759]";
  if (tone === "accent") return "text-[color:var(--app-accent-deep)]";
  if (tone === "warning") return "text-[#8E8E93]";
  if (tone === "muted") return "text-[#8E8E93]";
  return "text-[#8E8E93]";
}

function AgentMetric({
  mode,
  compact = false,
  align = "right",
}: {
  mode: OneAgentMode;
  compact?: boolean;
  /**
   * `left`/`right` are the list-view alignments. `grid` is the dashboard card:
   * one centered line — value + label together at a smaller size — that never
   * wraps or clips (labels shrink to fit; see the 11px label class below).
   */
  align?: "right" | "left" | "grid";
}) {
  const isTopWinner =
    mode.id === "finance" && mode.primaryMetric.label.endsWith("%");
  const tone = resolveMetricTone(mode);
  const valueTone = isTopWinner ? "default" : tone;
  const labelTone = isTopWinner ? "positive" : tone;
  const isGrid = align === "grid";

  if (isGrid && !shouldShowGridMetric(mode)) return null;
  if (!isGrid && !shouldShowListMetric(mode)) return null;

  return (
    <span
      data-testid={isTopWinner ? "one-finance-top-winner-kpi" : undefined}
      className={cn(
        "inline-flex w-full min-w-0 items-baseline gap-1",
        isGrid
          ? "justify-center whitespace-nowrap text-center"
          : align === "left"
            ? "justify-start text-left"
            : "text-right",
        !isGrid &&
          (compact
            ? "max-w-full flex-wrap justify-center"
            : align === "left"
              ? "flex-wrap"
              : "justify-end whitespace-nowrap"),
      )}
    >
      <span
        data-ui-role="body-strong"
        className={cn(
          "shrink-0 tabular-nums font-semibold tracking-normal",
          isGrid ? "text-[11px] leading-4" : "text-[15px] leading-5",
          metricValueClassName(valueTone),
        )}
      >
        {mode.primaryMetric.value}
      </span>
      <span
        data-ui-role="trailing-value"
        className={cn(
          "min-w-0 font-normal tracking-normal",
          isGrid ? "truncate text-[11px] leading-4" : "text-[15px] leading-5",
          !isGrid &&
            (compact
              ? "whitespace-normal text-center [overflow-wrap:anywhere]"
              : "truncate"),
          metricLabelClassName(labelTone),
        )}
      >
        {mode.primaryMetric.label}
      </span>
    </span>
  );
}

function AgentNotificationBadge({ value }: { value: number }) {
  return (
    <span
      data-testid="one-agent-notification-badge"
      className="absolute -right-1.5 -top-1.5 z-20 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-[color:var(--background)] bg-[#FF3B30] px-1 text-[11px] font-semibold leading-none text-white shadow-none"
      aria-hidden
    >
      {formatBadgeValue(value)}
    </span>
  );
}

function AgentLiveDot() {
  return (
    <span
      data-testid="one-agent-live-dot"
      className="absolute -right-0.5 -top-0.5 z-20 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--background)] bg-[#34C759]"
      aria-hidden
    />
  );
}

function AgentGridItem({
  mode,
  className,
}: {
  mode: OneAgentMode;
  className?: string;
}) {
  const badgeValue = actionBadgeValue(mode);
  const liveValue = locationLiveValue(mode);

  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}${formatA11yMetric(mode)}`}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        "group relative flex min-h-[108px] min-w-0 w-full flex-col items-center justify-start gap-2 rounded-[18px] px-1.5 py-1 text-center",
        "transition-[background-color,opacity,transform] duration-150 ease-[var(--motion-ease-standard)]",
        "hover:bg-[rgba(120,120,128,.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60 active:scale-[0.97] active:opacity-80 motion-reduce:transition-none motion-reduce:active:scale-100",
        className,
      )}
    >
      <span className="relative z-10 overflow-visible">
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          paletteIndex={mode.paletteIndex}
          isActive={mode.statusTone !== "muted"}
          size="roster-lg"
          treatment="default"
        />
        {badgeValue !== null ? (
          <AgentNotificationBadge value={badgeValue} />
        ) : liveValue !== null ? (
          <AgentLiveDot />
        ) : null}
      </span>
      <span className="relative z-10 flex w-full min-w-0 flex-col items-center gap-[2px] text-center">
        <span
          className="block w-full truncate text-center text-[13px] font-semibold leading-[17px] tracking-normal text-[#1D1D1F] dark:text-[#F5F5F7]"
          data-ui-role="body-strong"
        >
          {mode.title}
        </span>
        <AgentMetric mode={mode} align="grid" />
      </span>
    </Link>
  );
}

function AgentListRow({ mode }: { mode: OneAgentMode }) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}${formatA11yMetric(mode)}`}
      title={mode.description}
      data-testid={`one-agent-list-row-${mode.id}`}
      className={cn(
        "group/agent-row relative grid min-h-[58px] w-full grid-cols-[40px_minmax(0,1fr)_minmax(84px,auto)_14px] items-center gap-x-3 overflow-hidden px-3.5 text-left outline-none",
        "transition-colors duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-[rgba(120,120,128,.08)] active:bg-[rgba(120,120,128,.12)]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <span className="relative z-10 flex items-center justify-center">
        <span className="relative overflow-visible">
          <AgentSectionIcon
            id={mode.id}
            icon={mode.icon}
            tone={mode.tone}
            paletteIndex={mode.paletteIndex}
            isActive={mode.statusTone !== "muted"}
            size="roster"
            treatment="default"
          />
          {actionBadgeValue(mode) !== null ? (
            <AgentNotificationBadge value={actionBadgeValue(mode) ?? 0} />
          ) : locationLiveValue(mode) !== null ? (
            <AgentLiveDot />
          ) : null}
        </span>
      </span>
      <span className="relative z-10 flex min-w-0 flex-col justify-center">
        <span
          data-ui-role="row-label"
          className="ui-text-row-label min-w-0 truncate"
        >
          {mode.title}
        </span>
        {/*
          The description was carried on every capability but rendered only as a
          `title` attribute — a hover tooltip, which does not exist on a phone.
          A roster of nine one-word labels asks the reader to already know what
          each agent does, and the one people do not find is the one whose name
          explains least.
        */}
        {mode.description ? (
          <span
            data-ui-role="row-description"
            className="min-w-0 truncate text-[12px] leading-[16px] text-[#6E6E73] dark:text-[#98989D]"
          >
            {mode.description}
          </span>
        ) : null}
      </span>
      <span className="relative z-10 flex min-w-0 max-w-[132px] justify-end">
        <AgentMetric mode={mode} />
      </span>
      <ChevronRight
        aria-hidden
        className="relative z-10 h-4 w-4 text-[#C7C7CC] [stroke-width:1.7]"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-16 right-4 h-px bg-[rgba(60,60,67,.12)] group-last/agent-list:hidden"
      />
    </Link>
  );
}

function AgentRosterViewToggle({
  value,
  onChange,
}: {
  value: AgentRosterView;
  onChange: (next: AgentRosterView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Agent roster view"
      className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-[13px] bg-[rgba(120,120,128,.14)] p-0.5"
    >
      <ShellActionSurface
        aria-label="Show agent grid view"
        aria-pressed={value === "grid"}
        data-testid="one-agents-view-grid"
        onClick={() => onChange("grid")}
        className={cn(
          "h-8 w-8 rounded-[11px]",
          value === "grid"
            ? "bg-white text-[color:var(--app-accent-deep)] shadow-[0_1px_2px_rgba(0,0,0,.10)] hover:bg-white dark:bg-[#2C2C2E] dark:text-[color:var(--app-accent-bright)]"
            : "bg-transparent text-[#6E6E73] shadow-none hover:bg-transparent hover:text-[#1D1D1F] dark:bg-transparent dark:text-[#98989D]",
        )}
      >
        <Grid2X2 className="h-4 w-4 [stroke-width:1.8]" aria-hidden />
      </ShellActionSurface>
      <ShellActionSurface
        aria-label="Show agent list view"
        aria-pressed={value === "list"}
        data-testid="one-agents-view-list"
        onClick={() => onChange("list")}
        className={cn(
          "h-8 w-8 rounded-[11px]",
          value === "list"
            ? "bg-white text-[color:var(--app-accent-deep)] shadow-[0_1px_2px_rgba(0,0,0,.10)] hover:bg-white dark:bg-[#2C2C2E] dark:text-[color:var(--app-accent-bright)]"
            : "bg-transparent text-[#6E6E73] shadow-none hover:bg-transparent hover:text-[#1D1D1F] dark:bg-transparent dark:text-[#98989D]",
        )}
      >
        <List className="h-4 w-4 [stroke-width:1.8]" aria-hidden />
      </ShellActionSurface>
    </div>
  );
}

export function OneAgentRoster({
  capabilityStatusById,
  userId,
}: {
  capabilityStatusById: Record<string, CapabilityStatus>;
  userId?: string | null;
}) {
  const cachedMetrics = useCachedAgentMetrics(userId);
  const setupDismissed = Boolean(
    userId &&
      (OneSetupCompletionHintService.isResolved(userId) ||
        PreVaultUserStateService.getCachedBootstrapState(userId)
          ?.setupCompleted === true),
  );
  const modes = buildModes(capabilityStatusById, cachedMetrics, setupDismissed);
  const [view, setView] = useState<AgentRosterView>(readPersistedRosterView);
  const [animateViewChange, setAnimateViewChange] = useState(false);
  const [query, setQuery] = useState("");
  const visibleModes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return modes;
    return modes.filter((mode) =>
      [
        mode.title,
        mode.description,
        mode.primaryMetric.value,
        mode.primaryMetric.label,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [modes, query]);

  const selectView = (next: AgentRosterView) => {
    if (next === view) return;
    setAnimateViewChange(true);
    setView(next);
    try {
      window.localStorage.setItem(AGENT_ROSTER_VIEW_STORAGE_KEY, next);
    } catch {
      // Storage can be disabled without blocking a local display change.
    }
  };

  return (
    <section
      aria-labelledby="one-agents-heading"
      data-testid="one-agents-section"
      className="mx-auto w-full max-w-[560px]"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <PageTitle
          as="h1"
          id="one-agents-heading"
          className="min-w-0 whitespace-nowrap"
        >
          Agents ({modes.length})
        </PageTitle>
        <AgentRosterViewToggle value={view} onChange={selectView} />
      </div>
      <label className="relative mb-3.5 block">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#8E8E93] [stroke-width:1.8]"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search agents"
          aria-label="Search agents"
          data-ui-role="input-text"
          data-testid="one-agents-search"
          className="h-[46px] w-full rounded-[15px] border border-transparent bg-white py-[12px] pl-11 pr-10 text-[15px] font-normal leading-5 text-[#1D1D1F] outline-none placeholder:text-[#8E8E93] focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent)]/55 dark:bg-[#1C1C1E] dark:text-[#F5F5F7]"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[#6E6E73] transition-colors hover:bg-[rgba(120,120,128,.12)] hover:text-[#1D1D1F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/55"
          >
            <X className="h-4 w-4 [stroke-width:2]" aria-hidden />
          </button>
        ) : null}
      </label>
      <div
        key={view}
        data-testid="one-agents-view-content"
        className={animateViewChange ? "motion-step-enter" : undefined}
      >
        {view === "grid" ? (
          <div
            data-testid="one-agents-grid"
            className="mx-auto w-full max-w-[552px] overflow-visible"
          >
            <div
              data-agent-roster-layout="app-icon-launcher-grid"
              className="grid w-full grid-cols-3 justify-center gap-x-4 gap-y-5 overflow-visible min-[430px]:gap-x-6 sm:gap-x-7 sm:gap-y-6"
            >
              {visibleModes.map((mode) => (
                <AgentGridItem key={mode.id} mode={mode} />
              ))}
            </div>
            {visibleModes.length === 0 ? (
              <div
                data-testid="one-agents-empty-state"
                className="py-10 text-center"
              >
                <p className="text-[17px] font-semibold leading-[22px] text-[#1D1D1F] dark:text-[#F5F5F7]">
                  No matching agents
                </p>
                <p className="mt-1 text-[15px] font-normal leading-5 text-[#8E8E93]">
                  Try another search.
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <div
            data-testid="one-agents-list"
            className="group/agent-list overflow-hidden rounded-[20px] bg-white shadow-none dark:bg-[#1C1C1E]"
          >
            {visibleModes.map((mode) => (
              <AgentListRow key={mode.id} mode={mode} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
