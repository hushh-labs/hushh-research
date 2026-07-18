import { describe, expect, it } from "vitest";

import {
  REQUEST_ID_HEADER,
  getOrCreateRequestId,
} from "@/lib/observability/request-id";

describe("getOrCreateRequestId", () => {
  it("uses a valid header value", () => {
    const result = getOrCreateRequestId(
      new Headers({
        [REQUEST_ID_HEADER]: "abc12345",
      })
    );

    expect(result).toBe("abc12345");
  });
});
