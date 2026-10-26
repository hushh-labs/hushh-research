import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/market/quotes/route";
import { fetchPythonApi } from "@/app/api/_utils/backend";

vi.mock("@/app/api/_utils/backend", () => ({ fetchPythonApi: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("forwards only the public symbols query, without owner credentials or cookies", async () => {
  const payload = { quotes: [{ symbol: "ADBE", price: 261.19, quoted_at: null, is_stale: true }] };
  vi.mocked(fetchPythonApi).mockResolvedValueOnce(Response.json(payload));
  const response = await GET(new NextRequest("https://app.test/api/market/quotes?symbols=ADBE&owner=synthetic", {
    headers: { Authorization: "Bearer synthetic-owner-token", Cookie: "session=synthetic-cookie" },
  }));
  const [path, options] = vi.mocked(fetchPythonApi).mock.calls[0]!;
  expect(path).toBe("/api/market/quotes?symbols=ADBE");
  expect(options?.headers).toBeUndefined();
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual(payload);
});

it("rejects an oversized query before forwarding it", async () => {
  expect((await GET(new NextRequest("https://app.test/api/market/quotes?symbols=" + "A".repeat(1025)))).status).toBe(400);
  expect(fetchPythonApi).not.toHaveBeenCalled();
});
