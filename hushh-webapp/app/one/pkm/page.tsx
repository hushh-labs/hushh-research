import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function PkmPage() {
  return (
    <PkmSettingsShell
      eyebrow="One / Memory"
      title="Memory"
      description="Browse the details One remembers and control how they can be shared."
    >
      <PkmNaturalPanel />
    </PkmSettingsShell>
  );
}
