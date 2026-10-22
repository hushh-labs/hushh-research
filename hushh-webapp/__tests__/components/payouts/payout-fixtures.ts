import type { Mock } from "vitest";
import { act } from "@testing-library/react";

// Shared payout fixtures. State and vi.mock stay in each test file, where vitest hoists them.
export const liveWallet = {
  coinName: "Hussh Coins", coinsPerDollar: 100, currency: "USD", payoutMode: "live", testPayouts: false,
  liveRedemptionEnabled: true, maxRedeemCoins: 50000,
  live: { balanceCoins: 1822, reservedCoins: 0, availableCoins: 1822, amountCents: 1822, held: false, nextRedeemCoins: 911 },
  sandbox: { balanceCoins: 911, reservedCoins: 0, availableCoins: 911, amountCents: 911, held: false },
  latestRedemption: null, redemptionHistory: [],
};
export const readyAccount = {
  detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true,
  ready: true, status: "ready", bankStatus: "linked", canManageBank: true,
};
// Lets the last read's effects run before asserting that nothing else happened.
export const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

export const noBalance = {
  stripeMode: "live", currency: "USD", accountLinked: false, inStripeCents: 0, availableCents: 0, pendingCents: 0,
  nextAvailableOn: null, nextAvailableCents: null, asOf: "2026-10-11T10:00:00.000Z", stale: false,
};
// Stripe paused payouts over verification; the bank itself is linked and fine.
export const pausedForVerification = { ...readyAccount, payoutsEnabled: false, ready: false, status: "restricted",
  bank: { name: "Example Bank", last4: "6789", status: "verified" } };
export const verificationNeeded = { state: "past_due", deadline: null, items: ["identity"], eventuallyDue: false, hasErrors: false,
  disabledReason: "requirements_past_due" };
export const inStripe = {
  ...noBalance, accountLinked: true, inStripeCents: 155, availableCents: 100, pendingCents: 55,
  nextAvailableOn: "2026-10-14T00:00:00.000Z", nextAvailableCents: 55,
};

type PayoutTestState = {
  query: string; pathname: string; token: string | null; epoch: number; native: boolean;
  router: { replace: Mock }; hosted: Mock; nativeOpen?: Mock;
  popup: { close: Mock; location: { replace: Mock } };
  account: Mock; onboard: Mock; manage: Mock; earnings: Mock; bankPayouts: Mock;
  hashcoins: Mock; redeemTest: Mock; redeemLive: Mock; balance?: Mock;
};

/** Reset all provider and session fixtures consistently; callers select readiness explicitly. */
export function resetPayoutState(state: PayoutTestState) {
  state.query = "";
  state.pathname = "/one/profile/payouts";
  state.router.replace.mockReset();
  window.sessionStorage.clear();
  state.token = "owner-token";
  state.epoch = 1;
  state.native = false;
  state.hosted.mockReset().mockResolvedValue(undefined);
  state.nativeOpen?.mockReset().mockResolvedValue(undefined);
  state.popup.close.mockReset();
  state.popup.location.replace.mockReset();
  state.account.mockReset().mockResolvedValue({ account: null });
  state.manage.mockReset().mockResolvedValue({ url: "https://example.invalid/unsafe" });
  state.onboard.mockReset().mockResolvedValue({ url: "https://example.invalid/unsafe" });
  state.earnings.mockReset().mockResolvedValue({ currency: "USD", transactions: [], nextCursor: null });
  state.bankPayouts.mockReset().mockResolvedValue({ currency: "USD", payouts: [] });
  state.balance?.mockReset().mockResolvedValue(noBalance);
  state.hashcoins.mockReset().mockResolvedValue({
    ...liveWallet, payoutMode: "test", testPayouts: true, liveRedemptionEnabled: false,
    live: liveWallet.sandbox, sandbox: liveWallet.sandbox,
  });
  state.redeemTest.mockReset();
  state.redeemLive.mockReset();
}
