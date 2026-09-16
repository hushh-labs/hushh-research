import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({ getPythonApiUrl: () => "https://backend.test" }));
import { POST } from "@/app/api/consent/vault-owner-token/route";

afterEach(() => vi.unstubAllGlobals());

describe("owner token renewal proxy", () => {
  it.each([
    [403, "AUTH_VAULT_OWNER_INVALID"],
    [503, "AUTH_ACCOUNT_STATUS_UNAVAILABLE"],
    [423, "AUTH_ACCOUNT_DELETION_IN_PROGRESS"],
  ])("forwards renewal evidence and preserves typed %s failure", async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(
      { detail: { code, message: "private backend diagnostic" } }, { status: Number(status) },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const result = await POST(new NextRequest("https://app.test/api/consent/vault-owner-token", {
      method: "POST", headers: { Authorization: "Bearer synthetic-firebase" },
      body: JSON.stringify({ userId: "synthetic-owner", renewalOfToken: "synthetic-prior" }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      userId: "synthetic-owner", renewalOfToken: "synthetic-prior",
    });
    expect(result.status).toBe(status);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.json()).toEqual({ error: "Failed to issue VAULT_OWNER token", code });
  });
});
