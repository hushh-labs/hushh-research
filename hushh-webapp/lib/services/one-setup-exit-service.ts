"use client";

import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

export function readOneSetupCompletionHint(userId: string): boolean | null {
  return OneSetupCompletionHintService.isResolved(userId) ? true : null;
}

export function writeOneSetupCompletionHint(
  userId: string,
  resolved: boolean | null,
): void {
  if (resolved === true) {
    OneSetupCompletionHintService.markResolved(userId);
    return;
  }
  OneSetupCompletionHintService.clear(userId);
}

export function primeOneSetupResolved(params: {
  userId: string;
  skipped: boolean;
  completedAt?: number | null;
}): void {
  writeOneSetupCompletionHint(params.userId, true);
  setOnboardingRequiredCookie(false);
  setOnboardingFlowActiveCookie(false);
  OneSetupGateService.markSeen(params.userId);
  PreVaultUserStateService.primeSetupResolved({
    userId: params.userId,
    skipped: params.skipped,
    completedAt: params.completedAt,
  });
}

export function acknowledgeOneSetupExit(params: {
  userId: string;
  skipped: boolean;
  isVaultUnlocked?: boolean;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
}): Promise<void> {
  const completedAt = Date.now();
  return (async () => {
    await PreVaultUserStateService.syncKaiSetupState({
      userId: params.userId,
      completed: true,
      skipped: params.skipped,
      completedAt,
    });
    await PreVaultUserStateService.syncOnboardingJourney({
      userId: params.userId,
      phase: "root_completion",
    });
    // Root completion must not mutate the Finance profile. Finance has its own
    // terminal capability acknowledgement and setupCapabilityIds signal.
    // Do not make local guards/cookies claim success before both durable writes
    // settle. A failed write must leave the journey recoverable on this hub.
    primeOneSetupResolved({
      userId: params.userId,
      skipped: params.skipped,
      completedAt,
    });
  })();
}
