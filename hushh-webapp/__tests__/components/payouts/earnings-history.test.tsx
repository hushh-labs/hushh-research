import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

import { DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
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

  it("shows actual transaction fees, streams updates, and keeps transfers separate from bank deposits", async () => {
    const transaction = {
      requestId: "11111111-1111-4111-8111-111111111111", description: "March statements",
      status: "awaiting_fee", grossAmountCents: 1000, refundAmountCents: 500, platformFeeCents: 15,
      processingFeeCents: null, netAmountCents: null, reversedAmountCents: null,
      createdAt: "2026-10-10T12:00:00Z", transferredAt: null, expectedFiles: 2, confirmedFiles: 1,
    };
    state.earnings.mockResolvedValueOnce({ currency: "USD", transactions: [transaction], nextCursor: null })
      .mockResolvedValue({ currency: "USD", transactions: [{ ...transaction, status: "transferred", processingFeeCents: 59, netAmountCents: 426 }], nextCursor: null });
    render(<DocumentPayoutAccountCard />);
    const title = await screen.findByText("March statements");
    const details = title.closest("details")!;
    expect(details.querySelector("summary")).toHaveTextContent("Calculating");
    fireEvent.click(details.querySelector("summary")!);
    expect(within(details).getByText("Hushh (3%)")).toBeInTheDocument();
    expect(within(details).getByText("$0.15")).toBeInTheDocument();
    expect(within(details).getByText("$5.00")).toBeInTheDocument();
    act(() => {
      dispatchPayoutStateChanged({ kinds: ["earnings", "wallet"], requestIds: [transaction.requestId], source: "sse" });
    });
    expect(await screen.findByText(/Transferred to Stripe/)).toBeVisible();
    expect(state.account).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Stripe transfers and bank deposits update separately.")).toBeVisible();
    expect(screen.queryByText(/bank payout paid/)).toBeNull();
    expect(details.querySelector("summary")).toHaveTextContent("$4.26");
    expect(within(details).getByText("$0.59")).toBeInTheDocument();
  });

  it.each([
    ["test", "awaiting_account", "Test payment", "No bank deposit"],
    ["test", "due", "Test payment", "No bank deposit"],
    ["test", "transferred", "Test payment", "No bank deposit"],
    ["legacy", "awaiting_account", "Payment mode unconfirmed", "Under review"],
  ])("keeps %s %s history from promising a live payout", async (stripeMode, status, modeLabel, statusLabel) => {
    state.account.mockResolvedValue({ stripeMode: "live", account: null });
    state.earnings.mockResolvedValue({ stripeMode: "live", currency: "USD", transactions: [{
      requestId: "11111111-1111-4111-8111-111111111111", description: "Earlier documents", stripeMode,
      status, grossAmountCents: 1000, refundAmountCents: 0, platformFeeCents: 30,
      processingFeeCents: 59, netAmountCents: 911, reversedAmountCents: 0,
      createdAt: "2026-10-10T12:00:00Z", transferredAt: "2026-10-10T12:00:00Z", expectedFiles: 1, confirmedFiles: 1,
    }], nextCursor: null });
    render(<DocumentPayoutAccountCard />);
    const title = await screen.findByText("Earlier documents");
    expect(title.closest("summary")).toHaveTextContent(modeLabel);
    expect(title.closest("summary")).toHaveTextContent(statusLabel);
    expect(title.closest("summary")).not.toHaveTextContent(/Link bank to receive|Transfer pending/);
    expect(title.closest("summary")).toHaveTextContent("$9.11");
    expect(screen.queryByText(/bank payout paid/)).toBeNull();
  });

  it("loads the next transaction page and clears history on an account switch", async () => {
    const make = (requestId: string, description: string) => ({
      requestId, description, status: "awaiting_delivery", grossAmountCents: 1000,
      refundAmountCents: null, platformFeeCents: null, processingFeeCents: null, netAmountCents: null,
      reversedAmountCents: null, createdAt: "2026-10-10T12:00:00Z", transferredAt: null,
      expectedFiles: null, confirmedFiles: null,
    });
    const first = make("11111111-1111-4111-8111-111111111111", "First request");
    const second = make("22222222-2222-4222-8222-222222222222", "Older request");
    state.earnings.mockResolvedValueOnce({ currency: "USD", transactions: [first], nextCursor: first.requestId })
      .mockResolvedValueOnce({ currency: "USD", transactions: [second], nextCursor: null });
    const view = render(<DocumentPayoutAccountCard />);
    fireEvent.click(await screen.findByRole("button", { name: "More transactions" }));
    expect(await screen.findByText("Older request")).toBeVisible();
    expect(state.earnings).toHaveBeenLastCalledWith("owner-token", first.requestId);
    expect(screen.getByText("First request")).toBeVisible();
    state.token = "new-owner";
    state.epoch++;
    view.rerender(<DocumentPayoutAccountCard />);
    expect(screen.queryByText("First request")).toBeNull();
    expect(screen.queryByText("Older request")).toBeNull();
    expect(await screen.findByText("No earnings yet.")).toBeVisible();
  });
});
