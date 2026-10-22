import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxyEmailAuth } from "@/app/api/auth/email/_proxy";

vi.mock("@/app/api/_utils/backend", () => ({ getPythonApiUrl: () => "http://127.0.0.1:8000" }));

describe("Email auth browser origin boundary", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ status: "accepted" })));
  });

  it("accepts the actual loopback authority despite Next URL normalization and rejects another origin", async () => {
    const request = (origin: string) => new NextRequest("http://localhost:3000/api/auth/email/request", {
      method: "POST", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    });
    expect((await proxyEmailAuth(request("http://127.0.0.1:3000"), "request")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await proxyEmailAuth(request("https://other.example"), "request")).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
