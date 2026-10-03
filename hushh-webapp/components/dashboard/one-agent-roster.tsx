"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  CaretRightIcon,
  GridIcon,
  ListIcon,
  SearchIcon,
} from "@/components/icons/ui";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { SearchClearButton } from "@/components/app-ui/search-clear-button";
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
  isCapabilityOnboarded,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
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
import type { AgentProfileIconStyle } from "@/lib/design/agent-theme-registry";
import {
  DASHBOARD_AGENT_ICON_STYLE_BY_ID,
  DEFAULT_DASHBOARD_AGENT_ICON_STYLE,
} from "@/lib/design/home-icon-palette";

type OneAgentMode = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: OneCapabilityIcon;
  statusTone: CapabilityStatusTone;
  /**
   * Computed but not currently rendered -- greyscale-until-onboarded icons
   * were reverted (icons stay full color regardless of setup state) pending
   * further product direction. Kept so the icon treatment is a one-line
   * change to bring back, not a rebuild.
   */
  isOnboarded: boolean;
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

/**
 * Returns true only when this person is actively sharing their location.
 * Received grants describe someone else's share and must not light up the
 * owner's roster entry as if the owner had an active outbound share.
 */
export function hasActiveLocationActivity(
  location: OneLocationState | null | undefined,
): boolean {
  return (location?.ownerGrants ?? []).some(
    (grant) => /^(active|shared|granted)$/i.test(String(grant.status).trim()),
  );
}

const AGENT_ROSTER_VIEW_STORAGE_KEY = "hushh:one-agent-roster-view";

function dashboardAgentIconStyle(mode: OneAgentMode): AgentProfileIconStyle {
  const palette: Readonly<Record<string, AgentProfileIconStyle>> =
    DASHBOARD_AGENT_ICON_STYLE_BY_ID;
  return palette[mode.id] ?? DEFAULT_DASHBOARD_AGENT_ICON_STYLE;
}

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
    const liveShares = location.ownerGrants.filter((grant) =>
      /^(active|shared|granted)$/i.test(String(grant.status).trim()),
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

const ROSTER_DISPLAY_ORDER: readonly string[] = [
  "gmail",
  "calendar",
  "location",
  "finance",
  "ria",
  "wallet",
  "pkm",
  "consent",
];

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
        ? capability.id === "finance"
          ? `${buildOneSetupCapabilityRoute(capability.id)}?from=${encodeURIComponent(ROUTES.ONE_HOME)}`
          : buildOneSetupCapabilityRoute(capability.id)
        : capability.href,
      icon: capability.icon,
      statusTone: display.tone,
      isOnboarded: isCapabilityOnboarded(status),
      primaryMetric,
      paletteIndex,
      tone: capability.tone,
      isExploreOnly: capability.isExploreOnly === true,
    };
  }).sort((a, b) => {
    const rank = (id: string) => {
      const index = ROSTER_DISPLAY_ORDER.indexOf(id);
      return index < 0 ? ROSTER_DISPLAY_ORDER.length : index;
    };
    return rank(a.id) - rank(b.id);
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

interface AgentCardTheme {
  cardBg: string;
  cardBorder: string;
  badgeBg: string;
  badgeFg: string;
  circleBtnBg: string;
  circleBtnFg: string;
}

const AGENT_CARD_THEME_BY_ID: Record<string, AgentCardTheme> = {
  gmail: {
    cardBg: "bg-[#FFF5F6] dark:bg-[#200B10]",
    cardBorder: "border-[#FFE5E8] dark:border-[#4C121E]",
    badgeBg: "bg-[#FFE8EC] dark:bg-[#381018]",
    badgeFg: "text-[#E11D48] dark:text-[#FB7185]",
    circleBtnBg: "bg-[#FFE8EC] dark:bg-[#381018]",
    circleBtnFg: "text-[#E11D48] dark:text-[#FB7185]",
  },
  calendar: {
    cardBg: "bg-[#F0F8FF] dark:bg-[#07192E]",
    cardBorder: "border-[#E0F0FE] dark:border-[#0C2D52]",
    badgeBg: "bg-[#E2F1FE] dark:bg-[#0E3560]",
    badgeFg: "text-[#0284C7] dark:text-[#38BDF8]",
    circleBtnBg: "bg-[#E2F1FE] dark:bg-[#0E3560]",
    circleBtnFg: "text-[#0284C7] dark:text-[#38BDF8]",
  },
  location: {
    cardBg: "bg-[#F2F9FF] dark:bg-[#071B30]",
    cardBorder: "border-[#E2F0FE] dark:border-[#0E3258]",
    badgeBg: "bg-[#E2F1FE] dark:bg-[#0E3560]",
    badgeFg: "text-[#0284C7] dark:text-[#38BDF8]",
    circleBtnBg: "bg-[#E2F1FE] dark:bg-[#0E3560]",
    circleBtnFg: "text-[#0284C7] dark:text-[#38BDF8]",
  },
  finance: {
    cardBg: "bg-[#F0FDF4] dark:bg-[#061F12]",
    cardBorder: "border-[#DCFCE7] dark:border-[#0F3D24]",
    badgeBg: "bg-[#DCFCE7] dark:bg-[#0F3D24]",
    badgeFg: "text-[#16A34A] dark:text-[#4ADE80]",
    circleBtnBg: "bg-[#DCFCE7] dark:bg-[#0F3D24]",
    circleBtnFg: "text-[#16A34A] dark:text-[#4ADE80]",
  },
  ria: {
    cardBg: "bg-[#FAF5FF] dark:bg-[#1C0B2E]",
    cardBorder: "border-[#F3E8FF] dark:border-[#38145C]",
    badgeBg: "bg-[#F3E8FF] dark:bg-[#38145C]",
    badgeFg: "text-[#9333EA] dark:text-[#C084FC]",
    circleBtnBg: "bg-[#F3E8FF] dark:bg-[#38145C]",
    circleBtnFg: "text-[#9333EA] dark:text-[#C084FC]",
  },
  wallet: {
    cardBg: "bg-[#FFFBEB] dark:bg-[#261604]",
    cardBorder: "border-[#FEF3C7] dark:border-[#4B2C08]",
    badgeBg: "bg-[#FEF3C7] dark:bg-[#4B2C08]",
    badgeFg: "text-[#D97706] dark:text-[#FBBF24]",
    circleBtnBg: "bg-[#FEF3C7] dark:bg-[#4B2C08]",
    circleBtnFg: "text-[#D97706] dark:text-[#FBBF24]",
  },
  pkm: {
    cardBg: "bg-[#F4F6FF] dark:bg-[#0F132C]",
    cardBorder: "border-[#E5EBFF] dark:border-[#1E2556]",
    badgeBg: "bg-[#E6ECFE] dark:bg-[#1E2556]",
    badgeFg: "text-[#4F46E5] dark:text-[#818CF8]",
    circleBtnBg: "bg-[#E6ECFE] dark:bg-[#1E2556]",
    circleBtnFg: "text-[#4F46E5] dark:text-[#818CF8]",
  },
  consent: {
    cardBg: "bg-[#FFF7ED] dark:bg-[#281106]",
    cardBorder: "border-[#FFEDD5] dark:border-[#4E220C]",
    badgeBg: "bg-[#FFEDD5] dark:bg-[#4E220C]",
    badgeFg: "text-[#EA580C] dark:text-[#FB923C]",
    circleBtnBg: "bg-[#FFEDD5] dark:bg-[#4E220C]",
    circleBtnFg: "text-[#EA580C] dark:text-[#FB923C]",
  },
};

const DEFAULT_AGENT_CARD_THEME: AgentCardTheme = {
  cardBg: "bg-muted/40 dark:bg-muted/20",
  cardBorder: "border-border/60 dark:border-white/10",
  badgeBg: "bg-muted dark:bg-white/10",
  badgeFg: "text-muted-foreground dark:text-muted-foreground",
  circleBtnBg: "bg-muted dark:bg-white/10",
  circleBtnFg: "text-foreground dark:text-foreground",
};

function AgentMetric({
  mode,
  align = "right",
}: {
  mode: OneAgentMode;
  align?: "right" | "left" | "grid" | "pill";
}) {
  const isTopWinner =
    mode.id === "finance" && mode.primaryMetric.label.endsWith("%");
  const tone = resolveMetricTone(mode);
  const valueTone = isTopWinner ? "default" : tone;
  const labelTone = isTopWinner ? "positive" : tone;
  const isGrid = align === "grid";
  const isPill = align === "pill";

  return (
    <span
      data-testid={isTopWinner ? "one-finance-top-winner-kpi" : undefined}
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1",
        isPill
          ? "items-center whitespace-nowrap"
          : isGrid
            ? "justify-start whitespace-nowrap text-left"
            : align === "left"
              ? "justify-start text-left"
              : "justify-end whitespace-nowrap text-right",
      )}
    >
      <span
        data-ui-role="body-strong"
        className={cn(
          "shrink-0 tabular-nums font-semibold tracking-normal",
          isPill
            ? "text-xs font-bold"
            : isGrid
              ? "text-[12px] leading-4 font-bold text-foreground/90 sm:text-[13px]"
              : "text-[15px] leading-5",
          !isPill && !isGrid && metricValueClassName(valueTone),
        )}
      >
        {mode.primaryMetric.value}
      </span>
      <span
        data-ui-role="trailing-value"
        className={cn(
          "min-w-0 tracking-normal",
          isPill
            ? "text-xs font-medium"
            : isGrid
              ? "truncate text-[12px] leading-4 font-normal text-muted-foreground sm:text-[13px]"
              : "text-[15px] leading-5",
          !isPill && !isGrid && metricLabelClassName(labelTone),
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
  const theme = AGENT_CARD_THEME_BY_ID[mode.id] ?? DEFAULT_AGENT_CARD_THEME;

  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        "group relative flex min-h-[136px] w-full flex-col justify-between overflow-hidden rounded-[20px] border p-3.5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.02)] sm:min-h-[148px] sm:p-4",
        "transition-all duration-200 ease-out hover:scale-[1.015] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60 focus-visible:ring-inset motion-reduce:transition-none",
        theme.cardBg,
        theme.cardBorder,
        className,
      )}
    >
      <div className="relative z-10 flex items-start justify-between">
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          paletteIndex={mode.paletteIndex}
          isActive
          size="roster"
          treatment="profile"
          glyphContrast="default"
          profileStyle={dashboardAgentIconStyle(mode)}
        />
      </div>

      <div className="relative z-10 flex items-end justify-between gap-2 pt-3">
        <div className="flex min-w-0 flex-col">
          <span
            className="block truncate text-[14px] font-semibold leading-tight text-[#1D1D1F] dark:text-[#F5F5F7] sm:text-[15px]"
            data-ui-role="body-strong"
          >
            {mode.title}
          </span>
          <div className="mt-1 flex items-center">
            <AgentMetric mode={mode} align="grid" />
          </div>
        </div>

        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-transform duration-200 group-hover:translate-x-0.5",
            theme.circleBtnBg,
            theme.circleBtnFg,
          )}
          aria-hidden="true"
        >
          <CaretRightIcon className="h-3.5 w-3.5 stroke-[2.5]" />
        </div>
      </div>

      <MaterialRipple variant="blue" effect="fade" className="z-0" />
    </Link>
  );
}

function AgentListRow({ mode }: { mode: OneAgentMode }) {
  const theme = AGENT_CARD_THEME_BY_ID[mode.id] ?? DEFAULT_AGENT_CARD_THEME;

  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      title={mode.description}
      data-testid={`one-agent-list-row-${mode.id}`}
      className={cn(
        "group/agent-row relative flex min-h-[58px] w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none transition-colors duration-150",
        "hover:bg-[rgba(120,120,128,.06)] active:bg-[rgba(120,120,128,.1)]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <div className="relative z-10 flex min-w-0 items-center gap-3.5">
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          paletteIndex={mode.paletteIndex}
          isActive
          size="roster"
          treatment="profile"
          glyphContrast="default"
          profileStyle={dashboardAgentIconStyle(mode)}
        />
        <span
          data-ui-role="row-label"
          className="text-[15px] font-medium text-[#1D1D1F] dark:text-[#F5F5F7]"
        >
          {mode.title}
        </span>
      </div>

      <div className="relative z-10 flex items-center gap-2">
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold tracking-normal transition-colors",
            theme.badgeBg,
            theme.badgeFg,
          )}
        >
          <AgentMetric mode={mode} align="pill" />
        </div>
        <CaretRightIcon
          aria-hidden
          className="h-3.5 w-3.5 text-[#C7C7CC] transition-transform duration-150 group-hover/agent-row:translate-x-0.5 dark:text-[#636366]"
        />
      </div>

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
      className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-black/[0.04] p-[3px] backdrop-blur-md border border-black/[0.06] dark:border-white/[0.08] dark:bg-white/[0.06] shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)]"
    >
      <ShellActionSurface
        aria-label="Show agent grid view"
        aria-pressed={value === "grid"}
        data-testid="one-agents-view-grid"
        onClick={() => onChange("grid")}
        className={cn(
          "h-[26px] w-7 rounded-full border-0 transition-[background-color,color,box-shadow,transform] duration-150",
          value === "grid"
            ? "bg-white text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] hover:bg-white dark:bg-white/[0.16] dark:text-white dark:shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
            : "bg-transparent text-muted-foreground/75 shadow-none hover:bg-transparent hover:text-foreground dark:bg-transparent",
        )}
      >
        <GridIcon className="h-3.5 w-3.5" aria-hidden />
      </ShellActionSurface>
      <ShellActionSurface
        aria-label="Show agent list view"
        aria-pressed={value === "list"}
        data-testid="one-agents-view-list"
        onClick={() => onChange("list")}
        className={cn(
          "h-[26px] w-7 rounded-full border-0 transition-[background-color,color,box-shadow,transform] duration-150",
          value === "list"
            ? "bg-white text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] hover:bg-white dark:bg-white/[0.16] dark:text-white dark:shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
            : "bg-transparent text-muted-foreground/75 shadow-none hover:bg-transparent hover:text-foreground dark:bg-transparent",
        )}
      >
        <ListIcon className="h-3.5 w-3.5" aria-hidden />
      </ShellActionSurface>
    </div>
  );
}

/** Search isn't pulling its weight yet at 9 agents -- off for now, easy to flip back on. */
const SHOW_AGENT_SEARCH = false;

export function OneAgentRoster({
  capabilityStatusById,
  userId,
}: {
  capabilityStatusById: Record<string, CapabilityStatus>;
  userId?: string | null;
  displayName?: string | null;
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
  useEffect(() => {
    if (!animateViewChange) return;
    const timeout = window.setTimeout(() => setAnimateViewChange(false), 320);
    return () => window.clearTimeout(timeout);
  }, [animateViewChange]);
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
      // No pb- here. The scroll root already reserves the bottom bars
      // (app/providers.tsx pads it by --app-scroll-bottom-pad, the measured
      // --app-bottom-shell-height), and .app-page-shell adds the 24px reading
      // gap on top. Reserving them a second time is the wide empty band under
      // the last agent on /one: roughly another 90-115px of scroll that no
      // content can ever occupy. See components/calendar/calendar-agent-page-layout.ts.
      className="mx-auto w-full max-w-[720px]"
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
      {SHOW_AGENT_SEARCH ? (
        <label className="relative mb-3.5 block">
          <SearchIcon
            className="pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#8E8E93]"
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
            className="h-11 w-full rounded-[14px] border border-[rgba(60,60,67,.12)] bg-white/95 py-[11px] pl-11 pr-12 text-[15px] font-normal leading-5 text-[#1D1D1F] outline-none placeholder:text-[#8E8E93] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent)]/60 dark:border-white/[0.1] dark:bg-[#0A0A0C] dark:text-[#F5F5F7]"
          />
          <SearchClearButton
            visible={query.length > 0}
            label="Clear agent search"
            onClear={() => setQuery("")}
            className="text-[#8E8E93] hover:bg-black/[0.06] hover:text-[#1D1D1F] dark:hover:bg-white/[0.08] dark:hover:text-[#F5F5F7]"
          />
        </label>
      ) : null}
      <div
        key={view}
        data-testid="one-agents-view-content"
        className={cn(animateViewChange && "motion-step-enter")}
      >
        {view === "grid" ? (
          <div
            data-testid="one-agents-grid"
            className="w-full"
          >
            <div
              data-agent-roster-layout="grouped-icon-grid"
              className="grid w-full grid-cols-[repeat(3,minmax(84px,1fr))] justify-center gap-3 sm:gap-4"
            >
              {visibleModes.map((mode) => (
                <AgentGridItem key={mode.id} mode={mode} />
              ))}
            </div>
          </div>
        ) : (
          <div
            data-testid="one-agents-list"
            className="group/agent-list overflow-hidden rounded-[20px] border border-[rgba(60,60,67,.08)] bg-white/95 shadow-[0_16px_42px_-28px_rgba(0,0,0,.08)] divide-y divide-[rgba(60,60,67,.06)] dark:border-white/[0.08] dark:bg-[#0A0A0C] dark:shadow-[0_12px_40px_-20px_rgba(0,0,0,0.85)] dark:divide-white/[0.06] sm:rounded-[24px]"
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
