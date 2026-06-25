import { describe, expect, it } from "vitest";

import { createMockRequest } from "./test-helpers";

describe("test helpers", () => {
  it("uses localhost as the default request origin", () => {
    const request = createMockRequest("/api/test");

    expect(request.nextUrl.origin).toBe("http://localhost:3000");
    expect(request.nextUrl.pathname).toBe("/api/test");
  });
});