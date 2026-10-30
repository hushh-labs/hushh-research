"use client";

import { useEffect, useRef, useState } from "react";
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

  // The tab this page last asked the router for. A soft navigation reaches
  // `useSearchParams` a round trip AFTER the pane has moved, so `activeTab`
  // alone cannot tell "already requested" from "not requested".
  const requestedTabRef = useRef<PortfolioTab | null>(null);

  const navigateToTab = (tab: PortfolioTab) => {
    const destination = FINANCE_TAB_DEFINITION.tabs.find(
      (candidate) => candidate.value === tab,
    );
    if (!destination) return;
    requestedTabRef.current = tab;
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

  // A tab press is the selection: the pager follows `visibleTab`, so it has to
  // change with the press, not with the URL echo. Waiting for the echo left the
  // pager's self-heal reading the old tab as the selection and dragging the
  // pane back to it.
  const selectTab = (tab: PortfolioTab) => {
    setVisibleTab(tab);
    navigateToTab(tab);
  };

  // Settling a pane (a swipe, or the press above) confirms the URL. It must not
  // ask the router again for a tab it is already on its way to, because a second
  // `replace` pre-empts the first and restarts its round trip.
  const commitTab = (tab: PortfolioTab) => {
    if (tab === (requestedTabRef.current ?? activeTab)) return;
    navigateToTab(tab);
  };

  useEffect(() => {
    requestedTabRef.current = null;
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
          titleVisuallyHidden
        />
        <TopShellTabs
          tabSet={{ ...FINANCE_TAB_DEFINITION, activeValue: visibleTab }}
          onValueChange={(value) => selectTab(value as PortfolioTab)}
        />
      </AppPageHeaderRegion>
      <KaiMarketHomeProvider>
      <SwipeViews
        tabSetId={FINANCE_TAB_DEFINITION.id}
        activeValue={visibleTab}
        options={FINANCE_TAB_DEFINITION.tabs}
        onSelectionChange={(value) => setVisibleTab(value as PortfolioTab)}
        onSelectionCommit={(value) => commitTab(value as PortfolioTab)}
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
