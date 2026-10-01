import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MailConnectedAccount, MailOverview } from "../../components/gmail/mail-overview";
import { GmailWorkspaceNavigation } from "../../components/gmail/gmail-workspace-navigation";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { SurfaceStack } from "../../components/app-ui/surfaces";

function Fixture() {
  const [fetching, setFetching] = useState(true);
  const [action, setAction] = useState("");
  const [issue, setIssue] = useState(false);
  return <><AppPageShell width="agent" className="bg-background py-8 text-foreground lg:pt-[80px]">
    <AppPageHeaderRegion className="mx-auto max-w-[820px]">
      <PageHeader
        title="Mail"
        titleRole="agent"
        description="Connected to your Mail"
        className="[&_[data-slot=page-header-copy]]:!space-y-3"
      />
    </AppPageHeaderRegion>
    <AppPageContentRegion className="mx-auto !mt-0 max-w-[820px]">
    <SurfaceStack compact>
    <GmailWorkspaceNavigation value="overview" onValueChange={() => {}} />
    <MailConnectedAccount onReconnect={() => setAction("reconnect")} onDisconnect={() => setAction("disconnect")} />
    <output data-testid="mail-action" className="sr-only">{action}</output>
    <MailOverview fetching={fetching} receiptIssue={issue} receiptCount={34} receiptDetail={issue ? "Sync failed. Please try again in a moment." : fetching ? "Fetching your latest purchases…" : "Your latest receipts are ready."} receiptUpdated="Last updated just now." onOpenChat={() => {}} />
    </SurfaceStack>
    </AppPageContentRegion>
    <div className="fixed left-0 top-0 z-50">
    <button onClick={() => setFetching(false)}>Finish sync</button>
    <button onClick={() => { setFetching(false); setIssue(true); }}>Fail sync</button>
    </div>
  </AppPageShell>
  <aside data-testid="desktop-bottom-clearance" aria-hidden="true" className="fixed inset-x-0 bottom-0 hidden h-32 bg-background/90 lg:block">Reserved voice and navigation space</aside>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
