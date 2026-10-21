import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequesterPaymentView } from "@/lib/consent/document-request-payment-view";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const state = vi.hoisted(() => ({
  decide: vi.fn(),
  checkout: vi.fn(),
  assign: vi.fn(),
  token: "vault-token" as string | null,
  epoch: 1,
  user: { uid: "reviewer", getIdToken: vi.fn(async () => "firebase-token") },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.user }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ getVaultOwnerToken: () => state.token }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
// Every clock the section subscribes to, by id: the shared periodic task and
// the shared coarse clock both register here, so a test sees any subscription.
const clock = vi.hoisted(() => ({ tasks: new Map<string, { intervalMs: number; run: () => void }>() }));
vi.mock("@/lib/perf/use-periodic-task", () => ({
  usePeriodicTask: (id: string, intervalMs: number, run: () => void, options: { enabled?: boolean } = {}) => {
    const enabled = options.enabled !== false;
    useEffect(() => {
      if (!enabled) return;
      clock.tasks.set(id, { intervalMs, run });
      return () => {
        clock.tasks.delete(id);
      };
    });
  },
  useCoarseClock: (intervalMs: number) => {
    useEffect(() => {
      const id = `coarse-clock:${intervalMs}:${Math.random()}`;
      clock.tasks.set(id, { intervalMs, run: () => undefined });
      return () => {
        clock.tasks.delete(id);
      };
    }, [intervalMs]);
    return Date.now();
  },
}));
vi.mock("@/lib/services/drive-request-payment-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-request-payment-service")>()),
  DriveRequestPaymentService: { checkout: state.checkout },
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: { decide: state.decide },
}));

import { RequesterPaymentSection } from "@/components/consent/requester-payment-section";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";
import type { DrivePackageDisclosure } from "@/lib/consent/drive-package-disclosure";

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

function show(view: RequesterPaymentView | null, onChanged = vi.fn(), ownerName?: string) {
  render(
    <RequesterPaymentSection
      requestId={requestId}
      revision={3}
      payment={view}
      price={null}
      ownerName={ownerName}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

/** The visible payment block (not the screen-reader announcement). */
const section = () => screen.getByTestId("requester-payment-section");

/** Move the device clock and run every clock task the section holds. */
function tick(ms: number) {
  vi.setSystemTime(Date.now() + ms);
  act(() => {
    for (const task of [...clock.tasks.values()]) task.run();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.token = "vault-token";
  state.epoch = 1;
  state.user = { uid: "reviewer", getIdToken: vi.fn(async () => "firebase-token") };
  vi.stubGlobal("location", { ...window.location, assign: state.assign });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clock.tasks.clear();
  state.decide.mockReset();
  state.checkout.mockReset();
  state.assign.mockReset();
});

describe("RequesterPaymentSection", () => {
  it("shows the exact approved coverage and limitations before enabling Pay", async () => {
    const disclosure: DrivePackageDisclosure = { schemaVersion: 1, packageDigest: "b".repeat(64), packageRevision: 2,
      selectedCount: 2, coverageStatus: "partial", periods: [{ start: "2026-09-01", end: "2026-09-30" }],
      limitations: ["Missing coverage: October 1–9, 2026."] };
    const props = { requestId, revision: 3, payment: payment({ packageDisclosureRequired: true }), price: null, onChanged: vi.fn() };
    const mounted = render(<RequesterPaymentSection {...props} />);
    const pay = screen.getByRole("button", { name: "Pay $25" });
    expect(pay).toBeDisabled();
    fireEvent.click(pay);
    expect(state.checkout).not.toHaveBeenCalled();
    mounted.rerender(<RequesterPaymentSection {...props} packageDisclosure={disclosure} />);
    expect(screen.getByText("Incomplete documents")).toBeVisible();
    expect(screen.getByText("2026-09-01 – 2026-09-30")).toBeVisible();
    expect(screen.getByText("Missing coverage: October 1–9, 2026.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Approved documents" }).compareDocumentPosition(pay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pay).toBeEnabled();
    state.checkout.mockResolvedValueOnce("https://checkout.stripe.com/c/pay/current");
    fireEvent.click(pay);
    await waitFor(() => expect(state.assign).toHaveBeenCalledOnce());
  });

  it("blocks Pay for malformed marked-packet details", () => {
    render(<RequesterPaymentSection requestId={requestId} revision={3}
      payment={payment({ packageDisclosureRequired: true })} price={null} onChanged={vi.fn()}
      packageDisclosure={{ schemaVersion: 1 } as DrivePackageDisclosure} />);
    expect(screen.getByRole("button", { name: "Pay $25" })).toBeDisabled();
    expect(screen.getByText("Document details are unavailable. Refresh before paying.")).toBeVisible();
  });

  it("does not reuse cached disclosure when the current payment explicitly has none", () => {
    render(<RequesterPaymentSection requestId={requestId} revision={3}
      payment={payment({ packageDisclosureRequired: true, packageDisclosure: null })} price={null} onChanged={vi.fn()}
      packageDisclosure={{ schemaVersion: 1, packageDigest: "b".repeat(64), packageRevision: 2,
        selectedCount: 1, coverageStatus: "complete", periods: [], limitations: [] }} />);
    expect(screen.getByRole("button", { name: "Pay $25" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Approved documents" })).toBeNull();
  });

  it.each(["account", "session", "request", "unmount"])("ignores late checkout after %s changes", async (boundary) => {
    let finish!: (url: string) => void;
    state.checkout.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    const onChanged = vi.fn();
    const props = { requestId, revision: 3, payment: payment(), price: null, onChanged };
    const mounted = render(<RequesterPaymentSection {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay $25" }));
    await waitFor(() => expect(state.checkout).toHaveBeenCalledOnce());
    if (boundary === "account") {
      state.user = { ...state.user, uid: "another-buyer" };
      mounted.rerender(<RequesterPaymentSection {...props} />);
    } else if (boundary === "session") state.epoch += 1;
    else if (boundary === "request") mounted.rerender(<RequesterPaymentSection {...props} requestId="22222222-2222-4222-8222-222222222222" />);
    else mounted.unmount();
    await act(async () => { finish("https://checkout.stripe.com/c/pay/old"); });
    expect(state.assign).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not send checkout when the account changes while its token is loading", async () => {
    let finish!: (token: string) => void;
    state.user.getIdToken.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    const props = { requestId, revision: 3, payment: payment(), price: null, onChanged: vi.fn() };
    const mounted = render(<RequesterPaymentSection {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay $25" }));
    state.user = { ...state.user, uid: "another-buyer" };
    mounted.rerender(<RequesterPaymentSection {...props} />);
    await act(async () => { finish("old-user-token"); });
    expect(state.checkout).not.toHaveBeenCalled();
    expect(state.assign).not.toHaveBeenCalled();
  });

  it("suppresses late checkout error and refresh after a session change", async () => {
    let fail!: (cause: Error) => void;
    state.checkout.mockReturnValueOnce(new Promise<string>((_, reject) => { fail = reject; }));
    const onChanged = show(payment());
    fireEvent.click(screen.getByRole("button", { name: "Pay $25" }));
    await waitFor(() => expect(state.checkout).toHaveBeenCalledOnce());
    state.epoch += 1;
    await act(async () => { fail(new Error("old request")); });
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes a successful no-charge completion without redirecting or showing an error", async () => {
    state.checkout.mockResolvedValueOnce({ requestId, existingAccess: true });
    const onChanged = show(payment());
    fireEvent.click(screen.getByRole("button", { name: "Pay $25" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(state.assign).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the countdown and starts the existing Checkout from Pay", async () => {
    state.checkout.mockResolvedValueOnce("https://checkout.stripe.com/c/pay/cs_test");
    show(payment());
    expect(section()).toHaveTextContent("Payment due");
    expect(section()).toHaveTextContent("Sharing starts after payment. · 29m left");
    fireEvent.click(screen.getByRole("button", { name: "Pay $25" }));
    await waitFor(() => expect(state.assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test"));
    expect(state.checkout).toHaveBeenCalledWith("firebase-token", requestId);
  });

  it.each([
    ["identity", "owner"], ["identity", "request"], ["identity", "vault"], ["identity", "unmount"],
    ["checkout", "owner"], ["checkout", "request"], ["checkout", "vault"], ["checkout", "unmount"],
  ] as const)("retires pending %s when %s changes", async (stage, retirement) => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { settle = resolve; });
    if (stage === "identity") state.user.getIdToken.mockReturnValueOnce(pending);
    else state.checkout.mockReturnValueOnce(pending);
    const onChanged = vi.fn();
    const props = { requestId, revision: 3, payment: payment(), price: null, onChanged };
    const view = render(<RequesterPaymentSection {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pay $25" })); });
    if (stage === "checkout") expect(state.checkout).toHaveBeenCalledOnce();
    if (retirement === "unmount") view.unmount();
    else {
      if (retirement === "owner") state.user = { uid: "replacement", getIdToken: vi.fn(async () => "other-token") };
      if (retirement === "vault") state.epoch += 1;
      view.rerender(<RequesterPaymentSection {...props} requestId={retirement === "request" ? "replacement-request" : requestId} />);
    }
    await act(async () => { settle(stage === "identity" ? "firebase-token" : "https://checkout.stripe.com/c/pay/cs_test"); });
    if (stage === "identity") expect(state.checkout).not.toHaveBeenCalled();
    expect(state.assign).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not refresh or show a retired Checkout failure in the replacement session", async () => {
    let fail!: (cause: Error) => void;
    state.checkout.mockReturnValueOnce(new Promise<string>((_, reject) => { fail = reject; }));
    const onChanged = vi.fn();
    const props = { requestId, revision: 3, payment: payment(), price: null, onChanged };
    const view = render(<RequesterPaymentSection {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pay $25" })); });
    state.user = { uid: "replacement", getIdToken: vi.fn(async () => "other-token") };
    view.rerender(<RequesterPaymentSection {...props} />);
    await act(async () => { fail(new Error("Checkout failed")); });
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.assign).not.toHaveBeenCalled();
  });

  it("explains a closed payment window without offering Pay", () => {
    show(payment({ state: "link_expired", checkoutExpiresAt: null, nextAction: "new_request" }), vi.fn(), "Alex");
    expect(section()).toHaveTextContent("Payment link expired");
    // Says where to go next instead of promising an action the panel lacks.
    expect(section()).toHaveTextContent("Ask Alex again from their profile.");
    expect(section()).not.toHaveTextContent("Send a new request");
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();
  });

  it("keeps the countdown and Pay out of the live region and announces only state changes", () => {
    show(payment({ checkoutExpiresAt: at(45_000) }));
    const live = screen.getByRole("status");
    const pay = screen.getByRole("button", { name: "Pay $25" });
    expect(live).not.toContainElement(pay);
    expect(section()).toHaveTextContent("45s left");
    // Opening the panel announces nothing; it is read in place.
    const heard = new Set([live.textContent]);
    for (let second = 0; second < 5; second += 1) {
      tick(1_000);
      heard.add(screen.getByRole("status").textContent);
    }
    expect(section()).toHaveTextContent("40s left");
    expect([...heard]).toEqual([""]);
    // The window closing is a state change, and is said once.
    tick(40_000);
    expect(screen.getByRole("status").textContent).toBe(
      "Payment link expired. Ask the owner again from their profile.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(/left/);
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();
  });

  it("subscribes to a clock only while the view can change on its own", () => {
    const refunded = payment({
      state: "refunded", checkoutExpiresAt: null, nextAction: "none",
      refund: { status: "succeeded", amountCents: 2500 },
    });
    for (const settled of [
      refunded,
      payment({ state: "paid", checkoutExpiresAt: null, nextAction: "none" }),
      payment({ state: "closed", checkoutExpiresAt: null, nextAction: "none" }),
      payment({ state: "none", amountCents: null, checkoutExpiresAt: null, nextAction: "none" }),
    ]) {
      show(settled);
      expect(clock.tasks.size).toBe(0);
      cleanup();
    }
    show(null);
    expect(clock.tasks.size).toBe(0);
    cleanup();
    // An open request can still expire: a slow clock, never per second.
    show(payment({ state: "awaiting_owner", checkoutExpiresAt: null, nextAction: "wait_owner" }));
    expect([...clock.tasks.values()].map((task) => task.intervalMs)).toEqual([30_000]);
    cleanup();
    show(payment());
    expect([...clock.tasks.values()].map((task) => task.intervalMs)).toEqual([1_000]);
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

  it.each(["owner", "unmount"])("retires a withdrawal reply after %s changes", async (retirement) => {
    let settle!: (value: { requestId: string; status: string; payment: RequesterPaymentView }) => void;
    state.decide.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const onChanged = vi.fn();
    const props = { requestId, revision: 3, payment: payment(), price: null, onChanged };
    const view = render(<RequesterPaymentSection {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Withdraw request/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Withdraw request/ })); });
    expect(state.decide).toHaveBeenCalledOnce();
    if (retirement === "unmount") view.unmount();
    else {
      state.user = { uid: "replacement", getIdToken: vi.fn(async () => "other-token") };
      view.rerender(<RequesterPaymentSection {...props} />);
    }
    await act(async () => { settle({ requestId, status: "cancelled", payment: payment({ state: "closed", withdrawn: true }) }); });
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Request withdrawn")).toBeNull();
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
    expect(section()).toHaveTextContent("Refunded $25");
    expect(screen.queryByRole("button", { name: /Withdraw/ })).toBeNull();
    cleanup();
    show(null);
    expect(screen.queryByTestId("requester-payment-section")).toBeNull();
    show(payment({ state: "none", amountCents: null, checkoutExpiresAt: null, nextAction: "none" }));
    expect(screen.queryByTestId("requester-payment-section")).toBeNull();
  });
});
