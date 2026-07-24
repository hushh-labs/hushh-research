import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout, isRequestTimeoutError } from "@/lib/api/request-timeout";

describe("request timeout guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through successful backend responses", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(fetchWithTimeout("https://api.test/config", { method: "GET" }, 100)).resolves.toBe(
      response
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves backend error responses for callers to shape", async () => {
    const response = new Response(JSON.stringify({ detail: "nope" }), { status: 503 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await fetchWithTimeout("https://api.test/config", { method: "GET" }, 100);

    expect(result.status).toBe(503);
  });

  it("identifies abort and timeout errors", () => {
    expect(isRequestTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isRequestTimeoutError({ name: "TimeoutError" })).toBe(true);
    expect(isRequestTimeoutError(new Error("backend failed"))).toBe(false);
  });
});
