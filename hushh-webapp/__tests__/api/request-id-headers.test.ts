import { describe, expect, it } from "vitest";

import { createUpstreamHeaders } from "@/app/api/_utils/request-id";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

describe("createUpstreamHeaders", () => {
  it("preserves a custom header string containing nested colon punctuation characters", () => {
    const rawInput = "custom:header:string";
    const headers = createUpstreamHeaders("req_colon_123", {
      "X-Hushh-Custom-Metadata": rawInput,
    });

    expect(headers.get(REQUEST_ID_HEADER)).toBe("req_colon_123");
    expect(headers.get("X-Hushh-Custom-Metadata")).toBe(rawInput);
  });
});
