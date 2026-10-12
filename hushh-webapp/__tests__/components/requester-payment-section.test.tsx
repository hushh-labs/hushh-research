import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequesterPaymentView } from "@/lib/consent/document-request-payment-view";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const state = vi.hoisted(() => ({
  decide: vi.fn(),
  checkout: vi.fn(),
  assign: vi.fn(),
  token: "vault-token" as string | null,
  epoch: 1,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { getIdToken: async () => "firebase-token" } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ getVaultOwnerToken: () => state.token }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({
  useCoarseClock: () => NOW,
}));
vi.mock("@/lib/services/drive-request-payment-service", () => ({
  DriveRequestPaymentService: { checkout: state.checkout },
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: { decide: state.decide },
}));

import { RequesterPaymentSection } from "@/components/consent/requester-payment-section";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

const requestId = "11111111-1111-4111-8111-111111111111";
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function payment(overrides: Partial<RequesterPaymentView> = {}): RequesterPaymentView {
  return {
    state: "payable",
    amountCents: 2500,
    currency: "usd",
    checkoutExpiresAt: at(29 * 60_000),
    requestExpiresAt: at(86_400_000),
    refund: null,
    nextAction: "pay",
    withdrawn: false,
    ...overrides,
  };
}

function show(view: RequesterPaymentView | null, onChanged = vi.fn()) {
  render(
    <RequesterPaymentSection
      requestId={requestId}
      revision={3}
      payment={view}
      price={null}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

beforeEach(() => {
  state.token = "vault-token";
  vi.stubGlobal("location", { ...window.location, assign: state.assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.decide.mockReset();
  state.checkout.mockReset();
  state.assign.mockReset();
});

describe("RequesterPaymentSection", () => {
  it("shows the countdown and starts the existing Checkout from Pay", async () => {
    state.checkout.mockResolvedValueOnce("https://checkout.stripe.com/c/pay/cs_test");
    show(payment());
    expect(screen.getByRole("status")).toHaveTextContent("Payment due");
    expect(screen.getByRole("status")).toHaveTextContent("Sharing starts after payment. · 29m left");
    fireEvent.click(screen.getByRole("button", { name: "Pay $25" }));
    await waitFor(() => expect(state.assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test"));
    expect(state.checkout).toHaveBeenCalledWith("firebase-token", requestId);
  });

  it("explains a closed payment window without offering Pay", () => {
    show(payment({ state: "link_expired", checkoutExpiresAt: null, nextAction: "new_request" }));
    expect(screen.getByRole("status")).toHaveTextContent("Payment window closed");
    expect(screen.getByRole("status")).toHaveTextContent("Send a new request to try again.");
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();
  });

  it("withdraws only on the confirming tap, then says so", async () => {
    state.decide.mockResolvedValueOnce({
      requestId,
      status: "cancelled",
      payment: payment({ state: "closed", checkoutExpiresAt: null, nextAction: "none", withdrawn: true }),
    });
    const onChanged = show(payment());
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request (tap again to confirm)" }));
    expect(state.decide).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Withdraw request" }));
    });
    expect(state.decide).toHaveBeenCalledWith("vault-token", requestId, "cancel", 3, expect.any(Function));
    expect(screen.getByRole("status")).toHaveTextContent("Request withdrawn");
    expect(screen.queryByRole("button", { name: /Withdraw request/ })).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("says a refund is coming when the payment won the race", async () => {
    state.decide.mockResolvedValueOnce({
      requestId,
      status: "cancelled",
      payment: payment({
        state: "refund_pending",
        checkoutExpiresAt: null,
        nextAction: "none",
        withdrawn: true,
        refund: { status: "queued", amountCents: 2500 },
      }),
    });
    show(payment());
    fireEvent.click(screen.getByRole("button", { name: /Withdraw request/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Withdraw request/ }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Payment received after you withdrew");
    expect(screen.getByRole("status")).toHaveTextContent("Refund of $25 pending");
    expect(screen.getByRole("status")).not.toHaveTextContent("Request withdrawn");
  });

  it("explains a refusal for a paid request and refreshes", async () => {
    state.decide.mockRejectedValueOnce(new DriveSharingError("request_paid", 409));
    const onChanged = show(payment({ state: "preparing", checkoutExpiresAt: null, nextAction: "wait_owner" }));
    fireEvent.click(screen.getByRole("button", { name: /Withdraw request/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Withdraw request/ }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Payment or sharing already started. Refresh to see it.");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("shows refunds without Withdraw, and nothing when no payment applies", () => {
    show(payment({ state: "refunded", checkoutExpiresAt: null, nextAction: "none", refund: { status: "succeeded", amountCents: 2500 } }));
    expect(screen.getByRole("status")).toHaveTextContent("Refunded $25");
    expect(screen.queryByRole("button", { name: /Withdraw/ })).toBeNull();
    cleanup();
    show(null);
    expect(screen.queryByTestId("requester-payment-section")).toBeNull();
    show(payment({ state: "none", amountCents: null, checkoutExpiresAt: null, nextAction: "none" }));
    expect(screen.queryByTestId("requester-payment-section")).toBeNull();
  });
});
