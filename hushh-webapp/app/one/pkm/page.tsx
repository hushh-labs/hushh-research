import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function PkmPage() {
  return (
    // The top bar's trail says "Memory" beside the back arrow, as Feed and
    // Connect do, so the page does not draw the title a second time.
    <PkmSettingsShell
      title="Memory"
      titleVisuallyHidden
    >
      <PkmNaturalPanel />
    </PkmSettingsShell>
  );
}
