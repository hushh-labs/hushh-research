import { notFound } from "next/navigation";
import ProfileAppearanceLiquidGlassLab from "@/components/labs/profile-appearance-liquid-glass-lab";
import { resolveAppEnvironment } from "@/lib/app-env";

/**
 * Renders the Liquid Glass Lab page.
 * Restricts access to development environments only.
 */
export default function ProfileAppearanceLabPage() {
  const environment = resolveAppEnvironment();
  const isDev = environment === "development";

  if (!isDev) {
    notFound();
  }

  return <ProfileAppearanceLiquidGlassLab />;
}