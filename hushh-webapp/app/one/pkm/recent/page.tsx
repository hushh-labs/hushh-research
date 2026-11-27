import { NativeRecentMemory } from "./native-recent-memory";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

export default function PkmRecentPage() {
  return (
    <PkmSettingsShell
      title="Recently learned"
      titleVisuallyHidden
      description="The latest things One remembers"
    >
      <NativeRecentMemory />
    </PkmSettingsShell>
  );
}
