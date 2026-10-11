import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted and vi.mock are file-scoped, so each payouts test file repeats this setup.
const state = vi.hoisted(() => ({
  query: "",
  pathname: "/one/profile/payouts",
  router: { replace: vi.fn() },
  token: "owner-token" as string | null,
  account: vi.fn(),
  onboard: vi.fn(),
  bankPayouts: vi.fn(),
  manage: vi.fn(),
  earnings: vi.fn(),
  hashcoins: vi.fn(),
  redeemTest: vi.fn(),
  redeemLive: vi.fn(),
  epoch: 1,
  native: false,
}));

vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => state.native }));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => state.router,
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/services/document-payout-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/document-payout-service")>(),
  DocumentPayoutService: { account: state.account, onboard: state.onboard, bankPayouts: state.bankPayouts, manage: state.manage, earnings: state.earnings, hashcoins: state.hashcoins, redeemTest: state.redeemTest, redeemLive: state.redeemLive },
}));

import { PAYOUT_FALLBACK_POLL_MS, usePayoutSnapshot } from "@/components/consent/document-payout-account";

function PayoutPollHarness() {
  usePayoutSnapshot(state.hashcoins);
  usePayoutSnapshot(state.earnings);
  usePayoutSnapshot(state.bankPayouts, { bankOnly: true });
  return null;
}

describe("document payout account", () => {
  beforeEach(() => {
    state.query = "";
    state.pathname = "/one/profile/payouts";
    state.router.replace.mockReset();
    window.sessionStorage.clear();
    state.epoch = 1;
    state.native = false;
    state.manage.mockReset().mockResolvedValue({ url: "https://example.invalid/unsafe" });
    state.earnings.mockReset().mockResolvedValue({ currency: "USD", transactions: [], nextCursor: null });
    state.token = "owner-token";
    state.account.mockReset().mockResolvedValue({ account: null });
    state.onboard.mockReset().mockResolvedValue({ url: "https://example.invalid/unsafe" });
    state.bankPayouts.mockReset().mockResolvedValue({ currency: "USD", payouts: [] });
    state.hashcoins.mockReset().mockResolvedValue({
      coinName: "Hussh Coins", coinsPerDollar: 100, currency: "USD", payoutMode: "test", testPayouts: true, liveRedemptionEnabled: false, maxRedeemCoins: 50000,
      live: { balanceCoins: 911, reservedCoins: 0, availableCoins: 911, amountCents: 911, held: false },
      sandbox: { balanceCoins: 911, reservedCoins: 0, availableCoins: 911, amountCents: 911, held: false }, latestRedemption: null,
    });
    state.redeemTest.mockReset();
    state.redeemLive.mockReset();
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("recovers visible payout snapshots on a bounded poll, coalesces slow reads, and stops for hidden or changed owners", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    let finishSlowWallet!: (value: unknown) => void;
    state.hashcoins.mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSlowWallet = resolve; }))
      .mockResolvedValue({});
    try {
      const view = render(<PayoutPollHarness />);
      await act(async () => { await Promise.resolve(); });
      for (const load of [state.hashcoins, state.earnings, state.bankPayouts]) {
        expect(load).toHaveBeenCalledExactlyOnceWith("owner-token");
      }

      await act(async () => { await vi.advanceTimersByTimeAsync(PAYOUT_FALLBACK_POLL_MS); });
      expect(state.hashcoins).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(PAYOUT_FALLBACK_POLL_MS * 2); });
      expect(state.hashcoins).toHaveBeenCalledTimes(2);
      await act(async () => { finishSlowWallet({}); });
      expect(state.hashcoins).toHaveBeenCalledTimes(3);

      hidden = true;
      const beforeHidden = [state.hashcoins.mock.calls.length, state.earnings.mock.calls.length, state.bankPayouts.mock.calls.length];
      await act(async () => { await vi.advanceTimersByTimeAsync(PAYOUT_FALLBACK_POLL_MS * 2); });
      expect([state.hashcoins.mock.calls.length, state.earnings.mock.calls.length, state.bankPayouts.mock.calls.length]).toEqual(beforeHidden);

      hidden = false;
      state.token = "second-owner";
      state.epoch++;
      view.rerender(<PayoutPollHarness />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(PAYOUT_FALLBACK_POLL_MS); });
      for (const load of [state.hashcoins, state.earnings, state.bankPayouts]) {
        expect(load.mock.calls.filter(([token]) => token === "second-owner")).toHaveLength(2);
      }
      view.unmount();
      const afterUnmount = [state.hashcoins.mock.calls.length, state.earnings.mock.calls.length, state.bankPayouts.mock.calls.length];
      await act(async () => { await vi.advanceTimersByTimeAsync(PAYOUT_FALLBACK_POLL_MS); });
      expect([state.hashcoins.mock.calls.length, state.earnings.mock.calls.length, state.bankPayouts.mock.calls.length]).toEqual(afterUnmount);
    } finally {
      hiddenSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
