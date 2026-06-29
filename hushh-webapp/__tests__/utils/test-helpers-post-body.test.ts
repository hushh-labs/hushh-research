import { describe, expect, it } from "vitest";

import { createMockPOST } from "./test-helpers";

describe("createMockPOST", () => {
  it("serializes request body as json", async () => {
    const request = createMockPOST("/api/test", {
      name: "gracy",
      role: "tester",
    });

    await expect(request.json()).resolves.toEqual({
      name: "gracy",
      role: "tester",
    });
  });
});