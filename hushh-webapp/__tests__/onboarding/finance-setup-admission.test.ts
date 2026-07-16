import { describe, expect, it } from "vitest";

import {
  canActivateFinanceSetup,
  shouldShowFinanceSetupWizard,
} from "@/lib/onboarding/finance-setup-admission";

describe("Finance setup admission", () => {
  it("keeps the canonical Finance route open after root setup is skipped", () => {
    expect(
      shouldShowFinanceSetupWizard({
        onboardingResolved: true,
        hasPendingPreVaultState: false,
        isCanonicalFinanceSetupRoute: true,
        wizardReentryRequested: false,
        preserveOnboardingAuditRoute: false,
      }),
    ).toBe(true);
  });

  it("keeps an unresolved account on the canonical Finance route without a draft", () => {
    expect(
      shouldShowFinanceSetupWizard({
        onboardingResolved: false,
        hasPendingPreVaultState: false,
        isCanonicalFinanceSetupRoute: true,
        wizardReentryRequested: false,
        preserveOnboardingAuditRoute: false,
      }),
    ).toBe(true);
  });

  it("allows Finance activation only when no different capability owns setup", () => {
    expect(
      canActivateFinanceSetup({
        onboardingActiveCapability: null,
        onboardingPhase: "root_completion",
      }),
    ).toBe(true);
    expect(
      canActivateFinanceSetup({
        onboardingActiveCapability: "finance",
        onboardingPhase: "capability_setup",
      }),
    ).toBe(true);
    expect(
      canActivateFinanceSetup({
        onboardingActiveCapability: "gmail",
        onboardingPhase: "capability_setup",
      }),
    ).toBe(false);
  });
});
