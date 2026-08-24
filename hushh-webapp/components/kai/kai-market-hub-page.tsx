"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { KaiFlow, type FlowState } from "@/components/kai/kai-flow";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { useAuth } from "@/lib/firebase/auth-context";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { useVault } from "@/lib/vault/vault-context";
import {
  resolveRegisteredTopShellTabValue,
  TOP_SHELL_TAB_REGISTRY,
} from "@/lib/navigation/top-shell-tabs";
import { KAI_MARKET_PATH } from "@/lib/navigation/routes";
import { KaiPreviewRouter } from "@/components/kai/views/kai-preview-router";
import { KaiAnalysisPageContent } from "@/app/one/kai/analysis/page";
import { scheduleFinanceWorkspaceWarmup } from "@/lib/kai/finance-workspace-warmup";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { cn } from "@/lib/utils";

const FINANCE_TAB_DEFINITION = TOP_SHELL_TAB_REGISTRY.finance;
type PortfolioTab = (typeof FINANCE_TAB_DEFINITION.tabs)[number]["value"];

/** Canonical query-tabbed Finance workspace. */
export function KaiMarketHubPage() {
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const { registerSteps, completeStep, reset } = useStepProgress();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialized, setInitialized] = useState(false);
  const [flowState, setFlowState] = useState<FlowState>("checking");

  const activeTab = resolveRegisteredTopShellTabValue(
    FINANCE_TAB_DEFINITION,
    searchParams.get(FINANCE_TAB_DEFINITION.queryParam),
  ) as PortfolioTab;
  const [visibleTab, setVisibleTab] = useState<PortfolioTab>(activeTab);

  const setActiveTab = (tab: PortfolioTab) => {
    const destination = FINANCE_TAB_DEFINITION.tabs.find(
      (candidate) => candidate.value === tab,
    );
    if (
      !destination ||
      destination.href === `${KAI_MARKET_PATH}?tab=${activeTab}`
    )
      return;
    beginRouteTransition(
      destination.href,
      () => router.replace(destination.href, { scroll: false }),
      "tap",
      "contextual",
    );
  };

  useEffect(() => {
    setVisibleTab(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (authLoading) return;
    if (!initialized) {
      registerSteps(2);
      setInitialized(true);
    }
    if (user) completeStep();
    return () => reset();
  }, [authLoading, completeStep, initialized, registerSteps, reset, user]);

  useEffect(() => {
    if (initialized && flowState !== "checking") completeStep();
  }, [completeStep, flowState, initialized]);

  useEffect(() => {
    if (!user?.uid) return;
    return scheduleFinanceWorkspaceWarmup({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
      // The warmup primes every Finance panel. Do not cancel it merely because
      // a swipe changed the query selection before the browser became idle.
      activeTab: "market",
    });
  }, [user?.uid, vaultKey, vaultOwnerToken]);

  if (authLoading || !user) return null;

  // Finance is a One workspace, not a dashboard canvas. Match Profile's
  // reading measure and let the shared shell own the only outer gutter.
  return (
    <AppPageShell
      as="div"
      fitContent
      width="reading"
      className="relative !px-0"
      data-finance-workspace="true"
      nativeTest={{
        routeId: KAI_MARKET_PATH,
        marker: "native-route-kai-home",
        authState: "authenticated",
        dataState: flowState === "checking" ? "loading" : "loaded",
      }}
    >
      <SwipeViews
        tabSetId={FINANCE_TAB_DEFINITION.id}
        activeValue={visibleTab}
        options={FINANCE_TAB_DEFINITION.tabs}
        onSelectionChange={(value) => setVisibleTab(value as PortfolioTab)}
        onSelectionCommit={(value) => setActiveTab(value as PortfolioTab)}
        panelInset="page"
        heightMode="active"
        viewportMinHeight="0"
      >
        <div className="w-full">
          <AppPageContentRegion>
            <KaiPreviewRouter />
          </AppPageContentRegion>
        </div>
        <div className="w-full">
          <AppPageContentRegion>
            <KaiFlow
              userId={user.uid}
              mode="dashboard"
              vaultOwnerToken={vaultOwnerToken ?? ""}
              onStateChange={setFlowState}
            />
          </AppPageContentRegion>
        </div>
        <div className="w-full">
          <AppPageContentRegion>
            <KaiAnalysisPageContent />
          </AppPageContentRegion>
        </div>
      </SwipeViews>
    </AppPageShell>
  );
}
