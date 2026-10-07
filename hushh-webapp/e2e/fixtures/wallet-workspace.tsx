import React from "react";
import { createRoot } from "react-dom/client";

import { WalletWorkspace } from "../../components/wallet/wallet-workspace";
import { AppPageShell, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { PageHeader } from "../../components/app-ui/page-sections";
import { TopShellTabs } from "../../components/app-ui/top-shell-tabs";
import { TOP_SHELL_TAB_REGISTRY } from "../../lib/navigation/top-shell-tabs";
import { Switch } from "../../components/ui/switch";

const reference = (window as unknown as {
  __locationReference?: { hubClass: string; headerClass: string };
}).__locationReference;

createRoot(document.getElementById("root")!).render(reference ? (
  <AppPageShell width="agent" fitContent className="relative isolate [--app-page-content-bottom-gap:0px]">
    <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden">
      <div data-location-hub className={reference.hubClass}>
        <PageHeader title="Location" titleRole="agent" actionsInlineMobile className={reference.headerClass}
          actions={<div className="ml-auto flex min-h-0 w-[92px] shrink-0 flex-col items-center justify-center overflow-visible">
            <Switch size="ios" aria-label="Location" />
            <button className="mt-1 block w-full whitespace-nowrap text-center font-[family-name:var(--font-app-body)] text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-[color:var(--app-secondary-label)]">Location off</button>
          </div>}
        />
        <TopShellTabs tabSet={{ ...TOP_SHELL_TAB_REGISTRY.location, activeValue: "now" }} />
      </div>
    </AppPageContentRegion>
  </AppPageShell>
) : <WalletWorkspace />);
