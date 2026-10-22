import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { SurfaceStack } from "../../components/app-ui/surfaces";
import { type GmailWorkspace, GmailWorkspaceNavigation, GmailWorkspacePanels } from "../../components/gmail/gmail-workspace-navigation";
import { MailConnectionStatus } from "../../components/gmail/mail-kyc-connect-entry";
import { resolveGmailStatusSummary } from "../../lib/profile/mail-flow";

/**
 * Mail opened by `/one/gmail?workspace=kyc` before Gmail is connected: the page
 * header, the tab bar on KYC, and the shared Mail connection card, laid out exactly as
 * GmailReceiptsPage lays them out.
 * Synthetic and offline: the connect press is recorded, nothing is called.
 */
function Fixture() {
  const [workspace, setWorkspace] = useState<GmailWorkspace>("kyc");
  const [connects, setConnects] = useState(0);
  const revoked = new URLSearchParams(window.location.search).has("revoked");
  const statusSummary = resolveGmailStatusSummary({
    status: {
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
      last_sync_status: "idle",
      auto_sync_enabled: false,
      revoked,
      last_sync_at: revoked ? new Date(Date.now() - 13 * 86_400_000).toISOString() : null,
    },
  });
  const statusPanel = (
    <MailConnectionStatus
      statusSummary={statusSummary}
      primaryActionLabel={revoked ? "Reconnect Mail" : "Connect Mail"}
      onConnect={() => setConnects((count) => count + 1)}
    />
  );
  return (
    <div data-app-scroll-root="true" className="relative h-dvh overflow-y-auto">
    <AppPageShell as="div" width="agent" className="bg-background py-8 text-foreground">
      <AppPageHeaderRegion className="mx-auto max-w-[820px]">
        <PageHeader
          title="Mail"
          titleRole="agent"
          className="[&_[data-slot=page-header-copy]]:!space-y-3"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="mx-auto !mt-0 max-w-[820px]">
        <SurfaceStack compact>
          <GmailWorkspaceNavigation value={workspace} onValueChange={setWorkspace} />
          <GmailWorkspacePanels
            value={workspace}
            onValueChange={setWorkspace}
            panels={{
              overview: statusPanel,
              kyc: statusPanel,
              receipts: (
                <div className="space-y-4">
                  {statusPanel}
                  <p>Saved receipts</p>
                  <div data-swipe-views-horizontal-scroll data-testid="receipt-rail" className="overflow-x-auto">
                    <div className="w-[1000px] py-6">Synthetic wide receipt table</div>
                  </div>
                </div>
              ),
            }}
          />
          <output data-testid="kyc-connects" className="sr-only">{connects}</output>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
