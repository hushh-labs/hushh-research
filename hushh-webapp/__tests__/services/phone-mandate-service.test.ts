import { describe, expect, it } from "vitest";

import { ROUTES } from "@/lib/navigation/routes";
import { isPhoneMandatePath } from "@/lib/services/phone-mandate-service";

describe("isPhoneMandatePath", () => {
  it("detects the phone mandate route", () => {
    expect(
      isPhoneMandatePath(
        ROUTES.PHONE_MANDATE
      )
    ).toBe(true);
  });

  it("rejects non-phone-mandate routes", () => {
    expect(
      isPhoneMandatePath("/kai")
    ).toBe(false);

    expect(
      isPhoneMandatePath(null)
    ).toBe(false);
  });
});
