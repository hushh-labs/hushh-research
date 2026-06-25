import Link from "next/link";
import {
  ChevronRight,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader, SectionHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { ONE_CAPABILITIES } from "@/lib/onboarding/one-capabilities";
import {
  getCapabilityStatusDisplay,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import {
  isCapabilitySetupActionable,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { ROUTES } from "@/lib/navigation/routes";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

type OneDashboardMode = {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  status: string;
  statusTone: CapabilityStatusTone;
  tone:
    | "finance"
    | "gmail"
    | "email"
    | "location"
    | "pkm"
    | "consent"
    | "connected";
  group: "workflow" | "memory" | "access";
};

// Borderless neutral glass per the Card Depth Model: depth comes from the
// shared shadow tokens, NOT from per-tone outline borders or tinted chrome.
const MODE_TILE_CLASS =
  "group relative isolate flex min-h-[5.8rem] flex-col overflow-hidden rounded-lg border border-transparent bg-card/78 p-3 text-left shadow-[var(--app-card-shadow-standard)] transition-[background-color,box-shadow] duration-200 hover:bg-card hover:shadow-[var(--app-card-shadow-feature)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[6.15rem]";

// Tone tints the ICON WELL only — the one place tone color is sanctioned. Outer
// card chrome stays neutral.
const MODE_ICON_CLASS_BY_TONE: Record<OneDashboardMode["tone"], string> = {
  finance: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  gmail: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  email: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  location: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
  pkm: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  consent: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  connected: "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
};

// State emphasis via neutral copy weight only — no tinted/bordered status pills.
const MODE_STATUS_CLASS_BY_TONE: Record<CapabilityStatusTone, string> = {
  ready: "border-transparent bg-transparent px-0 text-muted-foreground",
  action: "border-transparent bg-transparent px-0 font-medium text-foreground",
  attention: "border-transparent bg-transparent px-0 font-medium text-foreground",
  muted: "border-transparent bg-transparent px-0 text-muted-foreground",
};

function buildModes(statusById: Record<string, CapabilityStatus>): OneDashboardMode[] {
  // Stable identity (title/desc/href/icon/tone/group) comes from the shared
  // ONE_CAPABILITIES catalog; live per-tile status comes from the capability
  // setup-state resolver via `statusById` so the dashboard never fabricates
  // status. Missing entries render an honest "Checking…" muted state.
  return ONE_CAPABILITIES.map((cap) => {
    const status = statusById[cap.id];
    const display = status
      ? getCapabilityStatusDisplay(status)
      : { label: "Checking…", tone: "muted" as CapabilityStatusTone };
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
    };
  });
}

function ModeTile({
  mode,
  className,
}: {
  mode: OneDashboardMode;
  className?: string;
}) {
  const Icon = mode.icon;
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      className={cn(MODE_TILE_CLASS, className)}
    >
      <MaterialRipple variant="link" effect="glass" className="rounded-lg" />
      <span className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10",
            MODE_ICON_CLASS_BY_TONE[mode.tone],
          )}
        >
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden />
        </span>
        <Badge
          variant="secondary"
          className={cn(
            "max-w-[8.5rem] shrink-0 truncate text-[10px] sm:max-w-[9rem] sm:text-xs",
            MODE_STATUS_CLASS_BY_TONE[mode.statusTone],
          )}
        >
          {mode.status}
        </Badge>
      </span>
      <span className="mt-2 block min-w-0 sm:mt-2.5">
        <span className="block truncate text-[15px] font-semibold leading-5 text-foreground sm:text-lg sm:leading-6">
          {mode.title}
        </span>
        <span className="mt-1 hidden truncate text-sm leading-5 text-muted-foreground sm:block">
          {mode.description}
        </span>
      </span>
    </Link>
  );
}

function ModeSection({
  title,
  description,
  accent,
  modes,
  gridClassName,
}: {
  title: string;
  description: string;
  accent: "neutral" | "kai" | "consent";
  modes: OneDashboardMode[];
  gridClassName: string;
}) {
  if (modes.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={`one-section-${title.toLowerCase()}`}
      className="space-y-2"
    >
      <SectionHeader
        id={`one-section-${title.toLowerCase()}`}
        title={title}
        description={description}
        accent={accent}
        className="px-0"
        testId={`one-${title.toLowerCase()}-section`}
      />
      <div className={cn("grid gap-2 sm:gap-2.5", gridClassName)}>
        {modes.map((mode) => (
          <ModeTile key={mode.id} mode={mode} />
        ))}
      </div>
    </section>
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
        <PageHeader
          eyebrow={`Good to see you, ${firstName}.`}
          title="One dashboard"
          description="Start a workflow, open memory, or review access."
          icon={LayoutDashboard}
          accent="neutral"
          actions={
            <span className="flex items-center gap-2">
              {hasSetupRemaining ? (
                <Link
                  href={ROUTES.ONE_SETUP}
                  className="inline-flex items-center gap-1 rounded-full bg-card/78 px-3 py-1 text-xs font-medium text-foreground shadow-[var(--app-card-shadow-standard)] transition-[background-color,box-shadow] duration-200 hover:bg-card hover:shadow-[var(--app-card-shadow-feature)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                >
                  Finish setup
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              ) : null}
              {pendingConsents > 0 ? (
                <Badge variant="secondary" className="w-fit whitespace-nowrap">
                  {`${pendingConsents} consent${pendingConsents === 1 ? "" : "s"} pending`}
                </Badge>
              ) : consentResolved ? (
                <Badge variant="secondary" className="w-fit whitespace-nowrap">
                  No pending consents
                </Badge>
              ) : null}
            </span>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact className="gap-4">
          <ModeSection
            title="Workflows"
            description="Finance, email, location, and connected systems."
            accent="kai"
            modes={workflowModes}
            gridClassName="grid-cols-2 md:grid-cols-4"
          />
          <ModeSection
            title="Memory"
            description="Gmail receipts and saved knowledge."
            accent="neutral"
            modes={memoryModes}
            gridClassName="grid-cols-2 md:grid-cols-4"
          />
          <ModeSection
            title="Access"
            description="Approvals and revocations."
            accent="consent"
            modes={accessModes}
            gridClassName="grid-cols-2 md:grid-cols-4"
          />
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
