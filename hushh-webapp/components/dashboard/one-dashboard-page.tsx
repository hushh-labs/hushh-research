import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { OneAgentRoster } from "@/components/dashboard/one-agent-roster";
import { type CapabilityStatus } from "@/lib/services/capability-setup-state-service";

export function OneDashboardPage({
  capabilityStatusById = {},
  displayName,
  userId,
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
  userId?: string | null;
}) {
  return (
    <AppPageShell
      as="main"
      width="reading"
      fitContent
      className="relative isolate bg-[color:var(--one-launcher-background)]"
      data-one-launcher-root="true"
      nativeTest={{
        routeId: "/one",
        marker: "native-route-one-home",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <AppPageContentRegion>
        <OneAgentRoster
          capabilityStatusById={capabilityStatusById}
          displayName={displayName}
          userId={userId}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
