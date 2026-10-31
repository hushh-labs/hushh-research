import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { PkmSharingPriceReview } from "@/components/profile/pkm-sharing-price-review";

export default function PkmPage() {
  return (
    <PkmSettingsShell title="Memory" titleRole="agent" titleVisuallyHidden shellWidth="agent">
      <PkmSharingPriceReview />
      <PkmNaturalPanel />
    </PkmSettingsShell>
  );
}
