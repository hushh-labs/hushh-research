"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  Grid2X2,
  List,
} from "lucide-react";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  getOneSetupCapability,
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
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { cn } from "@/lib/utils";
import styles from "./one-agent-roster.module.css";

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
    (capability) => capability.isVisibleOnRoster !== false,
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
            tone: "muted" as CapabilityStatusTone,
          };

    return {
      id: capability.id,
      title: capability.title,
      description: capability.description,
      href: setupCapability
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

function AgentTile({ mode }: { mode: OneAgentMode }) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      data-testid={`one-agent-tile-${mode.id}`}
      title={mode.description}
      className={cn(
        "group grid min-h-[5.75rem] grid-cols-[3.5rem_minmax(0,1fr)_1rem] items-center gap-3 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-3 py-3 text-left shadow-[var(--app-card-shadow-standard)]",
        "transition-[background-color,border-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:border-[color:var(--app-card-border-strong)] hover:bg-[color:var(--app-card-surface-compact)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100",
      )}
    >
      <AgentSectionIcon
        id={mode.id}
        icon={mode.icon}
        tone={mode.tone}
        size="card"
        className="self-center"
      />
      <span className="min-w-0 self-center">
        <span className="block text-[15px] font-semibold leading-tight text-foreground">
          {mode.title}
        </span>
        <span
          className={cn(
            "mt-1 block text-[12.5px] font-medium leading-tight",
            gridStatusClassName(mode),
          )}
        >
          {mode.status}
        </span>
      </span>
      <ChevronRight
        className="h-4 w-4 justify-self-end text-muted-foreground transition-transform duration-[var(--motion-duration-sm)] group-hover:translate-x-0.5 motion-reduce:transition-none"
        aria-hidden
      />
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
        <div
          data-testid="one-agents-grid"
          data-agent-roster-layout="2-column-cards"
          className={styles.oneAgentGrid}
        >
          {modes.map((mode) => (
            <AgentTile key={mode.id} mode={mode} />
          ))}
        </div>
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
