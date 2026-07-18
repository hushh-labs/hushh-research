import { describe, expect, it } from "vitest";

import { ROUTES } from "@/lib/navigation/routes";
import { shouldBypassPhoneMandateForRoute } from "@/lib/services/phone-mandate-service";

describe("shouldBypassPhoneMandateForRoute", () => {
  it("bypasses ria onboarding", () => {
    expect(
      shouldBypassPhoneMandateForRoute(
        ROUTES.RIA_ONBOARDING
      )
    ).toBe(true);
  });

  it("does not bypass other routes", () => {
    expect(
      shouldBypassPhoneMandateForRoute("/kai")
    ).toBe(false);

    expect(
      shouldBypassPhoneMandateForRoute(undefined)
    ).toBe(false);
  });
});
