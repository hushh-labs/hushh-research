import type { ReactNode } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayoutActivityItem, PayoutReceipt } from "@/lib/services/payout-activity-service";

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
  balance: vi.fn(),
  redeemTest: vi.fn(),
  redeemLive: vi.fn(),
  hosted: vi.fn(),
  popup: { closed: false, opener: null, location: { replace: vi.fn() }, close: vi.fn() },
  epoch: 1,
  native: false,
  activityItems: [] as PayoutActivityItem[],
  receipt: null as PayoutReceipt | null,
  privacy: { generation: 0, shielded: false, appIsActive: true },
  privacyListeners: new Set<() => void>(),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyObservation: () => ({ state: state.privacy }),
  subscribeNativePrivacyObservation: (listener: () => void) => { state.privacyListeners.add(listener); return () => state.privacyListeners.delete(listener); },
}));

vi.mock("@/lib/services/scope-commerce-browser", () => ({
  COMMERCE_RETURN_EVENT: "hushh:commerce-return",
  openCommerceHostedWindow: () => state.native ? null : state.popup,
  openCommerceHostedUrl: state.hosted,
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
  subscribeVaultSessionEpoch: () => () => {},
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/services/document-payout-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/document-payout-service")>(),
  DocumentPayoutService: { account: state.account, onboard: async (token: string, purpose?: "verify", attemptId?: string) => {
    const value = await state.onboard(token, purpose, attemptId);
    return { ...value, attemptId, source: "documents", returnUrl: `https://one.hushh.ai/one/profile/payouts?commerceReturn=1&commerceAttemptId=${attemptId}&commerceSource=documents` };
  }, bankPayouts: state.bankPayouts, manage: state.manage, earnings: state.earnings, hashcoins: state.hashcoins, balance: state.balance, redeemTest: state.redeemTest, redeemLive: state.redeemLive },
}));
// Activity, its sheets and the freshness line have their own tests; here they
// only show what Payouts hands them.
vi.mock("@/components/consent/payouts/activity-card", () => ({
  PayoutActivityCard: ({ freshness, onAction }: { freshness?: ReactNode; onAction?: (action: "manage_bank" | "verify") => void }) => (
    <section aria-label="Activity">{freshness}
      {onAction ? (["manage_bank", "verify"] as const).map((action) => (
        <button key={action} type="button" onClick={() => onAction(action)}>{`Receipt step ${action}`}</button>
      )) : null}
    </section>
  ),
}));
vi.mock("@/components/consent/payouts/activity-sheet", () => ({
  PayoutActivitySheet: ({ open, initialFilter, onOpenChange }: { open: boolean; initialFilter?: string; onOpenChange: (open: boolean) => void }) => open
    ? <div role="dialog" aria-label={`Activity: ${initialFilter}`}><button type="button" onClick={() => onOpenChange(false)}>Close activity</button></div>
    : null,
}));
vi.mock("@/components/consent/payouts/receipts/payout-receipt-sheet", () => ({
  usePayoutReceipt: (id: string | null) => ({ receipt: state.receipt?.id === id ? state.receipt : null, failed: false, missing: false, loading: false, retry: () => undefined }),
  receiptHeader: () => ({ title: "Synthetic receipt", description: "Pending" }),
  PayoutReceiptSheet: ({ itemId, onOpenChange }: { itemId: string | null; onOpenChange: (open: boolean) => void }) => itemId
    ? <div role="dialog" aria-label={`Receipt ${itemId}`}><button type="button" onClick={() => onOpenChange(false)}>Close receipt</button></div>
    : null,
}));
vi.mock("@/components/consent/payouts/use-payout-activity", () => ({
  usePayoutActivity: () => ({ items: state.activityItems, initialized: true, loading: false, failed: false, error: null,
    hasMore: false, loadingMore: false, moreFailed: false, loadMore: () => undefined, retry: () => undefined }),
}));
vi.mock("@/components/consent/payouts/payout-freshness", () => ({
  PayoutFreshness: () => <span>Payouts freshness</span>,
}));

import { DocumentHashcoinPayouts } from "@/components/consent/document-hashcoins";
import { useNativePayouts } from "@/components/profile/use-native-payouts";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import {
  dispatchPayoutStateChanged, subscribePayoutStateChanged, type PayoutStateChangedDetail,
} from "@/lib/payouts/payout-events";
import { ApiError } from "@/lib/services/api-client";
import { liveWallet, readyAccount, settle, resetPayoutState, noBalance, pausedForVerification, verificationNeeded, inStripe } from "./payout-fixtures";

describe("document payout account", () => {
  beforeEach(() => {
    resetPayoutState(state);
    state.activityItems = []; state.receipt = null;
    state.privacy = { generation: 0, shielded: false, appIsActive: true }; state.privacyListeners.clear();
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps native reads dormant until admission, opens activity without moving money and rejects a retired redemption callback", async () => {
    const view = renderHook(({ active }) => useNativePayouts(active), { initialProps: { active: false } });
    await settle();
    expect(state.hashcoins).not.toHaveBeenCalled(); expect(state.account).not.toHaveBeenCalled();
    view.rerender({ active: true });
    await waitFor(() => expect(view.result.current.rows.has("payout-redeem")).toBe(true));
    state.activityItems = Array.from({ length: 2500 }, (_, index) => ({ id: `earning:${index}`, kind: "earning", status: "credited", occurredAt: "2026-10-17T00:00:00Z",
      updatedAt: "2026-10-17T00:00:00Z", coinsDelta: 100, amountCents: 100, balanceAfterCoins: 100, request: null, review: null, test: false }));
    const retiredRedeem = view.result.current.rows.get("payout-redeem")!;
    act(() => { view.result.current.rows.get("payout-coins")!(); });
    expect(view.result.current.pages.map(page => page.id)).toEqual(["payouts", "payout-activity"]);
    expect(view.result.current.pages[1].sections.find(section => section.id === "payout-activity-items")!.rows.length).toBeLessThanOrEqual(22);
    act(() => { view.result.current.rows.get("payout-next")!(); });
    expect(view.result.current.rows.has("payout-previous")).toBe(true);
    expect(state.redeemTest).not.toHaveBeenCalled(); expect(state.redeemLive).not.toHaveBeenCalled();
    act(() => { expect(view.result.current.back()).toBe(true); });
    expect(view.result.current.pages.map(page => page.id)).toEqual(["payouts"]);
    view.rerender({ active: false });
    await act(async () => retiredRedeem());
    expect(state.redeemTest).not.toHaveBeenCalled(); expect(state.redeemLive).not.toHaveBeenCalled();
    view.unmount();
  });

  it("cancels a receipt's queued bank step when privacy changes before native return completes", async () => {
    const last = { id: "22222222-2222-4222-8222-222222222222", amountCoins: 100, status: "succeeded", stripeMode: "live" };
    state.hashcoins.mockResolvedValue({ ...liveWallet, latestRedemption: last });
    state.receipt = { id: `redemption:${last.id}`, kind: "redemption", mode: "live", status: "succeeded", coins: 100, amountCents: 100,
      reference: null, request: null, earning: null, transfer: { status: "sent", requestedAt: null, sentAt: null, completedAt: null },
      reversal: null, funds: null, bankDeposit: null, review: { reason: "under_review", nextStep: "update_bank" } };
    const view = renderHook(() => useNativePayouts(true));
    await waitFor(() => expect(view.result.current.rows.has("payout-last")).toBe(true));
    act(() => { view.result.current.rows.get("payout-last")!(); });
    const step = view.result.current.pages.at(-1)!.sections.flatMap(section => section.rows).find(row => row.label === "Update your bank")!;
    expect(step).toBeDefined();
    act(() => { view.result.current.rows.get(step.id)!(); });
    expect(state.onboard).not.toHaveBeenCalled(); expect(state.manage).not.toHaveBeenCalled();
    act(() => {
      state.privacy = { generation: 1, shielded: true, appIsActive: false };
      state.privacyListeners.forEach(listener => listener());
      state.privacy = { generation: 2, shielded: false, appIsActive: true };
      state.privacyListeners.forEach(listener => listener());
      view.result.current.onPresented();
    });
    expect(state.onboard).not.toHaveBeenCalled(); expect(state.manage).not.toHaveBeenCalled();
    view.unmount();
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
    const live = await screen.findByRole("region", { name: "Document and answer earnings" });
    await waitFor(() => expect(live).toHaveTextContent("911 Hussh Coins"));
    expect(live).toHaveTextContent("100 Hussh Coins = $1");
    expect(live).toHaveTextContent("$9.11");
    const sandbox = screen.getByRole("region", { name: "Payout sandbox" });
    expect(sandbox).toHaveTextContent("Your real Hussh Coins stay unchanged");
    expect(within(sandbox).getByRole("button", { name: /Test redeem/ })).toHaveAttribute("data-voice-control-id", "profile_payouts_test_redeem");
    fireEvent.click(within(sandbox).getByRole("button", { name: /Test redeem/ }));
    expect(await within(sandbox).findByText("Test transfer completed")).toBeVisible();
    expect(state.redeemTest).toHaveBeenCalledExactlyOnceWith("owner-token", 911, expect.any(String));
    expect(live).toHaveTextContent("911 Hussh Coins");
    // Nothing left to test-redeem: no action, and never "$0.00".
    await waitFor(() => expect(within(sandbox).queryByRole("button", { name: /Test redeem/ })).toBeNull());
    expect(document.body).not.toHaveTextContent("$0.00");
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
    expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent("911 Hussh Coins");
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test redeem|Check test redemption/ })).toBeNull();
    expect(state.redeemTest).not.toHaveBeenCalled();
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it("redeems one eligible live earning to Stripe without claiming a bank deposit", async () => {
    state.hashcoins.mockResolvedValueOnce(liveWallet).mockImplementation(() => new Promise(() => {}));
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    let finish!: (value: unknown) => void;
    state.redeemLive.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const payoutEvents: PayoutStateChangedDetail[] = [];
    const consentSources: unknown[] = [];
    const stop = subscribePayoutStateChanged((detail) => payoutEvents.push(detail));
    const onConsent = (event: Event) => consentSources.push((event as CustomEvent<{ source?: string }>).detail?.source);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsent);
    try {
      render(<DocumentHashcoinPayouts />);
      const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
      expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent("1,822 Hussh Coins");
      const button = within(redeem).getByRole("button", { name: "Redeem $9.11" });
      expect(button).toHaveAttribute("data-voice-control-id", "profile_payouts_redeem");
      await waitFor(() => expect(button).toBeEnabled());
      // One paid request at a time: this tap sends the next earning, not the whole balance.
      expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent("$18.22 ready to redeem");
      expect(redeem).toHaveTextContent("$9.11 of $18.22 ready · one paid request at a time");
      fireEvent.click(button);
      expect(await within(redeem).findByRole("button", { name: "Sending…" })).toBeDisabled();
      expect(state.redeemLive).toHaveBeenCalledExactlyOnceWith("owner-token", 911, expect.any(String));
      await act(async () => { finish({ id: "11111111-1111-4111-8111-111111111111", amountCoins: 911, status: "succeeded", stripeMode: "live", reversalStatus: "none" }); });
      const sent = await within(redeem).findByRole("button", { name: "Sent to Stripe. Bank deposit follows your payout settings." });
      // A cash-out rings the payout bus only; the consent bus stays for consent changes.
      expect(payoutEvents).toContainEqual({ kinds: ["wallet", "balance"], source: "local_redeem" });
      expect(consentSources).not.toContain("hashcoins_redemption");
      fireEvent.click(sent);
      expect(await screen.findByRole("dialog", { name: "Receipt redemption:11111111-1111-4111-8111-111111111111" })).toBeVisible();
      expect(state.redeemTest).not.toHaveBeenCalled();
      expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    } finally {
      stop();
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onConsent);
    }
  });

  it.each([
    ["no account", { account: null }, "Link a bank to redeem", "$18.22 waiting on your bank"],
    ["unfinished setup", { account: { ...readyAccount, detailsSubmitted: false, transfersEnabled: false,
      payoutsEnabled: false, ready: false, status: "onboarding_required", bankStatus: "missing" } }, "Fix your bank to redeem",
      "$18.22 waiting on your bank"],
    ["a bank that needs attention", { account: { ...readyAccount, ready: false, status: "onboarding_required",
      bankStatus: "needs_attention" } }, "Fix your bank to redeem", "$18.22 waiting on your bank"],
    ["a restricted account", { account: { ...readyAccount, payoutsEnabled: false, ready: false, status: "restricted" } },
      "Fix your bank to redeem", "$18.22 waiting on your bank"],
    // Stripe paused payouts over verification: the bank is fine, "Verify details" is the fix.
    ...(["due", "past_due", "disabled"] as const).map((verificationState) => [`verification ${verificationState}`,
      { account: { ...pausedForVerification, verification: { ...verificationNeeded, state: verificationState } } },
      "Verify your details to redeem", "$18.22 waiting on Stripe"] as const),
    ["verification in review", { account: { ...pausedForVerification, verification: { ...verificationNeeded, state: "in_review" } } },
      "Stripe is reviewing your details", "$18.22 waiting on Stripe"],
    // Unknown is not "can't": the coin row keeps its state.
    ["a failed bank check", null, "Bank check unavailable", "$18.22 ready to redeem"],
  ])("holds a new redemption with %s and says why in its place", async (_, account, reason, coinState) => {
    state.hashcoins.mockResolvedValue(liveWallet);
    if (account) state.account.mockResolvedValue({ stripeMode: "live", ...account });
    else state.account.mockRejectedValue(new ApiError("private", 503));
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    expect(await within(redeem).findByText(reason)).toBeVisible();
    expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent(coinState);
    if (coinState.includes("waiting")) expect(document.body).not.toHaveTextContent("ready to redeem");
    if (reason !== "Fix your bank to redeem") expect(redeem).not.toHaveTextContent("Fix your bank");
    // One line: the reason takes the scope line's place.
    expect(redeem).not.toHaveTextContent("of $18.22 ready");
    const button = within(redeem).getByRole("button", { name: "Redeem $9.11" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it.each([false, true])("native=%s: an unreadable open transfer holds a new redemption and keeps its coins reserved", async (native) => {
    state.native = native;
    state.hashcoins.mockResolvedValue({ ...liveWallet, redeemBlocked: true });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    expect(await within(redeem).findByText(native ? "Checking a transfer. Update the app to see it."
      : "Checking a transfer. Coins stay reserved.")).toBeVisible();
    const button = within(redeem).getByRole("button", { name: "Redeem $9.11" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.redeemLive).not.toHaveBeenCalled();
    expect(within(redeem).queryByRole("button", { name: "Reload" }) !== null).toBe(!native);
  });

  it("re-reads the bank when the server refuses a redemption for bank setup", async () => {
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValueOnce({ stripeMode: "live", account: readyAccount })
      .mockResolvedValue({ stripeMode: "live", account: { ...readyAccount, payoutsEnabled: false, ready: false, status: "restricted" } });
    state.redeemLive.mockRejectedValue(new ApiError("refused", 409, { detail: { code: "PAYOUT_ACCOUNT_REQUIRED" } }));
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    const button = await within(redeem).findByRole("button", { name: "Redeem $9.11" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await within(redeem).findByText("Finish bank setup, then try again.")).toBeVisible();
    // The refused tap re-reads the bank, so the gate shows why instead of re-offering it.
    expect(await within(redeem).findByText("Fix your bank to redeem")).toBeVisible();
    expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeDisabled();
    expect(state.redeemLive).toHaveBeenCalledOnce();
  });

  it("never presents a transfer state this build can't name as a refund", async () => {
    const row = { id: "11111111-1111-4111-8111-111111111111", amountCoins: 911, status: "succeeded",
      stripeMode: "live", reversalStatus: "unrecognized" };
    state.hashcoins.mockResolvedValue({ ...liveWallet, latestRedemption: row, redemptionHistory: [row] });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    expect(await within(redeem).findByText("Transfer status updating.")).toBeVisible();
    expect(document.body).not.toHaveTextContent(/Refund|Recovery pending/);
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
    fireEvent.click(within(screen.getByRole("region", { name: "Redeem Hussh Coins" })).getByRole("button", { name: "Check transfer" }));
    await waitFor(() => expect(state.redeemLive).toHaveBeenCalledExactlyOnceWith("owner-token", 911, request.clientRequestId));
  });

  it("shows a refunded live transfer as reversed, not bank paid", async () => {
    const reversed = { id: "11111111-1111-4111-8111-111111111111", amountCoins: 911,
      status: "succeeded", stripeMode: "live", reversalStatus: "reversed" };
    state.hashcoins.mockResolvedValue({ payoutMode: "live", testPayouts: false, liveRedemptionEnabled: true,
      live: { balanceCoins: -911, reservedCoins: 0, availableCoins: 0, amountCents: -911, held: true, nextRedeemCoins: 0 },
      sandbox: { balanceCoins: 0, reservedCoins: 0, availableCoins: 0, amountCents: 0, held: false },
      latestRedemption: reversed, redemptionHistory: [reversed] });
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    expect(redeem).toHaveTextContent("Refunded payment. Transfer reversed.");
    expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent("Under review");
    expect(document.body).not.toHaveTextContent("Sent to Stripe");
    // Nothing is ready, so there is no action to offer, and never "$0.00".
    expect(within(redeem).queryByRole("button", { name: /^Redeem|Check transfer/ })).toBeNull();
    expect(document.body).not.toHaveTextContent("$0.00");
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
    await waitFor(() => expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent("911 Hussh Coins"));
    expect(screen.queryByRole("region", { name: "Payout sandbox" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Redeem Hussh Coins" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test redeem|Check test redemption|^Redeem|Check transfer/ })).toBeNull();
    expect(state.redeemTest).not.toHaveBeenCalled();
    expect(state.redeemLive).not.toHaveBeenCalled();
  });

  it("shows the bank without waiting on Hussh Coins and keeps the last good balance when a refresh fails", async () => {
    let fail!: (cause: unknown) => void;
    state.hashcoins.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    expect(await screen.findByRole("button", { name: "Manage bank" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Activity" })).toBeVisible();
    expect(state.account).toHaveBeenCalledOnce();
    await act(async () => { fail(new Error("Unavailable")); });
    expect(await screen.findByText("Couldn't load Hussh Coins.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage bank" })).toBeEnabled();

    state.hashcoins.mockResolvedValueOnce(liveWallet).mockRejectedValue(new Error("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry balance" }));
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    expect(await screen.findByText("Couldn't refresh.")).toBeVisible();
    expect(screen.queryByText("Couldn't load Hussh Coins.")).toBeNull();
    // One failure, one line: the wallet's own line stands in for the freshness line.
    expect(screen.queryByText("Payouts freshness")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent("1,822 Hussh Coins");
    expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeDisabled();
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
      // Expired setup stays explicit even when the coin reader cannot load.
      expect(state.onboard).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Get a new payout setup link" }));
      await waitFor(() => expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token", undefined, expect.any(String)));
      // A native build bundles its reader, so only an update helps.
      state.native = true;
      view.rerender(<DocumentHashcoinPayouts />);
      expect(screen.getByText("Couldn't load Hussh Coins. Update the app.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
      expect(state.onboard).toHaveBeenCalledOnce();
    } finally { Object.defineProperty(window, "location", { configurable: true, value: realLocation }); }
  });

  it("coalesces returns and queues a fresh bank read behind an earlier display read", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // Activity reads its own feed; Payouts no longer reads deposits or earnings itself.
    const loads = () => [state.hashcoins, state.account, state.balance, state.bankPayouts, state.earnings].map((load) => load.mock.calls.length);
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    // A bank read started before Stripe return cannot satisfy its fresh check.
    // The other first reads queue nothing behind them.
    act(() => { window.dispatchEvent(new Event("focus")); });
    await screen.findByRole("button", { name: "Manage bank" });
    await waitFor(() => expect(state.account).toHaveBeenCalledTimes(2));
    await settle();
    expect(loads()).toEqual([1, 2, 1, 0, 0]);
    expect(state.account).toHaveBeenNthCalledWith(1, "owner-token");
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
    // One read per return; the bank's is fresh.
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(loads()).toEqual([2, 3, 2, 0, 0]);
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
    now += 1_001;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(loads()).toEqual([3, 4, 3, 0, 0]);
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
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

  // Payouts v2 layout: two cards, one action, nothing that reads "$0.00".
  it.each(["live", "test"] as const)("%s mode with nothing ready shows two cards, no money action and no $0.00", async (mode) => {
    const zero = { balanceCoins: 0, reservedCoins: 0, availableCoins: 0, amountCents: 0, held: false };
    state.hashcoins.mockResolvedValue({ ...liveWallet, payoutMode: mode, testPayouts: mode === "test", liveRedemptionEnabled: mode === "live",
      live: { ...zero, nextRedeemCoins: 0 }, sandbox: zero });
    state.account.mockResolvedValue({ stripeMode: mode, account: readyAccount });
    state.balance.mockResolvedValue({ ...noBalance, accountLinked: true });
    render(<DocumentHashcoinPayouts />);
    const money = await screen.findByRole("region", { name: "Document and answer earnings" });
    await waitFor(() => expect(money).toHaveTextContent("0 Hussh Coins"));
    expect(money).toHaveTextContent(mode === "live" ? "Nothing ready to redeem" : "100 Hussh Coins = $1");
    // The one freshness line ages with the balances, so it sits under "Document and answer earnings".
    expect(money).toHaveTextContent("Payouts freshness");
    expect(screen.getByRole("region", { name: "Activity" })).not.toHaveTextContent("Payouts freshness");
    await waitFor(() => expect(state.balance).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole("region", { name: "Redeem Hussh Coins" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Redeem|Check transfer|Test redeem/ })).toBeNull();
    for (const heading of ["Hussh Coins", "Cash out", "Transfers", "Bank deposits", "Transactions"]) {
      expect(screen.queryByRole("heading", { name: heading })).toBeNull();
    }
    expect(document.body).not.toHaveTextContent(/Net earnings after|One request at a time|In Stripe/);
    expect(document.body).not.toHaveTextContent("$0.00");
  });

  // Shapes follow the wallet parser: remaining = available - next; not redeemable = available - redeemable.
  it.each([
    ["more ready after this one", { redeemableCoins: 1500, redeemableCount: 2, remainingAfterNextCoins: 911, notRedeemableCoins: 322 },
      "$15.00 ready to redeem", "$9.11 of $15.00 ready"],
    ["one earning ready while another is held", { redeemableCoins: 911, redeemableCount: 1, remainingAfterNextCoins: 911, notRedeemableCoins: 911,
      holds: [{ id: "earning:33333333-3333-4333-8333-333333333333", reason: "payment_disputed", nextStep: "wait_for_bank", coins: 911, requestId: null, requestLabel: null, since: null }] },
      "Under review", null],
  ])("redeems the next ready earning with %s", async (_, readiness, coinState, scopeLine) => {
    state.hashcoins.mockResolvedValue({ ...liveWallet, live: { ...liveWallet.live, ...readiness } });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
    expect(screen.getByRole("region", { name: "Document and answer earnings" })).toHaveTextContent(coinState);
    if (scopeLine) expect(redeem).toHaveTextContent(scopeLine);
    else expect(redeem).not.toHaveTextContent(/ of \$/);
  });

  it("never redeems a balance read over a minute ago; it reads it again first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    try {
      // Re-reads wait until released; after that, any further read answers at once.
      const reads: Array<(value: unknown) => void> = [];
      let released = false;
      state.hashcoins.mockResolvedValueOnce({ ...liveWallet })
        .mockImplementation(() => released ? Promise.resolve({ ...liveWallet }) : new Promise((resolve) => { reads.push(resolve); }));
      state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
      render(<DocumentHashcoinPayouts />);
      const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
      await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
      // The clock moves past a minute before any timer runs: the tap re-reads instead of redeeming.
      vi.setSystemTime(Date.now() + 61_000);
      fireEvent.click(within(redeem).getByRole("button", { name: "Redeem $9.11" }));
      await waitFor(() => expect(reads.length).toBeGreaterThan(0));
      expect(state.redeemLive).not.toHaveBeenCalled();
      // Once the minute passes on screen, the action waits for that read.
      act(() => { vi.advanceTimersByTime(61_000); });
      const waiting = await within(redeem).findByRole("button", { name: "Updating balance…" });
      expect(waiting).toBeDisabled();
      fireEvent.click(waiting);
      expect(state.redeemLive).not.toHaveBeenCalled();
      released = true;
      await act(async () => { for (const finish of reads) finish({ ...liveWallet }); });
      await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
      expect(state.redeemLive).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("never redeems a wallet with an unread payout change; it waits for the reread", async () => {
    let release!: (value: unknown) => void;
    state.hashcoins.mockResolvedValueOnce({ ...liveWallet })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue({ ...liveWallet });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    state.redeemLive.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", amountCoins: 911,
      status: "succeeded", stripeMode: "live", reversalStatus: "none" });
    render(<DocumentHashcoinPayouts />);
    const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
    await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
    // The wallet was read moments ago, but a cash-out elsewhere (or a reversed earning) just changed it.
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    await waitFor(() => expect(state.hashcoins).toHaveBeenCalledTimes(2));
    const waiting = within(redeem).getByRole("button", { name: "Updating balance…" });
    expect(waiting).toBeDisabled();
    fireEvent.click(waiting);
    expect(state.redeemLive).not.toHaveBeenCalled();
    await act(async () => { release({ ...liveWallet }); });
    const button = await within(redeem).findByRole("button", { name: "Redeem $9.11" });
    await waitFor(() => expect(button).toBeEnabled());
    // Once read, the gate opens again.
    fireEvent.click(button);
    await waitFor(() => expect(state.redeemLive).toHaveBeenCalledExactlyOnceWith("owner-token", 911, expect.any(String)));
  });

  it("reads the wallet once when the owner returns after a minute away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    // A return after 120s leaves the next aligned 45s poll 15s away.
    // Keep this 2s resume assertion independent of the real wall-clock phase.
    vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    try {
      state.hashcoins.mockResolvedValue({ ...liveWallet });
      state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
      render(<DocumentHashcoinPayouts />);
      const redeem = await screen.findByRole("region", { name: "Redeem Hussh Coins" });
      await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
      await settle();
      const before = state.hashcoins.mock.calls.length;
      act(() => {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(state.hashcoins).toHaveBeenCalledTimes(before);
      act(() => {
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      // The store's return read is the only one; nothing queues a second behind it.
      expect(state.hashcoins).toHaveBeenCalledTimes(before + 1);
      await waitFor(() => expect(within(redeem).getByRole("button", { name: "Redeem $9.11" })).toBeEnabled());
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(document, "hidden");
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("says why money is under review and what to do, under the balance", async () => {
    const hold = (fields: Record<string, unknown>) => ({ requestId: null, requestLabel: null, since: null, ...fields });
    state.hashcoins.mockResolvedValue({ ...liveWallet, live: { balanceCoins: -911, reservedCoins: 0, availableCoins: 0,
      amountCents: -911, held: true, nextRedeemCoins: 0, holds: [
        hold({ id: "earning:33333333-3333-4333-8333-333333333333", reason: "payment_disputed", nextStep: "wait_for_bank",
          coins: 500, requestLabel: "Tax return 2025" }),
        // A balance below zero has no Activity item, so it is the one explained here.
        hold({ id: "balance", reason: "negative_balance", nextStep: "contact_support", coins: 911 }),
      ] } });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const money = await screen.findByRole("region", { name: "Document and answer earnings" });
    await waitFor(() => expect(money).toHaveTextContent("Under review · 2 items"));
    const row = screen.getByTestId("payout-hold-row");
    expect(row).toHaveTextContent("A refund left your balance below zero.");
    expect(row).toHaveTextContent("Contact support");
    expect(row).toHaveTextContent("$9.11");
    expect(money).not.toHaveTextContent("The buyer's bank");
    expect(document.body).not.toHaveTextContent("$0.00");
  });

  it("names a held earning's request, its next step and its amount", async () => {
    state.hashcoins.mockResolvedValue({ ...liveWallet, live: { ...liveWallet.live, redeemableCoins: 911, redeemableCount: 1,
      remainingAfterNextCoins: 911, notRedeemableCoins: 911, holds: [{ id: "earning:33333333-3333-4333-8333-333333333333",
        reason: "payment_disputed", nextStep: "wait_for_bank", coins: 911, requestId: null, requestLabel: "Tax return 2025", since: null }] } });
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const row = await screen.findByTestId("payout-hold-row");
    expect(row).toHaveTextContent("The buyer's bank is reviewing this payment.");
    expect(row).toHaveTextContent("Tax return 2025 · Wait for the bank");
    expect(row).toHaveTextContent("$9.11");
    expect(screen.getByRole("region", { name: "Document and answer earnings" })).not.toHaveTextContent("items");
  });

  it("takes a receipt's next step with the bank rows' own Manage and Verify details, never a money action", async () => {
    const assign = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { assign, replace: vi.fn() } });
    try {
      state.hashcoins.mockResolvedValue(liveWallet);
      state.manage.mockResolvedValue({ url: "https://stripe.com/express/acct_owner/login_token" });
      state.onboard.mockResolvedValue({ url: "https://connect.stripe.com/setup/safe_link" });
      state.account.mockResolvedValue({ stripeMode: "live", account: { ...pausedForVerification, verification: verificationNeeded } });
      render(<DocumentHashcoinPayouts />);
      const money = await screen.findByRole("region", { name: "Document and answer earnings" });
      expect(await within(money).findByRole("button", { name: /Verify details/ })).toBeEnabled();
      const activity = screen.getByRole("region", { name: "Activity" });

      fireEvent.click(within(activity).getByRole("button", { name: "Receipt step verify" }));
      await waitFor(() => expect(state.hosted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "documents" }), "onboarding", state.popup, expect.any(AbortSignal)));
      expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token", "verify", expect.any(String));
      expect(state.manage).not.toHaveBeenCalled();
      await waitFor(() => expect(within(money).getByRole("button", { name: /Verify details/ })).toBeEnabled());

      vi.mocked(window.open).mockReturnValue(state.popup as unknown as Window);
      fireEvent.click(within(activity).getByRole("button", { name: "Receipt step manage_bank" }));
      // Stripe's bank settings open in a new tab from inside the click, like the bank row.
      expect(window.open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
      await waitFor(() => expect(state.popup.location.replace).toHaveBeenLastCalledWith("https://stripe.com/express/acct_owner/login_token"));
      expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token");
      expect(state.onboard).toHaveBeenCalledOnce();
      expect(state.redeemLive).not.toHaveBeenCalled();
      expect(state.redeemTest).not.toHaveBeenCalled();
    } finally { Object.defineProperty(window, "location", { configurable: true, value: realLocation }); }
  });

  it("opens coin activity from the Hussh Coins row and returns focus to it", async () => {
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    const money = await screen.findByRole("region", { name: "Document and answer earnings" });
    const row = await within(money).findByRole("button", { name: /1,822 Hussh Coins/ });
    fireEvent.click(row);
    const sheet = await screen.findByRole("dialog", { name: "Activity: coins" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close activity" }));
    expect(screen.queryByRole("dialog", { name: "Activity: coins" })).toBeNull();
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("keeps a transfer's receipt open while a refresh settles it", async () => {
    const pending = { id: "33333333-3333-4333-8333-333333333333", clientRequestId: "44444444-4444-4444-8444-444444444444",
      amountCoins: 911, status: "pending", stripeMode: "live", reversalStatus: "none" };
    const settled = { ...liveWallet, live: { balanceCoins: 911, reservedCoins: 0, availableCoins: 911, amountCents: 911, held: false, nextRedeemCoins: 0 } };
    state.hashcoins.mockResolvedValueOnce({ ...liveWallet, latestRedemption: pending,
      live: { ...liveWallet.live, reservedCoins: 911, availableCoins: 911, nextRedeemCoins: 0 } })
      .mockResolvedValue(settled);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    fireEvent.click(await screen.findByRole("button", { name: "Transfer pending." }));
    const receipt = await screen.findByRole("dialog", { name: `Receipt redemption:${pending.id}` });
    // The transfer settles and nothing else is ready: the whole action leaves, the receipt stays.
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Redeem Hussh Coins" })).toBeNull());
    expect(receipt).toBeVisible();
    fireEvent.click(within(receipt).getByRole("button", { name: "Close receipt" }));
    expect(screen.queryByRole("dialog", { name: /Receipt/ })).toBeNull();
  });

  it.each([
    ["no linked account", () => state.balance.mockResolvedValue({ ...inStripe, accountLinked: false })],
    ["a test-mode balance", () => state.balance.mockResolvedValue({ ...inStripe, stripeMode: "test" })],
    ["nothing in Stripe", () => state.balance.mockResolvedValue({ ...inStripe, inStripeCents: 0, availableCents: 0, pendingCents: 0 })],
    ["no balance reading", () => state.balance.mockRejectedValue(new ApiError("unavailable", 503, { detail: { code: "BALANCE_UNAVAILABLE" } }))],
  ])("hides In Stripe with %s", async (_, arrange) => {
    arrange();
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    await screen.findByRole("region", { name: "Document and answer earnings" });
    await waitFor(() => expect(state.balance).toHaveBeenCalledOnce());
    await settle();
    expect(screen.queryByText("In Stripe")).toBeNull();
  });

  it("shows money in Stripe that isn't in the bank yet, and when it settles", async () => {
    state.balance.mockResolvedValue(inStripe);
    state.hashcoins.mockResolvedValue(liveWallet);
    state.account.mockResolvedValue({ stripeMode: "live", account: readyAccount });
    render(<DocumentHashcoinPayouts />);
    // Stripe dates funds by UTC day; whatever the device's zone, that day is shown.
    const day = new Date("2026-10-14T12:00:00.000Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const money = await screen.findByRole("region", { name: "Document and answer earnings" });
    const row = await within(money).findByRole("button", { name: /In Stripe/ });
    expect(row).toHaveTextContent(`Settling · available ${day}`);
    expect(row).toHaveTextContent("$1.55");
    fireEvent.click(row);
    const sheet = await screen.findByRole("dialog", { name: "In Stripe" });
    expect(sheet).toHaveTextContent("Available$1.00");
    expect(sheet).toHaveTextContent("Settling");
    expect(sheet).toHaveTextContent("$0.55");
    expect(sheet).toHaveTextContent(`Available ${day}`);
    // Money in Stripe is not in the bank yet.
    expect(sheet).not.toHaveTextContent(/deposit/i);
  });
});
