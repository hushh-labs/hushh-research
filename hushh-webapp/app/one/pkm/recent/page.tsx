import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function PkmRecentPage() {
  return (
    <PkmSettingsShell title="Recently learned" description="The latest things One remembers">
      <PkmNaturalPanel view="recent" />
    </PkmSettingsShell>
  );
}
