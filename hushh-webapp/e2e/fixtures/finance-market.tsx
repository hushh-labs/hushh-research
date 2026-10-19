import { createRoot } from "react-dom/client";
import { AppPageShell, AppPageHeaderRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { RowLabel, RowDescription, HelperText, TrailingAction } from "../../components/app-ui/typography";
import { KaiMarketPreviewView } from "../../components/kai/views/kai-market-preview-view";

createRoot(document.getElementById("root")!).render(
  <>
    <AppPageShell width="agent" fitContent>
      <AppPageHeaderRegion><PageHeader title="Finance" titleRole="agent" /></AppPageHeaderRegion>
      <KaiMarketPreviewView />
    </AppPageShell>
    <div hidden data-location-type-reference>
      <RowLabel>Location row</RowLabel>
      <RowDescription>Location description</RowDescription>
      <HelperText>Location helper</HelperText>
      <TrailingAction>Location action</TrailingAction>
    </div>
  </>,
);
