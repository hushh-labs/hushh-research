import { describe, expect, it } from "vitest";

import { humanizeConsentScope } from "@/lib/consent/consent-display";

describe("humanizeConsentScope", () => {
  it("returns 'Personal Knowledge Model access' for pkm.read scope", () => {
    expect(humanizeConsentScope("pkm.read")).toBe(
      "Personal Knowledge Model access",
    );
  });
});