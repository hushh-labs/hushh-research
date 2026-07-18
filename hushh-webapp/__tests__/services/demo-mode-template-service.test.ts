import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDemoPortfolioTemplateAsset } from "@/lib/services/demo-mode-template-service";

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("fetchDemoPortfolioTemplateAsset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("returns parsed json when the request succeeds", async () => {
    const payload = { portfolio: [] };

    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    const result = await fetchDemoPortfolioTemplateAsset();

    expect(result).toEqual(payload);
  });

  it("throws when the asset request fails", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 500,
      })
    );

    await expect(fetchDemoPortfolioTemplateAsset()).rejects.toThrow(
      "Demo template unavailable."
    );
  });

  it("returns an empty object when json parsing fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockRejectedValue(new Error("invalid json")),
    });

    const result = await fetchDemoPortfolioTemplateAsset();

    expect(result).toEqual({});
  });

  it("uses the demo template asset path", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await fetchDemoPortfolioTemplateAsset();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url] = mockFetch.mock.calls[0];

    expect(String(url)).toContain(
      "/demo-mode/portfolio-template.json?v=2026-02-25"
    );
  });
});
