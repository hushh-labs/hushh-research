import { createRoot } from "react-dom/client";
import { FirstConnectInsightsCard } from "../../components/agent/first-connect-insights-card";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";
publishValidatedAuthSessionOwner("fixture-owner");
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl p-4"><FirstConnectInsightsCard ownerId="fixture-owner" vaultKey="synthetic-key" vaultOwnerToken="synthetic-token" enabled /></main>,
);
