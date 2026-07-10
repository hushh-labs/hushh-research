import { describe, expect, it } from "vitest";

import { isConnectionRequestEntry } from "@/components/consent/connection-request-entry";

describe("isConnectionRequestEntry", () => {
  it("is true for connection_request kind", () => {
    expect(isConnectionRequestEntry({ kind: "connection_request" })).toBe(true);
  });
  it("is false for other kinds", () => {
    expect(isConnectionRequestEntry({ kind: "incoming_request" })).toBe(false);
  });
});
