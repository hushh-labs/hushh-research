"use client";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { KaiFlow, type FlowState } from "@/components/kai/kai-flow";
import type { PortfolioDashboardSection } from "@/components/kai/views/dashboard-master-view";
import { useAuth } from "@/lib/firebase/auth-context";
import { buildKaiPortfolioSectionRoute } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { useState } from "react";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";

export function KaiPortfolioDetailPage({
  section,
}: {
  section: Exclude<PortfolioDashboardSection, "overview">;
}) {
  const { user, loading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [flowState, setFlowState] = useState<FlowState>("checking");

  if (loading || !user) return null;

  return (
    <AppPageShell
      as="div"
      width="reading"
      className={`relative pb-32 ${financeStyles.workspace}`}
      nativeTest={{
        routeId: buildKaiPortfolioSectionRoute(section),
        marker: `native-route-kai-portfolio-${section}`,
        authState: "authenticated",
        dataState: flowState === "checking" ? "loading" : "loaded",
      }}
    >
      <KaiFlow
        userId={user.uid}
        mode="dashboard"
        vaultOwnerToken={vaultOwnerToken ?? ""}
        dashboardSection={section}
        onStateChange={setFlowState}
      />
    </AppPageShell>
  );
}
