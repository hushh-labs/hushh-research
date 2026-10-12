import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), driveStatus: vi.fn(), dispatch: vi.fn(),
  user: { uid: "requester-a", getIdToken: async () => "requester-token" },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.apiFetch } }));
vi.mock("@/lib/services/drive-request-payment-service", () => ({ DriveRequestPaymentService: { status: mocks.driveStatus } }));
vi.mock("@/lib/consent/consent-events", () => ({ dispatchConsentStateChanged: mocks.dispatch }));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button>,
}));

import { FeedPaymentReturnNotice } from "@/components/feed/feed-payment-return-notice";
import { AnswerPaymentReturnNotice } from "@/components/feed/answer-payment-return-notice";

const REQUEST = "11111111-2222-4333-8444-555555555555";
const OTHER_REQUEST = "22222222-3333-4444-8555-666666666666";
const pending = {
  requestStatus: "approved", orderStatus: "checkout_open", amountCents: 1000,
  currency: "usd", checkoutUrl: null, paidAt: null, refundedAt: null, refundReason: null,
  fulfilment: "owner_device", answerDeadlineAt: null, answerDeadlineHours: 72,
  preparationStatus: "ready", reconciliationRequired: false,
};
const paid = { ...pending, requestStatus: "answered", orderStatus: "paid", paidAt: "2026-10-13T08:00:00Z" };
const respond = (value: unknown) => new Response(JSON.stringify(value));
const tick = async () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user = { uid: "requester-a", getIdToken: async () => "requester-token" };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/one/feed");
});

describe("answer Checkout returns use real Request payment status", () => {
  it.each([
    ["answerPaymentRequestId", "success"], ["answerPaymentRequestId", "cancel"],
    ["paymentRequestId", "paid"], ["paymentRequestId", "cancelled"],
  ])("routes %s with %s to Request's own status and refreshes Feed", async (parameter, checkout) => {
    window.history.replaceState({}, "", `/one/feed?${parameter}=${REQUEST}&checkout=${checkout}`);
    mocks.apiFetch.mockResolvedValueOnce(respond(paid));
    render(<FeedPaymentReturnNotice />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Your answer is ready to open in Feed"));
    expect(mocks.apiFetch).toHaveBeenCalledExactlyOnceWith(`/api/one/answer-requests/${REQUEST}/payment`, {
      method: "GET", cache: "no-store", headers: { Authorization: "Bearer requester-token" },
    });
    expect(mocks.driveStatus).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith({ source: "answer_payment_status", requestId: `answer_request:${REQUEST}` });
  });

  it("waits for actual payment and retries a failed status read before reporting delivery", async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValueOnce(respond(pending))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(respond({ ...paid, requestStatus: "answering" }))
      .mockResolvedValueOnce(respond(paid));
    render(<AnswerPaymentReturnNotice requestId={REQUEST} checkout="paid" />);
    await tick();
    expect(screen.getByRole("status")).toHaveTextContent("Payment is processing");
    expect(screen.getByRole("status")).not.toHaveTextContent("Payment confirmed");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("couldn't check payment yet");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("Your answer is being prepared");
    expect(screen.getByRole("status")).not.toHaveTextContent("ready to open");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("ready to open in Feed");
    expect(mocks.apiFetch).toHaveBeenCalledTimes(4);
    expect(mocks.dispatch).toHaveBeenCalledTimes(3);
  });

  it("does not treat paid metadata without a valid paid time as confirmation and supports explicit retry", async () => {
    mocks.apiFetch.mockResolvedValueOnce(respond({ ...paid, paidAt: null })).mockResolvedValueOnce(respond(paid));
    render(<AnswerPaymentReturnNotice requestId={REQUEST} checkout="success" />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("couldn't check payment yet"));
    expect(screen.getByRole("status")).not.toHaveTextContent("Payment confirmed");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh question" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ready to open in Feed"));
  });

  it("keeps checking a cancelled Checkout hint for delayed settlement", async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValueOnce(respond(pending)).mockResolvedValueOnce(respond(paid));
    render(<AnswerPaymentReturnNotice requestId={REQUEST} checkout="cancelled" />);
    await tick();
    expect(screen.getByRole("status")).toHaveTextContent("Checkout was cancelled");
    expect(screen.getByRole("status")).not.toHaveTextContent("weren't charged");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("ready to open in Feed");
  });

  it("reports refund pending for a late payment on a closed question and then the refund", async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValueOnce(respond({ ...paid, requestStatus: "cancelled" }))
      .mockResolvedValueOnce(respond({ ...paid, requestStatus: "cancelled", orderStatus: "refunded", refundedAt: "2026-10-13T09:00:00Z" }));
    render(<AnswerPaymentReturnNotice requestId={REQUEST} checkout="success" />);
    await tick();
    expect(screen.getByRole("status")).toHaveTextContent("Refund pending");
    expect(screen.getByRole("status")).not.toHaveTextContent("Payment confirmed");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("was refunded");
  });

  it.each(["request", "account"])("discards a stale payment read after %s changes", async (change) => {
    let resolve!: (response: Response) => void;
    mocks.apiFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }))
      .mockResolvedValueOnce(respond(pending));
    const view = render(<AnswerPaymentReturnNotice requestId={REQUEST} checkout="success" />);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    if (change === "account") mocks.user = { uid: "requester-b", getIdToken: async () => "requester-b-token" };
    view.rerender(<AnswerPaymentReturnNotice requestId={change === "request" ? OTHER_REQUEST : REQUEST} checkout="success" />);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    await act(async () => { resolve(respond(paid)); await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("Payment is processing");
    expect(screen.getByRole("status")).not.toHaveTextContent("ready to open");
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves Drive's success route, status method and sharing copy", async () => {
    window.history.replaceState({}, "", `/one/feed?paymentRequestId=${REQUEST}&checkout=success`);
    mocks.driveStatus.mockResolvedValueOnce({ status: "paid", amountCents: 1000, currency: "usd" });
    render(<FeedPaymentReturnNotice />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sharing will continue shortly"));
    expect(mocks.driveStatus).toHaveBeenCalledExactlyOnceWith("requester-token", REQUEST);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith({ source: "drive_payment_confirmed" });
  });
});
