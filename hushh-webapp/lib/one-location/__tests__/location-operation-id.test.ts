import { describe, expect, it } from "vitest";

import { boundedLocationOperationId } from "@/lib/one-location/location-operation-id";

describe("boundedLocationOperationId", () => {
  it("keeps ordinary operation ids readable", () => {
    expect(boundedLocationOperationId("share", "action-1", "user-a")).toBe(
      "share:action-1:user-a",
    );
  });

  it("bounds long ids without collapsing distinct recipients", () => {
    const upstream = "a".repeat(160);
    const first = boundedLocationOperationId("check-in", upstream, "user-a");
    const second = boundedLocationOperationId("check-in", upstream, "user-b");

    expect(first).toHaveLength(160);
    expect(second).toHaveLength(160);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
  });
});
