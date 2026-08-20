import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { OneAgentPresence } from "@/components/dashboard/one-agent-presence";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import { OneHomeGreeting } from "@/components/dashboard/one-home-greeting";
import { type CapabilityStatus } from "@/lib/services/capability-setup-state-service";

export function OneDashboardPage({
  displayName = null,
  capabilityStatusById = {},
  userId,
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
  userId?: string | null;
}) {
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
          <OneHomeGreeting displayName={displayName} />
          <OneAgentPresence />
          <OneAgentRoster capabilityStatusById={capabilityStatusById} userId={userId} />
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
