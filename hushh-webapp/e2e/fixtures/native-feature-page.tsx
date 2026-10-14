import { createRoot } from "react-dom/client";
import { NativeFeaturePage } from "../../components/app-ui/native-feature-page";
import { SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import { AccountProfileIcon, GmailAgentIcon } from "../../components/icons/agents";
import accountStyles from "../../components/profile/profile-your-account.module.css";
import { AppPageShell } from "../../components/app-ui/app-page-shell";

const pane = document.getElementById("root")!.dataset.pane === "true";

createRoot(document.getElementById("root")!).render(
  <NativeFeaturePage pane={pane} contentInset={pane ? "profile" : undefined} open title="Preferences" owner="synthetic" context="synthetic" onBack={() => undefined}
    bodyClassName="profile-pane-scroll-root"
    onClose={document.getElementById("root")!.dataset.pane === "true" ? () => undefined : undefined}>
    <AppPageShell width="reading" fitContent className={pane ? "profile-pane-page profile-pane-page--inner" : undefined}>
    <p data-content-start>Public preference choices</p>
    <div data-profile-stack-content="true" className={accountStyles.paneAccountContent}>
      <SettingsGroup>
        <SettingsRow icon={AccountProfileIcon} iconTone="capability" title="Name" />
        <SettingsRow icon={GmailAgentIcon} iconTone="capability" title="Email" />
      </SettingsGroup>
    </div>
    </AppPageShell>
  </NativeFeaturePage>,
);
