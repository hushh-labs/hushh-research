import { useEffect } from "react";
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

import { PAYOUT_FALLBACK_POLL_MS, PAYOUT_READY_SOURCE, usePayoutSnapshot } from "@/components/consent/document-payout-account";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";

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
    // Polls ride the shared idle clock, which wakes on 45 s boundaries: mount 5 s past one.
    vi.setSystemTime(Date.UTC(2026, 9, 11, 10) + 5_000);
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

  it("shares one store read per payout loader and follows only that resource's payout changes", async () => {
    vi.useFakeTimers();
    // The compact bank card (request review, price sheet), the Feed's bank cue and earnings.
    function CompactReaders() {
      usePayoutSnapshot(state.account, { bankOnly: true, ignoreReadyEvent: true });
      usePayoutSnapshot(state.account, { bankOnly: true, ignoreReadyEvent: true });
      usePayoutSnapshot(state.bankPayouts, { bankOnly: true, refreshOnFeedChange: true, ignoreReadyEvent: true });
      usePayoutSnapshot(state.earnings);
      return null;
    }
    const reads = () => [state.account, state.bankPayouts, state.earnings].map((load) => load.mock.calls.length);
    const settleWindow = () => act(async () => { await vi.advanceTimersByTimeAsync(200); });
    try {
      render(<CompactReaders />);
      await act(async () => { await Promise.resolve(); });
      expect(reads()).toEqual([1, 1, 1]);

      // An earning credit rereads earnings only: no Stripe account read, no deposit read.
      act(() => { dispatchPayoutStateChanged({ kinds: ["earnings", "wallet"], source: "sse" }); });
      await settleWindow();
      expect(reads()).toEqual([1, 1, 2]);

      // Feed frames, consent decisions and the ignored bank-ready announcement read nothing.
      act(() => {
        dispatchConsentStateChanged({ source: "sse_document_feed", reconcile: true });
        dispatchConsentStateChanged({ source: PAYOUT_READY_SOURCE });
      });
      await settleWindow();
      expect(reads()).toEqual([1, 1, 2]);

      act(() => {
        dispatchPayoutStateChanged({ kinds: ["bank_payouts"], source: "sse" });
        dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" });
      });
      await settleWindow();
      expect(reads()).toEqual([2, 2, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops calling a read current once its vault session ends, before any re-render", async () => {
    const seen: Array<{ isCurrent: () => boolean }> = [];
    function Reader() {
      const snapshot = usePayoutSnapshot(state.earnings);
      useEffect(() => { seen.push(snapshot); });
      return null;
    }
    render(<Reader />);
    await act(async () => { await Promise.resolve(); });
    const reader = seen.at(-1)!;
    expect(reader.isCurrent()).toBe(true);
    // A lock or a new vault session lands while a page request is still out.
    state.epoch++;
    expect(reader.isCurrent()).toBe(false);
  });
});
