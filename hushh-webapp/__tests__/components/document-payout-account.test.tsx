import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: "",
  token: "owner-token" as string | null,
  account: vi.fn(),
  onboard: vi.fn(),
  bankPayouts: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token }),
}));
vi.mock("@/lib/services/document-payout-service", () => ({
  DocumentPayoutService: { account: state.account, onboard: state.onboard, bankPayouts: state.bankPayouts },
}));

import { DocumentBankPayoutStatusCard, DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";

describe("document payout account", () => {
  beforeEach(() => {
    state.query = "";
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
    await waitFor(() => expect(screen.getByText(/Ready to receive document earnings/)).toBeVisible());
    expect(screen.queryByRole("button", { name: /payout setup/i })).toBeNull();
    expect(screen.getByLabelText("Document payouts")).not.toHaveTextContent(/deposited|paid to bank/i);
  });

  it("tries one fresh Connect link after Stripe returns an expired one", async () => {
    state.query = "documentPayouts=refresh";
    const { rerender } = render(<DocumentPayoutAccountCard handleReturn />);
    await waitFor(() => expect(state.onboard).toHaveBeenCalledExactlyOnceWith("owner-token"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open payout setup. Try again.");
    rerender(<DocumentPayoutAccountCard handleReturn />);
    expect(state.onboard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Set up US payouts" }));
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
    await screen.findByText(/Ready to receive document earnings/);
    state.token = "second-owner";
    rerender(<DocumentPayoutAccountCard />);
    expect(screen.queryByText(/Ready to receive document earnings/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking payout setup…");
    resolveSecond({ account: null });
    await screen.findByRole("button", { name: "Set up US payouts" });
  });

  it("shows only a signed aggregate paid bank payout as paid", async () => {
    state.bankPayouts.mockResolvedValue({ currency: "USD", payouts: [{
      id: "po_private", amountCents: 911, status: "paid", expectedArrivalAt: null, failureCode: null,
    }] });
    render(<DocumentBankPayoutStatusCard />);
    const card = await screen.findByLabelText("Bank payout status");
    expect(card).toHaveTextContent("$9.11 bank payout paid.");
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
    await waitFor(() => expect(screen.queryByLabelText("Bank payout status")).toBeNull());
  });
});
