// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.test",
}));

import { proxyExternalConnectorRequest } from "@/app/api/connectors/_proxy";

afterEach(() => vi.restoreAllMocks());

describe("connector proxy privacy", () => {
  it("never caches the short-lived owner-only Picker credential", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          accessToken: "synthetic-short-lived",
          sessionId: "opaque",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest(
      "https://app.test/api/connectors/google_drive/picker/session",
      {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({ origin: "https://app.test" }),
      },
    );
    const response = await proxyExternalConnectorRequest(request, [
      "google_drive",
      "picker",
      "session",
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({
      accessToken: "synthetic-short-lived",
      sessionId: "opaque",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://backend.test/api/connectors/google_drive/picker/session",
    );
    expect(init.headers.get("authorization")).toBe("Bearer synthetic-owner");
    expect(url).not.toContain("synthetic");
  });

  it("gives an allowed Drive question the same long budget as document preparation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const id = "11111111-1111-4111-8111-111111111111";
    const post = (path: string[]) =>
      proxyExternalConnectorRequest(
        new NextRequest(`https://app.test/api/connectors/${path.join("/")}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: 1 }),
        }),
        path,
      );
    await post(["google_drive", "sharing", "queries", id, "allow"]);
    await post(["google_drive", "sharing", "requests", id, "prepare"]);
    await post(["google_drive", "sharing", "queries", id, "deny"]);
    await post(["google_drive", "sharing", "queries"]);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
      170_000,
      170_000,
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(timeout.mock.calls[2][0]).toBeLessThan(170_000);
    expect(timeout.mock.calls[3][0]).toBeLessThan(170_000);
  });

  it("does not log upstream exception messages containing private material", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error("private-provider-response synthetic-secret"),
        ),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await proxyExternalConnectorRequest(
      new NextRequest("https://app.test/api/connectors"),
      [],
    );
    expect(response.status).toBe(502);
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret");
    expect(await response.text()).not.toContain("private-provider-response");
  });

  describe("streamed document preparation", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const path = ["google_drive", "sharing", "requests", id, "prepare", "stream"];
    const post = () =>
      proxyExternalConnectorRequest(
        new NextRequest(`https://app.test/api/connectors/${path.join("/")}`, {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-owner",
            "content-type": "application/json",
          },
          body: "{}",
        }),
        path,
      );
    const frame = (text: string) => new TextEncoder().encode(text);

    function upstream() {
      let push!: (chunk: Uint8Array) => void;
      let end!: () => void;
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk) => controller.enqueue(chunk);
          end = () => controller.close();
        },
        pull() {
          reads += 1;
        },
      });
      return { body, push: (c: Uint8Array) => push(c), end: () => end(), reads: () => reads };
    }

    it("passes stage frames through unbuffered with private headers", async () => {
      const source = upstream();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(source.body, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const response = await post();
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, no-cache, no-transform",
      );
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([200_000]);
      const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(init.headers.get("accept")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      source.push(frame('event: stage\ndata: {"event":"stage","stage":"starting"}\n\n'));
      const first = await reader.read();
      // Delivered before the upstream finished: nothing is buffered.
      expect(new TextDecoder().decode(first.value)).toContain('"starting"');
      source.end();
      expect((await reader.read()).done).toBe(true);
    });

    it("keeps draining the backend after the browser goes away", async () => {
      const source = upstream();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(source.body, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      const response = await post();
      await response.body!.cancel();
      source.push(frame("event: stage\ndata: {}\n\n"));
      source.push(frame("event: complete\ndata: {}\n\n"));
      source.end();
      await vi.waitFor(() => expect(source.reads()).toBeGreaterThan(2));
    });

    it("keeps an owner error from the stream route as buffered JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({ detail: "Owner authorization required" }, { status: 401 }),
        ),
      );
      const response = await post();
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ detail: "Owner authorization required" });
    });
  });
});
