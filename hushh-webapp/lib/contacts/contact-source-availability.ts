/**
 * Resolve contact-source availability when the capability probe itself fails.
 *
 * A native bridge rejection is not evidence that the phone has no address
 * book: the deliberate tap can still retry the plugin and surface a useful
 * error. On web there is no implicit address book, so only a configured Google
 * source keeps the flow available. Keeping this rule shared prevents Connect
 * and One Location onboarding from silently diverging again.
 */
export function resolveContactSourceProbeFailure({
  native,
  googleConfigured,
}: {
  native: boolean;
  googleConfigured: boolean;
}): { available: boolean; googleFallback: boolean } {
  return {
    available: native || googleConfigured,
    googleFallback: !native && googleConfigured,
  };
}
