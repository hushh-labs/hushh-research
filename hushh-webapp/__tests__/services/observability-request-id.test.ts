import { describe, expect, it } from "vitest";

import {
  REQUEST_ID_HEADER,
  getOrCreateRequestId,
} from "@/lib/observability/request-id";

describe("getOrCreateRequestId", () => {
  it("creates a replacement for invalid header values", () => {
    const result = getOrCreateRequestId(
      new Headers({
        [REQUEST_ID_HEADER]: "bad id",
      })
    );

    expect(result).toBeTruthy();
    expect(result).not.toBe("bad id");
  });
});
