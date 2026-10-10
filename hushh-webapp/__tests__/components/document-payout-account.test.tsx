import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: "",
  token: "owner-token" as string | null,
  account: vi.fn(),
  onboard: vi.fn(),
  bankPayouts: vi.fn(),
  manage: vi.fn(),
  earnings: vi.fn(),
  hashcoins: vi.fn(),
  redeemTest: vi.fn(),
  epoch: 1,
}));

vi.mock("next/navigation", () => ({
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
  DocumentPayoutService: { account: state.account, onboard: state.onboard, bankPayouts: state.bankPayouts, manage: state.manage, earnings: state.earnings, hashcoins: state.hashcoins, redeemTest: state.redeemTest },
}));

import { DocumentBankPayoutStatusCard, DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
import { DocumentHashcoinPayouts } from "@/components/consent/document-hashcoins";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { ApiError } from "@/lib/services/api-client";

describe("document payout account", () => {
  beforeEach(() => {
    state.query = "";
    state.epoch = 1;
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
  });

  it("shows real Hussh Coins above a distinct sandbox and never calls a test transfer a real deposit", async () => {
    const redeemed = { id: "11111111-1111-4111-8111-111111111111", amountCoins: 911, status: "succeeded", stripeMode: "test" };
    state.redeemTest.mockImplementationOnce(async () => {
      state.hashcoins.mockResolvedValue({
        payoutMode: "test", testPayouts: true,
        live: { balanceCoins: 911, amountCents: 911, held: false },
        sandbox: { balanceCoins: 0, reservedCoins: 0, availableCoins: 0, held: false }, latestRedemption: null,
        redemptionHistory: [redeemed],
      });
      return redeemed;
    });
    render(<DocumentHashcoinPayouts />);
    const live = await screen.findByRole("region", { name: "Hussh Coins" });
    await waitFor(() => expect(live).toHaveTextContent("911 Hussh Coins"));
    expect(live).toHaveTextContent("100 Hussh Coins = $1");
    expect(live).toHaveTextContent("$9.11");
    const sandbox = screen.getByRole("region", { name: "Payout sandbox" });
    expect(sandbox).toHaveTextContent("Your real Hussh Coins stay unchanged");
    fireEvent.click(within(sandbox).getByRole("button", { name: /Test redeem/ }));
    expect(await within(sandbox).findByText("Test transfer completed")).toBeVisible();
    expect(state.redeemTest).toHaveBeenCalledExactlyOnceWith("owner-token", 911, expect.any(String));
    expect(live).toHaveTextContent("911 Hussh Coins");
    expect(within(sandbox).getByRole("button", { name: "Test redeem $0.00" })).toBeDisabled();
    expect(screen.queryByText(/bank payout paid/)).toBeNull();
  });

  it("keeps live bank setup plainly labeled and never offers test redemption in live mode", async () => {
    state.hashcoins.mockResolvedValue({ payoutMode: "live", testPayouts: false,
      live: { balanceCoins: 911, amountCents: 911, held: false },
      sandbox: { availableCoins: 911, held: false }, latestRedemption: null });
    state.account.mockResolvedValue({ account: null, stripeMode: "live" });
    render(<DocumentHashcoinPayouts />);
    expect(await screen.findByRole("button", { name: "Link bank" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "Document payouts" })).toHaveTextContent("US payouts");
    expect(screen.getByRole("region", { name: "Hussh Coins" })).toHaveTextContent("911 Hussh Coins");
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test redeem|Check test redemption/ })).toBeNull();
    expect(state.redeemTest).not.toHaveBeenCalled();
  });

  it.each([
    { payoutMode: undefined, testPayouts: true },
    { payoutMode: "unknown", testPayouts: true },
    { payoutMode: "test", testPayouts: false },
    { payoutMode: "test", testPayouts: undefined },
  ])("hides bank and redemption controls without confirmed sandbox or live mode: %j", async (mode) => {
    state.hashcoins.mockResolvedValue({ ...mode,
      live: { balanceCoins: 911, amountCents: 911, held: false },
      sandbox: { availableCoins: 911, held: false }, latestRedemption: null });
    render(<DocumentHashcoinPayouts />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Hussh Coins" })).toHaveTextContent("911 Hussh Coins"));
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Document payouts" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test redeem|Check test redemption|Link bank/ })).toBeNull();
    expect(state.account).not.toHaveBeenCalled();
    expect(state.bankPayouts).not.toHaveBeenCalled();
    expect(state.redeemTest).not.toHaveBeenCalled();
  });

  it("keeps bank and redemption controls closed during loading and after a failed mode refresh", async () => {
    let finish!: (value: unknown) => void;
    state.hashcoins.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<DocumentHashcoinPayouts />);
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(state.account).not.toHaveBeenCalled();
    await act(async () => { finish({ payoutMode: "test", testPayouts: true,
      live: { balanceCoins: 911, amountCents: 911, held: false },
      sandbox: { availableCoins: 911, held: false }, latestRedemption: null }); });
    expect(await screen.findByRole("button", { name: /Test redeem/ })).toBeEnabled();
    state.hashcoins.mockRejectedValue(new Error("Unavailable"));
    fireEvent(window, new CustomEvent(CONSENT_STATE_CHANGED_EVENT));
    expect(await screen.findByText("Couldn't load Hussh Coins.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Document payouts" })).toBeNull();
    expect(state.redeemTest).not.toHaveBeenCalled();
  });

  it("caps each test redemption and shows the amount before submitting", async () => {
    state.hashcoins.mockResolvedValue({ payoutMode: "test", testPayouts: true, live: { balanceCoins: 70000, amountCents: 70000, held: false },
      sandbox: { balanceCoins: 70000, availableCoins: 70000, held: false }, maxRedeemCoins: 50000, latestRedemption: null });
    state.redeemTest.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", amountCoins: 50000, status: "unknown", stripeMode: "test" });
    render(<DocumentHashcoinPayouts />);
    fireEvent.click(await screen.findByRole("button", { name: "Test redeem $500.00" }));
    await waitFor(() => expect(state.redeemTest).toHaveBeenCalledExactlyOnceWith("owner-token", 50000, expect.any(String)));
  });

  it("recovers an unknown redemption with its original key after reopening, without reserving again", async () => {
    const request = { id: "11111111-1111-4111-8111-111111111111", clientRequestId: "22222222-2222-4222-8222-222222222222", amountCoins: 911, status: "unknown", stripeMode: "test" };
    state.hashcoins.mockResolvedValue({
      payoutMode: "test", testPayouts: true,
      live: { balanceCoins: 911, amountCents: 911, held: false },
      sandbox: { balanceCoins: 911, reservedCoins: 911, availableCoins: 0, held: false }, latestRedemption: request,
    });
    let finish!: (value: unknown) => void;
    state.redeemTest.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<DocumentHashcoinPayouts />);
    const button = await screen.findByRole("button", { name: "Check test redemption" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(state.redeemTest).toHaveBeenCalledExactlyOnceWith("owner-token", 911, request.clientRequestId));
    await act(async () => { finish(request); });
    expect(await screen.findByRole("button", { name: "Check test redemption" })).toBeEnabled();
    expect(screen.getByText("Checking test redemption. Your test balance is reserved.")).toBeVisible();
  });

  it("drops stale Hashcoin balances and redemption results when the owner changes", async () => {
    let finish!: (value: unknown) => void;
    state.redeemTest.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<DocumentHashcoinPayouts />);
    fireEvent.click(await screen.findByRole("button", { name: /Test redeem/ }));
    await waitFor(() => expect(state.redeemTest).toHaveBeenCalledOnce());
    state.token = "second-owner";
    state.epoch++;
    state.hashcoins.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(<DocumentHashcoinPayouts />);
    expect(screen.queryByText("911 Hussh Coins")).toBeNull();
    await act(async () => { finish({ id: "11111111-1111-4111-8111-111111111111", amountCoins: 911, status: "succeeded", stripeMode: "test" }); });
    expect(screen.queryByText("Sent to your test Stripe balance. No real money moved.")).toBeNull();
  });

  it("shows Connect readiness without claiming a bank deposit", async () => {
    state.query = "documentPayouts=done";
    state.account.mockResolvedValue({
      account: {
        detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true,
        ready: true, status: "ready",
      },
    });
    render(<DocumentPayoutAccountCard handleReturn />);
    await waitFor(() => expect(screen.getByText("Bank linked")).toBeVisible());
    expect(screen.queryByRole("button", { name: /payout setup/i })).toBeNull();
    expect(screen.getByLabelText("Document payouts")).not.toHaveTextContent(/deposited|paid to bank/i);
  });

  it("tries one fresh Connect link after Stripe returns an expired one", async () => {
    state.query = "documentPayouts=refresh";
    const { rerender } = render(<DocumentPayoutAccountCard handleReturn />);
    await waitFor(() => expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open bank setup. Try again.");
    rerender(<DocumentPayoutAccountCard handleReturn />);
    expect(state.onboard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Link bank" }));
    await waitFor(() => expect(state.onboard).toHaveBeenCalledTimes(2));
  });

  it("explains platform activation failures and retries secure bank setup", async () => {
    const assign = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    try {
      state.onboard.mockRejectedValueOnce(new ApiError("Private provider details", 503, {
        detail: { code: "PAYOUT_PLATFORM_SETUP_REQUIRED", message: "Private provider details" },
      })).mockResolvedValueOnce({ url: "https://connect.stripe.com/setup/safe_link" });
      render(<DocumentPayoutAccountCard compact />);
      fireEvent.click(await screen.findByRole("button", { name: "Link bank" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Bank setup is unavailable. Hushh needs to activate payouts.");
      expect(screen.queryByText(/Private provider details/)).toBeNull();
      expect(assign).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Link bank" }));
      await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("https://connect.stripe.com/setup/safe_link"));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally { Object.defineProperty(window, "location", { configurable: true, value: realLocation }); }
  });

  it("retries an unknown account state without calling it an unlinked bank", async () => {
    state.account.mockRejectedValueOnce(new ApiError("private", 503)).mockResolvedValueOnce({ account: null });
    render(<DocumentPayoutAccountCard compact />);
    const retry = await screen.findByRole("button", { name: "Retry bank check" });
    expect(retry).toBeEnabled();
    expect(screen.getByText("Bank status unavailable")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Link bank" })).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Link bank" })).toBeEnabled();
    expect(state.account).toHaveBeenCalledTimes(2);
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("keeps verified bank management available during refresh failure and accepts Stripe Express links", async () => {
    const assign = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    try {
      state.account.mockResolvedValueOnce({ stripeMode: "live", account: {
        detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true, ready: true, status: "ready",
        canManageBank: true, bankStatus: "linked", bank: { name: "Example Bank", last4: "6789", status: "verified" },
      } }).mockRejectedValueOnce(new ApiError("private", 503));
      state.manage.mockResolvedValueOnce({ url: "https://stripe.com/express/acct_owner/login_token" });
      render(<DocumentPayoutAccountCard />);
      await screen.findByText("Bank linked");
      act(() => window.dispatchEvent(new Event("focus")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check your bank. Try again.");
      expect(screen.queryByText("Bank linked")).toBeNull();
      const manage = screen.getByRole("button", { name: "Manage bank" });
      expect(manage).toBeEnabled();
      fireEvent.click(manage);
      await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("https://stripe.com/express/acct_owner/login_token"));
      expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token");
      expect(state.onboard).not.toHaveBeenCalled();
    } finally { Object.defineProperty(window, "location", { configurable: true, value: realLocation }); }
  });

  it("clears one owner's readiness while another owner account loads", async () => {
    let resolveSecond!: (value: { account: null }) => void;
    state.account.mockImplementation((token: string) => token === "owner-token"
      ? Promise.resolve({ account: {
          detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true,
          ready: true, status: "ready",
        } })
      : new Promise((resolve) => { resolveSecond = resolve; }));
    const { rerender } = render(<DocumentPayoutAccountCard />);
    await screen.findByText("Bank linked");
    state.token = "second-owner";
    rerender(<DocumentPayoutAccountCard />);
    expect(screen.queryByText("Bank linked")).toBeNull();
    expect(screen.getByText("Checking…")).toBeVisible();
    resolveSecond({ account: null });
    await screen.findByRole("button", { name: "Link bank" });
  });

  it("refetches after Stripe return and announces actual readiness once without a loop", async () => {
    const { rerender } = render(<DocumentPayoutAccountCard handleReturn compact />);
    await screen.findByRole("button", { name: "Link bank" });
    const events = vi.fn();
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, events);
    try {
      state.query = "documentPayouts=done";
      state.account.mockResolvedValueOnce({ account: {
        detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true, ready: true, status: "ready",
      } });
      rerender(<DocumentPayoutAccountCard handleReturn compact />);
      expect(await screen.findByText("Bank linked")).toBeVisible();
      await waitFor(() => expect(events).toHaveBeenCalledOnce());
      expect(state.account).toHaveBeenCalledTimes(2);
      expect(state.onboard).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Manage bank" }));
      await waitFor(() => expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token"));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open bank setup");
    } finally { window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, events); }
  });

  it("drops an old owner's onboarding result after an account switch", async () => {
    let finish!: (value: { url: string }) => void;
    state.onboard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<DocumentPayoutAccountCard compact />);
    fireEvent.click(await screen.findByRole("button", { name: "Link bank" }));
    await waitFor(() => expect(state.onboard).toHaveBeenCalledOnce());
    state.token = "new-owner";
    state.epoch++;
    view.rerender(<DocumentPayoutAccountCard compact />);
    await screen.findByRole("button", { name: "Link bank" });
    await act(async () => { finish({ url: "https://unsafe.invalid/old-account" }); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Link bank" })).toBeEnabled();
  });

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
    act(() => window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT, {
      detail: { source: "sse_document_feed", requestId: transaction.requestId },
    })));
    expect(await screen.findByText(/Transferred to Stripe/)).toBeVisible();
    expect(state.account).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Stripe transfers and bank deposits update separately.")).toBeVisible();
    expect(screen.queryByText(/bank payout paid/)).toBeNull();
    expect(details.querySelector("summary")).toHaveTextContent("$4.26");
    expect(within(details).getByText("$0.59")).toBeInTheDocument();
  });

  it("keeps bank recovery available when Stripe pauses payouts and refreshes changed bank details", async () => {
    const account = { detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: false,
      ready: false, status: "restricted", canManageBank: true, bankStatus: "needs_attention",
      bank: { name: "Example Bank", last4: "6789", status: "errored" } };
    state.account.mockResolvedValueOnce({ stripeMode: "live", account })
      .mockResolvedValueOnce({ stripeMode: "live", account: { ...account, bankStatus: "missing", bank: null } });
    render(<DocumentPayoutAccountCard compact />);
    const action = await screen.findByRole("button", { name: "Manage bank" });
    expect(action).toBeEnabled();
    expect(screen.getByText("Update your bank")).toBeVisible();
    fireEvent.click(action);
    await waitFor(() => expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token"));
    act(() => window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT, {
      detail: { source: "sse_document_feed", reconcile: true },
    })));
    expect(await screen.findByText("Bank needed")).toBeVisible();
    expect(screen.queryByText("Bank linked")).toBeNull();
    expect(screen.getByRole("button", { name: "Manage bank" })).toBeEnabled();
  });

  it("retries an unavailable bank check without sending verified owners through identity setup", async () => {
    const account = { detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true,
      ready: false, status: "onboarding_required", canManageBank: true, bankStatus: "unavailable", bank: null };
    state.account.mockResolvedValueOnce({ stripeMode: "live", account })
      .mockResolvedValueOnce({ stripeMode: "live", account: { ...account, ready: true, status: "ready",
        bankStatus: "linked", bank: { name: "Example Bank", last4: "6789", status: "verified" } } });
    render(<DocumentPayoutAccountCard compact />);
    expect(await screen.findByText("Bank check unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage bank" })).toBeEnabled();
    expect(screen.queryByText("Verify details")).toBeNull();
    expect(screen.queryByText("Bank linked")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Bank linked")).toBeVisible();
    expect(screen.getByText("Example Bank •••• 6789")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(state.account).toHaveBeenCalledTimes(2);
    expect(state.onboard).not.toHaveBeenCalled();
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
    window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT, {
      detail: { source: "sse_document_feed", requestId: "document_share_request:1" },
    }));
    expect(state.bankPayouts).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT, {
      detail: { source: "sse_document_feed", reconcile: true },
    }));
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
