import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchDemoPortfolioTemplateAsset } from "@/lib/services/demo-mode-template-service";

describe("demo-mode-template-service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the demo portfolio template asset", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    vi.stubGlobal("fetch", mockFetch);

    await fetchDemoPortfolioTemplateAsset();

    const [url] = mockFetch.mock.calls[0];

    expect(url).toContain("/demo-mode/portfolio-template.json");
  });

  it("returns the parsed JSON body on success", async () => {
    const fixture = {
      holdings: [],
      generatedAt: "2026-01-01",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fixture),
      }),
    );

    const result = await fetchDemoPortfolioTemplateAsset();

    expect(result).toEqual(fixture);
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      }),
    );

    await expect(
      fetchDemoPortfolioTemplateAsset(),
    ).rejects.toThrow("Demo template unavailable.");
  });

  it("returns an empty object when JSON parsing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error("malformed json")),
      }),
    );

    const result = await fetchDemoPortfolioTemplateAsset();

    expect(result).toEqual({});
  });
});