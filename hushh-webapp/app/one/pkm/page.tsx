import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function PkmPage() {
  return (
    <PkmSettingsShell title="Memory" titleRole="agent" shellWidth="agent">
      <PkmNaturalPanel />
    </PkmSettingsShell>
  );
}
