import { describe, expect, it } from "vitest";

import { validateHeaderTimestampConstraints } from "@/lib/observability/request-id";

describe("validateHeaderTimestampConstraints", () => {
  it("accepts valid timestamps", () => {
    expect(
      validateHeaderTimestampConstraints(900, {
        nowMs: 1000,
      })
    ).toEqual({
      isSyncBlockAccepted: true,
      errorLabel: null,
    });
  });
});
