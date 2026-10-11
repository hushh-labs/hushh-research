import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetchStream: vi.fn(),
  onConsentMutated: vi.fn(),
  onFeedChanged: vi.fn(),
  dispatchFeedStateChanged: vi.fn(),
  dispatchConsentStateChanged: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetchStream: mocks.apiFetchStream },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/services/native-sse-fetch", () => ({ nativeStreamFetch: vi.fn() }));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: mocks.onConsentMutated, onFeedChanged: mocks.onFeedChanged },
}));
vi.mock("@/lib/feed/feed-events", () => ({ dispatchFeedStateChanged: mocks.dispatchFeedStateChanged }));
vi.mock("@/lib/consent/consent-events", () => ({
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));

import { useDocumentFeedStream } from "@/lib/feed/use-document-feed-stream";

const REQUEST = "11111111-2222-4333-8444-555555555555";

function stream(frames: string) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      // Leave it open as a real SSE stream; unmount aborts the fetch.
    },
  });
}

describe("document Feed stream", () => {
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.5); });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shares one stream between Feed and Payouts until the last surface closes", async () => {
    mocks.apiFetchStream.mockResolvedValue({ ok: true, status: 200, body: stream("event: feed_reset\ndata: {}\n\n") });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const feed = renderHook(() => useDocumentFeedStream(user));
    const payouts = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
    const signal = mocks.apiFetchStream.mock.calls[0][1].signal as AbortSignal;
    feed.unmount();
    expect(signal.aborted).toBe(false);
    payouts.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("does not dispatch an account event after its last consumer closes", async () => {
    let resolveResponse!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveResponse = resolve; });
    mocks.apiFetchStream.mockReturnValueOnce(pending);
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    const body = stream("event: feed_reset\ndata: {}\n\n");
    const cancel = vi.spyOn(body, "cancel");
    await act(async () => { resolveResponse({ ok: true, status: 200, body }); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
  });

  it("does not create a stream for an inactive Profile panel", async () => {
    const view = renderHook(() => useDocumentFeedStream(null));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiFetchStream).not.toHaveBeenCalled();
    view.unmount();
  });

  it("repairs on an opaque event, ignoring malformed request ids", async () => {
    vi.useFakeTimers();
    const body = stream([
      `event: feed_changed\nid: event-1\ndata: {"request_id":"${REQUEST}","file_name":"private.pdf"}\n\n`,
      "event: feed_changed\ndata: {\"request_id\":\"../../other\"}\n\n",
    ].join(""));
    mocks.apiFetchStream.mockResolvedValue({ ok: true, status: 200, body });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(mocks.apiFetchStream).toHaveBeenCalledWith(
      "/api/consent/document-feed/requester",
      expect.objectContaining({ headers: { Authorization: "Bearer token", Accept: "text/event-stream" } }),
    );
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
    mocks.apiFetchStream.mockResolvedValue({ ok: true, status: 200, body });
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

  it("reconnects after a dropped stream and rereads the server snapshot", async () => {
    vi.useFakeTimers();
    const first = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    mocks.apiFetchStream
      .mockResolvedValueOnce({ ok: true, status: 200, body: first })
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream("event: feed_reset\ndata: {}\n\n") });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({
      source: "sse_document_feed", requestId: undefined, reconcile: true,
    });
    result.unmount();
  });

  it("refreshes an expired token once without an authentication request storm", async () => {
    vi.useFakeTimers();
    mocks.apiFetchStream.mockResolvedValue({ ok: false, status: 401, body: null });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(user.getIdToken).toHaveBeenNthCalledWith(2, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(2);
    result.unmount();
  });

  it("repairs general Feed changes without inventing a document request or consent mutation", async () => {
    mocks.apiFetchStream.mockResolvedValue({ ok: true, status: 200, body: stream("event: feed_changed\ndata: {}\n\n") });
    const view = renderHook(() => useDocumentFeedStream({ uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.onFeedChanged).toHaveBeenCalledWith("requester");
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("arrived");
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    view.unmount();
  });

  it("settles a hung token lookup and ignores its late result after retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let finishToken!: (value: string) => void;
    const user = { uid: "requester", getIdToken: vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishToken = resolve; }))
      .mockResolvedValue("new-token") };
    mocks.apiFetchStream.mockResolvedValue({ ok: true, status: 200, body: stream("") });
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(11_100); });
    expect(user.getIdToken).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetchStream.mock.calls[0][1].headers.Authorization).toBe("Bearer new-token");
    await act(async () => { finishToken("old-token"); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("abandons a silent stream and reconnects with a fresh token lookup", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const cancel = vi.fn();
    const first = new ReadableStream<Uint8Array>({ cancel });
    mocks.apiFetchStream.mockResolvedValueOnce({ ok: true, status: 200, body: first })
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream("event: feed_reset\ndata: {}\n\n") });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(46_100); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("cancels a late response after the response-header deadline", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mocks.apiFetchStream.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream("") });
    const view = renderHook(() => useDocumentFeedStream({ uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(16_100); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(2);
    const body = stream("event: feed_reset\ndata: {}\n\n");
    const cancel = vi.spyOn(body, "cancel");
    await act(async () => finish({ ok: true, status: 200, body }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    view.unmount();
  });

  it("switches repeated failures to slow retries instead of reconnecting indefinitely", async () => {
    vi.useFakeTimers();
    mocks.apiFetchStream.mockResolvedValue({ ok: false, status: 503, body: null });
    const view = renderHook(() => useDocumentFeedStream({ uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(92_000); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(8);
    await act(async () => { await vi.advanceTimersByTimeAsync(250_000); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(8);
    view.unmount();
  });

  it("aborts hidden work and repairs once when returning to the app", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.apiFetchStream.mockImplementation(async () => ({ ok: true, status: 200, body: stream("") }));
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const view = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const firstSignal = mocks.apiFetchStream.mock.calls[0][1].signal as AbortSignal;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(2);
    expect(mocks.onFeedChanged).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
