import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { DocumentBankPayoutStatusCard, DocumentPayoutAccountCard, PAYOUT_FALLBACK_POLL_MS, usePayoutSnapshot } from "@/components/consent/document-payout-account";
import { DocumentHashcoinPayouts } from "@/components/consent/document-hashcoins";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { ApiError } from "@/lib/services/api-client";

function PayoutPollHarness() {
  usePayoutSnapshot(state.hashcoins);
  usePayoutSnapshot(state.earnings);
  usePayoutSnapshot(state.bankPayouts, { bankOnly: true });
  return null;
}

const liveWallet = {
  coinName: "Hussh Coins", coinsPerDollar: 100, currency: "USD", payoutMode: "live", testPayouts: false,
  liveRedemptionEnabled: true, maxRedeemCoins: 50000,
  live: { balanceCoins: 1822, reservedCoins: 0, availableCoins: 1822, amountCents: 1822, held: false, nextRedeemCoins: 911 },
  sandbox: { balanceCoins: 911, reservedCoins: 0, availableCoins: 911, amountCents: 911, held: false },
  latestRedemption: null, redemptionHistory: [],
};
const readyAccount = {
  detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true,
  ready: true, status: "ready", bankStatus: "linked", canManageBank: true,
};
// Lets the last read's effects run before asserting that nothing else happened.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

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

  describe("Stripe Express bank settings", () => {
    const express = "https://stripe.com/express/acct_owner/login_token";
    const assign = vi.fn();
    const realLocation = window.location;
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    beforeEach(() => {
      assign.mockReset();
      tab.opener = {};
      tab.location.replace.mockReset();
      tab.close.mockReset();
      Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    });
    afterEach(() => { Object.defineProperty(window, "location", { configurable: true, value: realLocation }); });

    it("keeps verified bank management available during refresh failure and opens Express in a new tab", async () => {
      const open = vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
      state.account.mockResolvedValueOnce({ stripeMode: "live", account: { ...readyAccount,
        bank: { name: "Example Bank", last4: "6789", status: "verified" } } }).mockRejectedValueOnce(new ApiError("private", 503));
      state.manage.mockResolvedValueOnce({ url: express });
      render(<DocumentPayoutAccountCard />);
      expect(await screen.findByText("Example Bank •••• 6789 · Default for deposits")).toBeVisible();
      act(() => window.dispatchEvent(new Event("focus")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check your bank. Try again.");
      expect(screen.queryByText("Bank linked")).toBeNull();
      const manage = screen.getByRole("button", { name: "Manage bank" });
      expect(manage).toBeEnabled();
      fireEvent.click(manage);
      // Opened inside the click, before any await, with no way back to this tab.
      expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
      expect(tab.opener).toBeNull();
      await waitFor(() => expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(express));
      expect(assign).not.toHaveBeenCalled();
      expect(tab.close).not.toHaveBeenCalled();
      expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token");
      expect(state.onboard).not.toHaveBeenCalled();
    });

    it("uses this tab natively or when a new tab is blocked, and closes the new tab when Stripe refuses", async () => {
      const open = vi.mocked(window.open);
      state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
      state.manage.mockResolvedValue({ url: express });
      render(<DocumentPayoutAccountCard />);
      const manage = await screen.findByRole("button", { name: "Manage bank" });
      fireEvent.click(manage);
      await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(express));
      state.native = true;
      open.mockClear();
      await waitFor(() => expect(manage).toBeEnabled());
      fireEvent.click(manage);
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
      expect(open).not.toHaveBeenCalled();
      state.native = false;
      open.mockReturnValue(tab as unknown as Window);
      state.manage.mockRejectedValueOnce(new ApiError("private", 503));
      await waitFor(() => expect(manage).toBeEnabled());
      fireEvent.click(manage);
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open bank setup. Try again.");
      expect(tab.close).toHaveBeenCalledOnce();
      expect(tab.location.replace).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledTimes(2);
    });
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

  describe("return to the screen that opened bank setup", () => {
    const pending = { detailsSubmitted: true, transfersEnabled: false, payoutsEnabled: false, ready: false, status: "onboarding_required" };
    const linked = { account: { ...pending, transfersEnabled: true, payoutsEnabled: true, ready: true, status: "ready" } };
    const assign = vi.fn();
    const replace = vi.fn();
    const realLocation = window.location;
    const startSetup = async (query: string) => {
      state.query = query;
      const view = render(<DocumentPayoutAccountCard handleReturn showHistory={false} />);
      fireEvent.click(await screen.findByRole("button", { name: "Link bank" }));
      await waitFor(() => expect(assign).toHaveBeenCalledOnce());
      view.unmount();
      assign.mockReset();
      state.query = "documentPayouts=done";
    };
    beforeEach(() => {
      replace.mockReset();
      state.onboard.mockResolvedValue({ url: "https://connect.stripe.com/setup/safe_link" });
      Object.defineProperty(window, "location", { configurable: true, value: { assign, replace } });
    });
    afterEach(() => {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    });

    it("tries one fresh Connect link after Stripe returns an expired one, without a Back loop", async () => {
      await startSetup("from=%2Fone%2Ffeed");
      const key = window.sessionStorage.key(0)!;
      const origin = window.sessionStorage.getItem(key);
      state.query = "documentPayouts=refresh";
      state.router.replace.mockImplementation((href: string) => { state.query = href.split("?")[1] ?? ""; });
      const view = render(<DocumentPayoutAccountCard handleReturn showHistory={false} />);
      await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("https://connect.stripe.com/setup/safe_link"));
      // The marker leaves history before Stripe replaces this entry.
      expect(state.router.replace).toHaveBeenCalledExactlyOnceWith("/one/profile/payouts", { scroll: false });
      expect(assign).not.toHaveBeenCalled();
      view.rerender(<DocumentPayoutAccountCard handleReturn showHistory={false} />);
      await settle();
      expect(state.onboard).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "Link bank" }));
      await waitFor(() => expect(assign).toHaveBeenCalledOnce());
      expect(window.sessionStorage.getItem(key)).toBe(origin);
    });

    it("goes back once the account first reads ready, and stays while setup is unfinished", async () => {
      await startSetup("from=%2Fone%2Ffeed");
      state.account.mockResolvedValueOnce({ account: pending }).mockResolvedValueOnce(linked);
      render(<DocumentPayoutAccountCard handleReturn showHistory={false} />);
      expect(await screen.findByRole("button", { name: "Finish setup" })).toBeEnabled();
      await settle();
      expect(state.router.replace).not.toHaveBeenCalled();
      expect(window.sessionStorage.length).toBe(1);
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(state.router.replace).toHaveBeenCalledExactlyOnceWith("/one/feed"));
      expect(window.sessionStorage.length).toBe(0);
    });

    it("stays on Payouts for an external or expired origin", async () => {
      await startSetup("from=https%3A%2F%2Fevil.example%2Fone%2Ffeed");
      expect(window.sessionStorage.length).toBe(0);
      await startSetup("from=%2Fone%2Ffeed");
      const anHourLater = Date.now() + 61 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValue(anHourLater);
      state.account.mockResolvedValue(linked);
      render(<DocumentPayoutAccountCard handleReturn showHistory={false} />);
      expect(await screen.findByText("Bank linked")).toBeVisible();
      await waitFor(() => expect(window.sessionStorage.length).toBe(0));
      expect(state.router.replace).not.toHaveBeenCalled();
    });

    it("still opens bank setup when storage is blocked, then stays on Payouts", async () => {
      const sessionStoragePrototype = Object.getPrototypeOf(window.sessionStorage);
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        vi.spyOn(sessionStoragePrototype, method).mockImplementation(() => { throw new Error("storage blocked"); });
      }
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await startSetup("from=%2Fone%2Ffeed");
      state.account.mockResolvedValue(linked);
      render(<DocumentPayoutAccountCard handleReturn showHistory={false} />);
      expect(await screen.findByText("Bank linked")).toBeVisible();
      await settle();
      expect(state.router.replace).not.toHaveBeenCalled();
    });
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
    expect(screen.getByText("Example Bank •••• 6789 · Default for deposits")).toBeVisible();
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
