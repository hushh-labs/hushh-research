"use client";

import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const ONE_SETUP_COMPLETION_HINT_PREFIX = "one_setup_completion_hint:";

function hintKey(userId: string): string {
  return `${ONE_SETUP_COMPLETION_HINT_PREFIX}${userId}`;
}

export function readOneSetupCompletionHint(userId: string): boolean | null {
  const value = getSessionItem(hintKey(userId));
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

export function writeOneSetupCompletionHint(
  userId: string,
  resolved: boolean | null,
): void {
  if (resolved === null) {
    removeSessionItem(hintKey(userId));
    return;
  }
  setSessionItem(hintKey(userId), resolved ? "1" : "0");
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
  primeOneSetupResolved({
    userId: params.userId,
    skipped: params.skipped,
    completedAt,
  });

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
  })();
}
