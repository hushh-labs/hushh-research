"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Grid2X2, List, Search } from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";

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
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
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
type AgentMetricTone = "default" | "positive" | "warning" | "muted";

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
  if (typeof window === "undefined") return "list";
  try {
    const persisted = window.localStorage.getItem(
      AGENT_ROSTER_VIEW_STORAGE_KEY,
    );
    return persisted === "grid" ? "grid" : "list";
  } catch {
    return "list";
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
      label:
        pendingConsents.length === 1
          ? "request to review"
          : "requests to review",
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
      label: liveShares === 1 ? "live share" : "live shares",
    };
  }

  const metadata = cache.peek<PersonalKnowledgeModelMetadata>(
    CACHE_KEYS.PKM_METADATA(userId),
  )?.data;
  const attributes = positiveNumber(metadata?.totalAttributes);
  if (attributes !== null) {
    metrics.pkm = {
      value: String(attributes),
      label: attributes === 1 ? "saved detail" : "saved details",
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
      label: connectedSystems === 1 ? "connected system" : "connected systems",
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
      return { value: "—", label: "checking requests" };
    }
    const pendingConsentCount = status.pendingCount;
    return {
      value: String(pendingConsentCount),
      label:
        pendingConsentCount === 1 ? "request to review" : "requests to review",
    };
  }

  if (!status || status.state === "unknown") {
    return { value: "—", label: "status not loaded" };
  }

  if (status.pendingCount > 0) {
    return {
      value: String(status.pendingCount),
      label: status.pendingCount === 1 ? "item to review" : "items to review",
    };
  }

  const actionsDue =
    status.state === "completed" || status.state === "skipped" ? 0 : 1;
  return {
    value: String(actionsDue),
    label: actionsDue === 1 ? "action due" : "actions due",
  };
}

function isZeroMetric(metric: AgentMetric): boolean {
  return Number(metric.value) === 0;
}

function resolveMetricTone(mode: OneAgentMode): AgentMetricTone {
  const metric = mode.primaryMetric;
  const isZero = isZeroMetric(metric);

  if (metric.value === "—") return "muted";

  if (mode.id === "finance") {
    return metric.label.endsWith("%") ? "default" : "muted";
  }

  if (mode.id === "location") {
    return isZero ? "muted" : "positive";
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
  if (tone === "warning") return "text-[#FF9500]";
  if (tone === "muted") return "text-[#8E8E93]";
  return "text-[#1D1D1F] dark:text-[#F5F5F7]";
}

function metricLabelClassName(tone: AgentMetricTone): string {
  if (tone === "positive") return "text-[#34C759]";
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

function AgentGridItem({
  mode,
  className,
}: {
  mode: OneAgentMode;
  className?: string;
}) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        // Reference design: centered card — large pastel icon tile, then a
        // bold title, then a single-line KPI ("1 action due"). `min-w-0` +
        // consistent gaps keep every cell's icon/title/KPI on the same
        // baseline across columns. Colors are unchanged (the tone logic in
        // AgentMetric still drives them).
        "group relative flex min-h-[9.5rem] min-w-0 w-full flex-col items-center justify-start gap-2.5 overflow-hidden rounded-[16px] px-2 py-3.5 text-center",
        "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-[color:var(--app-card-surface-compact)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-inset active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        className,
      )}
    >
      <AgentSectionIcon
        id={mode.id}
        icon={mode.icon}
        tone={mode.tone}
        paletteIndex={mode.paletteIndex}
        isActive={mode.statusTone !== "muted"}
        size="roster-lg"
        treatment="profile"
        glyphContrast="default"
        className="relative z-10"
      />
      <span className="relative z-10 flex w-full min-w-0 flex-col items-center gap-1 text-center">
        <span
          className="block w-full truncate text-center text-[16px] font-semibold leading-5 tracking-[-0.01em] text-[#1D1D1F] dark:text-[#F5F5F7]"
          data-ui-role="body-strong"
        >
          {mode.title}
        </span>
        <AgentMetric mode={mode} align="grid" />
      </span>
      <MaterialRipple variant="blue" effect="fade" className="z-0" />
    </Link>
  );
}

function AgentListRow({ mode }: { mode: OneAgentMode }) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      title={mode.description}
      data-testid={`one-agent-list-row-${mode.id}`}
      className={cn(
        "group/agent-row relative grid min-h-[64px] w-full grid-cols-[40px_minmax(0,1fr)_auto_14px] items-center gap-x-3 overflow-hidden px-3.5 text-left outline-none",
        "transition-colors duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-[rgba(120,120,128,.08)] active:bg-[rgba(120,120,128,.12)]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <span className="relative z-10 flex items-center justify-center">
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          paletteIndex={mode.paletteIndex}
          isActive={mode.statusTone !== "muted"}
          size="roster"
          treatment="profile"
          glyphContrast="default"
        />
      </span>
      <span
        data-ui-role="row-label"
        className="ui-text-row-label relative z-10 min-w-0 truncate"
      >
        {mode.title}
      </span>
      <span className="relative z-10 flex min-w-0 max-w-[148px] justify-end">
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
      <MaterialRipple variant="blue" effect="fade" className="z-0" />
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
      className="inline-flex h-11 shrink-0 items-center rounded-[14px] bg-[rgba(120,120,128,.12)] p-0"
    >
      <ShellActionSurface
        aria-label="Show agent grid view"
        aria-pressed={value === "grid"}
        data-testid="one-agents-view-grid"
        onClick={() => onChange("grid")}
        className={cn(
          "h-11 w-11 rounded-[14px]",
          value === "grid"
            ? "bg-[color:var(--app-accent)] text-white shadow-none hover:bg-[color:var(--app-accent)] dark:bg-[color:var(--app-accent)]"
            : "bg-transparent text-[#6E6E73] shadow-none hover:bg-transparent hover:text-[#1D1D1F] dark:bg-transparent",
        )}
      >
        <Grid2X2 className="h-[17px] w-[17px] [stroke-width:1.8]" aria-hidden />
      </ShellActionSurface>
      <ShellActionSurface
        aria-label="Show agent list view"
        aria-pressed={value === "list"}
        data-testid="one-agents-view-list"
        onClick={() => onChange("list")}
        className={cn(
          "h-11 w-11 rounded-[14px]",
          value === "list"
            ? "bg-[color:var(--app-accent)] text-white shadow-none hover:bg-[color:var(--app-accent)] dark:bg-[color:var(--app-accent)]"
            : "bg-transparent text-[#6E6E73] shadow-none hover:bg-transparent hover:text-[#1D1D1F] dark:bg-transparent",
        )}
      >
        <List className="h-[17px] w-[17px] [stroke-width:1.8]" aria-hidden />
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
      className="mx-auto w-full max-w-[880px]"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="one-agents-heading"
          className="min-w-0 truncate text-[28px] font-bold leading-[34px] tracking-normal text-[#1D1D1F]"
        >
          Agents ({modes.length})
        </h2>
        <AgentRosterViewToggle value={view} onChange={selectView} />
      </div>
      <label className="relative mb-4 block">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground [stroke-width:1.8]"
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
          className="h-[52px] w-full rounded-[16px] border border-[rgba(60,60,67,.12)] bg-white py-[15px] pl-11 pr-4 text-[17px] font-normal leading-[22px] text-[#1D1D1F] outline-none placeholder:text-[#8E8E93] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/70 dark:bg-[#1C1C1E] dark:text-[#F5F5F7]"
        />
      </label>
      <div
        key={view}
        data-testid="one-agents-view-content"
        className={animateViewChange ? "motion-step-enter" : undefined}
      >
        {view === "grid" ? (
          <div
            data-testid="one-agents-grid"
            className="rounded-[var(--app-card-radius-standard,24px)] bg-white p-2 shadow-[var(--app-card-shadow-standard)] dark:bg-[#1C1C1E]"
          >
            <div
              data-agent-roster-layout="grouped-icon-grid"
              className="grid w-full grid-cols-[repeat(3,104px)] justify-center gap-x-2 gap-y-2 min-[430px]:grid-cols-[repeat(3,112px)] sm:grid-cols-[repeat(4,128px)] sm:gap-x-2.5 sm:gap-y-3"
            >
              {visibleModes.map((mode) => (
                <AgentGridItem key={mode.id} mode={mode} />
              ))}
            </div>
          </div>
        ) : (
          <div
            data-testid="one-agents-list"
            className="group/agent-list overflow-hidden rounded-[var(--app-card-radius-standard,24px)] bg-white shadow-[var(--app-card-shadow-standard)] dark:bg-[#1C1C1E]"
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
