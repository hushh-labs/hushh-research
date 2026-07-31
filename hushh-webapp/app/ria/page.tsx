"use client";

import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Compatibility entrypoint only.  The RIA profile owns the canonical home
 * surface; keeping this route avoids breaking saved links and native intents.
 */
export default function RiaCompatibilityHomePage() {
  return <ClientRedirect to={ROUTES.RIA_PROFILE} />;
}
