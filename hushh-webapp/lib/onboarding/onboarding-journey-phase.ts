import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

/** A destination is not authority to resolve onboarding after phone verification. */
export function resolvePostPhoneOnboardingPhase(
  setupResolved: boolean,
): NonNullable<PreVaultUserState["onboardingPhase"]> {
  return setupResolved ? "root_completion" : "setup_hub";
}

export function hasExplicitIncompleteSetup(state: PreVaultUserState): boolean {
    if (state.setupCompleted === true) return false;
    if (state.setupCompleted === false) return true;
    return (
      state.onboardingJourneyVersion === 1 &&
      state.onboardingPhase !== null &&
      state.onboardingPhase !== "root_completion"
    );
  }
