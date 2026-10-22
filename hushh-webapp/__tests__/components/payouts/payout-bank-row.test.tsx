import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
import { PayoutBankRows, type PayoutBankActions } from "@/components/consent/payouts/payout-bank-row";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";
import { ApiError } from "@/lib/services/api-client";
import { readyAccount, settle } from "./payout-fixtures";

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
      const linkBank = await screen.findByRole("button", { name: "Link bank" });
      await waitFor(() => expect(linkBank).toBeEnabled());
      fireEvent.click(linkBank);
      expect(await screen.findByRole("alert")).toHaveTextContent("Bank setup is unavailable. Hussh needs to turn on payouts.");
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
    await act(async () => { resolveSecond({ account: null }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Link bank" })).toBeEnabled());
  });

  it("refetches after Stripe return and announces actual readiness once without a loop", async () => {
    const { rerender } = render(<DocumentPayoutAccountCard handleReturn compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Link bank" })).toBeEnabled());
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
      expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
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
      const linkBank = await screen.findByRole("button", { name: "Link bank" });
      await waitFor(() => expect(linkBank).toBeEnabled());
      fireEvent.click(linkBank);
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
    let finishAccount!: (value: { account: null }) => void;
    state.account.mockImplementationOnce(() => new Promise((resolve) => { finishAccount = resolve; }));
    let finish!: (value: { url: string }) => void;
    state.onboard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<DocumentPayoutAccountCard compact />);
    const linkBank = await screen.findByRole("button", { name: "Link bank" });
    // The accessible label exists during the initial read, before setup can open.
    expect(linkBank).toBeDisabled();
    fireEvent.click(linkBank);
    expect(state.onboard).not.toHaveBeenCalled();
    await act(async () => { finishAccount({ account: null }); });
    await waitFor(() => expect(linkBank).toBeEnabled());
    fireEvent.click(linkBank);
    await waitFor(() => expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token"));
    state.token = "new-owner";
    state.epoch++;
    view.rerender(<DocumentPayoutAccountCard compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Link bank" })).toBeEnabled());
    await act(async () => { finish({ url: "https://unsafe.invalid/old-account" }); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Link bank" })).toBeEnabled();
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
    act(() => { dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" }); });
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
    // A retry asks Stripe again; the server's display cache would repeat "unavailable".
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
    expect(state.onboard).not.toHaveBeenCalled();
  });
});

describe("payout bank rows", () => {
  const verified = { ...readyAccount, bank: { name: "Example Bank", last4: "6789", status: "verified" } };
  const due = { state: "due", deadline: "2026-10-30T12:00:00+00:00", items: ["identity"],
    eventuallyDue: false, hasErrors: false, disabledReason: null };
  const assign = vi.fn();
  const realLocation = window.location;
  const rows = () => render(<SettingsGroup title="Your money"><PayoutBankRows handleReturn /></SettingsGroup>);
  beforeEach(() => {
    state.query = "";
    state.pathname = "/one/profile/payouts";
    state.router.replace.mockReset();
    window.sessionStorage.clear();
    state.epoch = 1;
    state.native = false;
    state.token = "owner-token";
    state.account.mockReset().mockResolvedValue({ stripeMode: "live", account: verified });
    state.manage.mockReset().mockResolvedValue({ url: "https://stripe.com/express/acct_owner/login_token" });
    state.onboard.mockReset().mockResolvedValue({ url: "https://connect.stripe.com/setup/safe_link" });
    assign.mockReset();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    vi.restoreAllMocks();
  });

  it("names the default bank with an inline Manage, and no Verify row while Stripe needs nothing", async () => {
    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified,
      verification: { ...due, state: "none", deadline: null, items: [], eventuallyDue: true } } });
    rows();
    // The routine "Default for deposits" line stays out of the spoken name.
    const manage = await screen.findByRole("button", { name: "Manage bank, Example Bank •••• 6789" });
    expect(manage).toHaveTextContent("Example Bank •••• 6789");
    expect(manage).toHaveTextContent("Default for deposits");
    expect(manage).toHaveTextContent(/Manage$/);
    expect(screen.queryByText("Bank linked")).toBeNull();
    expect(screen.queryByText("Verify details")).toBeNull();
    fireEvent.click(manage);
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("https://stripe.com/express/acct_owner/login_token"));
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("opens a verify link that collects everything Stripe will need", async () => {
    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified, verification: due } });
    rows();
    const verify = await screen.findByRole("button", { name: /Verify details/ });
    expect(verify).toHaveTextContent("Due Oct 30");
    fireEvent.click(verify);
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("https://connect.stripe.com/setup/safe_link"));
    expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token", "verify");
    expect(state.manage).not.toHaveBeenCalled();
  });

  it.each([
    ["past_due", "Overdue · payouts paused", true],
    ["upcoming", "Stripe needs more information", true],
    ["disabled", "Payouts paused", true],
    ["in_review", "In review", false],
  ])("describes a %s verification in one line", async (verificationState, copy, actionable) => {
    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified, ready: false, status: "restricted",
      verification: { ...due, state: verificationState, deadline: null } } });
    rows();
    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage bank, Example Bank •••• 6789" })).toHaveTextContent("Default for deposits");
    // Nothing to do while Stripe reviews, so that row is not a control.
    expect(screen.queryByRole("button", { name: /Verify details/ }) !== null).toBe(actionable);
  });

  it("lends its own Manage and Verify details to a receipt's next step, with the rows' guards", async () => {
    const actions = createRef<PayoutBankActions>();
    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified, verification: { ...due, state: "in_review" } } });
    render(<SettingsGroup title="Your money"><PayoutBankRows handleReturn actionsRef={actions} /></SettingsGroup>);
    expect(await screen.findByText("In review")).toBeVisible();
    // Nothing to verify while Stripe reviews, so the step opens the bank row's Manage.
    act(() => { actions.current!.verifyDetails(); });
    expect(screen.getByRole("button", { name: /^Manage bank/ })).toHaveTextContent("Opening…");
    // A second tap while it opens does nothing, as on the row.
    act(() => { actions.current!.manageBank(); });
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("https://stripe.com/express/acct_owner/login_token"));
    expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token");
    expect(state.onboard).not.toHaveBeenCalled();

    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified, verification: due } });
    act(() => dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Verify details/ })).toBeEnabled());
    act(() => { actions.current!.verifyDetails(); });
    await waitFor(() => expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token", "verify"));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith("https://connect.stripe.com/setup/safe_link"));
    expect(state.manage).toHaveBeenCalledOnce();
  });

  it("shows a failed verify link on its own row and keeps bank management working", async () => {
    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified, verification: due } });
    state.onboard.mockRejectedValueOnce(new ApiError("Private provider details", 503));
    rows();
    fireEvent.click(await screen.findByRole("button", { name: /Verify details/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open bank setup. Try again.");
    expect(screen.getByRole("button", { name: /Verify details/ })).toHaveTextContent("Couldn't open bank setup");
    expect(screen.queryByText(/Private provider details/)).toBeNull();
    expect(screen.getByRole("button", { name: "Manage bank, Example Bank •••• 6789" })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("offers a bank re-check, not setup, when the first read fails", async () => {
    state.account.mockRejectedValueOnce(new ApiError("private", 503));
    rows();
    const retry = await screen.findByRole("button", { name: "Retry bank check, Bank status unavailable" });
    expect(retry).toHaveTextContent("Bank status unavailable");
    // With nothing to manage, the row is the one re-check control.
    expect(screen.getAllByRole("button", { name: /^Retry bank check/ })).toHaveLength(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check your bank. Try again.");
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Manage bank, Example Bank •••• 6789" })).toHaveTextContent("Example Bank •••• 6789");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("keeps verified bank management available during refresh failure and offers a fresh check beside it", async () => {
    const express = "https://stripe.com/express/acct_owner/login_token";
    state.account.mockResolvedValueOnce({ stripeMode: "live", account: verified })
      .mockRejectedValueOnce(new ApiError("private", 503))
      .mockResolvedValueOnce({ stripeMode: "live", account: verified });
    state.manage.mockResolvedValueOnce({ url: express });
    rows();
    await screen.findByRole("button", { name: "Manage bank, Example Bank •••• 6789" });
    expect(screen.queryByRole("button", { name: "Retry bank check" })).toBeNull();
    act(() => window.dispatchEvent(new Event("focus")));
    // The alert sits outside the row's hidden content, so it is announced.
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check your bank. Try again.");
    expect(screen.getByText("Bank status unavailable")).toBeVisible();
    const manage = screen.getByRole("button", { name: "Manage bank, Example Bank •••• 6789, Bank status unavailable" });
    const retry = screen.getByRole("button", { name: "Retry bank check" });
    expect(manage).toBeEnabled();
    expect(retry).toBeEnabled();
    fireEvent.click(manage);
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(express));
    expect(state.manage).toHaveBeenCalledExactlyOnceWith("owner-token");
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Manage bank, Example Bank •••• 6789" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry bank check" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.account).toHaveBeenCalledTimes(3);
    // A retry asks Stripe again; the server's display cache would repeat the old read.
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
    expect(state.manage).toHaveBeenCalledOnce();
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("retries an unavailable bank check without sending verified owners through identity setup", async () => {
    const account = { ...readyAccount, ready: false, status: "onboarding_required", bankStatus: "unavailable", bank: null };
    state.account.mockResolvedValueOnce({ stripeMode: "live", account })
      .mockResolvedValueOnce({ stripeMode: "live", account: verified });
    rows();
    expect(await screen.findByText("Bank check unavailable")).toBeVisible();
    // Stripe may keep cutting the bank list short, so Manage stays reachable.
    expect(screen.getByRole("button", { name: "Manage bank, Bank check unavailable" })).toBeEnabled();
    expect(screen.queryByText("Verify details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry bank check" }));
    expect(await screen.findByRole("button", { name: "Manage bank, Example Bank •••• 6789" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry bank check" })).toBeNull();
    expect(state.account).toHaveBeenCalledTimes(2);
    expect(state.account).toHaveBeenLastCalledWith("owner-token", { fresh: true });
    expect(state.onboard).not.toHaveBeenCalled();
    expect(state.manage).not.toHaveBeenCalled();
  });

  it.each([
    ["needs_attention", { bankStatus: "needs_attention", bank: { ...verified.bank, status: "errored" } }, "Manage bank, Example Bank •••• 6789, Update your bank"],
    ["missing", { bankStatus: "missing", bank: null }, "Manage bank, Bank needed"],
    ["restricted", { ready: false, status: "restricted" }, "Manage bank, Example Bank •••• 6789, Verification needed"],
  ])("names a %s bank and its state, not only the action", async (_, patch, name) => {
    state.account.mockResolvedValue({ stripeMode: "live", account: { ...verified, ...patch } });
    rows();
    expect(await screen.findByRole("button", { name })).toBeEnabled();
  });

  it("rereads the bank for account doorbells only", async () => {
    rows();
    await screen.findByRole("button", { name: "Manage bank, Example Bank •••• 6789" });
    await settle();
    expect(state.account).toHaveBeenCalledOnce();
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet", "earnings"], source: "sse" }); });
    await settle();
    expect(state.account).toHaveBeenCalledOnce();
    // Focus moving inside the page is not a return from Stripe.
    act(() => { screen.getByRole("button", { name: "Manage bank, Example Bank •••• 6789" }).focus(); });
    act(() => { dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" }); });
    await waitFor(() => expect(state.account).toHaveBeenCalledTimes(2));
    // Server doorbells keep the cached read; only the owner's own actions skip it.
    expect(state.account).toHaveBeenLastCalledWith("owner-token");
  });

  it("keeps the compact card's Bank linked only while Stripe needs nothing now", async () => {
    state.account.mockResolvedValueOnce({ stripeMode: "live", account: { ...verified, verification: due } })
      .mockResolvedValueOnce({ stripeMode: "live", account: { ...verified, verification: { ...due, state: "upcoming" } } });
    render(<DocumentPayoutAccountCard compact />);
    expect(await screen.findByText("Payout bank")).toBeVisible();
    expect(screen.queryByText("Bank linked")).toBeNull();
    act(() => { dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" }); });
    expect(await screen.findByText("Bank linked")).toBeVisible();
    expect(screen.getByText("Example Bank •••• 6789 · Default for deposits")).toBeVisible();
  });
});
