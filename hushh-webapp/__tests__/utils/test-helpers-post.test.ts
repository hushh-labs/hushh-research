import { describe, expect, it } from "vitest";

import { createMockPOST } from "./test-helpers";

describe("createMockPOST", () => {
  it("sets json content type for post requests", () => {
    const request = createMockPOST("/api/test", {
      name: "gracy",
    });

    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toContain(
      "application/json",
    );
  });
});