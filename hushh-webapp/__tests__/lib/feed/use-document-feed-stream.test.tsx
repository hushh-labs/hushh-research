import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  onConsentMutated: vi.fn(),
  onFeedChanged: vi.fn(),
  onFeedHistoryMutated: vi.fn(),
  dispatchFeedStateChanged: vi.fn(),
  dispatchConsentStateChanged: vi.fn(),
  setPayoutStreamState: vi.fn(),
  auth: { sessionVerificationRequired: false },
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/services/document-feed-transport", () => ({
  createDocumentFeedTransport: () => ({ open: mocks.open }),
  createFeedStreamCoordinator: () => ({
    join: ({ onRole }: { onRole: (role: "leader") => void }) => onRole("leader"),
    post: () => {},
    leave: () => {},
  }),
  observeIdTokenChanges: () => () => {},
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: mocks.onConsentMutated, onFeedChanged: mocks.onFeedChanged, onFeedHistoryMutated: mocks.onFeedHistoryMutated },
}));
vi.mock("@/lib/feed/feed-events", () => ({ dispatchFeedStateChanged: mocks.dispatchFeedStateChanged }));
vi.mock("@/lib/consent/consent-events", () => ({
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));
vi.mock("@/lib/payouts/payout-live-store", () => ({
  setPayoutStreamState: mocks.setPayoutStreamState,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useDocumentFeedStream } from "@/lib/feed/use-document-feed-stream";
import { subscribePayoutStateChanged, type PayoutStateChangedDetail } from "@/lib/payouts/payout-events";

const REQUEST = "11111111-2222-4333-8444-555555555555";
const HELLO = 'event: hello\ndata: {"v":2,"heartbeat_ms":15000,"max_lifetime_ms":840000,"live":true}\n\n';

function stream(frames: string) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      // Leave it open as a real SSE stream; unmount aborts the attempt.
    },
  });
}

const ok = (body: ReadableStream<Uint8Array>) => ({ status: 200, body, retryAfterMs: null });
const failed = (status: number) => ({ status, body: null, retryAfterMs: null });
const flush = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });

describe("document Feed stream", () => {
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.5); });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mocks.auth.sessionVerificationRequired = false;
    publishValidatedAuthSessionOwner(null);
  });

  it("shares one stream between Feed and Payouts until the last surface closes", async () => {
    mocks.open.mockResolvedValue(ok(stream("event: feed_reset\ndata: {}\n\n")));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const app = renderHook(() => useDocumentFeedStream(user));
    const feed = renderHook(() => useDocumentFeedStream(user));
    const payouts = renderHook(() => useDocumentFeedStream(user));
    await flush();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open.mock.calls[0][0]).toMatchObject({ uid: "requester", token: "token" });
    const signal = mocks.open.mock.calls[0][0].signal as AbortSignal;
    feed.unmount();
    payouts.unmount();
    expect(signal.aborted).toBe(false);
    app.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("does not dispatch an account event after its last consumer closes", async () => {
    let resolveResponse!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveResponse = resolve; });
    mocks.open.mockReturnValueOnce(pending);
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await flush();
    view.unmount();
    const body = stream("event: feed_reset\ndata: {}\n\n");
    const cancel = vi.spyOn(body, "cancel");
    await act(async () => { resolveResponse(ok(body)); });
    await flush();
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
  });

  it("does not create a stream for an inactive Profile panel", async () => {
    const view = renderHook(() => useDocumentFeedStream(null));
    await flush();
    expect(mocks.open).not.toHaveBeenCalled();
    view.unmount();
  });

  it("invalidates saved history for a content-free deletion hint", async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue(ok(stream('event: feed_changed\ndata: {"reason":"history_mutated"}\n\n')));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(mocks.onFeedHistoryMutated).toHaveBeenCalledWith("requester");
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("arrived");
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
    result.unmount();
  });

  it("repairs on an opaque event, ignoring malformed request ids", async () => {
    vi.useFakeTimers();
    const body = stream([
      `event: feed_changed\nid: event-1\ndata: {"request_id":"${REQUEST}","file_name":"private.pdf"}\n\n`,
      "event: feed_changed\ndata: {\"request_id\":\"../../other\"}\n\n",
    ].join(""));
    mocks.open.mockResolvedValue(ok(body));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    const targeted = {
      source: "sse_document_feed",
      requestId: `document_share_request:${REQUEST}`,
      reconcile: true,
    };
    expect(mocks.dispatchConsentStateChanged.mock.calls).toEqual([[targeted]]);
    // The malformed id neither refreshes nor widens the trailing reread.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(mocks.dispatchConsentStateChanged.mock.calls).toEqual([[targeted], [targeted]]);
    expect(mocks.onConsentMutated).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.dispatchConsentStateChanged.mock.calls)).not.toContain("private.pdf");
    result.unmount();
  });

  it("refreshes on a burst's first frame, then once after it settles or reaches the cap", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let push!: (frames: string) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (frames) => controller.enqueue(encoder.encode(frames));
      },
    });
    mocks.open.mockResolvedValue(ok(body));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    const changed = `event: feed_changed\ndata: {"request_id":"${REQUEST}"}\n\n`;
    const dispatched = () => mocks.dispatchConsentStateChanged.mock.calls.length;
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await advance(50);

    push(`event: feed_reset\ndata: {}\n\n${changed}`);
    await advance(0);
    expect(dispatched()).toBe(1);
    await advance(900);
    push(changed);
    await advance(900);
    expect(dispatched()).toBe(1);
    await advance(100);
    expect(dispatched()).toBe(2);
    // The burst mixed a reset with a request, so its reread covers the account.
    expect(mocks.dispatchConsentStateChanged).toHaveBeenLastCalledWith({
      source: "sse_document_feed", requestId: undefined, reconcile: true,
    });

    // Frames every 500ms never go quiet; the cap rereads 5s after the burst began.
    push(changed);
    for (let elapsed = 500; elapsed < 5_000; elapsed += 500) {
      await advance(500);
      push(changed);
    }
    await advance(499);
    expect(dispatched()).toBe(3);
    await advance(1);
    expect(dispatched()).toBe(4);

    // Closing the last surface cancels the pending trailing reread.
    push(changed);
    await advance(0);
    expect(dispatched()).toBe(5);
    view.unmount();
    await advance(10_000);
    expect(dispatched()).toBe(5);
    expect(mocks.onConsentMutated).toHaveBeenCalledTimes(5);
  });

  it("repairs general Feed changes without inventing a document request or consent mutation", async () => {
    mocks.open.mockResolvedValue(ok(stream("event: feed_changed\ndata: {}\n\n")));
    const view = renderHook(() => useDocumentFeedStream({ uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") }));
    await flush();
    expect(mocks.onFeedChanged).toHaveBeenCalledWith("requester");
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("arrived");
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    view.unmount();
  });

  it("rings only the payout bus for payout frames and reports the stream state", async () => {
    vi.useFakeTimers();
    const payoutEvents: PayoutStateChangedDetail[] = [];
    const unsubscribe = subscribePayoutStateChanged((detail) => payoutEvents.push(detail));
    const encoder = new TextEncoder();
    let push!: (frames: string) => void;
    mocks.open.mockResolvedValue(ok(new ReadableStream<Uint8Array>({
      start(controller) { push = (frames) => controller.enqueue(encoder.encode(frames)); },
    })));
    const user = { uid: "owner", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    push(`${HELLO}event: payout_changed\ndata: {"kinds":["bank_payouts"],"request_ids":[]}\n\n`);
    // A minute of heartbeats spans at least one tick of the 45 s repair clock.
    for (let second = 0; second < 60; second += 15) {
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      push(`event: heartbeat\ndata: {"ts":${second},"live":true}\n\n`);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(payoutEvents).toEqual([{ kinds: ["bank_payouts"], source: "sse" }]);
    // A live stream covers the Feed: no consent cascade and no periodic repair.
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
    expect(mocks.onFeedChanged).not.toHaveBeenCalled();
    expect(mocks.setPayoutStreamState.mock.calls.map(([state]) => state)).toEqual(["reconnecting", "live"]);
    view.unmount();
    expect(mocks.setPayoutStreamState).toHaveBeenLastCalledWith("polling");
    unsubscribe();
  });

  it("reconnects after a dropped stream and rereads the server snapshot", async () => {
    vi.useFakeTimers();
    const first = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    mocks.open
      .mockResolvedValueOnce(ok(first))
      .mockResolvedValueOnce(ok(stream("event: feed_reset\ndata: {}\n\n")));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({
      source: "sse_document_feed", requestId: undefined, reconcile: true,
    });
    result.unmount();
  });

  it("refreshes an expired token once, then waits for the session to verify again", async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue(failed(401));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(user.getIdToken).toHaveBeenNthCalledWith(2, true);
    // No authentication request storm, however long the page stays open.
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 60_000); });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.setPayoutStreamState).toHaveBeenLastCalledWith("unavailable");

    mocks.auth.sessionVerificationRequired = true;
    view.rerender();
    mocks.auth.sessionVerificationRequired = false;
    view.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(mocks.open).toHaveBeenCalledTimes(3);
    expect(user.getIdToken).toHaveBeenLastCalledWith(true);
    view.unmount();
  });

  it("settles a hung token lookup and ignores its late result after retry", async () => {
    vi.useFakeTimers();
    let finishToken!: (value: string) => void;
    const user = { uid: "requester", getIdToken: vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishToken = resolve; }))
      .mockResolvedValue("new-token") };
    mocks.open.mockResolvedValue(ok(stream("")));
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(11_100); });
    expect(user.getIdToken).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open.mock.calls[0][0].token).toBe("new-token");
    await act(async () => { finishToken("old-token"); });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("abandons a silent stream and reconnects with a fresh token lookup", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const first = new ReadableStream<Uint8Array>({ cancel });
    mocks.open.mockResolvedValueOnce(ok(first))
      .mockResolvedValueOnce(ok(stream("event: feed_reset\ndata: {}\n\n")));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(46_100); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("cancels a late response after the response-header deadline", async () => {
    // Keep the wall-clock-aligned 45s repair outside this 16.1s timeout/retry window.
    vi.useFakeTimers({ now: 0 });
    let finish!: (value: unknown) => void;
    mocks.open.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(ok(stream("")));
    const view = renderHook(() => useDocumentFeedStream({ uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(16_100); });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    const body = stream("event: feed_reset\ndata: {}\n\n");
    const cancel = vi.spyOn(body, "cancel");
    // A wall-clock-aligned fallback may reconcile while the first response is
    // pending. The late response itself must not dispatch another change.
    const dispatchesBeforeLateResponse = mocks.dispatchConsentStateChanged.mock.calls.length;
    await act(async () => finish(ok(body)));
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledTimes(dispatchesBeforeLateResponse);
    view.unmount();
  });

  it("switches repeated failures to slow retries instead of reconnecting indefinitely", async () => {
    vi.useFakeTimers();
    // (A 503 is the server's busy signal and waits for Retry-After instead.)
    mocks.open.mockResolvedValue(failed(502));
    const view = renderHook(() => useDocumentFeedStream({ uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(92_000); });
    expect(mocks.open).toHaveBeenCalledTimes(8);
    await act(async () => { await vi.advanceTimersByTimeAsync(250_000); });
    expect(mocks.open).toHaveBeenCalledTimes(8);
    view.unmount();
  });

  it("aborts hidden work and repairs once when returning to the app", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.open.mockImplementation(async () => ok(stream("")));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const firstSignal = mocks.open.mock.calls[0][0].signal as AbortSignal;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.onFeedChanged).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.onFeedChanged).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("stops dispatching and reconnecting once another sign-in owns the tab", async () => {
    vi.useFakeTimers();
    publishValidatedAuthSessionOwner("requester");
    const encoder = new TextEncoder();
    let push!: (frames: string) => void;
    let close!: () => void;
    mocks.open.mockImplementation(async () => ok(new ReadableStream<Uint8Array>({
      start(controller) {
        push = (frames) => controller.enqueue(encoder.encode(frames));
        close = () => controller.close();
      },
    })));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    push(HELLO);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    mocks.setPayoutStreamState.mockClear();

    // Sign-out, then a sign-in on this tab before React replaced the stream.
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("requester");
    const payoutEvents: PayoutStateChangedDetail[] = [];
    const unsubscribe = subscribePayoutStateChanged((detail) => payoutEvents.push(detail));
    push(`event: feed_reset\ndata: {}\n\nevent: payout_changed\ndata: {"kinds":["wallet"]}\n\n`);
    close();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(mocks.onFeedChanged).not.toHaveBeenCalled();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    expect(payoutEvents).toEqual([]);
    expect(mocks.setPayoutStreamState).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    unsubscribe();
    view.unmount();
  });
});
