import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: "owner-a" as string | null, epoch: 1 }));

vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token }) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));

import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";
import {
  getPayoutFreshness,
  PAYOUT_READY_SOURCE,
  resetPayoutLiveStoreForTests,
  setPayoutStreamState,
  usePayoutResource,
  type PayoutResourceKey,
} from "@/lib/payouts/payout-live-store";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";

const KEYS: PayoutResourceKey[] = ["wallet", "account", "bank_payouts", "balance", "earnings"];
// A multiple of every poll interval (15 s, 45 s, 5 min), so idle-clock ticks land predictably.
const ALIGNED = Date.UTC(2026, 9, 11, 10);
const loads = Object.fromEntries(KEYS.map((key) => [key, vi.fn()])) as Record<PayoutResourceKey, ReturnType<typeof vi.fn>>;
const reads = () => Object.fromEntries(KEYS.map((key) => [key, loads[key].mock.calls.length])) as Record<PayoutResourceKey, number>;
let hidden = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mount(keys: PayoutResourceKey[]) {
  return renderHook(() => Object.fromEntries(keys.map((key) => [key, usePayoutResource(key, loads[key])])));
}

const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const advanceTo = (offset: number) => advance(ALIGNED + offset - Date.now());
const returnToPage = () => act(() => {
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
});
const setHidden = (value: boolean) => act(() => {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
});

describe("payout live store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ALIGNED + 5_000);
    state.token = "owner-a";
    state.epoch = 1;
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    for (const key of KEYS) loads[key].mockReset().mockImplementation(async () => ({ key }));
  });
  afterEach(() => {
    cleanup();
    resetPayoutLiveStoreForTests();
    resetIdleSchedulerForTests();
    vi.useRealTimers();
  });

  it("shares one read per resource and queues exactly one follow-up behind a read in flight", async () => {
    const first = deferred<object>();
    loads.wallet.mockImplementationOnce(() => first.promise);
    const view = renderHook(() => [usePayoutResource("wallet", loads.wallet), usePayoutResource("wallet", loads.wallet)]);
    expect(loads.wallet).toHaveBeenCalledExactlyOnceWith("owner-a");

    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    await advance(200);
    act(() => { view.result.current[0].retry(); });
    await advance(200);
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    await advance(200);
    expect(loads.wallet).toHaveBeenCalledOnce();

    await act(async () => { first.resolve({ balance: 1 }); });
    expect(loads.wallet).toHaveBeenCalledTimes(2);
    await flush();
    await advance(1_000);
    expect(loads.wallet).toHaveBeenCalledTimes(2);
    expect(view.result.current[0].data).toEqual({ key: "wallet" });
    expect(view.result.current[1].data).toBe(view.result.current[0].data);
  });

  it("coalesces change signals inside 150 ms into one read", async () => {
    mount(["wallet"]);
    await flush();
    const reread = deferred<object>();
    loads.wallet.mockImplementationOnce(() => reread.promise);
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    await advance(60);
    act(() => { dispatchPayoutStateChanged({ kinds: ["earnings", "wallet"], source: "sse" }); });
    await advance(60);
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "local_redeem" }); });
    expect(loads.wallet).toHaveBeenCalledOnce();
    await advance(40);
    expect(loads.wallet).toHaveBeenCalledTimes(2);
    // A change-triggered reread is what the freshness line calls "refreshing".
    expect(getPayoutFreshness().refreshing).toBe(true);
    await act(async () => { reread.resolve({ key: "wallet" }); });
    expect(getPayoutFreshness().refreshing).toBe(false);
    await advance(300);
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }); });
    await advance(150);
    expect(loads.wallet).toHaveBeenCalledTimes(3);
  });

  it("rereads only the resources a change names, never on unrelated consent changes", async () => {
    mount(["wallet", "account", "bank_payouts", "balance"]);
    await flush();
    const opened = reads();
    expect(opened).toMatchObject({ wallet: 1, account: 1, bank_payouts: 1, balance: 1 });

    // A bank deposit update never rereads the coin wallet or the Stripe account.
    act(() => { dispatchPayoutStateChanged({ kinds: ["bank_payouts"], source: "sse" }); });
    await advance(200);
    expect(reads()).toMatchObject({ wallet: 1, account: 1, bank_payouts: 2, balance: 2 });

    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], requestIds: ["11111111-1111-4111-8111-111111111111"], source: "sse" }); });
    await advance(200);
    expect(reads()).toMatchObject({ wallet: 2, account: 1, bank_payouts: 2, balance: 3 });

    // Feed frames and consent decisions stay on the consent bus.
    act(() => {
      dispatchConsentStateChanged({ source: "sse_document_feed", reconcile: true });
      dispatchConsentStateChanged({ source: "consent_approved" });
    });
    await advance(200);
    expect(reads()).toMatchObject({ wallet: 2, account: 1, bank_payouts: 2, balance: 3 });

    // The bank-ready announcement rereads the account, and nothing else.
    act(() => { dispatchConsentStateChanged({ source: PAYOUT_READY_SOURCE }); });
    await advance(200);
    expect(reads()).toMatchObject({ wallet: 2, account: 2, bank_payouts: 2, balance: 3 });

    // A reconnect rereads every kind, but pulls the Stripe-backed account only every 5 minutes.
    act(() => { dispatchPayoutStateChanged({ kinds: undefined, source: "sse_reset" }); });
    await advance(200);
    expect(reads()).toMatchObject({ wallet: 3, account: 2, bank_payouts: 3, balance: 4 });
    act(() => { dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" }); });
    await advance(200);
    expect(reads().account).toBe(3);
  });

  it("drops an old owner's data and replies when the vault session changes", async () => {
    const oldReply = deferred<object>();
    loads.wallet.mockImplementation((token: string) => token === "owner-a" ? oldReply.promise : Promise.resolve({ owner: token }));
    const view = mount(["wallet"]);
    state.token = "owner-b";
    state.epoch = 2;
    view.rerender();
    expect(view.result.current.wallet.data).toBeNull();
    expect(loads.wallet).toHaveBeenLastCalledWith("owner-b");
    await act(async () => { oldReply.resolve({ owner: "owner-a" }); });
    expect(view.result.current.wallet.data).toEqual({ owner: "owner-b" });

    // Same token, new vault session (a lock and unlock): nothing carries over.
    state.epoch = 3;
    view.rerender();
    expect(view.result.current.wallet.data).toBeNull();
    await flush();
    expect(loads.wallet).toHaveBeenCalledTimes(3);
    expect(view.result.current.wallet.data).toEqual({ owner: "owner-b" });

    state.token = null;
    view.rerender();
    await advance(60_000);
    expect(view.result.current.wallet.data).toBeNull();
    expect(loads.wallet).toHaveBeenCalledTimes(3);
  });

  it("keeps the last verified data while any payout reader is mounted, and only then", async () => {
    const payouts = mount(["bank_payouts"]);
    const payoutsScreen = mount(["wallet"]);
    await flush();
    payoutsScreen.unmount();
    await flush();
    // Back to Payouts while the Feed's bank cue stayed: the balance is there at once.
    const reopened = mount(["wallet"]);
    expect(reopened.result.current.wallet.data).toEqual({ key: "wallet" });
    expect(loads.wallet).toHaveBeenCalledOnce();

    reopened.unmount();
    payouts.unmount();
    await flush();
    const later = mount(["wallet"]);
    expect(later.result.current.wallet.data).toBeNull();
    expect(loads.wallet).toHaveBeenCalledTimes(2);
  });

  it("marks data stale on a failed read, on a change not read yet, and for a wallet past one minute", async () => {
    const view = mount(["wallet", "bank_payouts"]);
    await flush();
    expect(view.result.current.wallet.stale).toBe(false);

    // A known change: stale until its read lands.
    const change = deferred<object>();
    loads.bank_payouts.mockImplementationOnce(() => change.promise);
    act(() => { dispatchPayoutStateChanged({ kinds: ["bank_payouts"], source: "sse" }); });
    expect(view.result.current.bank_payouts.stale).toBe(true);
    await advance(200);
    await act(async () => { change.resolve({ key: "bank_payouts", changed: true }); });
    expect(view.result.current.bank_payouts.stale).toBe(false);

    // A failed refresh keeps the last verified data, flagged.
    loads.bank_payouts.mockRejectedValueOnce(new Error("unavailable"));
    act(() => { view.result.current.bank_payouts.retry(); });
    await advance(200);
    expect(view.result.current.bank_payouts).toMatchObject({ data: { key: "bank_payouts", changed: true }, failed: true, stale: true });
    expect(getPayoutFreshness().failures).toBe(1);

    // Age alone makes only the wallet stale (money acts on it).
    loads.wallet.mockImplementation(() => new Promise(() => {}));
    loads.bank_payouts.mockImplementation(() => new Promise(() => {}));
    await advance(59_000 - (Date.now() - (view.result.current.wallet.lastSuccessAt ?? 0)));
    expect(view.result.current.wallet.stale).toBe(false);
    await advance(2_000);
    expect(view.result.current.wallet.stale).toBe(true);
  });

  it("polls visible pages at 45 s, every 15 s for a moving transfer while the stream is not live, and the account every 5 min", async () => {
    mount(["wallet", "account"]);
    await flush();
    const polled = deferred<object>();
    loads.wallet.mockImplementationOnce(() => polled.promise);
    await advanceTo(45_100);
    expect(reads()).toMatchObject({ wallet: 2, account: 1 });
    // A fallback poll stays quiet: no "Updating…" every 45 s.
    expect(getPayoutFreshness().refreshing).toBe(false);
    await act(async () => { polled.resolve({ key: "wallet" }); });
    await advanceTo(135_100);
    expect(reads()).toMatchObject({ wallet: 4, account: 1 });
    await advanceTo(305_000);
    expect(reads().account).toBe(1);
    await advanceTo(315_100);
    expect(reads()).toMatchObject({ wallet: 8, account: 2 });

    // A transfer is pending and nothing streams: the wallet reads every 15 s.
    loads.wallet.mockImplementation(async () => ({ latestRedemption: { status: "pending" } }));
    act(() => { dispatchPayoutStateChanged({ kinds: ["wallet"], source: "local_redeem" }); });
    await advance(200);
    expect(reads().wallet).toBe(9);
    await advanceTo(360_100);
    expect(reads().wallet).toBe(12);

    // A live stream reports it instead: back to 45 s.
    act(() => { setPayoutStreamState("live"); });
    expect(getPayoutFreshness().stream).toBe("live");
    await advanceTo(405_100);
    expect(reads().wallet).toBe(13);

    // Nothing polls while the page is hidden.
    await setHidden(true);
    await advanceTo(600_100);
    expect(reads()).toMatchObject({ wallet: 13, account: 2 });
  });

  it("reads once per return, never queues behind a read in flight, and treats a long absence as stale", async () => {
    const view = mount(["bank_payouts", "balance"]);
    await flush();
    await returnToPage();
    await flush();
    expect(reads()).toMatchObject({ bank_payouts: 2, balance: 2 });
    await returnToPage();
    await flush();
    expect(reads()).toMatchObject({ bank_payouts: 2, balance: 2 });

    // A return during a read waits for nothing more after it.
    await advance(2_000);
    const slow = deferred<object>();
    loads.bank_payouts.mockImplementationOnce(() => slow.promise);
    act(() => { view.result.current.bank_payouts.retry(); });
    await advance(200);
    await returnToPage();
    await act(async () => { slow.resolve({ key: "bank_payouts" }); });
    await advance(1_000);
    expect(reads()).toMatchObject({ bank_payouts: 3, balance: 3 });

    // Changes while hidden wait for the return, which reads each resource once.
    await setHidden(true);
    act(() => { dispatchPayoutStateChanged({ kinds: ["bank_payouts"], source: "sse" }); });
    await advance(30_000);
    expect(reads()).toMatchObject({ bank_payouts: 3, balance: 3 });
    const pending = deferred<object>();
    loads.bank_payouts.mockImplementationOnce(() => pending.promise);
    await setHidden(false);
    expect(reads()).toMatchObject({ bank_payouts: 4, balance: 4 });
    expect(view.result.current.bank_payouts.stale).toBe(true);
    await act(async () => { pending.resolve({ key: "bank_payouts" }); });
    await advance(200);
    expect(reads().bank_payouts).toBe(4);
    expect(view.result.current.balance.stale).toBe(false);

    // A minute or more away: what is on screen stays stale until it is read again.
    const away = deferred<object>();
    loads.balance.mockImplementationOnce(() => away.promise);
    await setHidden(true);
    await advance(61_000);
    await setHidden(false);
    expect(view.result.current.balance.stale).toBe(true);
    await act(async () => { away.resolve({ key: "balance" }); });
    expect(view.result.current.balance.stale).toBe(false);
  });
});
