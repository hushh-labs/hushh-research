"use client";

import { KaiNavTourLocalService } from "@/lib/services/kai-nav-tour-local-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
import { KycIdentityProfileDraftService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import { VaultMethodPromptLocalService } from "@/lib/services/vault-method-prompt-local-service";

/**
 * Centralized cleanup for user-scoped local state.
 *
 * Goal:
 * - Ensure deleted accounts leave no user-scoped onboarding/tour/prompt state
 *   in Capacitor Preferences/local fallbacks.
 * - Keep normal multi-account sign-in isolation by user-id scoping.
 */
export class UserLocalStateService {
  static async clearForUser(userId: string): Promise<void> {
    if (!userId) return;

    OneSetupCompletionHintService.clear(userId);
    PreVaultSensitiveDraftService.clearForUser(userId);
    KycIdentityProfileDraftService.clear(userId);

    const tasks: Array<Promise<unknown>> = [
      PreVaultOnboardingService.clear(userId),
      FinanceSetupDraftService.clear(userId),
      KaiNavTourLocalService.clear(userId),
      RiaOnboardingDraftLocalService.clear(userId),
      VaultMethodPromptLocalService.clear(userId),
    ];

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[UserLocalStateService] Failed clearing user-scoped local state:", result.reason);
      }
    }
  }
}
