import Link from "next/link";
import { ArrowUpRight, ChevronRight, Lock, type LucideIcon } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { Badge } from "@/components/ui/badge";
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

/**
 * ONE HOME — "Cinematic Cards" design.
 *
 * Content + logic are unchanged: identity comes from the shared
 * `ONE_CAPABILITIES` catalog and live status from the capability setup-state
 * resolver (`getCapabilityStatusDisplay`). Only the presentation changed — the
 * grouped inset list was replaced by full-width gradient "workflow" cards
 * (bright when actionable, dark + lock when vault-gated), a black
 * "Finish setup — X% done" bar, and calm Memory/Access rows. Colors here are an
 * intentional, DASHBOARD-LOCAL design choice; the shared monochrome tone map
 * (`ONE_CAPABILITY_ICON_CLASS_BY_TONE`, still consumed by the setup hub +
 * onboarding preview) is deliberately untouched.
 */

type OneDashboardMode = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  status: string;
  statusTone: CapabilityStatusTone;
  tone: OneCapabilityTone;
  group: "workflow" | "memory" | "access";
  /** True when the capability is gated behind an (elsewhere) vault unlock. */
  locked: boolean;
  /** True for capabilities set up by looking once (Explore) rather than configuring. */
  isExploreOnly: boolean;
};

const MONO_INDEX_FONT = 'ui-monospace, "SF Mono", Menlo, monospace';

// DASHBOARD-LOCAL per-tone color set for the workflow cards — 2a "pastel
// blocks, type-led" palette (One Dashboard Final). Every card is a FLAT pastel
// surface with dark ink; bright vs locked differ only by badge/arrow vs
// number/lock, never by darkness. bg = block fill, ink = title, muted = body
// copy, faint = mono index + lock glyph, cta = locked "Unlock to see" emphasis.
const CARD_COLORS: Record<
  OneCapabilityTone,
  { bg: string; ink: string; muted: string; faint: string; cta: string }
> = {
  finance: {
    bg: "#DCF2E1",
    ink: "#0A2914",
    muted: "rgba(10,41,20,0.55)",
    faint: "rgba(20,80,45,0.5)",
    cta: "rgba(10,41,20,0.7)",
  },
  connected: {
    bg: "#EAE3FA",
    ink: "#221046",
    muted: "rgba(34,16,70,0.55)",
    faint: "rgba(60,35,110,0.45)",
    cta: "rgba(34,16,70,0.7)",
  },
  email: {
    bg: "#D9E9F8",
    ink: "#0B2540",
    muted: "rgba(11,37,64,0.55)",
    faint: "rgba(15,55,95,0.45)",
    cta: "rgba(11,37,64,0.7)",
  },
  location: {
    bg: "#FFE9D2",
    ink: "#3D1F05",
    muted: "rgba(61,31,5,0.55)",
    faint: "rgba(120,60,10,0.45)",
    cta: "rgba(61,31,5,0.7)",
  },
  gmail: {
    bg: "#D9E9F8",
    ink: "#0B2540",
    muted: "rgba(11,37,64,0.55)",
    faint: "rgba(15,55,95,0.45)",
    cta: "rgba(11,37,64,0.7)",
  },
  pkm: {
    bg: "#FFE9D2",
    ink: "#3D1F05",
    muted: "rgba(61,31,5,0.55)",
    faint: "rgba(120,60,10,0.45)",
    cta: "rgba(61,31,5,0.7)",
  },
  consent: {
    bg: "#EAE3FA",
    ink: "#221046",
    muted: "rgba(34,16,70,0.55)",
    faint: "rgba(60,35,110,0.45)",
    cta: "rgba(34,16,70,0.7)",
  },
};

function buildModes(
  statusById: Record<string, CapabilityStatus>,
): OneDashboardMode[] {
  // Stable identity (title/desc/href/icon/tone/group) comes from the shared
  // ONE_CAPABILITIES catalog; live per-tile status comes from the capability
  // setup-state resolver via `statusById` so the dashboard never fabricates
  // status. Missing entries render an honest "Checking…" muted state.
  return ONE_CAPABILITIES.map((cap) => {
    const status = statusById[cap.id];
    const display = status
      ? getCapabilityStatusDisplay(status, { isExploreOnly: cap.isExploreOnly })
      : { label: "Checking…", tone: "muted" as CapabilityStatusTone };
    // "Locked" (dark tile + padlock) means the real state can only be read after
    // a vault unlock done elsewhere. An OAuth `blocked` ("Connect to set up") is
    // NOT locked — it is an actionable bright card.
    const locked =
      !!status &&
      (status.requiresUnlock === true ||
        (status.state === "blocked" && status.prerequisite === "vault"));
    return {
      id: cap.id,
      title: cap.title,
      description: cap.description,
      href: cap.href,
      icon: cap.icon,
      status: display.label,
      statusTone: display.tone,
      tone: cap.tone,
      group: cap.group,
      locked,
      isExploreOnly: cap.isExploreOnly === true,
    };
  });
}

/** Right-aligned action word color for the Memory/Access list rows. */
function listActionClass(mode: OneDashboardMode): string {
  if (mode.locked) return "text-black/35 dark:text-white/40";
  if (mode.statusTone === "ready") return "text-[#0A0A0A] dark:text-white";
  // Explore-only invitations ("Explore"/"Explored") read as neutral ink, not a
  // setup CTA.
  if (mode.isExploreOnly && mode.statusTone === "action")
    return "text-[#0A0A0A] dark:text-white";
  // 2a keeps action CTAs in dark ink (no blue); emphasis is carried by weight.
  return "text-[#0A0A0A] dark:text-white";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function WorkflowCard({
  mode,
  size,
  index,
}: {
  mode: OneDashboardMode;
  size: "hero" | "wide" | "tile";
  index: string;
}) {
  const colors = CARD_COLORS[mode.tone];
  const bright = !mode.locked;
  const isTile = size === "tile";
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-[26px] p-5 sm:p-6",
        "transition-transform duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        size === "hero" ? "min-h-[190px]" : "min-h-[150px]",
      )}
      style={{ background: colors.bg }}
    >
      <div className="relative flex items-start justify-between gap-2">
        {bright ? (
          <span
            className="inline-flex items-center rounded-full bg-white/65 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: colors.ink }}
          >
            {mode.status}
          </span>
        ) : (
          <span
            className="text-[12px] font-bold"
            style={{ fontFamily: MONO_INDEX_FONT, color: colors.faint }}
          >
            {index}
          </span>
        )}
        {bright ? (
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style={{ background: colors.ink }}
          >
            <ArrowUpRight className="h-5 w-5" aria-hidden style={{ color: colors.bg }} />
          </span>
        ) : (
          <Lock className="h-4 w-4 shrink-0" aria-hidden style={{ color: colors.faint }} />
        )}
      </div>

      <div className="relative mt-8">
        <h3
          className={cn(
            "font-[family-name:var(--font-app-display)] font-extrabold leading-[1.05]",
            size === "hero"
              ? "text-[28px] tracking-[-0.5px]"
              : "text-[22px] tracking-[-0.3px]",
          )}
          style={{ color: colors.ink }}
        >
          {mode.title}
        </h3>
        {bright ? (
          <p
            className={cn(
              "mt-1.5 max-w-[24rem] leading-snug",
              isTile ? "text-[13px]" : "text-[14px]",
            )}
            style={{ color: colors.muted }}
          >
            {mode.description}
          </p>
        ) : (
          <p
            className="mt-1 text-[13px] font-semibold"
            style={{ color: colors.cta }}
          >
            {mode.status} <span aria-hidden>→</span>
          </p>
        )}
      </div>
    </Link>
  );
}

function ListRow({ mode, last }: { mode: OneDashboardMode; last: boolean }) {
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg py-3.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        !last && "border-b border-black/10 dark:border-white/10",
      )}
    >
      <span className="min-w-0">
        <span className="block text-[17px] font-bold leading-tight text-[#0A0A0A] dark:text-white">
          {mode.title}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-black/40 dark:text-white/45">
          {mode.description}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-[14px] font-semibold",
          listActionClass(mode),
        )}
      >
        {mode.status}
      </span>
    </Link>
  );
}

function SectionLabel({ id, children }: { id: string; children: string }) {
  return (
    <div className="mb-2 mt-6 flex items-center gap-3">
      <span
        id={id}
        className="text-[12px] font-semibold uppercase tracking-[0.15em] text-black/35 dark:text-white/40"
      >
        {children}
      </span>
      <span aria-hidden className="h-px flex-1 bg-black/10 dark:bg-white/10" />
    </div>
  );
}

function FinishSetupBar({ percent }: { percent: number }) {
  return (
    <Link
      href={ROUTES.ONE_SETUP}
      aria-label="Finish setting up One"
      className="flex items-center gap-4 rounded-[20px] bg-[#111] p-4 transition-transform duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-semibold text-white">Finish setup</span>
          <span className="text-[13px] text-white/45">{percent}% done</span>
        </span>
        <span className="mt-2.5 block h-[3px] w-full overflow-hidden rounded-full bg-white/[0.18]">
          <span
            className="block h-full rounded-full bg-white transition-[width] duration-500 ease-[var(--motion-ease-standard)]"
            style={{ width: `${percent}%` }}
          />
        </span>
      </span>
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-white text-[#111]">
        <ChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </Link>
  );
}

export function OneDashboardPage({
  displayName,
  capabilityStatusById = {},
}: {
  displayName?: string | null;
  /** Live per-capability setup status from `useCapabilitySetupStates`. */
  capabilityStatusById?: Record<string, CapabilityStatus>;
}) {
  const firstName =
    String(displayName || "")
      .trim()
      .split(/\s+/)[0] || "there";
  const modes = buildModes(capabilityStatusById);
  const consentStatus = capabilityStatusById.consent;
  const pendingConsents = consentStatus?.pendingCount ?? 0;
  // Only make a positive "no pending consents" claim once consent is actually
  // resolved (set up). While the state is still unknown/blocked we stay silent
  // rather than implying an all-clear.
  const consentResolved =
    consentStatus?.state === "completed" ||
    consentStatus?.state === "needs-attention";
  const hasSetupRemaining = Object.values(capabilityStatusById).some((status) =>
    isCapabilitySetupActionable(status),
  );

  // "X% done" reflects genuinely set-up capabilities (completed/skipped) over the
  // set-up-able ones (explore-only tabs are excluded — they are looked at, not
  // configured). Same honest basis as the Set up One hub.
  const setupable = ONE_CAPABILITIES.filter((cap) => !cap.isExploreOnly);
  const doneCount = setupable.filter((cap) => {
    const status = capabilityStatusById[cap.id];
    return status ? isCapabilitySetupComplete(status) : false;
  }).length;
  const percent = setupable.length
    ? Math.round((doneCount / setupable.length) * 100)
    : 0;

  const workflowModes = modes.filter((mode) => mode.group === "workflow");
  const memoryModes = modes.filter((mode) => mode.group === "memory");
  const accessModes = modes.filter((mode) => mode.group === "access");

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
      <AppPageHeaderRegion>
        <header
          data-slot="page-header"
          data-page-primary="true"
          data-testid="page-header"
          className="space-y-2"
        >
          <p className="text-[12px] font-semibold uppercase tracking-[0.15em] text-black/35 dark:text-white/40">
            {`Good to see you, ${firstName}.`}
          </p>
          <h1 className="font-[family-name:var(--font-app-display)] text-[34px] font-extrabold leading-[1.02] tracking-[-1px] text-foreground sm:text-[40px] sm:tracking-[-1.2px]">
            One dashboard
          </h1>
          <p className="text-[15px] leading-6 text-black/45 dark:text-white/50">
            Start a workflow, open memory, or review access.
          </p>
          {pendingConsents > 0 ? (
            <Badge variant="secondary" className="w-fit whitespace-nowrap">
              {`${pendingConsents} consent${pendingConsents === 1 ? "" : "s"} pending`}
            </Badge>
          ) : consentResolved ? (
            <Badge variant="secondary" className="w-fit whitespace-nowrap">
              No pending consents
            </Badge>
          ) : null}
        </header>
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        {hasSetupRemaining ? (
          <div className="mb-1">
            <FinishSetupBar percent={percent} />
          </div>
        ) : null}

        {workflowModes.length > 0 ? (
          <section
            aria-labelledby="one-section-workflows"
            data-testid="one-workflows-section"
          >
            <SectionLabel id="one-section-workflows">Workflows</SectionLabel>
            <div className="space-y-3">
              {workflowModes[0] ? (
                <WorkflowCard mode={workflowModes[0]} size="hero" index="01" />
              ) : null}
              {workflowModes[1] || workflowModes[2] ? (
                <div className="grid grid-cols-2 gap-3">
                  {workflowModes[1] ? (
                    <WorkflowCard mode={workflowModes[1]} size="tile" index="02" />
                  ) : null}
                  {workflowModes[2] ? (
                    <WorkflowCard mode={workflowModes[2]} size="tile" index="03" />
                  ) : null}
                </div>
              ) : null}
              {workflowModes.slice(3).map((mode, i) => (
                <WorkflowCard
                  key={mode.id}
                  mode={mode}
                  size="wide"
                  index={pad2(i + 4)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {memoryModes.length > 0 ? (
          <section
            aria-labelledby="one-section-memory"
            data-testid="one-memory-section"
          >
            <SectionLabel id="one-section-memory">Memory</SectionLabel>
            <div>
              {memoryModes.map((mode, i) => (
                <ListRow
                  key={mode.id}
                  mode={mode}
                  last={i === memoryModes.length - 1}
                />
              ))}
            </div>
          </section>
        ) : null}

        {accessModes.length > 0 ? (
          <section
            aria-labelledby="one-section-access"
            data-testid="one-access-section"
          >
            <SectionLabel id="one-section-access">Access</SectionLabel>
            <div>
              {accessModes.map((mode, i) => (
                <ListRow
                  key={mode.id}
                  mode={mode}
                  last={i === accessModes.length - 1}
                />
              ))}
            </div>
          </section>
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
