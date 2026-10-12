import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  onConsentMutated: vi.fn(),
  dispatchConsentStateChanged: vi.fn(),
  setPayoutStreamState: vi.fn(),
  auth: { sessionVerificationRequired: false },
}));

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
  CacheSyncService: { onConsentMutated: mocks.onConsentMutated },
}));
vi.mock("@/lib/consent/consent-events", () => ({
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));
vi.mock("@/lib/payouts/payout-live-store", () => ({
  setPayoutStreamState: mocks.setPayoutStreamState,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));

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

describe("document Feed stream hook", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.auth.sessionVerificationRequired = false;
  });

  it("shares one stream between Feed and Payouts until the last surface closes", async () => {
    mocks.open.mockResolvedValue(ok(stream("event: feed_reset\ndata: {}\n\n")));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const feed = renderHook(() => useDocumentFeedStream(user));
    const payouts = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open.mock.calls[0][0]).toMatchObject({ uid: "requester", token: "token" });
    const signal = mocks.open.mock.calls[0][0].signal as AbortSignal;
    feed.unmount();
    expect(signal.aborted).toBe(false);
    payouts.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("does not dispatch an account event after its last consumer closes", async () => {
    let resolveResponse!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveResponse = resolve; });
    mocks.open.mockReturnValueOnce(pending);
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    const body = stream("event: feed_reset\ndata: {}\n\n");
    const cancel = vi.spyOn(body, "cancel");
    await act(async () => { resolveResponse(ok(body)); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
  });

  it("does not create a stream for an inactive Profile panel", async () => {
    const view = renderHook(() => useDocumentFeedStream(null));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.open).not.toHaveBeenCalled();
    view.unmount();
  });

  it("repairs on an opaque event with one reread, ignoring malformed request ids", async () => {
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
    // A single frame is one burst: no echo reread after it settles.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.dispatchConsentStateChanged.mock.calls).toEqual([[targeted]]);
    expect(mocks.onConsentMutated).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.dispatchConsentStateChanged.mock.calls)).not.toContain("private.pdf");
    result.unmount();
  });

  it("rings only the payout bus for payout frames and reports the stream state", async () => {
    vi.useFakeTimers();
    const payoutEvents: PayoutStateChangedDetail[] = [];
    const unsubscribe = subscribePayoutStateChanged((detail) => payoutEvents.push(detail));
    mocks.open.mockResolvedValue(ok(stream(
      `${HELLO}event: payout_changed\ndata: {"kinds":["bank_payouts"],"request_ids":[]}\n\n`,
    )));
    const user = { uid: "owner", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(payoutEvents).toEqual([{ kinds: ["bank_payouts"], source: "sse" }]);
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
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
    mocks.open.mockResolvedValue({ status: 401, body: null, retryAfterMs: null });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(user.getIdToken).toHaveBeenNthCalledWith(2, true);
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
});
