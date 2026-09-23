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
});
