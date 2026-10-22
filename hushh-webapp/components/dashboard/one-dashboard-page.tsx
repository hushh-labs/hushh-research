import { preload } from "react-dom";
import { WALLET_HERO_SRC } from "@/lib/wallet/wallet-artwork";
import { WalletEntryWarmup } from "@/components/wallet/wallet-entry-warmup";
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
  messagesUnreadCount,
}: {
  displayName?: string | null;
  capabilityStatusById?: Record<string, CapabilityStatus>;
  userId?: string | null;
  messagesUnreadCount?: number | null;
}) {
  // Warm the lightweight artwork while the user chooses an agent.
  preload(WALLET_HERO_SRC, { as: "image", fetchPriority: "high" });
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
        <WalletEntryWarmup />
        <OneAgentRoster
          capabilityStatusById={capabilityStatusById}
          displayName={displayName}
          userId={userId}
          messagesUnreadCount={messagesUnreadCount}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
