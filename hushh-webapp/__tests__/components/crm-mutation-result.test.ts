import { describe, expect, it } from "vitest";

import { mutationResultError } from "@/components/profile/connected-systems-panel";

describe("CRM mutation result classification", () => {
  it("classifies partial terminal results as unverified failures", () => {
    expect(mutationResultError({ status: "partial" })).toBe(
      "CRM request could not be fully verified.",
    );
    expect(mutationResultError({ resultClass: "partial" })).toBe(
      "CRM request could not be fully verified.",
    );
  });
});
