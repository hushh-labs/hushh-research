"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
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
import { KaiMarketHomeProvider } from "@/components/kai/shared/kai-market-home-context";
import { scheduleFinanceWorkspaceWarmup } from "@/lib/kai/finance-workspace-warmup";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { resetKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import marketBriefingStyles from "@/components/kai/shared/market-briefing.module.css";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";

const FINANCE_TAB_DEFINITION = TOP_SHELL_TAB_REGISTRY.finance;
type PortfolioTab = (typeof FINANCE_TAB_DEFINITION.tabs)[number]["value"];

/** Canonical query-tabbed Finance workspace. */
export function KaiMarketHubPage() {
  const { user, userId, loading: authLoading } = useAuth();
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
      () => {
        scrollAppToTop();
        resetKaiBottomChromeVisibility();
        router.replace(destination.href);
      },
      "tap",
      "contextual",
    );
  };

  useEffect(() => {
    setVisibleTab(activeTab);
    scrollAppToTop();
    resetKaiBottomChromeVisibility();
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
    if (!userId) return;
    return scheduleFinanceWorkspaceWarmup({
      userId,
      vaultKey,
      vaultOwnerToken,
      // The warmup primes every Finance panel. Do not cancel it merely because
      // a swipe changed the query selection before the browser became idle.
      activeTab: "market",
    });
  }, [userId, vaultKey, vaultOwnerToken]);

  if (authLoading || !user || !userId) return null;

  // Finance is a One workspace, not a dashboard canvas. Match Location's
  // agent column and let the shared shell own the only outer gutter.
  return (
    <AppPageShell
      as="div"
      fitContent
      width="agent"
      headerContentSpacing="compact"
      className="relative"
      data-finance-workspace="true"
      nativeTest={{
        routeId: KAI_MARKET_PATH,
        marker: "native-route-kai-home",
        authState: "authenticated",
        dataState: flowState === "checking" ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion
        className="space-y-[var(--page-header-section-gap)]"
        data-finance-workspace-header="true"
      >
        <PageHeader
          title="Finance"
          titleRole="agent"
        />
        <TopShellTabs
          tabSet={{ ...FINANCE_TAB_DEFINITION, activeValue: visibleTab }}
        />
      </AppPageHeaderRegion>
      <KaiMarketHomeProvider>
      <SwipeViews
        tabSetId={FINANCE_TAB_DEFINITION.id}
        activeValue={visibleTab}
        options={FINANCE_TAB_DEFINITION.tabs}
        onSelectionChange={(value) => setVisibleTab(value as PortfolioTab)}
        onSelectionCommit={(value) => setActiveTab(value as PortfolioTab)}
        heightMode="active"
        holdHeightDuringTransition={false}
        panelInset="none"
        viewportMinHeight="fill"
        className="mt-[var(--page-header-section-gap)]"
      >
        <div className={`w-full ${marketBriefingStyles.typography}`}>
          <AppPageContentRegion>
            <KaiPreviewRouter />
          </AppPageContentRegion>
        </div>
        <div className={`mx-auto w-full ${financeStyles.workspace}`}>
          <AppPageContentRegion>
            <KaiFlow
              userId={userId}
              mode="dashboard"
              vaultOwnerToken={vaultOwnerToken ?? ""}
              onStateChange={setFlowState}
            />
          </AppPageContentRegion>
        </div>
        <div className={`mx-auto w-full ${financeStyles.workspace}`}>
          <AppPageContentRegion>
            <KaiAnalysisPageContent />
          </AppPageContentRegion>
        </div>
      </SwipeViews>
      </KaiMarketHomeProvider>
    </AppPageShell>
  );
}
