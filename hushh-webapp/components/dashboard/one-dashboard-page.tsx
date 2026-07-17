import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import { type CapabilityStatus } from "@/lib/services/capability-setup-state-service";

export function OneDashboardPage({
  capabilityStatusById = {},
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
}) {
  return (
    <AppPageShell
      as="main"
      width="reading"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one",
        marker: "native-route-one-home",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <AppPageContentRegion>
        <OneAgentRoster capabilityStatusById={capabilityStatusById} />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
