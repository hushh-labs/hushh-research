import Link from "next/link";
import type { CSSProperties } from "react";
import {
  Briefcase,
  Check,
  ChevronRight,
  Circle,
  Lock,
  type LucideIcon,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import {
  ONE_CAPABILITIES,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import {
  getCapabilityStatusDisplay,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import {
  isCapabilitySetupActionable,
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

type OneAgentMode = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  status: string;
  statusTone: CapabilityStatusTone;
  tone: OneCapabilityTone;
  locked: boolean;
  isExploreOnly: boolean;
};

const ONE_DASHBOARD_INSET_CLASSNAME = "px-4 sm:px-6";
const ONE_AGENT_TILE_WIDTH = "5.75rem";
const ONE_AGENT_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  justifyItems: "center",
  columnGap: "1rem",
  rowGap: "1.25rem",
};

/**
 * RIA is a standalone top-level agent (workspace persona) rather than a setup
 * capability, so it has no CapabilityStatus. It sits directly after Finance,
 * mirroring the top-bar agent switcher roster exactly: the /one grid and the
 * dropdown must always present the same agents. /ria self-guards (non-RIA
 * users are redirected to RIA onboarding), so exposing the tile is safe.
 */
const RIA_AGENT_MODE: OneAgentMode = {
  id: "ria",
  title: "RIA",
  description: "Advisor workspace: clients, picks, and requests.",
  href: `${ROUTES.RIA_HOME}?from=${ROUTES.ONE_HOME}`,
  icon: Briefcase,
  status: "Explore",
  statusTone: "muted",
  // RIA gets its own Sky Blue tone, distinct from Finance's Lavender Mist.
  tone: "ria",
  locked: false,
  isExploreOnly: true,
};

function buildModes(
  statusById: Record<string, CapabilityStatus>,
): OneAgentMode[] {
  const modes = ONE_CAPABILITIES.map((cap) => {
    const status = statusById[cap.id];
    const display = status
      ? getCapabilityStatusDisplay(status, { isExploreOnly: cap.isExploreOnly })
      : { label: "Checking...", tone: "muted" as CapabilityStatusTone };
    const locked =
      !!status &&
      (status.requiresUnlock === true ||
        (status.state === "blocked" && status.prerequisite === "vault"));
    return {
      id: cap.id,
      title: cap.title,
      description: cap.description,
      href: cap.href.includes("?")
        ? `${cap.href}&from=${ROUTES.ONE_HOME}`
        : `${cap.href}?from=${ROUTES.ONE_HOME}`,
      icon: cap.icon,
      status: display.label,
      statusTone: display.tone,
      tone: cap.tone,
      locked,
      isExploreOnly: cap.isExploreOnly === true,
    };
  });
  const financeIndex = modes.findIndex((mode) => mode.id === "finance");
  modes.splice(
    financeIndex >= 0 ? financeIndex + 1 : modes.length,
    0,
    RIA_AGENT_MODE,
  );
  return modes;
}

function statusClassName(mode: OneAgentMode): string {
  if (mode.locked) return "text-muted-foreground";
  if (mode.statusTone === "ready") return "text-[#138a3d] dark:text-[#5ee283]";
  if (mode.statusTone === "attention") return "text-accent-strong";
  if (mode.statusTone === "action") return "text-foreground";
  return "text-muted-foreground";
}

function AgentIndicator({ mode }: { mode: OneAgentMode }) {
  if (mode.locked) {
    return (
      <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-muted text-muted-foreground shadow-[0_1px_6px_rgba(0,0,0,0.16)]">
        <Lock className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  if (mode.statusTone === "ready") {
    return (
      <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-[#34c759] text-white shadow-[0_1px_6px_rgba(0,0,0,0.16)]">
        <Check className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  if (mode.statusTone === "attention") {
    return (
      <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-background bg-accent text-[10px] font-bold text-accent-foreground shadow-[0_1px_6px_rgba(0,0,0,0.16)]">
        !
      </span>
    );
  }
  if (mode.statusTone === "action") {
    return (
      <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-accent-surface text-accent-strong shadow-[0_1px_6px_rgba(0,0,0,0.16)]">
        <Circle className="h-2.5 w-2.5 fill-current" aria-hidden />
      </span>
    );
  }
  return null;
}

function AgentTile({ mode }: { mode: OneAgentMode }) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        "group flex flex-col items-center gap-2 rounded-[22px] px-1.5 py-2 text-center",
        "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-black/[0.04] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:hover:bg-white/[0.06] motion-reduce:transition-none motion-reduce:active:scale-100",
      )}
      style={{ width: ONE_AGENT_TILE_WIDTH }}
    >
      <span className="relative">
        <AgentSectionIcon id={mode.id} icon={mode.icon} tone={mode.tone} />
        <AgentIndicator mode={mode} />
      </span>
      <span className="min-w-0 space-y-0.5">
        <span
          className="block truncate text-[12.5px] font-semibold leading-tight text-foreground"
          style={{ maxWidth: ONE_AGENT_TILE_WIDTH }}
        >
          {mode.title}
        </span>
        <span
          className={cn(
            "block truncate text-[11px] font-medium leading-tight",
            statusClassName(mode),
          )}
          style={{ maxWidth: ONE_AGENT_TILE_WIDTH }}
        >
          {mode.status}
        </span>
      </span>
    </Link>
  );
}

function FinishSetupStrip({ percent }: { percent: number }) {
  return (
    <Link
      href={ROUTES.ONE_SETUP}
      aria-label="Finish setting up One"
      className="flex w-full items-center gap-3 overflow-hidden rounded-[22px] border border-border/55 bg-black/[0.035] px-4 py-3 transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:bg-black/[0.055] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-white/[0.06] dark:hover:bg-white/[0.09] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold text-foreground">
            Finish setup
          </span>
          <span className="text-[12px] font-medium text-muted-foreground">
            {percent}% ready
          </span>
        </span>
        <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-foreground/[0.10]">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-[var(--motion-ease-standard)]"
            style={{ width: `${percent}%` }}
          />
        </span>
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background text-foreground shadow-[0_1px_8px_rgba(0,0,0,0.08)]">
        <ChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </Link>
  );
}

export function OneDashboardPage({
  capabilityStatusById = {},
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
}) {
  const modes = buildModes(capabilityStatusById);
  const hasSetupRemaining = Object.values(capabilityStatusById).some((status) =>
    isCapabilitySetupActionable(status),
  );
  const setupable = ONE_CAPABILITIES.filter((cap) => !cap.isExploreOnly);
  const doneCount = setupable.filter((cap) => {
    const status = capabilityStatusById[cap.id];
    return status ? isCapabilitySetupComplete(status) : false;
  }).length;
  const percent = setupable.length
    ? Math.round((doneCount / setupable.length) * 100)
    : 0;

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one",
        marker: "native-route-one-home",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <AppPageContentRegion>
        <div className="space-y-5">
          {hasSetupRemaining ? <FinishSetupStrip percent={percent} /> : null}
          <section
            aria-labelledby="one-agents-heading"
            data-testid="one-agents-section"
            className="overflow-hidden rounded-[30px] border border-border/45 bg-background/55 py-5 shadow-[0_1px_0_rgba(255,255,255,0.35)_inset] dark:bg-white/[0.025]"
          >
            <div
              className={cn(
                "mb-4 flex items-center justify-between gap-3",
                ONE_DASHBOARD_INSET_CLASSNAME,
              )}
            >
              <h2
                id="one-agents-heading"
                className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Agents
              </h2>
              <span className="text-[12px] font-medium text-muted-foreground">
                {doneCount} of {setupable.length} ready
              </span>
            </div>
            <div
              data-testid="one-agents-grid"
              className={ONE_DASHBOARD_INSET_CLASSNAME}
              style={ONE_AGENT_GRID_STYLE}
            >
              {modes.map((mode) => (
                <AgentTile key={mode.id} mode={mode} />
              ))}
            </div>
          </section>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
