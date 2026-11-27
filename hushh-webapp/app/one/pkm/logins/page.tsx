import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { WebsiteLoginsWorkspace } from "@/components/secrets/website-logins-workspace";

export default function WebsiteLoginsPage() {
  return <PkmSettingsShell title="Website logins" description="Private sign-in for your approved website tasks.">
    <WebsiteLoginsWorkspace />
  </PkmSettingsShell>;
}
