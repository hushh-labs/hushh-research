import { act, render, screen } from "@testing-library/react";
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

import { DocumentBankPayoutStatusCard } from "@/components/consent/document-payout-account";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";

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

  it("shows only a signed aggregate paid bank payout as paid", async () => {
    state.bankPayouts.mockResolvedValue({ currency: "USD", payouts: [{
      id: "po_private", amountCents: 911, status: "paid", expectedArrivalAt: null, failureCode: null,
    }, { id: "po_older", amountCents: 500, status: "in_transit", expectedArrivalAt: "2026-10-12T00:00:00Z", failureCode: null }] });
    render(<DocumentBankPayoutStatusCard />);
    const card = await screen.findByLabelText("Bank payout status");
    expect(card).toHaveTextContent("$9.11 bank payout paid.");
    expect(card).toHaveTextContent("$5.00 bank payout on its way.");
    expect(card).toHaveTextContent("Expected");
    expect(card).toHaveTextContent("may combine earnings from multiple requests");
    expect(card).not.toHaveTextContent("po_private");
    expect(state.bankPayouts).toHaveBeenCalledWith("owner-token");
  });

  it("shows a failed bank payout without leaking the provider failure code", async () => {
    state.bankPayouts.mockResolvedValue({ currency: "USD", payouts: [{
      id: "po_private", amountCents: 911, status: "failed", expectedArrivalAt: null,
      failureCode: "account_closed_private",
    }] });
    render(<DocumentBankPayoutStatusCard />);
    const card = await screen.findByLabelText("Bank payout status");
    expect(card).toHaveTextContent("bank payout failed. Check your linked bank details.");
    expect(card).not.toHaveTextContent("account_closed_private");
  });

  it("refreshes the separate Feed bank cue after a new payout event", async () => {
    const item = { id: "po_1", amountCents: 911, expectedArrivalAt: null, failureCode: null };
    state.bankPayouts.mockResolvedValueOnce({ currency: "USD", payouts: [{ ...item, status: "in_transit" }] })
      .mockResolvedValueOnce({ currency: "USD", payouts: [{ ...item, status: "paid" }] });
    render(<DocumentBankPayoutStatusCard compact refreshOnFeedChange />);
    expect(await screen.findByText("$9.11 bank payout on its way.")).toBeVisible();
    // A request's earning changing is not a bank deposit: the cue keeps its read.
    act(() => {
      dispatchPayoutStateChanged({ kinds: ["earnings"], requestIds: ["11111111-1111-4111-8111-111111111111"], source: "sse" });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(state.bankPayouts).toHaveBeenCalledTimes(1);
    act(() => { dispatchPayoutStateChanged({ kinds: ["bank_payouts"], source: "sse" }); });
    expect(await screen.findByText("$9.11 bank payout paid.")).toBeVisible();
    expect(state.bankPayouts).toHaveBeenCalledTimes(2);
  });

  it("hides the prior owner's bank status during an account switch", async () => {
    let finishSecond!: (value: { currency: "USD"; payouts: [] }) => void;
    state.bankPayouts.mockImplementation((token: string) => token === "owner-token"
      ? Promise.resolve({ currency: "USD", payouts: [{
          id: "po_1", amountCents: 911, status: "paid", expectedArrivalAt: null, failureCode: null,
        }] })
      : new Promise((resolve) => { finishSecond = resolve; }));
    const view = render(<DocumentBankPayoutStatusCard />);
    await screen.findByText("$9.11 bank payout paid.");
    state.token = "another-owner";
    view.rerender(<DocumentBankPayoutStatusCard />);
    expect(screen.queryByText("$9.11 bank payout paid.")).toBeNull();
    finishSecond({ currency: "USD", payouts: [] });
    expect(await screen.findByText("No bank deposits yet.")).toBeVisible();
  });
});
