"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Grid2X2, List, Search } from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { MajorSectionTitle } from "@/components/app-ui/typography";
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
import {
  INITIAL_METRIC_STATE,
  METRIC_MAX_AGE_MS,
  observeInteraction,
  shouldRecalculate,
  type MetricRecalcState,
} from "@/lib/dashboard/agent-metrics-policy";
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

/**
 * Metrics under a recalculation policy, rather than on every cache event.
 *
 * This previously bumped a revision for ANY cache write touching the user, so an
 * unrelated location ping or feed read re-derived every agent's metric — while a
 * person who did nothing never refreshed at all, because nothing wrote. Both
 * problems are the same missing idea, and `agent-metrics-policy` is that idea:
 * recompute after enough relevant interactions, OR after enough time, whichever
 * comes first.
 */
function useCachedAgentMetrics(
  userId?: string | null,
): Record<string, AgentMetric> {
  const [revision, setRevision] = useState(0);
  const policy = useRef<MetricRecalcState>(INITIAL_METRIC_STATE);

  useEffect(() => {
    if (!userId) return;
    return CacheService.getInstance().subscribe((event) => {
      const keys =
        event.type === "set"
          ? [event.key]
          : event.type === "invalidate" || event.type === "invalidate_user"
            ? event.keys
            : [];
      // A clear wipes what the projection reads, so it is not an "interaction"
      // to be counted — there is simply nothing left to show. Recompute now.
      if (event.type === "clear") {
        policy.current = INITIAL_METRIC_STATE;
        setRevision((current) => current + 1);
        return;
      }
      let due = false;
      for (const key of keys) {
        if (!key.includes(userId)) continue;
        const result = observeInteraction(policy.current, key, Date.now());
        policy.current = result.state;
        due = due || result.recalculate;
      }
      if (due) setRevision((current) => current + 1);
    });
  }, [userId]);

  // An age-based recompute needs something to wake it: with no further cache
  // writes, no event would ever arrive to notice the metric had gone stale.
  useEffect(() => {
    if (!userId) return;
    const timer = window.setInterval(() => {
      if (shouldRecalculate(policy.current, Date.now())) {
        policy.current = {
          interactionsSinceRecompute: 0,
          lastRecomputedAt: Date.now(),
        };
        setRevision((current) => current + 1);
      }
    }, METRIC_MAX_AGE_MS);
    return () => window.clearInterval(timer);
  }, [userId]);

  // `revision` is deliberately read so a policy-approved recompute produces a
  // fresh, read-only projection without introducing a second cache mirror.
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
      // Once onboarding is dismissed, a home tile for a not-yet-configured
      // capability opens the capability's OWN screen — never the setup hub.
      // Setup is reachable only via Profile → "Set Up One" (post-onboarding),
      // and routing a tile into a setup surface would be ejected by the guard.
      href:
        !setupDismissed && setupCapability && isActionable
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

function statusClassName(mode: OneAgentMode): string {
  if (mode.statusTone === "ready") return "text-[#138a3d] dark:text-[#5ee283]";
  if (mode.statusTone === "attention") return "text-accent-strong";
  if (mode.statusTone === "action") return "text-foreground";
  return "text-muted-foreground";
}

function metricClassName(mode: OneAgentMode): string {
  if (
    (mode.id === "finance" && mode.primaryMetric.label.endsWith("%")) ||
    mode.id === "connected-systems"
  ) {
    return "text-emerald-700 dark:text-emerald-300";
  }
  return statusClassName(mode);
}

function AgentMetricDisplay({
  mode,
  compact = false,
}: {
  mode: OneAgentMode;
  compact?: boolean;
}) {
  const isTopWinner =
    mode.id === "finance" && mode.primaryMetric.label.endsWith("%");
  const isPositiveMetric = isTopWinner || mode.id === "connected-systems";

  return (
    <span
      data-testid={isTopWinner ? "one-finance-top-winner-kpi" : undefined}
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1 whitespace-nowrap leading-tight",
        compact ? "justify-center" : "justify-end",
      )}
    >
      <span
        className={cn(
          "shrink-0 font-semibold tabular-nums tracking-normal",
          compact ? "text-[13px]" : "text-[15px]",
          metricClassName(mode),
        )}
      >
        {mode.primaryMetric.value}
      </span>
      <span
        className={cn(
          "min-w-0 truncate font-normal text-muted-foreground",
          compact ? "text-[12px]" : "text-[13px]",
          isPositiveMetric && "text-emerald-700/80 dark:text-emerald-300/85",
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
        "group relative flex min-h-[8.25rem] min-w-0 w-full flex-col items-center justify-start gap-2 overflow-hidden rounded-[12px] px-2.5 py-3 text-center",
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
        size="launcher"
        treatment="profile"
        glyphContrast="default"
        className="relative z-10"
      />
      <span className="relative z-10 min-w-0">
        <span className="block truncate text-[15px] font-normal leading-[20px] tracking-normal text-foreground">
          {mode.title}
        </span>
        <AgentMetricDisplay mode={mode} compact />
      </span>
      <MaterialRipple variant="blue" effect="fade" className="z-0" />
    </Link>
  );
}

function AgentListRow({ mode }: { mode: OneAgentMode }) {
  return (
    <SettingsRow
      asChild
      density="compact"
      title={mode.title}
      className="[--settings-row-px:16px] [--settings-row-py:10px]"
      leading={
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          paletteIndex={mode.paletteIndex}
          isActive={mode.statusTone !== "muted"}
          size="menu"
          treatment="profile"
          glyphContrast="default"
        />
      }
      trailing={<AgentMetricDisplay mode={mode} />}
      chevron
      testId={`one-agent-list-row-${mode.id}`}
    >
      <Link
        href={mode.href}
        aria-label={`Open ${mode.title}`}
        title={mode.description}
      />
    </SettingsRow>
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
      className="inline-flex shrink-0 items-center gap-1 rounded-[14px] bg-[color:var(--app-card-surface-compact)] p-1"
    >
      <ShellActionSurface
        aria-label="Show agent grid view"
        aria-pressed={value === "grid"}
        data-testid="one-agents-view-grid"
        onClick={() => onChange("grid")}
        className={cn(
          "h-9 w-9 rounded-[11px]",
          value === "grid"
            ? "bg-accent text-accent-foreground shadow-none hover:bg-accent dark:bg-accent"
            : "bg-transparent text-muted-foreground shadow-none hover:bg-foreground/[0.06] hover:text-foreground dark:bg-transparent",
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
          "h-9 w-9 rounded-[11px]",
          value === "list"
            ? "bg-accent text-accent-foreground shadow-none hover:bg-accent dark:bg-accent"
            : "bg-transparent text-muted-foreground shadow-none hover:bg-foreground/[0.06] hover:text-foreground dark:bg-transparent",
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
      className="mx-auto w-full max-w-[720px]"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <MajorSectionTitle
          as="h2"
          id="one-agents-heading"
          className="text-[28px] leading-[34px]"
        >
          agents ({modes.length})
        </MajorSectionTitle>
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
          placeholder="search agents"
          aria-label="search agents"
          data-testid="one-agents-search"
          className="h-11 w-full rounded-[16px] border-0 bg-[color:var(--app-card-surface-compact)] py-2 pl-11 pr-4 text-[17px] font-normal leading-[22px] tracking-normal text-foreground outline-none ring-1 ring-border/55 placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
        />
      </label>
      <div
        key={view}
        data-testid="one-agents-view-content"
        className={animateViewChange ? "motion-step-enter" : undefined}
      >
        {view === "grid" ? (
          <SettingsGroup
            embedded
            testId="one-agents-grid"
            className="[&_[data-slot=settings-group-shell]]:p-1.5 sm:[&_[data-slot=settings-group-shell]]:p-2"
          >
            <div
              data-agent-roster-layout="grouped-icon-grid"
              className="grid w-full grid-cols-3 gap-1.5 sm:grid-cols-4 sm:gap-2.5"
            >
              {visibleModes.map((mode) => (
                <AgentGridItem key={mode.id} mode={mode} />
              ))}
            </div>
          </SettingsGroup>
        ) : (
          <SettingsGroup embedded separatorInset testId="one-agents-list">
            {visibleModes.map((mode) => (
              <AgentListRow key={mode.id} mode={mode} />
            ))}
          </SettingsGroup>
        )}
      </div>
    </section>
  );
}
