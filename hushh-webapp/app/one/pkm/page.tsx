import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function PkmPage() {
  return (
    <PkmSettingsShell title="Memory" description="What One knows about you">
      <PkmNaturalPanel />
    </PkmSettingsShell>
  );
}
