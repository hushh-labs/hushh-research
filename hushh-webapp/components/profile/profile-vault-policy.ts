import type { ProfileDetail, ProfilePanel } from "@/lib/navigation/profile-routes";

export function profileRouteRequiresUnlockedVault(
  panel: ProfilePanel | null,
  detail: ProfileDetail | null,
): boolean {
  if (
    panel === "my-data" ||
    panel === "payouts" ||
    panel === "net-worth-score" ||
    panel === "world-model" ||
    panel === "request-pricing" ||
    panel === "connected-systems" ||
    panel === "connectors" ||
    panel === "gmail"
  ) {
    return true;
  }
  if (panel === "security") {
    return true;
  }
  return (
    panel === "preferences" &&
    (detail === "kai-preferences" || detail === "gemini")
  );
}
