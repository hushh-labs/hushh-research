import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";

describe("createHotGetJsonCache", () => {
  it("clears inflight only for matching request promise", () => {
    const cache = createHotGetJsonCache({
      freshTtlMs: 1_000,
      staleTtlMs: 2_000,
    });
    const firstRequest = Promise.resolve({ status: 200, payload: "first" });
    const secondRequest = Promise.resolve({ status: 200, payload: "second" });

    cache.setInflight("portfolio", firstRequest);
    cache.setInflight("portfolio", secondRequest);
    cache.clearInflight("portfolio", firstRequest);

    expect(cache.getInflight("portfolio")).toBe(secondRequest);

    cache.clearInflight("portfolio", secondRequest);

    expect(cache.getInflight("portfolio")).toBeNull();
  });
});
