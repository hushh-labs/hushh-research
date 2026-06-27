import { describe, expect, it } from "vitest";

import { createMockGET } from "./test-helpers";

describe("createMockGET", () => {
  it("applies multiple query params to the request url", () => {
    const request = createMockGET("/api/search", {
      q: "vault",
      page: "2",
    });

    expect(request.method).toBe("GET");
    expect(request.nextUrl.pathname).toBe("/api/search");
    expect(request.nextUrl.searchParams.get("q")).toBe("vault");
    expect(request.nextUrl.searchParams.get("page")).toBe("2");
  });
});