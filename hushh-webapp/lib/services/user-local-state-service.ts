"use client";

import { forgetLocationMemory } from "@/lib/one-location/location-grant-memory";
import { KaiNavTourLocalService } from "@/lib/services/kai-nav-tour-local-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
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
 
    // The sealed last-known coordinate (24h retention) and the remembered
    // grant (90d) are the only user-scoped records here that describe where a
    // person physically was, so they are the ones that most need to leave with
    // them. Synchronous, and deliberately not in the settled batch below: this
    // is two `removeItem` calls that already swallow their own failures, and an
    // unrelated rejection must not be able to skip it.
    forgetLocationMemory(userId);
 
 

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
