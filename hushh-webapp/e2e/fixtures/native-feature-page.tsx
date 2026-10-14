import { createRoot } from "react-dom/client";
import { NativeFeaturePage } from "../../components/app-ui/native-feature-page";
import { SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import { AccountProfileIcon, GmailAgentIcon } from "../../components/icons/agents";
import accountStyles from "../../components/profile/profile-your-account.module.css";

createRoot(document.getElementById("root")!).render(
  <NativeFeaturePage pane={document.getElementById("root")!.dataset.pane === "true"} open title="Preferences" owner="synthetic" context="synthetic" onBack={() => undefined}
    bodyClassName="profile-pane-scroll-root"
    onClose={document.getElementById("root")!.dataset.pane === "true" ? () => undefined : undefined}>
    <p>Public preference choices</p>
    <div data-profile-stack-content="true" className={accountStyles.paneAccountContent}>
      <SettingsGroup>
        <SettingsRow icon={AccountProfileIcon} iconTone="capability" title="Name" />
        <SettingsRow icon={GmailAgentIcon} iconTone="capability" title="Email" />
      </SettingsGroup>
    </div>
  </NativeFeaturePage>,
);
