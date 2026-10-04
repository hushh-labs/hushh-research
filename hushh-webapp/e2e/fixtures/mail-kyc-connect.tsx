import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { SurfaceStack } from "../../components/app-ui/surfaces";
import { type GmailWorkspace, GmailWorkspaceNavigation } from "../../components/gmail/gmail-workspace-navigation";
import { MailKycConnectEntry } from "../../components/gmail/mail-kyc-connect-entry";

/**
 * Mail opened by `/one/gmail?workspace=kyc` before Gmail is connected: the page
 * header, the tab bar on KYC, and KYC's own connect entry, laid out exactly as
 * GmailReceiptsPage lays them out.
 * Synthetic and offline: the connect press is recorded, nothing is called.
 */
function Fixture() {
  const [workspace, setWorkspace] = useState<GmailWorkspace>("kyc");
  const [connects, setConnects] = useState(0);
  return (
    <AppPageShell as="div" width="agent" className="bg-background py-8 text-foreground">
      <AppPageHeaderRegion className="mx-auto max-w-[820px]">
        <PageHeader
          title="Mail"
          titleRole="agent"
          description="Connect Mail to set up receipts and KYC requests."
          className="[&_[data-slot=page-header-copy]]:!space-y-3"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="mx-auto !mt-0 max-w-[820px]">
        <SurfaceStack compact>
          <GmailWorkspaceNavigation value={workspace} onValueChange={setWorkspace} />
          {workspace === "kyc" ? (
            <MailKycConnectEntry onConnect={() => setConnects((count) => count + 1)} />
          ) : null}
          <output data-testid="kyc-connects" className="sr-only">{connects}</output>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
