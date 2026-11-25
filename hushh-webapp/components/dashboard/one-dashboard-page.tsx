import { preload } from "react-dom";
import { WALLET_HERO_SRC } from "@/lib/wallet/wallet-artwork";
import { NativeOneDashboard } from "@/components/dashboard/native-one-dashboard";
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
  return <NativeOneDashboard capabilityStatusById={capabilityStatusById} displayName={displayName}
    userId={userId} messagesUnreadCount={messagesUnreadCount} />;
}
