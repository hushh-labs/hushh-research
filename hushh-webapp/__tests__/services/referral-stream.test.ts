import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { ApiService } from "@/lib/services/api-service";

/**
 * The live connection behind the Referrals tab.
 *
 * The property that matters is not "a stream opens" -- it is that the stream
 * carries a doorbell and the client re-reads through the authenticated
 * endpoint. A stream that carried the counts would be a second, quieter place
 * where "what may this referrer see" gets decided, and the two would drift.
 */

function streamOf(...frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const fakeUser = {
  uid: "test_user",
  getIdToken: () => Promise.resolve("id-token-abc"),
} as unknown as Parameters<typeof useReferralStream>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useReferralStream", () => {
  it("authenticates the stream with the caller's own token", async () => {
    const spy = vi
      .spyOn(ApiService, "apiFetchStream")
      .mockResolvedValue(streamOf('event: ready\ndata: {}\n\n'));

    renderHook(() => useReferralStream(fakeUser, vi.fn()));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [path_, init] = spy.mock.calls[0];
    expect(path_).toBe("/api/one/referrals/events");
    expect(new Headers(init?.headers as HeadersInit).get("Authorization")).toBe(
      "Bearer id-token-abc",
    );
  });

  it("calls back on a change event, so the client re-reads the summary", async () => {
    vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(
      streamOf(
        "event: ready\ndata: {}\n\n",
        'event: referral_changed\ndata: {"reason":"engagement"}\n\n',
      ),
    );
    const onChange = vi.fn();

    renderHook(() => useReferralStream(fakeUser, onChange));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it("ignores heartbeats, which are for the connection and not the screen", async () => {
    vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(
      streamOf(
        "event: ready\ndata: {}\n\n",
        'event: heartbeat\ndata: {"timestamp":1}\n\n',
        'event: heartbeat\ndata: {"timestamp":2}\n\n',
      ),
    );
    const onChange = vi.fn();

    renderHook(() => useReferralStream(fakeUser, onChange));

    await waitFor(() => expect(ApiService.apiFetchStream).toHaveBeenCalled());
    // Give the reader a turn before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reads events split across chunk boundaries", async () => {
    // A frame can arrive in pieces. Splitting on lines instead of on the blank
    // line that terminates a frame drops exactly these events, and only under
    // load, which is the worst way to find out.
    vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(
      streamOf("event: referral_ch", 'anged\ndata: {"reason":"x"}', "\n\n"),
    );
    const onChange = vi.fn();

    renderHook(() => useReferralStream(fakeUser, onChange));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it("reports disconnected when the stream cannot open, so polling resumes", async () => {
    vi.spyOn(ApiService, "apiFetchStream").mockRejectedValue(new Error("no stream"));

    const { result } = renderHook(() => useReferralStream(fakeUser, vi.fn()));

    await waitFor(() => expect(ApiService.apiFetchStream).toHaveBeenCalled());
    expect(result.current.connected).toBe(false);
  });

  it("opens nothing when nobody is signed in", async () => {
    const spy = vi.spyOn(ApiService, "apiFetchStream");
    renderHook(() => useReferralStream(null, vi.fn()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the referral SSE proxy route", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/one/referrals/events/route.ts"),
    "utf8",
  );

  it("hands the upstream body straight back instead of re-serialising it", () => {
    // The catch-all /api/one proxy reads its upstream to completion and
    // re-serialises as JSON. A stream through it does not error -- it arrives
    // as {} with status 200 and the screen simply never updates. This route
    // exists to avoid exactly that, so the property is worth pinning.
    expect(source).toContain("new Response(upstream.body");
    expect(source).toContain('"Content-Type": "text/event-stream"');
    expect(source).toContain('"X-Accel-Buffering": "no"');
    expect(source).not.toContain("await upstream.json()");
    expect(source).not.toContain("await upstream.text()");
  });

  it("refuses an unauthenticated stream before reaching the backend", () => {
    expect(source).toContain('if (!authorization)');
    expect(source).toContain("status: 401");
  });

  it("takes no user id from the URL", () => {
    // A stream keyed on a path parameter is a stream someone can point at
    // another person. This one is scoped by the token only.
    expect(source).not.toContain("[userId]");
    expect(source).not.toContain("params");
  });
});
