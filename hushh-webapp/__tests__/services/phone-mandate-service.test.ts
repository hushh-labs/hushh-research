import { describe, expect, it } from "vitest";

import { shouldRequirePhoneMandate } from "@/lib/services/phone-mandate-service";

describe("shouldRequirePhoneMandate", () => {
  it("requires a mandate when no bypass conditions apply", () => {
    expect(
      shouldRequirePhoneMandate({
        hasVault: false,
      })
    ).toBe(true);
  });
});
