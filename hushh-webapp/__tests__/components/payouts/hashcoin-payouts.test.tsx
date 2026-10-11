import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { DocumentHashcoinPayouts } from "@/components/consent/document-hashcoins";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { ApiError } from "@/lib/services/api-client";
import { liveWallet, readyAccount, settle } from "./payout-fixtures";

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
    state.account.mockResolvedValue({ account: null, stripeMode: "test" });
    render(<DocumentHashcoinPayouts />);
    const live = await screen.findByRole("region", { name: "Hussh Coins" });
    await waitFor(() => expect(live).toHaveTextContent("911 Hussh Coins"));
    expect(live).toHaveTextContent("100 Hussh Coins = $1");
    expect(live).toHaveTextContent("$9.11");
    // Outside the sandbox, the bank card names its own test mode.
    expect(await screen.findByRole("heading", { name: "Test bank account" })).toBeVisible();
    const sandbox = screen.getByRole("region", { name: "Payout sandbox" });
    expect(sandbox).toHaveTextContent("Your real Hussh Coins stay unchanged");
    fireEvent.click(within(sandbox).getByRole("button", { name: /Test redeem/ }));
    expect(await within(sandbox).findByText("Test transfer completed")).toBeVisible();
    expect(state.redeemTest).toHaveBeenCalledExactlyOnceWith("owner-token", 911, expect.any(String));
    expect(live).toHaveTextContent("911 Hussh Coins");
    await waitFor(() => expect(within(sandbox).getByRole("button", { name: "Test redeem $0.00" })).toBeDisabled());
    expect(screen.queryByText(/bank payout paid/)).toBeNull();
  });

  it("keeps live bank setup plainly labeled and never offers test redemption in live mode", async () => {
    state.hashcoins.mockResolvedValue({ payoutMode: "live", testPayouts: false,
      live: { balanceCoins: 911, amountCents: 911, held: false },
      sandbox: { availableCoins: 911, held: false }, latestRedemption: null });
    let finishAccount!: (value: unknown) => void;
    state.account.mockImplementationOnce(() => new Promise((resolve) => { finishAccount = resolve; }));
    render(<DocumentHashcoinPayouts />);
    const bankAction = await screen.findByRole("button", { name: "Link bank" });
    expect(bankAction).toBeDisabled();
    await waitFor(() => expect(state.account).toHaveBeenCalledExactlyOnceWith("owner-token"));
    await act(async () => { finishAccount({ account: null, stripeMode: "live" }); });
    await waitFor(() => expect(bankAction).toBeEnabled());
    expect(screen.getByRole("region", { name: "Document payouts" })).toHaveTextContent("US payouts");
    expect(screen.getByRole("region", { name: "Hussh Coins" })).toHaveTextContent("911 Hussh Coins");
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test redeem|Check test redemption/ })).toBeNull();
    expect(state.redeemTest).not.toHaveBeenCalled();
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it("redeems one eligible live earning to Stripe without claiming a bank deposit", async () => {
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    let finish!: (value: unknown) => void;
    state.redeemLive.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<DocumentHashcoinPayouts />);
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    expect(screen.getByRole("region", { name: "Hussh Coins" })).toHaveTextContent("1,822 Hussh Coins");
    expect(cashOut).toHaveTextContent("911 Hussh Coins ready");
    const button = within(cashOut).getByRole("button", { name: "Cash out $9.11" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await within(cashOut).findByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(state.redeemLive).toHaveBeenCalledExactlyOnceWith("owner-token", 911, expect.any(String));
    await act(async () => { finish({ id: "11111111-1111-4111-8111-111111111111", amountCoins: 911, status: "succeeded", stripeMode: "live", reversalStatus: "none" }); });
    expect(await within(cashOut).findByText("Sent to Stripe. Bank deposit follows your payout settings.")).toBeVisible();
    expect(state.redeemTest).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
  });

  it.each([
    ["no account", { account: null }, "Link a bank below to cash out"],
    ["unfinished setup", { account: { ...readyAccount, detailsSubmitted: false, transfersEnabled: false,
      payoutsEnabled: false, ready: false, status: "onboarding_required", bankStatus: "missing" } }, "Fix your bank below to cash out"],
    ["a bank that needs attention", { account: { ...readyAccount, ready: false, status: "onboarding_required",
      bankStatus: "needs_attention" } }, "Fix your bank below to cash out"],
    ["a restricted account", { account: { ...readyAccount, payoutsEnabled: false, ready: false, status: "restricted" } },
      "Fix your bank below to cash out"],
    ["a failed bank check", null, "Bank check unavailable"],
  ])("holds a new cash-out with %s and says why", async (_, account, reason) => {
    state.hashcoins.mockResolvedValue(liveWallet);
    if (account) state.account.mockResolvedValue({ stripeMode: "live", ...account });
    else state.account.mockRejectedValue(new ApiError("private", 503));
    render(<DocumentHashcoinPayouts />);
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    expect(await within(cashOut).findByText(reason)).toBeVisible();
    const button = within(cashOut).getByRole("button", { name: "Cash out $9.11" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it.each([false, true])("native=%s: an unreadable open transfer holds a new cash-out and keeps its coins reserved", async (native) => {
    state.native = native;
    state.hashcoins.mockResolvedValue({ ...liveWallet, redeemBlocked: true });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    expect(await within(cashOut).findByText(native ? "Checking a transfer. Update the app to see it."
      : "Checking a transfer. Coins stay reserved.")).toBeVisible();
    const button = within(cashOut).getByRole("button", { name: "Cash out $9.11" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.redeemLive).not.toHaveBeenCalled();
    expect(within(cashOut).queryByRole("button", { name: "Reload" }) !== null).toBe(!native);
  });

  it("re-reads the bank when the server refuses a cash-out for bank setup", async () => {
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValueOnce({ stripeMode: "live", account: readyAccount })
      .mockResolvedValue({ stripeMode: "live", account: { ...readyAccount, payoutsEnabled: false, ready: false, status: "restricted" } });
    state.redeemLive.mockRejectedValue(new ApiError("refused", 409, { detail: { code: "PAYOUT_ACCOUNT_REQUIRED" } }));
    render(<DocumentHashcoinPayouts />);
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    const button = await within(cashOut).findByRole("button", { name: "Cash out $9.11" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await within(cashOut).findByText("Finish bank setup, then try again.")).toBeVisible();
    // The refused tap re-reads the bank, so the gate shows why instead of re-offering it.
    expect(await within(cashOut).findByText("Fix your bank below to cash out")).toBeVisible();
    expect(within(cashOut).getByRole("button", { name: "Cash out $9.11" })).toBeDisabled();
    expect(state.redeemLive).toHaveBeenCalledOnce();
  });

  it("never presents a transfer state this build can't name as a refund", async () => {
    const row = { id: "11111111-1111-4111-8111-111111111111", amountCoins: 911, status: "succeeded",
      stripeMode: "live", reversalStatus: "unrecognized" };
    state.hashcoins.mockResolvedValue({ ...liveWallet, latestRedemption: row, redemptionHistory: [row] });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    expect(await within(cashOut).findByText("Transfer status updating.")).toBeVisible();
    expect(cashOut).toHaveTextContent("Status updating");
    expect(cashOut).not.toHaveTextContent(/Refund|Recovery pending/);
  });

  it("checks an unsettled live transfer with its original key even when the bank check fails", async () => {
    const request = { id: "11111111-1111-4111-8111-111111111111", clientRequestId: "22222222-2222-4222-8222-222222222222",
      amountCoins: 911, status: "unknown", stripeMode: "live", reversalStatus: "none" };
    state.hashcoins.mockResolvedValue({ ...liveWallet, latestRedemption: request,
      live: { ...liveWallet.live, reservedCoins: 911, availableCoins: 911, nextRedeemCoins: 0 } });
    state.account.mockRejectedValue(new ApiError("private", 503));
    state.redeemLive.mockResolvedValue(request);
    render(<DocumentHashcoinPayouts />);
    await screen.findByText("Bank status unavailable");
    fireEvent.click(within(screen.getByRole("region", { name: "Cash out Hussh Coins" })).getByRole("button", { name: "Check transfer" }));
    await waitFor(() => expect(state.redeemLive).toHaveBeenCalledExactlyOnceWith("owner-token", 911, request.clientRequestId));
  });

  it("shows a refunded live transfer as reversed, not bank paid", async () => {
    const reversed = { id: "11111111-1111-4111-8111-111111111111", amountCoins: 911,
      status: "succeeded", stripeMode: "live", reversalStatus: "reversed" };
    state.hashcoins.mockResolvedValue({ payoutMode: "live", testPayouts: false, liveRedemptionEnabled: true,
      live: { balanceCoins: -911, reservedCoins: 0, availableCoins: 0, amountCents: -911, held: true, nextRedeemCoins: 0 },
      sandbox: { balanceCoins: 0, reservedCoins: 0, availableCoins: 0, amountCents: 0, held: false },
      latestRedemption: null, redemptionHistory: [reversed] });
    render(<DocumentHashcoinPayouts />);
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    expect(cashOut).toHaveTextContent("Transfer reversed");
    expect(cashOut).not.toHaveTextContent("Sent to Stripe");
    expect(within(cashOut).getByRole("button", { name: "Cash out" })).toBeDisabled();
    expect(cashOut).not.toHaveTextContent("$0.00");
  });

  it.each([
    { payoutMode: undefined, testPayouts: true },
    { payoutMode: "unknown", testPayouts: true },
    { payoutMode: "test", testPayouts: false },
    { payoutMode: "test", testPayouts: undefined },
  ])("offers no redemption without confirmed sandbox or live mode: %j", async (mode) => {
    state.hashcoins.mockResolvedValue({ ...mode, liveRedemptionEnabled: true,
      live: { balanceCoins: 911, amountCents: 911, held: false, nextRedeemCoins: 911 },
      sandbox: { availableCoins: 911, held: false }, latestRedemption: null });
    render(<DocumentHashcoinPayouts />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Hussh Coins" })).toHaveTextContent("911 Hussh Coins"));
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Cash out Hussh Coins" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test redeem|Check test redemption|Cash out|Check transfer/ })).toBeNull();
    expect(state.redeemTest).not.toHaveBeenCalled();
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it("shows the bank without waiting on Hussh Coins and keeps the last good balance when a refresh fails", async () => {
    let fail!: (cause: unknown) => void;
    state.hashcoins.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    expect(await screen.findByRole("heading", { name: "Bank account" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Bank deposits" })).toBeVisible();
    expect(state.account).toHaveBeenCalledOnce();
    expect(state.bankPayouts).toHaveBeenCalledOnce();
    await act(async () => { fail(new Error("Unavailable")); });
    expect(await screen.findByText("Couldn't load Hussh Coins.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage bank" })).toBeEnabled();

    state.hashcoins.mockResolvedValueOnce(liveWallet).mockRejectedValue(new Error("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry balance" }));
    const cashOut = await screen.findByRole("region", { name: "Cash out Hussh Coins" });
    await waitFor(() => expect(within(cashOut).getByRole("button", { name: "Cash out $9.11" })).toBeEnabled());
    act(() => { window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT)); });
    expect(await screen.findByText("Couldn't refresh.")).toBeVisible();
    expect(screen.queryByText("Couldn't load Hussh Coins.")).toBeNull();
    expect(screen.getByRole("region", { name: "Hussh Coins" })).toHaveTextContent("1,822 Hussh Coins");
    expect(within(cashOut).getByRole("button", { name: "Cash out $9.11" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it("keeps bank setup reachable when this build can't read Hussh Coins", async () => {
    const reload = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { assign: vi.fn(), replace: vi.fn(), reload } });
    try {
      state.query = "documentPayouts=refresh";
      state.hashcoins.mockRejectedValue(Object.assign(new Error("Invalid Hussh Coins wallet"), { name: "PayoutContractError" }));
      const view = render(<DocumentHashcoinPayouts />);
      expect(await screen.findByText("Couldn't load Hussh Coins.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Retry balance" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalledOnce();
      // The one bank card still takes Stripe's return.
      await waitFor(() => expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token"));
      // A native build bundles its reader, so only an update helps.
      state.native = true;
      view.rerender(<DocumentHashcoinPayouts />);
      expect(screen.getByText("Couldn't load Hussh Coins. Update the app.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
      expect(state.onboard).toHaveBeenCalledOnce();
    } finally { Object.defineProperty(window, "location", { configurable: true, value: realLocation }); }
  });

  it("reads each payout source once on open and once per return to the tab", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const loads = () => [state.hashcoins, state.account, state.bankPayouts, state.earnings].map((load) => load.mock.calls.length);
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    // A return during the first reads queues nothing behind them.
    act(() => { window.dispatchEvent(new Event("focus")); });
    await screen.findByText("Bank linked");
    await settle();
    // Readiness refreshes only the transactions that depend on it.
    expect(loads()).toEqual([1, 1, 1, 2]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(loads()).toEqual([2, 2, 2, 3]);
    now += 1_001;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(loads()).toEqual([3, 3, 3, 4]);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Check test redemption" })).toBeEnabled());
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
});
