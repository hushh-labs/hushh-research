import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

/** A destination is not authority to resolve onboarding after phone verification. */
export function resolvePostPhoneOnboardingPhase(
  setupResolved: boolean,
): NonNullable<PreVaultUserState["onboardingPhase"]> {
  return setupResolved ? "root_completion" : "setup_hub";
}
