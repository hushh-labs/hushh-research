"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Grid2X2, List, Search, X } from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { PageSubtitle, PageTitle } from "@/components/app-ui/typography";
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

const AGENT_ROSTER_VIEW_STORAGE_KEY = "hushh:one-agent-roster-view";

/**
 * Screen-local rename: this roster shows plain, friendly labels instead of
 * the internal capability names. `capability.id`, routes, analytics and
 * every other screen that reads `capability.title` (setup steps, breadcrumbs,
 * the onboarding preview) are untouched — this map only changes what a
 * person reads on THIS grid/list.
 */
const AGENT_ROSTER_DISPLAY_LABEL: Partial<Record<string, string>> = {
  finance: "Money",
  ria: "Advisor",
  email: "Identity", // capability id for the KYC agent
  consent: "Approvals",
  "connected-systems": "Customers",
};

function agentDisplayLabel(mode: OneAgentMode): string {
  return AGENT_ROSTER_DISPLAY_LABEL[mode.id] ?? mode.title;
}

/*
 * AGENT ARTWORK IS IDENTITY, NOT STATE.
 *
 * This roster used to paint its icons two ways, and both drained them.
 *
 * It collapsed nine agent colours into three tint families (indigo / blue /
 * neutral) built from 14–16% alphas, so a chip measured 1.20–1.26:1 against
 * the white card it sits on — a chip you cannot see is not a chip. It also
 * passed `isActive={statusTone !== "muted"}`, and every vault-gated
 * capability resolves to `unknown` -> `muted` while the lock is on, which is
 * the normal state on landing here. Eight of the nine icons therefore
 * rendered grey-on-grey at 2.07:1, under the 3:1 floor WCAG 2.2 SC 1.4.11
 * sets for a graphical object.
 *
 * Both are now gone. Each agent wears its own saturated identity chip from
 * `AGENT_THEME_BY_TONE`, in both themes, whatever its setup state — which is
 * what `capability-status-display.ts` already asks for: "the premium card
 * model forbids tinting outer chrome to signal state — emphasis comes from
 * copy + elevation". Setup state is carried by the row's pending badge only.
 */

/** Icon feedback for a whole tile/row press. Lift on hover, settle on press. */
const AGENT_ICON_INTERACTION_CLASSNAME =
  "transition-[transform,box-shadow] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] " +
  "group-hover:-translate-y-px group-hover:shadow-[0_6px_16px_rgba(0,0,0,0.18)] " +
  "group-active:translate-y-0 group-active:scale-[0.94] group-active:shadow-none " +
  "motion-reduce:transition-none motion-reduce:group-active:scale-100";

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

/**
 * A single, reused rule for turning an existing metric into an at-a-glance
 * signal: a small amber count badge for pending work, or — for Location only
 * — a blue "Live" badge instead of a raw share count. No new backend state:
 * this only reads `mode.primaryMetric`, exactly as the roster already did.
 * Zero, unresolved ("—") and informational values (e.g. Finance's ticker,
 * which is text, not a count) all resolve to `null`, i.e. no badge — the
 * screen shows nothing for them rather than a "0" or a stale placeholder.
 */
type AgentBadge = { kind: "count"; value: number } | { kind: "live" };

function resolveAgentBadge(mode: OneAgentMode): AgentBadge | null {
  const raw = Number(mode.primaryMetric.value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (mode.id === "location") return { kind: "live" };
  return { kind: "count", value: raw };
}

/** Screen-reader-only text for the badge, using the existing metric wording. */
function agentBadgeAccessibleText(mode: OneAgentMode, badge: AgentBadge): string {
  if (badge.kind === "live") return "Live";
  return `${badge.value} ${mode.primaryMetric.label}`;
}

function AgentStatusBadge({
  badge,
  agentId,
}: {
  badge: AgentBadge;
  agentId: string;
}) {
  if (badge.kind === "live") {
    return (
      <span
        aria-hidden
        data-testid={`one-agent-badge-${agentId}`}
        data-agent-badge-kind="live"
        className="absolute -right-1 -top-1 z-20 flex h-4 items-center whitespace-nowrap rounded-full bg-[color:var(--app-accent)] px-[6px] text-[9px] font-semibold leading-none text-white ring-2 ring-background"
      >
        Live
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-testid={`one-agent-badge-${agentId}`}
      data-agent-badge-kind="count"
      className="absolute -right-1 -top-1 z-20 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#FF9500] px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-background"
    >
      {badge.value}
    </span>
  );
}

/** Shared icon + corner badge, used identically by the grid tile and the list row. */
function AgentIconWithBadge({
  mode,
  size,
  badge,
  descriptionId,
}: {
  mode: OneAgentMode;
  size: "roster" | "roster-dashboard";
  badge: AgentBadge | null;
  descriptionId: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <AgentSectionIcon
        id={mode.id}
        icon={mode.icon}
        tone={mode.tone}
        paletteIndex={mode.paletteIndex}
        size={size}
        className={AGENT_ICON_INTERACTION_CLASSNAME}
      />
      {badge ? <AgentStatusBadge badge={badge} agentId={mode.id} /> : null}
      {badge ? (
        <span id={descriptionId} className="sr-only">
          {agentBadgeAccessibleText(mode, badge)}
        </span>
      ) : null}
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
  const label = agentDisplayLabel(mode);
  const badge = resolveAgentBadge(mode);
  const descriptionId = `one-agent-status-${mode.id}-grid`;

  return (
    <Link
      href={mode.href}
      aria-label={`Open ${label}`}
      aria-describedby={badge ? descriptionId : undefined}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        "group relative flex min-h-[96px] min-w-0 w-full flex-col items-center justify-start gap-[7px] overflow-hidden rounded-[14px] px-1.5 py-2 text-center",
        "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-[rgba(120,120,128,.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60 focus-visible:ring-inset active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        className,
      )}
    >
      <AgentIconWithBadge
        mode={mode}
        size="roster-dashboard"
        badge={badge}
        descriptionId={descriptionId}
      />
      <span
        className="relative z-10 block w-full min-w-0 truncate text-center text-[14px] font-semibold leading-[18px] tracking-normal text-[#1D1D1F] dark:text-[#F5F5F7]"
        data-ui-role="body-strong"
      >
        {label}
      </span>
      <MaterialRipple variant="blue" effect="fade" className="z-0" />
    </Link>
  );
}

function AgentListRow({ mode }: { mode: OneAgentMode }) {
  const label = agentDisplayLabel(mode);
  const badge = resolveAgentBadge(mode);
  const descriptionId = `one-agent-status-${mode.id}-list`;

  return (
    <Link
      href={mode.href}
      aria-label={`Open ${label}`}
      aria-describedby={badge ? descriptionId : undefined}
      title={mode.description}
      data-testid={`one-agent-list-row-${mode.id}`}
      className={cn(
        // Both group names on purpose: `agent-row` is the named group the row
        // hairline already keys off, and the bare `group` is what the shared
        // icon interaction class reads.
        "group group/agent-row relative grid min-h-[58px] w-full grid-cols-[40px_minmax(0,1fr)_14px] items-center gap-x-3 overflow-hidden px-3.5 text-left outline-none",
        "transition-colors duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-[rgba(120,120,128,.08)] active:bg-[rgba(120,120,128,.12)]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <span className="relative z-10 flex items-center justify-center">
        <AgentIconWithBadge
          mode={mode}
          size="roster"
          badge={badge}
          descriptionId={descriptionId}
        />
      </span>
      <span
        data-ui-role="row-label"
        className="ui-text-row-label relative z-10 min-w-0 truncate"
      >
        {label}
      </span>
      <ChevronRight
        aria-hidden
        // #C7C7CC measured 1.68:1 on the white card — a chevron nobody could
        // see. #8E8E93 is the same iOS grey family at 3.10:1.
        className="relative z-10 h-4 w-4 text-[#8E8E93] [stroke-width:1.7]"
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
        agentDisplayLabel(mode),
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
      className="mx-auto w-full max-w-[720px] pb-[calc(var(--app-bottom-fixed-ui,96px)+1.75rem)] md:pb-[calc(var(--app-bottom-fixed-ui,96px)+2rem)]"
    >
      <div className="mb-4 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <PageTitle
            as="h1"
            id="one-agents-heading"
            className="min-w-0 whitespace-nowrap"
          >
            Your agents
          </PageTitle>
          <AgentRosterViewToggle value={view} onChange={selectView} />
        </div>
        <PageSubtitle className="text-muted-foreground">
          Choose what you need.
        </PageSubtitle>
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
          placeholder="Search"
          aria-label="Search agents"
          data-ui-role="input-text"
          data-testid="one-agents-search"
          className="h-[52px] w-full rounded-[16px] border border-[rgba(60,60,67,.12)] bg-white py-[11px] pl-11 pr-11 text-[15px] font-normal leading-5 text-[#1D1D1F] outline-none placeholder:text-[#8E8E93] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60 dark:bg-[#1C1C1E] dark:text-[#F5F5F7]"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-[rgba(120,120,128,.16)] text-[#8E8E93] hover:bg-[rgba(120,120,128,.24)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
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
            data-agent-roster-layout="grouped-icon-grid"
            className="grid w-full grid-cols-[repeat(3,minmax(84px,1fr))] justify-center gap-x-2 gap-y-6 min-[430px]:grid-cols-[repeat(3,minmax(96px,1fr))] sm:gap-x-3 sm:gap-y-7"
          >
            {visibleModes.map((mode) => (
              <AgentGridItem key={mode.id} mode={mode} />
            ))}
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
