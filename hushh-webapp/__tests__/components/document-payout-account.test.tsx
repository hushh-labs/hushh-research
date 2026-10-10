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
vi.mock("@/lib/services/document-payout-service", () => ({
  DocumentPayoutService: { account: state.account, onboard: state.onboard, bankPayouts: state.bankPayouts, manage: state.manage, earnings: state.earnings },
}));

import { DocumentBankPayoutStatusCard, DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";

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
