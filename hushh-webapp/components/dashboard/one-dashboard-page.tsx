import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HomeGreeting } from "@/components/dashboard/home-greeting";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import {
  isCapabilitySetupActionable,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";

export function OneDashboardPage({
  displayName,
  capabilityStatusById = {},
  userId,
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
  userId?: string | null;
}) {
  const hasSetupRemaining = Object.values(capabilityStatusById).some((status) =>
    isCapabilitySetupActionable(status),
  );
  // Honest, state-derived subline — never claims activity One did not do. The
  // roster below is the affordance it points at: it carries the per-capability
  // setup state, so "a few things left" is never a dead end.
  const greetingSubline = hasSetupRemaining
    ? "A few things left to set up whenever you're ready."
    : "Everything's ready when you are.";

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)]"
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
          <OneAgentRoster capabilityStatusById={capabilityStatusById} userId={userId} />
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
