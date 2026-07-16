import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

/**
 * The canonical Finance setup route is an intentional re-entry point after
 * root setup has been acknowledged. It must never bounce to the setup hub
 * merely because the account-level gate is already resolved.
 */
export function shouldShowFinanceSetupWizard(params: {
  onboardingResolved: boolean;
  hasPendingPreVaultState: boolean;
  isCanonicalFinanceSetupRoute: boolean;
  wizardReentryRequested: boolean;
  preserveOnboardingAuditRoute: boolean;
}): boolean {
  return (
    params.isCanonicalFinanceSetupRoute ||
    (!params.onboardingResolved && params.hasPendingPreVaultState) ||
    params.wizardReentryRequested ||
    params.preserveOnboardingAuditRoute
  );
}

/** A resolved root gate may start Finance setup, but cannot replace another active setup goal. */
export function canActivateFinanceSetup(
  journey: Pick<
    PreVaultUserState,
    "onboardingActiveCapability" | "onboardingPhase"
  >,
): boolean {
  return (
    journey.onboardingActiveCapability === null ||
    journey.onboardingActiveCapability === "finance" ||
    journey.onboardingPhase === "root_completion"
  );
}
