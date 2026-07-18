import { describe, expect, it } from "vitest";

import { sanitizeRequestId } from "@/lib/observability/request-id";

describe("sanitizeRequestId", () => {
  it("rejects invalid request ids", () => {
    expect(sanitizeRequestId("")).toBeNull();
    expect(sanitizeRequestId("bad id")).toBeNull();
    expect(sanitizeRequestId("%%%%")).toBeNull();
  });
});
