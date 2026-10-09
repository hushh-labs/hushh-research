import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  apiFetch: vi.fn(),
  dispatchConsentStateChanged: vi.fn(),
  user: { getIdToken: async () => "firebase-token" },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock("@/lib/services/drive-request-payment-service", () => ({
  DriveRequestPaymentService: { status: mocks.status },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));
vi.mock("@/lib/consent/consent-events", () => ({
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));

import { FeedPaymentReturnNotice } from "@/components/feed/feed-payment-return-notice";

afterEach(() => {
  vi.useRealTimers();
  mocks.status.mockReset();
  mocks.apiFetch.mockReset();
  mocks.dispatchConsentStateChanged.mockReset();
  window.history.replaceState({}, "", "/one/feed");
});

describe("Feed payment return", () => {
  it("waits for server confirmation after Stripe returns", async () => {
    window.history.replaceState({}, "", "/one/feed?paymentRequestId=11111111-1111-4111-8111-111111111111&checkout=success");
    mocks.status
      .mockResolvedValueOnce({ status: "checkout_open", amountCents: 1000, currency: "usd" })
      .mockResolvedValueOnce({ status: "paid", amountCents: 1000, currency: "usd" });
    vi.useFakeTimers();
    render(<FeedPaymentReturnNotice />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("Payment is processing");
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("Payment confirmed");
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledOnce();
  });

  it("does not promise sharing when a paid request needs reconciliation", async () => {
    window.history.replaceState({}, "", "/one/feed?paymentRequestId=11111111-1111-4111-8111-111111111111&checkout=success");
    mocks.status.mockResolvedValueOnce({
      status: "paid", amountCents: 1000, currency: "usd", reconciliationRequired: true,
    });
    render(<FeedPaymentReturnNotice />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("We're checking this request"));
    expect(screen.getByRole("status")).not.toHaveTextContent("Sharing will continue");
  });

  it("confirms an owner-priced payment through the real amount check", async () => {
    const actual = await vi.importActual<typeof import("@/lib/services/drive-request-payment-service")>(
      "@/lib/services/drive-request-payment-service",
    );
    mocks.status.mockImplementation(actual.DriveRequestPaymentService.status);
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "paid", amountCents: 2000, currency: "usd" })));
    window.history.replaceState({}, "", "/one/feed?paymentRequestId=11111111-1111-4111-8111-111111111111&checkout=success");
    render(<FeedPaymentReturnNotice />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Payment confirmed"));
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({ source: "drive_payment_confirmed" });
  });

  it("explains when the Stripe payment link expired", async () => {
    window.history.replaceState({}, "", "/one/feed?paymentRequestId=11111111-1111-4111-8111-111111111111&checkout=success");
    mocks.status.mockResolvedValueOnce({ status: "expired", amountCents: 1000, currency: "usd" });
    render(<FeedPaymentReturnNotice />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("payment link expired"));
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({ source: "drive_payment_expired" });
  });
});
