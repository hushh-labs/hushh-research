import Link from "next/link";
import { ChevronRight, ListChecks } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import { HomeGreeting } from "@/components/dashboard/home-greeting";
import { ONE_SETUP_CAPABILITIES } from "@/lib/onboarding/one-capabilities";
import {
  isCapabilitySetupActionable,
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import {
  buildOneSetupRoute,
  ROUTES,
} from "@/lib/navigation/routes";

function FinishSetupStrip({
  completedCount,
  totalCount,
}: {
  completedCount: number;
  totalCount: number;
}) {
  const percent = totalCount
    ? Math.round((completedCount / totalCount) * 100)
    : 0;

  return (
    <Link
      href={buildOneSetupRoute({ returnTo: ROUTES.ONE_HOME })}
      aria-label="Finish setting up One"
      data-testid="one-finish-setup"
      className="group flex w-full items-center gap-3 rounded-[22px] border border-accent/20 bg-accent-surface/65 px-4 py-3.5 transition-[background-color,border-color] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] hover:border-accent/35 hover:bg-accent-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none sm:px-5"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-accent text-accent-foreground shadow-[0_5px_14px_rgba(0,0,0,0.12)]">
        <ListChecks className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-[14px] font-semibold text-foreground">
            Finish setup
          </span>
          <span className="whitespace-nowrap text-[12px] font-medium text-muted-foreground">
            {completedCount} of {totalCount} setup steps ready
          </span>
        </span>
        <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.10]">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-[var(--motion-ease-standard)]"
            style={{ width: `${percent}%` }}
          />
        </span>
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/80 text-foreground shadow-[0_1px_8px_rgba(0,0,0,0.08)] transition-transform duration-[var(--motion-duration-sm)] group-hover:translate-x-0.5 motion-reduce:transition-none">
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
  const hasSetupRemaining = Object.values(capabilityStatusById).some((status) =>
    isCapabilitySetupActionable(status),
  );
  // Honest, state-derived subline — never claims activity One did not do.
  const greetingSubline = hasSetupRemaining
    ? "A few things left to set up whenever you're ready."
    : "Everything's ready when you are.";
  const setupable = ONE_SETUP_CAPABILITIES;
  const doneCount = setupable.filter((cap) => {
    const status = capabilityStatusById[cap.id];
    return status ? isCapabilitySetupComplete(status) : false;
  }).length;
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
          <HomeGreeting displayName={displayName} subline={greetingSubline} />
          {hasSetupRemaining ? (
            <FinishSetupStrip
              completedCount={doneCount}
              totalCount={setupable.length}
            />
          ) : null}
          <OneAgentRoster capabilityStatusById={capabilityStatusById} />
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
