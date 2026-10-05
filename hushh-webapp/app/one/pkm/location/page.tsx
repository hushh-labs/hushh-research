import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function LocationMemoryPage() {
  return (
    <PkmSettingsShell title="Location memory" titleVisuallyHidden>
      <PkmNaturalPanel view="location" />
    </PkmSettingsShell>
  );
}
