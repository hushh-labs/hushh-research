import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetchStream: vi.fn(),
  onConsentMutated: vi.fn(),
  dispatchConsentStateChanged: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetchStream: mocks.apiFetchStream },
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: mocks.onConsentMutated },
}));
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
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("repairs on reconnect reset and on an opaque event, ignoring malformed request ids", async () => {
    const body = stream([
      "event: feed_reset\ndata: {}\n\n",
      `event: feed_changed\nid: event-1\ndata: {"request_id":"${REQUEST}","file_name":"private.pdf"}\n\n`,
      "event: feed_changed\ndata: {\"request_id\":\"../../other\"}\n\n",
    ].join(""));
    mocks.apiFetchStream.mockResolvedValue({ ok: true, status: 200, body });
    const user = { uid: "requester", getIdToken: vi.fn().mockResolvedValue("token") };
    const result = renderHook(() => useDocumentFeedStream(user));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.apiFetchStream).toHaveBeenCalledWith(
      "/api/consent/document-feed/requester",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(mocks.onConsentMutated).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchConsentStateChanged).toHaveBeenNthCalledWith(1, {
      source: "sse_document_feed", requestId: undefined, reconcile: true,
    });
    expect(mocks.dispatchConsentStateChanged).toHaveBeenNthCalledWith(2, {
      source: "sse_document_feed",
      requestId: `document_share_request:${REQUEST}`,
      reconcile: true,
    });
    expect(JSON.stringify(mocks.dispatchConsentStateChanged.mock.calls)).not.toContain("private.pdf");
    result.unmount();
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
});
