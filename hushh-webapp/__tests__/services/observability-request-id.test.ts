import { describe, expect, it } from "vitest";

import { sanitizeRequestId } from "@/lib/observability/request-id";

describe("sanitizeRequestId", () => {
  it("accepts valid request ids", () => {
    expect(sanitizeRequestId("abc12345")).toBe("abc12345");
  });

  it("trims valid request ids", () => {
    expect(sanitizeRequestId("  abc12345  ")).toBe("abc12345");
  });
});
