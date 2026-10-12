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
