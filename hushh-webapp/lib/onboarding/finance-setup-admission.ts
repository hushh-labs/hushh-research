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

/** A resolved root gate may start Finance setup, and explicit Finance navigation always activates. */
export function canActivateFinanceSetup(
  journey: Pick<
    PreVaultUserState,
    "onboardingActiveCapability" | "onboardingPhase"
  >,
  isExplicitFinanceSetupRoute: boolean = true,
): boolean {
  return (
    isExplicitFinanceSetupRoute ||
    journey.onboardingActiveCapability === null ||
    journey.onboardingActiveCapability === "finance" ||
    journey.onboardingPhase === "root_completion"
  );
}
