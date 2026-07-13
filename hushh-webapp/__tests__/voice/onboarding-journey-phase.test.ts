import { resolvePostPhoneOnboardingPhase } from "@/lib/onboarding/onboarding-journey-phase";
import { describe, expect, it } from "vitest";

describe("post-phone onboarding phase", () => {
  it("returns to the setup hub unless the durable root gate is already resolved", () => {
    expect(resolvePostPhoneOnboardingPhase(false)).toBe("setup_hub");
    expect(resolvePostPhoneOnboardingPhase(true)).toBe("root_completion");
  });
});
