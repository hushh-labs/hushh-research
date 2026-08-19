import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

/**
 * Whether a durable record says, in so many words, that root setup is not done.
 *
 * A missing legacy mirror is not evidence. Accounts created before the journey
 * record existed carry nulls everywhere, and reading that as "incomplete" would
 * push established people back through a funnel they finished long ago. Only an
 * explicit `false`, or a versioned journey parked on a pre-completion phase,
 * activates the gate.
 */
export function hasExplicitIncompleteSetup(state: PreVaultUserState): boolean {
  if (PreVaultUserStateService.isSetupResolved(state)) return false;
  if (state.setupCompleted === false) return true;
  return (
    state.onboardingJourneyVersion === 1 &&
    state.onboardingPhase !== null &&
    state.onboardingPhase !== "root_completion"
  );
}
