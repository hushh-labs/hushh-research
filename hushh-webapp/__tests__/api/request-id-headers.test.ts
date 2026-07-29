import { describe, expect, it } from "vitest";

import { createUpstreamHeaders } from "@/app/api/_utils/request-id";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

describe("createUpstreamHeaders", () => {
  it("preserves colon-delimited custom header values when creating upstream request headers", () => {
    const compoundHeaderValue = "tier1:component:auth-proxy-relay";
    const headers = createUpstreamHeaders("req_network_123", {
      "X-Hushh-Custom-Metadata": compoundHeaderValue,
    });

    expect(headers.get(REQUEST_ID_HEADER)).toBe("req_network_123");
    expect(headers.get("X-Hushh-Custom-Metadata")).toBe(compoundHeaderValue);
  });
});
