import { describe, expect, it } from "vitest";

import { CONSENT_TOKEN_PREFIX } from "@/lib/constants";

describe("constants", () => {
  it("exports the correct consent token prefix", () => {
    expect(CONSENT_TOKEN_PREFIX).toBe("HCT");
  });
});