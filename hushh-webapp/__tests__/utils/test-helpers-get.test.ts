import { describe, expect, it } from "vitest";

import { createMockGET } from "./test-helpers";

describe("createMockGET", () => {
  it("preserves custom headers on GET requests", () => {
    const request = createMockGET(
      "/api/test",
      { q: "hello" },
      { Authorization: "Bearer test-token" },
    );

    expect(request.method).toBe("GET");
    expect(request.nextUrl.pathname).toBe("/api/test");
    expect(request.nextUrl.searchParams.get("q")).toBe("hello");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
  });
});