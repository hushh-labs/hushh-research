import { NextRequest } from "next/server";
import { afterEach, vi } from "vitest";

import { POST as cancelConsent } from "@/app/api/consent/cancel/route";
import { POST as logoutConsent } from "@/app/api/consent/logout/route";
import { POST as revokeConsent } from "@/app/api/consent/revoke/route";
import { POST as issueSessionToken } from "@/app/api/consent/session-token/route";
import { POST as setupVault } from "@/app/api/vault/setup/route";

function malformedPost(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
}

async function expectInvalidJson(response: Response) {
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: "Invalid JSON payload",
  });
}

describe("malformed JSON route handling", () => {
  it("rejects malformed vault setup payloads before backend work", async () => {
    await expectInvalidJson(
      await setupVault(malformedPost("/api/vault/setup")),
    );
  });

  it.each([
    ["/api/consent/cancel", cancelConsent],
    ["/api/consent/logout", logoutConsent],
    ["/api/consent/revoke", revokeConsent],
    ["/api/consent/session-token", issueSessionToken],
  ])("rejects malformed consent payloads for %s", async (path, handler) => {
    await expectInvalidJson(await handler(malformedPost(path)));
  });
});

describe("request-specific consent revocation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function request(requestId?: unknown) {
    return new NextRequest("http://localhost/api/consent/revoke", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "owner", scope: "attr.synthetic.release", requestId }),
    });
  }

  it.each([undefined, "request-target"])("preserves the chosen revocation boundary: %s", async requestId => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "revoked" })));
    vi.stubGlobal("fetch", upstream);
    expect((await revokeConsent(request(requestId))).status).toBe(200);
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toEqual({
      userId: "owner", scope: "attr.synthetic.release", ...(requestId === undefined ? {} : { requestId }),
    });
    expect(upstream.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-owner" });
  });

  it.each(["", "  ", null, 17, "x".repeat(129)])("refuses an invalid request selector without widening it: %s", async requestId => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect((await revokeConsent(request(requestId))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
