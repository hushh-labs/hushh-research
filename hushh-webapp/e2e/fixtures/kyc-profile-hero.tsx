import { useState } from "react";
import { createRoot } from "react-dom/client";
import { KycPasteDetailsDialog } from "../../components/gmail/kyc-paste-details-dialog";
import { KycProfileHero } from "../../components/gmail/kyc-profile-hero";
import { GmailWorkspaceNavigation } from "../../components/gmail/gmail-workspace-navigation";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { SurfaceStack } from "../../components/app-ui/surfaces";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState("");
  return <AppPageShell width="agent" className="bg-background py-8 text-foreground lg:pt-[80px]">
    <AppPageHeaderRegion className="mx-auto max-w-[820px]">
      <PageHeader title="Mail" titleRole="agent" description="Connected to your Mail" className="[&_[data-slot=page-header-copy]]:!space-y-3" />
    </AppPageHeaderRegion>
    <AppPageContentRegion className="mx-auto !mt-0 max-w-[820px]">
      <SurfaceStack compact>
        <GmailWorkspaceNavigation value="kyc" onValueChange={() => {}} />
        <KycProfileHero onPasteDetails={() => setOpen(true)} />
      </SurfaceStack>
    </AppPageContentRegion>
    <KycPasteDetailsDialog open={open} onOpenChange={setOpen} details={details} onDetailsChange={setDetails}
      saving={false} copied={false} onCopyPrompt={() => {}} onSave={() => setOpen(false)} onSkip={() => setOpen(false)} />
  </AppPageShell>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
