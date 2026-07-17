"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Grid2X2,
  List,
} from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
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
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { cn } from "@/lib/utils";

type OneAgentMode = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: OneCapabilityIcon;
  status: string;
  statusTone: CapabilityStatusTone;
  tone: OneCapabilityTone;
  isExploreOnly: boolean;
};

type AgentRosterView = "grid" | "list";

const AGENT_ROSTER_VIEW_STORAGE_KEY = "hushh:one-agent-roster-view";

function buildModes(
  statusById: Record<string, CapabilityStatus>,
): OneAgentMode[] {
  return ONE_CAPABILITIES.filter(
    (capability) =>
      capability.isVisibleOnRoster !== false && isOneCapabilityEnabled(capability),
  ).map((capability) => {
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

    const isActionable = "isActionable" in display ? (display as any).isActionable : true;

    return {
      id: capability.id,
      title: capability.title,
      description: capability.description,
      href: setupCapability && isActionable && status?.state !== "skipped"
        ? buildOneSetupCapabilityRoute(capability.id)
        : capability.href,
      icon: capability.icon,
      status: display.label,
      statusTone: display.tone,
      tone: capability.tone,
      isExploreOnly: capability.isExploreOnly === true,
    };
  });
}

function statusClassName(mode: OneAgentMode): string {
  if (mode.statusTone === "ready") return "text-[#138a3d] dark:text-[#5ee283]";
  if (mode.statusTone === "attention") return "text-accent-strong";
  if (mode.statusTone === "action") return "text-foreground";
  return "text-muted-foreground";
}

function gridStatusClassName(mode: OneAgentMode): string {
  if (mode.statusTone === "ready") return "text-[#138a3d] dark:text-[#5ee283]";
  return "text-muted-foreground";
}

function AgentGridItem({ mode }: { mode: OneAgentMode }) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        "group relative flex min-h-[8.5rem] min-w-0 flex-col items-center justify-start gap-2 overflow-hidden rounded-[12px] px-2 py-3 text-center",
        "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-[color:var(--app-card-surface-compact)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-inset active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
      )}
    >
      <AgentSectionIcon
        id={mode.id}
        icon={mode.icon}
        tone={mode.tone}
        isActive={mode.statusTone !== "muted"}
        size="launcher"
        className="relative z-10"
      />
      <span className="relative z-10 min-w-0">
        <span className="block truncate text-[13px] font-semibold leading-tight text-foreground">
          {mode.title}
        </span>
        <span
          className={cn(
            "mt-1 block truncate text-[11px] font-medium leading-tight",
            gridStatusClassName(mode),
          )}
        >
          {mode.status}
        </span>
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
      leading={
        <AgentSectionIcon
          id={mode.id}
          icon={mode.icon}
          tone={mode.tone}
          isActive={mode.statusTone !== "muted"}
          size="menu"
        />
      }
      trailing={
        <span className={cn("text-[12px] font-medium", statusClassName(mode))}>
          {mode.status}
        </span>
      }
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
      className="inline-flex shrink-0 items-center gap-0.5 rounded-xl bg-black/[0.045] p-0.5 dark:bg-white/[0.06]"
    >
      <ShellActionSurface
        aria-label="Show agent grid view"
        aria-pressed={value === "grid"}
        data-testid="one-agents-view-grid"
        onClick={() => onChange("grid")}
        className={cn(
          "h-8 w-8 rounded-[10px]",
          value === "grid"
            ? "bg-accent text-accent-foreground shadow-[0_1px_5px_rgba(0,0,0,0.14)] hover:bg-accent dark:bg-accent"
            : "bg-transparent text-muted-foreground shadow-none hover:bg-foreground/[0.06] hover:text-foreground dark:bg-transparent",
        )}
      >
        <Grid2X2 className="h-4 w-4" aria-hidden />
      </ShellActionSurface>
      <ShellActionSurface
        aria-label="Show agent list view"
        aria-pressed={value === "list"}
        data-testid="one-agents-view-list"
        onClick={() => onChange("list")}
        className={cn(
          "h-8 w-8 rounded-[10px]",
          value === "list"
            ? "bg-accent text-accent-foreground shadow-[0_1px_5px_rgba(0,0,0,0.14)] hover:bg-accent dark:bg-accent"
            : "bg-transparent text-muted-foreground shadow-none hover:bg-foreground/[0.06] hover:text-foreground dark:bg-transparent",
        )}
      >
        <List className="h-4 w-4" aria-hidden />
      </ShellActionSurface>
    </div>
  );
}

export function OneAgentRoster({
  capabilityStatusById,
}: {
  capabilityStatusById: Record<string, CapabilityStatus>;
}) {
  const modes = buildModes(capabilityStatusById);
  const [view, setView] = useState<AgentRosterView>("grid");

  useEffect(() => {
    try {
      const persisted = window.localStorage.getItem(AGENT_ROSTER_VIEW_STORAGE_KEY);
      if (persisted === "grid" || persisted === "list") {
        setView(persisted);
      }
    } catch {
      // Storage can be disabled by browser privacy settings; the default view
      // remains fully functional without persistence.
    }
  }, []);

  const selectView = (next: AgentRosterView) => {
    setView(next);
    try {
      window.localStorage.setItem(AGENT_ROSTER_VIEW_STORAGE_KEY, next);
    } catch {
      // A display preference is optional and must not block navigation.
    }
  };

  return (
    <section
      aria-labelledby="one-agents-heading"
      data-testid="one-agents-section"
      className="w-full"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="one-agents-heading"
          className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
        >
          Agents ({modes.length})
        </h2>
        <AgentRosterViewToggle value={view} onChange={selectView} />
      </div>
      {view === "grid" ? (
        <SettingsGroup
          embedded
          testId="one-agents-grid"
          className="[&_[data-slot=settings-group-shell]]:p-1.5 sm:[&_[data-slot=settings-group-shell]]:p-2"
        >
          <div
            data-agent-roster-layout="grouped-icon-grid"
            className="grid grid-cols-3 gap-1 sm:grid-cols-4 sm:gap-1.5"
          >
            {modes.map((mode) => (
              <AgentGridItem key={mode.id} mode={mode} />
            ))}
          </div>
        </SettingsGroup>
      ) : (
        // Same grouped-card treatment as Profile (SettingsGroup shell): the
        // solid card surface, standard border, and row dividers so list items
        // read identically on /one and /profile.
        <SettingsGroup embedded testId="one-agents-list">
          {modes.map((mode) => (
            <AgentListRow key={mode.id} mode={mode} />
          ))}
        </SettingsGroup>
      )}
    </section>
  );
}
