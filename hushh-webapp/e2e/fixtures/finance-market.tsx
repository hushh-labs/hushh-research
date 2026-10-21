import { createRoot } from "react-dom/client";
import { AppPageShell, AppPageHeaderRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { KaiMarketPreviewView } from "../../components/kai/views/kai-market-preview-view";
import { KaiMarketHomeProvider } from "../../components/kai/shared/kai-market-home-context";
import { KaiMarketNewsPage } from "../../components/kai/kai-market-news-page";
import marketStyles from "../../components/kai/shared/market-briefing.module.css";

createRoot(document.getElementById("root")!).render(
  window.location.pathname === "/finance-market-news-fixture" ? <KaiMarketNewsPage /> : <>
    <AppPageShell width="agent" fitContent className={marketStyles.typography}>
      <AppPageHeaderRegion><PageHeader title="Finance" titleRole="agent" /></AppPageHeaderRegion>
      <KaiMarketHomeProvider><KaiMarketPreviewView /></KaiMarketHomeProvider>
    </AppPageShell>
  </>,
);
