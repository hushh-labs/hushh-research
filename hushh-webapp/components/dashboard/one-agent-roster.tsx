"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  getOneSetupCapability,
  isOneCapabilityEnabled,
  ONE_CAPABILITIES,
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

type AgentMetric = {
  value: string;
  label: string;
};

type OneAgentMode = {
  id: string;
  title: string;
  href: string;
  primaryMetric: AgentMetric;
  status?: CapabilityStatus;
};

type AgentHomeStatus =
  | { kind: "action"; count: number; label: string }
  | { kind: "live"; count: number }
  | { kind: "setup" }
  | { kind: "none" };

type AgentGlyphKey =
  | "location"
  | "kyc"
  | "finance"
  | "ria"
  | "gmail"
  | "calendar"
  | "memory"
  | "consent"
  | "crm";

type AgentHomeDefinition = {
  id: string;
  label: string;
  order: number;
  surface: string;
  glyph: AgentGlyphKey;
  glyphClassName?: string;
  surfaceClassName?: string;
};

const ONE_HOME_AGENT_DEFINITIONS: readonly AgentHomeDefinition[] = [
  {
    id: "location",
    label: "Location",
    order: 0,
    surface: "var(--app-accent)",
    glyph: "location",
  },
  {
    id: "email",
    label: "KYC",
    order: 1,
    surface: "#32ADE6",
    glyph: "kyc",
  },
  {
    id: "finance",
    label: "Finance",
    order: 2,
    surface: "#5E5CE6",
    glyph: "finance",
  },
  {
    id: "ria",
    label: "RIA",
    order: 3,
    surface: "#AF52DE",
    glyph: "ria",
  },
  {
    id: "gmail",
    label: "Gmail",
    order: 4,
    surface: "#FFFFFF",
    glyph: "gmail",
    glyphClassName: "text-[#EA4335]",
    surfaceClassName: "ring-black/[0.08]",
  },
  {
    id: "calendar",
    label: "Calendar",
    order: 5,
    surface: "var(--app-accent)",
    glyph: "calendar",
  },
  {
    id: "pkm",
    label: "Memory",
    order: 6,
    surface: "#30B0C7",
    glyph: "memory",
  },
  {
    id: "consent",
    label: "Consent",
    order: 7,
    surface: "#636366",
    glyph: "consent",
  },
  {
    id: "connected-systems",
    label: "CRM",
    order: 8,
    surface: "#3A7CA5",
    glyph: "crm",
  },
] as const;

const ONE_HOME_DEFINITION_BY_ID = new Map(
  ONE_HOME_AGENT_DEFINITIONS.map((definition) => [
    definition.id,
    definition,
  ]),
);

const ACTION_METRIC_LABELS = new Set([
  "review",
  "reviews",
  "request",
  "requests",
  "approval waiting",
  "approvals waiting",
]);

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

export function resolveCachedAgentMetrics(
  userId: string | null | undefined,
): Record<string, AgentMetric> {
  if (!userId) return {};
  const cache = CacheService.getInstance();
  const metrics: Record<string, AgentMetric> = {};

  const market = canonicalMarketPayload(userId);
  const topMover = (market?.movers?.gainers ?? [])
    .filter(isPositiveMover)
    .sort((left, right) => right.change_pct - left.change_pct)[0];
  const moverSymbol = String(topMover?.symbol ?? "").trim().toUpperCase();
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
      label: "live",
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

  void revision;
  return resolveCachedAgentMetrics(userId);
}

function resolvePrimaryMetric({
  capabilityId,
  status,
}: {
  capabilityId: string;
  status?: CapabilityStatus;
}): AgentMetric {
  if (capabilityId === "consent") {
    if (!status || status.state === "unknown") {
      return { value: "0", label: "requests" };
    }
    const pendingConsentCount = status.pendingCount;
    return {
      value: String(pendingConsentCount),
      label: pendingConsentCount === 1 ? "request" : "requests",
    };
  }

  if (!status || status.state === "unknown") {
    return { value: "0", label: "none" };
  }

  if (status.pendingCount > 0) {
    return {
      value: String(status.pendingCount),
      label: status.pendingCount === 1 ? "review" : "reviews",
    };
  }

  return { value: "0", label: "none" };
}

function buildModes(
  statusById: Record<string, CapabilityStatus>,
  cachedMetrics: Record<string, AgentMetric>,
  setupDismissed: boolean,
): OneAgentMode[] {
  return ONE_CAPABILITIES.filter(
    (capability) =>
      capability.isVisibleOnRoster !== false &&
      isOneCapabilityEnabled(capability) &&
      ONE_HOME_DEFINITION_BY_ID.has(capability.id),
  )
    .map((capability) => {
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

      return {
        id: capability.id,
        title: capability.title,
        href: opensSetup
          ? buildOneSetupCapabilityRoute(capability.id)
          : capability.href,
        primaryMetric:
          cachedMetrics[capability.id] ??
          resolvePrimaryMetric({
            capabilityId: capability.id,
            status,
          }),
        status,
      };
    })
    .sort((left, right) => {
      const leftOrder = ONE_HOME_DEFINITION_BY_ID.get(left.id)?.order ?? 99;
      const rightOrder = ONE_HOME_DEFINITION_BY_ID.get(right.id)?.order ?? 99;
      return leftOrder - rightOrder;
    });
}

function positiveIntegerMetricValue(metric: AgentMetric): number | null {
  const number = Number(metric.value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function formatBadgeValue(value: number): string {
  return value > 99 ? "99+" : String(value);
}

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

function resolveAgentHomeStatus(mode: OneAgentMode): AgentHomeStatus {
  const actionCount = actionBadgeValue(mode);
  if (actionCount !== null) {
    return { kind: "action", count: actionCount, label: mode.primaryMetric.label };
  }

  const liveCount = locationLiveValue(mode);
  if (liveCount !== null) {
    return { kind: "live", count: liveCount };
  }

  const hasReliableSetupState =
    mode.status &&
    mode.status.state !== "unknown" &&
    mode.status.state !== "completed" &&
    mode.status.state !== "skipped" &&
    getOneSetupCapability(mode.id);

  return hasReliableSetupState ? { kind: "setup" } : { kind: "none" };
}

function formatTileAccessibleName(mode: OneAgentMode): string {
  const status = resolveAgentHomeStatus(mode);
  const definition = ONE_HOME_DEFINITION_BY_ID.get(mode.id);
  const label = definition?.label ?? mode.title;

  if (status.kind === "action") {
    return `${label}, ${formatBadgeValue(status.count)} ${status.label}`;
  }
  if (status.kind === "live") {
    return `${label}, live sharing active`;
  }
  if (status.kind === "setup") {
    return `${label}, setup required`;
  }
  return label;
}

function AgentHomeGlyph({
  glyph,
  className,
}: {
  glyph: AgentGlyphKey;
  className?: string;
}) {
  const common = {
    className: cn("h-[46%] w-[46%]", className),
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": true,
  } as const;

  switch (glyph) {
    case "location":
      return (
        <svg {...common}>
          <path d="M12 2.6c-4.1 0-7.1 3.1-7.1 7.2 0 5 5.5 10.5 6.6 11.5.3.3.7.3 1 0 1.1-1 6.6-6.5 6.6-11.5 0-4.1-3-7.2-7.1-7.2Zm0 10.1a2.9 2.9 0 1 1 0-5.8 2.9 2.9 0 0 1 0 5.8Z" />
        </svg>
      );
    case "kyc":
      return (
        <svg {...common}>
          <path d="M4.5 5.2c0-1.1.9-2 2-2h11c1.1 0 2 .9 2 2v13.6c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2V5.2Zm2.6 3.3h5.4v-2H7.1v2Zm.2 9.3h5.1c-.3-1.7-1.3-2.7-2.6-2.7s-2.2 1-2.5 2.7Zm2.5-4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Zm5.2.1 1.5 1.5 3-3-1.2-1.2-1.8 1.8-.6-.6-.9 1Z" />
        </svg>
      );
    case "finance":
      return (
        <svg {...common}>
          <path d="M4.2 17.8h15.6c.5 0 .9.4.9.9s-.4.9-.9.9H4.2a.9.9 0 0 1 0-1.8Zm1.2-4.5 4-4c.3-.3.8-.3 1.1 0l2.3 2.2 5.1-5.1h-2.1a.9.9 0 0 1 0-1.8h4.2c.5 0 .9.4.9.9v4.2a.9.9 0 0 1-1.8 0V7.7l-5.7 5.7c-.3.3-.8.3-1.1 0l-2.3-2.2-3.4 3.4a.9.9 0 0 1-1.2-1.3Z" />
        </svg>
      );
    case "ria":
      return (
        <svg {...common}>
          <path d="M8.8 11.3a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7.3c.7-3.8 2.8-5.7 6-5.7 2.2 0 3.9.9 4.9 2.6.3.5 0 1.1-.6 1.2-.7.2-1.2.7-1.3 1.4-.1.6-.6 1.1-1.2 1.1H3.5c-.5 0-.8-.2-.7-.6Zm12.2.8h5.2c.7 0 1.2-.5 1.2-1.2v-3.7c0-.7-.5-1.2-1.2-1.2H15c-.7 0-1.2.5-1.2 1.2v3.7c0 .7.5 1.2 1.2 1.2Zm.8-7h3.6v-.6c0-.5-.4-.9-.9-.9h-1.8c-.5 0-.9.4-.9.9v.6Z" />
        </svg>
      );
    case "gmail":
      return (
        <svg {...common} className={cn("h-[44%] w-[50%]", className)}>
          <path d="M4.8 6h14.4c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8V7.8C3 6.8 3.8 6 4.8 6Zm.5 2.2v7.6h13.4V8.2L12 13.1 5.3 8.2Zm1.4-.7 5.3 3.9 5.3-3.9H6.7Z" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <path d="M7.3 2.8c.6 0 1 .4 1 1v1h7.4v-1a1 1 0 1 1 2 0v1h.5c1.4 0 2.6 1.2 2.6 2.6v10.7c0 1.4-1.2 2.6-2.6 2.6H5.8c-1.4 0-2.6-1.2-2.6-2.6V7.4c0-1.4 1.2-2.6 2.6-2.6h.5v-1c0-.6.4-1 1-1Zm11.5 7H5.2v8.3c0 .3.3.6.6.6h12.4c.3 0 .6-.3.6-.6V9.8Zm-8.5 3.1h3.5c.5 0 .9.4.9.9v1.9c0 .5-.4.9-.9.9h-3.5a.9.9 0 0 1-.9-.9v-1.9c0-.5.4-.9.9-.9Z" />
        </svg>
      );
    case "memory":
      return (
        <svg {...common}>
          <path d="M8.3 3.6c-1.7 0-3 1.2-3.1 2.8a3.5 3.5 0 0 0-.7 6 3.3 3.3 0 0 0 3.1 4.7h.2a2.8 2.8 0 0 0 5.2 1.2V5.1a3.1 3.1 0 0 0-4.7-1.5Zm7.4 0A3.1 3.1 0 0 0 11 5.1v13.2a2.8 2.8 0 0 0 5.2-1.2h.2a3.3 3.3 0 0 0 3.1-4.7 3.5 3.5 0 0 0-.7-6 3.1 3.1 0 0 0-3.1-2.8Zm2.6 6.3 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5.5-1 .5 1Z" />
        </svg>
      );
    case "consent":
      return (
        <svg {...common}>
          <path d="M7.3 10.7V7.3a1 1 0 0 1 2 0v4.4h.8V5.5a1 1 0 1 1 2 0v6.2h.8V6.6a1 1 0 1 1 2 0v5.1h.8V8.2a1 1 0 1 1 2 0v6.2c0 4-2.4 6.5-6.1 6.5-2.8 0-4.8-1.3-6.3-4.2l-1.2-2.3a1.2 1.2 0 0 1 2.1-1.1l1 1.9v-4.5Zm7.8 6.5 1.6 1.6 3.4-3.4-1.1-1.1-2.3 2.3-.8-.8-.8 1.4Z" />
        </svg>
      );
    case "crm":
      return (
        <svg {...common}>
          <path d="M6 3.3h10.6c1 0 1.8.8 1.8 1.8v13.8c0 1-.8 1.8-1.8 1.8H6c-1 0-1.8-.8-1.8-1.8V5.1c0-1 .8-1.8 1.8-1.8Zm1.9 4.1h6.8V5.8H7.9v1.6Zm2.4 7.1c-1.7 0-2.9 1.1-3.3 3h8c-.4-1.9-1.7-3-3.4-3h-1.3Zm.6-1.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Zm7.9-5.7h1V6.2h-1v1.4Zm0 3.6h1V9.8h-1v1.4Zm0 3.6h1v-1.4h-1v1.4Z" />
        </svg>
      );
  }
}

function AgentHomeStatusAdornment({ status }: { status: AgentHomeStatus }) {
  if (status.kind === "action") {
    return (
      <span
        data-testid="one-agent-notification-badge"
        className="absolute -right-1.5 -top-1.5 z-20 inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-[color:var(--background)] bg-[color:var(--app-destructive)] px-1 text-[11px] font-semibold leading-none text-white"
        aria-hidden
      >
        {formatBadgeValue(status.count)}
      </span>
    );
  }

  if (status.kind === "live") {
    return (
      <span
        data-testid="one-agent-live-dot"
        className="absolute -right-1 -top-1 z-20 h-[10px] w-[10px] rounded-full border-2 border-[color:var(--background)] bg-[color:var(--app-success)]"
        aria-hidden
      />
    );
  }

  if (status.kind === "setup") {
    return (
      <span
        data-testid="one-agent-setup-badge"
        className="absolute -right-1 -top-1 z-20 inline-flex h-[17px] w-[17px] items-center justify-center rounded-full border-2 border-[color:var(--background)] bg-[color:var(--app-accent)] text-white"
        aria-hidden
      >
        <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M6 2.1v7.8M2.1 6h7.8"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.8"
          />
        </svg>
      </span>
    );
  }

  return null;
}

function AgentHomeIcon({
  definition,
  status,
}: {
  definition: AgentHomeDefinition;
  status: AgentHomeStatus;
}) {
  return (
    <span className="relative inline-flex overflow-visible">
      <span
        data-testid={`one-agent-icon-${definition.id}`}
        className={cn(
          "inline-flex h-[var(--one-agent-icon-size)] w-[var(--one-agent-icon-size)] items-center justify-center rounded-[25%] text-white",
          "shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.05)] ring-1 ring-white/25",
          definition.surfaceClassName,
        )}
        style={{ backgroundColor: definition.surface }}
        aria-hidden
      >
        <AgentHomeGlyph
          glyph={definition.glyph}
          className={definition.glyphClassName}
        />
      </span>
      <AgentHomeStatusAdornment status={status} />
    </span>
  );
}

function AgentLauncherItem({ mode }: { mode: OneAgentMode }) {
  const definition = ONE_HOME_DEFINITION_BY_ID.get(mode.id);
  if (!definition) return null;

  const status = resolveAgentHomeStatus(mode);
  const accessibleName = formatTileAccessibleName(mode);

  return (
    <Link
      href={mode.href}
      aria-label={accessibleName}
      data-testid={`one-agent-tile-${mode.id}`}
      className={cn(
        "group flex min-h-[var(--one-agent-cell-height)] min-w-0 flex-col items-center justify-center gap-2 rounded-[18px] px-1.5 py-2 text-center outline-none",
        "transition-[background-color,opacity,transform] duration-150 ease-[var(--motion-ease-standard)]",
        "hover:bg-[rgba(120,120,128,.08)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--background)] active:opacity-90 motion-reduce:transition-none",
      )}
    >
      <span className="transition-transform duration-[120ms] ease-[var(--motion-ease-standard)] group-active:scale-[0.95] motion-reduce:transition-none motion-reduce:group-active:scale-100">
        <AgentHomeIcon definition={definition} status={status} />
      </span>
      <span
        data-ui-role="body-strong"
        className="block max-w-full whitespace-nowrap text-center text-[13px] font-semibold leading-[17px] tracking-normal text-[#1D1D1F] dark:text-[#F5F5F7]"
      >
        {definition.label}
      </span>
    </Link>
  );
}

function AgentLauncherGrid({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="one-agents-grid"
      className="one-agent-launcher-grid mx-auto w-full max-w-[390px] overflow-visible px-0"
    >
      <div
        data-agent-roster-layout="app-icon-launcher-grid"
        className="one-agent-launcher-grid-inner grid w-full grid-cols-3 justify-items-center overflow-visible"
      >
        {children}
      </div>
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

  return (
    <section
      aria-label="One agents"
      data-testid="one-agents-section"
      className="mx-auto flex w-full max-w-[430px] flex-col justify-center"
    >
      <h1 className="sr-only">One</h1>
      <AgentLauncherGrid>
        {modes.map((mode) => (
          <AgentLauncherItem key={mode.id} mode={mode} />
        ))}
      </AgentLauncherGrid>
    </section>
  );
}
