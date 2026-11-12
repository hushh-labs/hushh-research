"use client";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { KaiFlow, type FlowState } from "@/components/kai/kai-flow";
import type { PortfolioDashboardSection } from "@/components/kai/views/dashboard-master-view";
import { useAuth } from "@/lib/firebase/auth-context";
import { buildKaiPortfolioSectionRoute } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { NativeFinanceRoute } from "./native-finance-workspace";
import { useRef, useState } from "react";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";

export function KaiPortfolioDetailPage({
  section,
}: {
  section: Exclude<PortfolioDashboardSection, "overview">;
}) {
  const { user, userId, loading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const nativeFrame = useRef<HTMLDivElement | null>(null);
  const [flowState, setFlowState] = useState<FlowState>("checking");

  if (loading || !user || !userId) return null;

  return (
    <NativeFinanceRoute frame={nativeFrame} path={buildKaiPortfolioSectionRoute(section)} model={{ owner: userId, view: "portfolio" }}><AppPageShell ref={nativeFrame}
      as="div"
      width="agent"
      className={`relative pb-32 ${financeStyles.workspace}`}
      nativeTest={{
        routeId: buildKaiPortfolioSectionRoute(section),
        marker: `native-route-kai-portfolio-${section}`,
        authState: "authenticated",
        dataState: flowState === "checking" ? "loading" : "loaded",
      }}
    >
      <KaiFlow
        userId={userId}
        mode="dashboard"
        vaultOwnerToken={vaultOwnerToken ?? ""}
        dashboardSection={section}
        onStateChange={setFlowState}
      />
    </AppPageShell></NativeFinanceRoute>
  );
}
