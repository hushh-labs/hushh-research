import Link from "next/link";
import {
  Check,
  ChevronRight,
  Circle,
  Lock,
  type LucideIcon,
} from "lucide-react";

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

type OneLauncherMode = {
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

const ICON_SURFACE_BY_TONE: Record<OneCapabilityTone, string> = {
  finance: "bg-[#1f1f1f] text-white dark:bg-white dark:text-[#111]",
  connected: "bg-[#f1f1f3] text-[#1d1d1f] dark:bg-white/[0.14] dark:text-white",
  email: "bg-[#f1f1f3] text-[#1d1d1f] dark:bg-white/[0.14] dark:text-white",
  gmail: "bg-white text-[#1d1d1f] dark:bg-white",
  location: "bg-[#f1f1f3] text-[#1d1d1f] dark:bg-white/[0.14] dark:text-white",
  pkm: "bg-[#f1f1f3] text-[#1d1d1f] dark:bg-white/[0.14] dark:text-white",
  consent: "bg-[#f1f1f3] text-[#1d1d1f] dark:bg-white/[0.14] dark:text-white",
};

function GmailBrandIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 193"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.826 17.455 17.455 17.455h40.727z"
      />
      <path
        fill="#34A853"
        d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837-27.026 25.798v98.91z"
      />
      <path
        fill="#EA4335"
        d="m58.182 93.14-4.174-38.647 4.174-36.989L128 69.868l69.818-52.364 4.669 34.992-4.669 40.644L128 145.504 58.182 93.14z"
      />
      <path
        fill="#FBBC04"
        d="M197.818 17.504V93.14L256 49.505V26.231c0-21.585-24.64-33.89-41.89-20.945l-16.292 12.218z"
      />
      <path
        fill="#C5221F"
        d="m0 49.505 26.759 20.065 31.423 23.57V17.504L41.89 5.286C24.61-7.66 0 4.646 0 26.231v23.274z"
      />
    </svg>
  );
}

function buildModes(
  statusById: Record<string, CapabilityStatus>,
): OneLauncherMode[] {
  return ONE_CAPABILITIES.map((cap) => {
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
}

function statusClassName(mode: OneLauncherMode): string {
  if (mode.locked) return "text-muted-foreground";
  if (mode.statusTone === "ready") return "text-[#138a3d] dark:text-[#5ee283]";
  if (mode.statusTone === "attention") return "text-accent-strong";
  if (mode.statusTone === "action") return "text-foreground";
  return "text-muted-foreground";
}

function LauncherIndicator({ mode }: { mode: OneLauncherMode }) {
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

function LauncherTile({ mode }: { mode: OneLauncherMode }) {
  const Icon = mode.icon;
  const iconNode =
    mode.id === "gmail" ? (
      <GmailBrandIcon className="h-8 w-8" />
    ) : (
      <Icon className="h-7 w-7" aria-hidden />
    );
  return (
    <Link
      href={mode.href}
      aria-label={`Open ${mode.title}`}
      title={mode.description}
      className={cn(
        "group flex min-w-0 flex-col items-center gap-2 rounded-[22px] px-1.5 py-2 text-center",
        "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
        "hover:bg-black/[0.04] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:hover:bg-white/[0.06] motion-reduce:transition-none motion-reduce:active:scale-100",
      )}
    >
      <span className="relative">
        <span
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-[20px] shadow-[0_10px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
            ICON_SURFACE_BY_TONE[mode.tone],
          )}
        >
          {iconNode}
        </span>
        <LauncherIndicator mode={mode} />
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="block max-w-[5.75rem] truncate text-[12.5px] font-semibold leading-tight text-foreground">
          {mode.title}
        </span>
        <span
          className={cn(
            "block max-w-[5.75rem] truncate text-[11px] font-medium leading-tight",
            statusClassName(mode),
          )}
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
      className="flex items-center gap-3 rounded-[22px] border border-border/55 bg-black/[0.035] px-4 py-3 transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:bg-black/[0.055] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-white/[0.06] dark:hover:bg-white/[0.09] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold text-foreground">Finish setup</span>
          <span className="text-[12px] font-medium text-muted-foreground">{percent}% ready</span>
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
  displayName,
  capabilityStatusById = {},
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
}) {
  const firstName =
    String(displayName || "")
      .trim()
      .split(/\s+/)[0] || "there";
  const modes = buildModes(capabilityStatusById);
  const consentStatus = capabilityStatusById.consent;
  const pendingConsents = consentStatus?.pendingCount ?? 0;
  const consentResolved =
    consentStatus?.state === "completed" ||
    consentStatus?.state === "needs-attention";
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
      <AppPageHeaderRegion>
        <header
          data-slot="page-header"
          data-page-primary="true"
          data-testid="page-header"
          className="space-y-2"
        >
          <p className="text-[12px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            {`Good to see you, ${firstName}.`}
          </p>
          <h1 className="font-[family-name:var(--font-app-display)] text-[34px] font-semibold leading-[1.02] tracking-normal text-foreground sm:text-[40px]">
            One
          </h1>
          <p className="max-w-[34rem] text-[15px] leading-6 text-muted-foreground">
            Your apps, memory, access, and specialist agents in one place.
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
        <div className="space-y-5">
          {hasSetupRemaining ? <FinishSetupStrip percent={percent} /> : null}
          <section
            aria-labelledby="one-launcher-heading"
            data-testid="one-launcher-section"
            className="rounded-[30px] border border-border/45 bg-background/55 px-3 py-5 shadow-[0_1px_0_rgba(255,255,255,0.35)_inset] dark:bg-white/[0.025] sm:px-5"
          >
            <div className="mb-4 flex items-center justify-between gap-3 px-1">
              <h2
                id="one-launcher-heading"
                className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Launcher
              </h2>
              <span className="text-[12px] font-medium text-muted-foreground">
                {doneCount} of {setupable.length} ready
              </span>
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {modes.map((mode) => (
                <LauncherTile key={mode.id} mode={mode} />
              ))}
            </div>
          </section>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
