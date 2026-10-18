import { createContext } from "react";

export { useVault } from "./bottom-shell-boundaries";

// Synthetic unlocked session and directory ports. The complete Messages
// workspace still renders production People/Circles panes and shared chrome.
export const VaultContext = createContext({ vaultOwnerToken: "fixture", vaultKey: "fixture" });
export const OneLocationService = {
  listCircles: async () => [
    { id: "circle", name: "Weekend friends", kind: "friends", role: "owner", memberCount: 2 },
    { id: "family", name: "Family", kind: "friends", role: "owner", memberCount: 4 },
    { id: "team", name: "Team", kind: "friends", role: "owner", memberCount: 6 },
    ...(new URLSearchParams(location.search).has("overflowInbox")
      ? Array.from({ length: 30 }, (_, index) => ({ id: `extra-${index}`, name: `Circle ${index + 1}`, kind: "friends", role: "owner", memberCount: 2 }))
      : []),
  ],
};
