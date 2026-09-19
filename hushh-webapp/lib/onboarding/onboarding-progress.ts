import { ONE_SETUP_CAPABILITIES } from "@/lib/onboarding/one-capabilities";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";

/**
 * Progress across the 7 optional setup capabilities, for the dashboard
 * "Finish setting up One" tile and the capability list screen it opens.
 *
 * A dismissed capability (permanently declined -- `status.state === "skipped"`
 * -- or soft-dismissed this session only) drops out of both the numerator AND
 * the denominator: completion is reachable by connecting OR dismissing every
 * remaining capability, not just by connecting all 7.
 */
export interface OnboardingProgress {
  /** All enabled setup capability ids, in authored order. */
  capabilityIds: readonly string[];
  completedIds: readonly string[];
  /** Permanently declined + this-session soft-dismissed, combined. */
  dismissedIds: readonly string[];
  remainingIds: readonly string[];
  /** capabilityIds.length minus dismissed -- the tile's "of N". */
  total: number;
  completed: number;
  /** True once every capability is completed or dismissed -- the tile hides. */
  isFinished: boolean;
}

export function resolveOnboardingProgress(
  statusById: Record<string, CapabilityStatus>,
  sessionDismissedIds: ReadonlySet<string>,
): OnboardingProgress {
  const capabilityIds = ONE_SETUP_CAPABILITIES.map((capability) => capability.id);
  const completedIds: string[] = [];
  const dismissedIds: string[] = [];
  const remainingIds: string[] = [];

  for (const id of capabilityIds) {
    const status = statusById[id];
    if (status?.state === "completed") {
      completedIds.push(id);
    } else if (status?.state === "skipped" || sessionDismissedIds.has(id)) {
      dismissedIds.push(id);
    } else {
      remainingIds.push(id);
    }
  }

  return {
    capabilityIds,
    completedIds,
    dismissedIds,
    remainingIds,
    total: capabilityIds.length - dismissedIds.length,
    completed: completedIds.length,
    isFinished: remainingIds.length === 0,
  };
}
