"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import {
  getOneSetupCapability,
  isOneCapabilityEnabled,
  ONE_CAPABILITIES,
  type OneCapabilityIcon,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import { getCapabilityStatusDisplay } from "@/lib/onboarding/capability-status-display";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { buildOneSetupCapabilityRoute, ROUTES } from "@/lib/navigation/routes";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import type {
  OneLocationGrant,
  OneLocationState,
} from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

type LauncherIndicator =
  | {
      kind: "attention";
      label: string;
      accessibleLabel: string;
    }
  | {
      kind: "live";
      accessibleLabel: string;
    };

type OneAgentMode = {
  id: string;
  title: string;
  href: string;
  icon: OneCapabilityIcon;
  tone: OneCapabilityTone;
  opensSetup: boolean;
  indicator: LauncherIndicator | null;
};

const ROOT_LAUNCHER_DESCOPED_CAPABILITY_IDS = new Set(["connected-systems"]);
const ACTIVE_GRANT_STATUS_PATTERN = /active|approved|shared|granted/i;

function avatarInitial(displayName?: string | null): string {
  const first = displayName?.trim().charAt(0);
  return first ? first.toUpperCase() : "O";
}

function hasActiveGrant(grant: OneLocationGrant): boolean {
  return ACTIVE_GRANT_STATUS_PATTERN.test(String(grant.status));
}

export function hasActiveLocationActivity(
  location: OneLocationState | null | undefined,
): boolean {
  if (!location) return false;
  return location.ownerGrants.some(hasActiveGrant);
}

function readCachedLocationLiveState(userId?: string | null): boolean {
  if (!userId) return false;
  const location = CacheService.getInstance().peek<OneLocationState>(
    CACHE_KEYS.ONE_LOCATION_STATE(userId),
  )?.data;
  return hasActiveLocationActivity(location);
}

function useCachedLocationLiveState(userId?: string | null): boolean {
  const [isLive, setIsLive] = useState(() =>
    readCachedLocationLiveState(userId),
  );

  useEffect(() => {
    if (!userId) {
      setIsLive(false);
      return;
    }

    const locationKey = CACHE_KEYS.ONE_LOCATION_STATE(userId);
    setIsLive(readCachedLocationLiveState(userId));

    return CacheService.getInstance().subscribe((event) => {
      if (event.type === "clear") {
        setIsLive(false);
        return;
      }

      const keys =
        event.type === "set"
          ? [event.key]
          : event.type === "invalidate" || event.type === "invalidate_user"
            ? event.keys
            : [];

      if (keys.includes(locationKey)) {
        setIsLive(readCachedLocationLiveState(userId));
      }
    });
  }, [userId]);

  return isLive;
}

function resolveIndicator({
  modeId,
  status,
  isLocationLive,
}: {
  modeId: string;
  status?: CapabilityStatus;
  isLocationLive: boolean;
}): LauncherIndicator | null {
  const pendingCount = status?.pendingCount ?? 0;
  if (pendingCount > 0) {
    return {
      kind: "attention",
      label: pendingCount > 99 ? "99+" : String(pendingCount),
      accessibleLabel: `${pendingCount} waiting`,
    };
  }

  if (modeId === "location" && isLocationLive) {
    return {
      kind: "live",
      accessibleLabel: "Live location activity",
    };
  }

  return null;
}

function buildModes(
  statusById: Record<string, CapabilityStatus>,
  setupDismissed: boolean,
  isLocationLive: boolean,
): OneAgentMode[] {
  return ONE_CAPABILITIES.filter(
    (capability) =>
      capability.isVisibleOnRoster !== false &&
      !ROOT_LAUNCHER_DESCOPED_CAPABILITY_IDS.has(capability.id) &&
      isOneCapabilityEnabled(capability),
  ).map((capability) => {
    const setupCapability = getOneSetupCapability(capability.id);
    const status = statusById[capability.id];
    const copy = setupCapability
      ? getCapabilitySetupCopy(capability.id)
      : undefined;
    const statusDisplay =
      setupCapability && copy
        ? status
          ? getCapabilityStatusDisplay(status, {
              isExploreOnly: capability.isExploreOnly,
              actionLabel: copy.actionLabel,
              resumeActionLabel: copy.resumeActionLabel,
            })
          : {
              label: copy.actionLabel,
              tone: "action" as const,
              isActionable: true,
            }
        : {
            label: capability.isExploreOnly ? "Explore" : "Open",
            tone: "action" as const,
            isActionable: true,
          };

    const opensSetup = Boolean(
      setupCapability &&
      statusDisplay.isActionable &&
      (!setupDismissed || capability.id === "finance"),
    );

    return {
      id: capability.id,
      title: capability.title,
      href: opensSetup
        ? buildOneSetupCapabilityRoute(capability.id)
        : capability.href,
      icon: capability.icon,
      tone: capability.tone,
      opensSetup,
      indicator: resolveIndicator({
        modeId: capability.id,
        status,
        isLocationLive,
      }),
    };
  });
}

function modeAccessibleLabel(mode: OneAgentMode): string {
  const base = mode.opensSetup
    ? `Open ${mode.title} setup`
    : `Open ${mode.title}`;
  return [base, mode.indicator?.accessibleLabel].filter(Boolean).join(", ");
}

function AgentLauncherIndicator({
  indicator,
}: {
  indicator: LauncherIndicator | null;
}) {
  if (!indicator) return null;

  if (indicator.kind === "attention") {
    return (
      <span
        aria-hidden
        data-testid="one-agent-indicator-attention"
        className="absolute -right-1 -top-1 z-20 inline-flex min-h-[20px] min-w-[20px] items-center justify-center rounded-full border-2 border-[color:var(--one-launcher-background)] bg-[#FF3B30] px-[5px] text-[11px] font-bold leading-none text-white shadow-[0_2px_8px_rgba(255,59,48,.28)]"
      >
        {indicator.label}
      </span>
    );
  }

  if (indicator.kind === "live") {
    return (
      <span
        aria-hidden
        data-testid="one-agent-indicator-live"
        className="absolute -right-0.5 -top-0.5 z-20 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--one-launcher-background)] bg-[#34C759] shadow-[0_2px_8px_rgba(52,199,89,.26)]"
      />
    );
  }

  return null;
}

function AgentGridItem({ mode }: { mode: OneAgentMode }) {
  return (
    <Link
      href={mode.href}
      aria-label={modeAccessibleLabel(mode)}
      data-testid={`one-agent-tile-${mode.id}`}
      className={cn(
        "group flex min-h-[92px] min-w-0 flex-col items-center justify-start gap-2 rounded-[16px] px-1.5 py-1.5 text-center outline-none sm:min-h-[100px] sm:gap-2.5 sm:px-2",
        "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-[rgba(120,120,128,.08)]",
        "focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--one-launcher-background)] active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
      )}
    >
      <span className="relative inline-flex">
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          isActive
          size="roster-dashboard"
        />
        <AgentLauncherIndicator indicator={mode.indicator} />
      </span>
      <span
        data-ui-role="body-strong"
        className="block min-h-[38px] w-full overflow-hidden text-center text-[15px] font-semibold leading-[19px] tracking-normal text-[#1D1D1F] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] dark:text-[#F5F5F7]"
      >
        {mode.title}
      </span>
    </Link>
  );
}

export function OneAgentRoster({
  capabilityStatusById,
  displayName,
  userId,
}: {
  capabilityStatusById: Record<string, CapabilityStatus>;
  displayName?: string | null;
  userId?: string | null;
}) {
  const isLocationLive = useCachedLocationLiveState(userId);
  const setupDismissed = Boolean(
    userId &&
    (OneSetupCompletionHintService.isResolved(userId) ||
      PreVaultUserStateService.getCachedBootstrapState(userId)
        ?.setupCompleted === true),
  );
  const modes = buildModes(
    capabilityStatusById,
    setupDismissed,
    isLocationLive,
  );

  return (
    <nav
      aria-label="One agents"
      data-testid="one-agents-section"
      className="mx-auto flex w-full max-w-[480px] flex-col gap-6 pb-2"
    >
      <div className="flex min-h-14 items-center justify-between gap-3">
        <h1
          data-testid="one-launcher-title"
          className="min-w-0 text-[34px] font-bold leading-[40px] tracking-normal text-[#1D1D1F] dark:text-[#F5F5F7]"
        >
          <span aria-hidden="true" className="mr-2 align-[-1px]">
            🤫
          </span>
          One
        </h1>
        <Link
          href={ROUTES.PROFILE}
          aria-label="Open Profile"
          data-testid="one-launcher-avatar-link"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-deep)] text-[15px] font-semibold leading-none text-white shadow-[0_8px_18px_rgba(0,122,255,.22)] outline-none transition-transform focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--one-launcher-background)] active:scale-[0.98] dark:bg-[color:var(--app-accent-bright)] dark:text-[#001A33]"
        >
          <span aria-hidden="true" data-testid="one-launcher-avatar">
            {avatarInitial(displayName)}
          </span>
        </Link>
      </div>

      {modes.length > 0 ? (
        <ul
          className="one-agent-launcher-grid w-full list-none justify-center p-0"
          data-testid="one-agents-grid"
          data-agent-roster-layout="app-icon-grid"
        >
          {modes.map((mode) => (
            <li key={mode.id} className="one-agent-launcher-tile min-w-0">
              <AgentGridItem mode={mode} />
            </li>
          ))}
        </ul>
      ) : (
        <div
          role="status"
          data-testid="one-agents-empty"
          className="px-5 py-8 text-center"
        >
          <p className="text-[17px] font-semibold leading-6 tracking-normal text-[#1D1D1F] dark:text-[#F5F5F7]">
            Agents unavailable
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            data-testid="one-agents-retry"
            className="mt-3 inline-flex h-10 items-center justify-center rounded-full px-5 text-[15px] font-semibold text-[color:var(--app-accent-deep)] outline-none transition-colors hover:bg-[rgba(0,122,255,.08)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] dark:text-[color:var(--app-accent-bright)]"
          >
            Try again
          </button>
        </div>
      )}
    </nav>
  );
}
