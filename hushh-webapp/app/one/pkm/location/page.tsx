import { NativeLocationMemory } from "./native-location-memory";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function LocationMemoryPage() {
  return (
    <PkmSettingsShell title="Location memory" titleVisuallyHidden>
      <NativeLocationMemory />
    </PkmSettingsShell>
  );
}
