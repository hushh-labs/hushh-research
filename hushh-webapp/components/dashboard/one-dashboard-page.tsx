import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import { type CapabilityStatus } from "@/lib/services/capability-setup-state-service";

export function OneDashboardPage({
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
      fitContent
      className="relative isolate"
      nativeTest={{
        routeId: "/one",
        marker: "native-route-one-home",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <AppPageContentRegion>
        <OneAgentRoster capabilityStatusById={capabilityStatusById} userId={userId} />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
