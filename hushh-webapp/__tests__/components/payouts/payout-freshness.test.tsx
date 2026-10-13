import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PayoutFreshness as Freshness } from "@/lib/payouts/payout-live-store";

const state = vi.hoisted(() => ({
  freshness: { lastSuccessAt: null, refreshing: false, failures: 0, online: true, stream: "polling" } as Freshness,
  invalidate: vi.fn(),
}));

vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: "owner-token" }) }));
vi.mock("@/lib/payouts/payout-live-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/payouts/payout-live-store")>(),
  usePayoutFreshness: () => state.freshness,
  invalidatePayoutResources: state.invalidate,
}));

import { PayoutFreshness } from "@/components/consent/payouts/payout-freshness";
import { PAYOUT_KINDS } from "@/lib/payouts/payout-events";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";

let NOW = Date.UTC(2026, 9, 11, 10);
const line = () => screen.getByTestId("payout-freshness");
const announced = () => screen.getByRole("status");
const show = (freshness: Partial<Freshness>) => { state.freshness = { ...state.freshness, ...freshness }; };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("payout freshness line", () => {
  beforeEach(() => {
    // The shared clock retains its snapshot between mounts. Keep fake time
    // monotonic so distinct tests cannot tick to an identical old snapshot.
    NOW += 24 * 60 * 60_000;
    vi.useFakeTimers();
    // The shared coarse clock retains its snapshot between mounts. Keep test
    // time moving forward so a tick cannot equal a previous test's snapshot.
    NOW += 24 * 60 * 60_000;
    vi.setSystemTime(NOW);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      setTimeout(() => callback(performance.now()), 16);
      return 1;
    });
    state.freshness = { lastSuccessAt: null, refreshing: false, failures: 0, online: true, stream: "polling" };
    state.invalidate.mockReset();
  });
  afterEach(() => {
    resetIdleSchedulerForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays hidden while fresh, then names the age on the 30 s clock", async () => {
    show({ lastSuccessAt: NOW - 45_000 });
    render(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^$/);
    // The idle clock wakes on the 30 s boundary, then runs after a frame.
    await advance(30_100);
    expect(line()).toHaveTextContent(/^Updated 1m ago$/);
    // The minutes ticking by are never announced.
    expect(announced()).toHaveTextContent(/^$/);
  });

  it("shows Updating… only for a triggered read on data over 10 s old, and only after 400 ms", async () => {
    show({ lastSuccessAt: NOW - 5_000, refreshing: true });
    const view = render(<PayoutFreshness />);
    await advance(1_000);
    expect(line()).toHaveTextContent(/^$/);

    show({ lastSuccessAt: NOW - 20_000 });
    view.rerender(<PayoutFreshness />);
    await advance(300);
    expect(line()).toHaveTextContent(/^$/);
    await advance(100);
    expect(line()).toHaveTextContent(/^Updating…$/);
    expect(announced()).toHaveTextContent(/^$/);

    show({ refreshing: false });
    view.rerender(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^$/);
  });

  it("offers Retry after two failed reads and announces only failure and going offline", async () => {
    show({ lastSuccessAt: NOW - 3 * 60_000, failures: 1 });
    const view = render(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^Updated 3m ago$/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    show({ failures: 2 });
    view.rerender(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^Couldn't update · Updated 3m ago\s*Retry$/);
    expect(announced()).toHaveTextContent(/^Couldn't update$/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith(PAYOUT_KINDS, "manual");

    show({ online: false, lastSuccessAt: NOW - 5 * 60_000 });
    view.rerender(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^Offline · Updated 5m ago$/);
    expect(announced()).toHaveTextContent(/^Offline$/);

    show({ online: true, failures: 0, lastSuccessAt: NOW });
    view.rerender(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^$/);
  });

  it("never says Updated just now after a failed read, and names the age from 1m on", async () => {
    show({ lastSuccessAt: NOW - 45_000, failures: 1 });
    const view = render(<PayoutFreshness />);
    // One quiet failure on data under a minute old: nothing to say yet.
    expect(line()).toHaveTextContent(/^$/);

    show({ failures: 2 });
    view.rerender(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^Couldn't update\s*Retry$/);
    expect(line()).not.toHaveTextContent("just now");
    expect(announced()).toHaveTextContent(/^Couldn't update$/);

    // The 30 s clock moves the last good read past a minute.
    await advance(30_100);
    expect(line()).toHaveTextContent(/^Couldn't update · Updated 1m ago\s*Retry$/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith(PAYOUT_KINDS, "manual");

    // Offline is not a failed read: its age may still be "just now".
    show({ online: false, failures: 0, lastSuccessAt: Date.now() - 20_000 });
    view.rerender(<PayoutFreshness />);
    expect(line()).toHaveTextContent(/^Offline · Updated just now$/);
  });
});
