import { OneOnboardingCapabilityClient } from "@/app/one/setup/[capability]/one-onboarding-capability-client";
import { ONE_CAPABILITIES } from "@/lib/onboarding/one-capabilities";

/**
 * Static params for the per-capability setup step. Capacitor builds with
 * `output: export`, so every dynamic `[capability]` value must be enumerated
 * here from the single capability catalog. Unknown capabilities still resolve
 * gracefully at runtime (the client redirects to `/one/setup`).
 */
export function generateStaticParams() {
  return ONE_CAPABILITIES.map((capability) => ({ capability: capability.id }));
}

export default async function OneOnboardingCapabilityPage({
  params,
}: {
  params: Promise<{ capability: string }>;
}) {
  const { capability } = await params;
  return <OneOnboardingCapabilityClient capabilityId={capability} />;
}
