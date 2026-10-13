import { notFound } from "next/navigation";

import ProfileAppearanceLiquidGlassLab from "@/components/labs/profile-appearance-liquid-glass-lab";
import { resolveAppEnvironment } from "@/lib/app-env";

export default function ProfileAppearanceLabPage() {
  if (resolveAppEnvironment() !== "development") {
    notFound();
  }

  return <ProfileAppearanceLiquidGlassLab />;
}
