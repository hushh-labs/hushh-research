import { createRoot } from "react-dom/client";
import { AppPageShell, AppPageHeaderRegion } from "../../components/app-ui/app-page-shell";
import { NavigationTitle } from "../../components/app-ui/typography";
import { TopShellTabs } from "../../components/app-ui/top-shell-tabs";
import { TOP_SHELL_TAB_REGISTRY } from "../../lib/navigation/top-shell-tabs";
import { KaiMarketPreviewView } from "../../components/kai/views/kai-market-preview-view";
import { KaiMarketHomeProvider } from "../../components/kai/shared/kai-market-home-context";
import { KaiMarketNewsPage } from "../../components/kai/kai-market-news-page";
import marketStyles from "../../components/kai/shared/market-briefing.module.css";

createRoot(document.getElementById("root")!).render(
  <>
    {/* The public fixture supplies shell geometry; title and tabs use shared production roles. */}
    <div className="mx-auto flex h-14 max-w-[728px] items-center px-5"><NavigationTitle as="div" role="heading" aria-level={1}>{window.location.pathname === "/finance-market-news-fixture" ? "News" : "Finance"}</NavigationTitle></div>
    {window.location.pathname === "/finance-market-news-fixture" ? <KaiMarketNewsPage /> : <>
    <AppPageShell width="agent" fitContent className={`${marketStyles.typography} ${marketStyles.workspaceFrame}`}>
      <AppPageHeaderRegion><TopShellTabs tabSet={{ ...TOP_SHELL_TAB_REGISTRY.finance, activeValue: "market" }} /></AppPageHeaderRegion>
      <KaiMarketHomeProvider><KaiMarketPreviewView /></KaiMarketHomeProvider>
    </AppPageShell>
  </>}
  </>,
);
