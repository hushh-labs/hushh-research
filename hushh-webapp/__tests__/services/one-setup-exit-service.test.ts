import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the setup EXIT (Skip / Finish) reliability contract:
 *
 *  1. The local "onboarding dismissed" latch is primed SYNCHRONOUSLY, before any
 *     awaited backend write — so a slow/hung/offline network can never trap the
 *     person on the setup hub (the original "skip nahi ho raha" bug).
 *  2. The durable cross-device write is retried so it reliably lands.
 *  3. Even if every write attempt fails, the sticky latch stays set (the
 *     bootstrap self-heal re-pushes later); Skip is never a dead end.
 *
 * See hushh-research-setup-skip memory + PRs #4629 / #4632.
 */

const {
  syncKaiSetupStateMock,
  syncOnboardingJourneyMock,
  primeSetupResolvedMock,
  markSeenMock,
  setRequiredCookieMock,
  setFlowActiveCookieMock,
} = vi.hoisted(() => ({
  syncKaiSetupStateMock: vi.fn(),
  syncOnboardingJourneyMock: vi.fn(),
  primeSetupResolvedMock: vi.fn(),
  markSeenMock: vi.fn(),
  setRequiredCookieMock: vi.fn(),
  setFlowActiveCookieMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    syncKaiSetupState: syncKaiSetupStateMock,
    syncOnboardingJourney: syncOnboardingJourneyMock,
    primeSetupResolved: primeSetupResolvedMock,
  },
}));

vi.mock("@/lib/services/one-setup-gate-service", () => ({
  OneSetupGateService: { markSeen: markSeenMock },
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingRequiredCookie: setRequiredCookieMock,
  setOnboardingFlowActiveCookie: setFlowActiveCookieMock,
}));

import { acknowledgeOneSetupExit } from "@/lib/services/one-setup-exit-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

describe("acknowledgeOneSetupExit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    syncKaiSetupStateMock.mockResolvedValue(undefined);
    syncOnboardingJourneyMock.mockResolvedValue(undefined);
  });

  it("primes the completion latch synchronously, before the durable writes settle", () => {
    const userId = "exit-sync-user";
    // The durable write never settles — the person must still reach home.
    syncKaiSetupStateMock.mockReturnValue(new Promise<void>(() => {}));

    void acknowledgeOneSetupExit({ userId, skipped: true });

    // The onboarding guard admits /one off this latch, so it MUST be set before
    // any await — otherwise a slow/hung network re-traps the person on the hub.
    expect(OneSetupCompletionHintService.isResolved(userId)).toBe(true);
  });

  it("retries the durable setupCompleted write until it lands", async () => {
    vi.useFakeTimers();
    const userId = "exit-retry-user";
    syncKaiSetupStateMock
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);

    const settled = acknowledgeOneSetupExit({ userId, skipped: false }).then(
      () => "ok",
      () => "err",
    );
    await vi.runAllTimersAsync();

    expect(await settled).toBe("ok");
    expect(syncKaiSetupStateMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("keeps the latch set even if every durable write attempt fails", async () => {
    vi.useFakeTimers();
    const userId = "exit-fail-user";
    syncKaiSetupStateMock.mockRejectedValue(new Error("offline"));

    const settled = acknowledgeOneSetupExit({ userId, skipped: true }).then(
      () => "ok",
      () => "err",
    );
    await vi.runAllTimersAsync();

    expect(await settled).toBe("err");
    // The sticky local latch persists → this device stays out of setup even
    // though the backend write never landed (the bootstrap self-heal re-pushes
    // later). Skip is never a dead end.
    expect(OneSetupCompletionHintService.isResolved(userId)).toBe(true);
    expect(syncKaiSetupStateMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
