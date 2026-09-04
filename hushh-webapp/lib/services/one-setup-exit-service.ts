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
  // Prime the local resolved state FIRST (synchronously) so the onboarding
  // guard admits /one immediately and the person always reaches home — even if
  // the durable backend writes below are slow or fail. The device-local
  // completion latch (backed by native Preferences on iOS) carries the
  // "resolved" signal; the awaited backend writes then make it account-wide.
  // A failed durable write stays recoverable: the person is already home and
  // can finish later from Profile or the hub. This favours a reliable exit over
  // trapping the person on the hub when the network is flaky.
  primeOneSetupResolved({
    userId: params.userId,
    skipped: params.skipped,
    completedAt,
  });
  return (async () => {
    // Persist the account-wide, cross-device setupCompleted flag. Retry so it
    // lands even on a flaky network: the sticky local latch already keeps THIS
    // device out of setup meanwhile, and the bootstrap self-heal re-pushes on a
    // future load if every attempt here still fails.
    await persistWithRetry(() =>
      PreVaultUserStateService.syncKaiSetupState({
        userId: params.userId,
        completed: true,
        skipped: params.skipped,
        completedAt,
      }),
    );
    await persistWithRetry(() =>
      PreVaultUserStateService.syncOnboardingJourney({
        userId: params.userId,
        phase: "root_completion",
      }),
    );
    // Root completion must not mutate the Finance profile. Finance has its own
    // terminal capability acknowledgement and setupCapabilityIds signal.
  })();
}

const SETUP_EXIT_RETRY_DELAYS_MS = [400, 1200];

async function persistWithRetry(op: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= SETUP_EXIT_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      await op();
      return;
    } catch (error) {
      lastError = error;
      const wait = SETUP_EXIT_RETRY_DELAYS_MS[attempt];
      if (wait === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}
