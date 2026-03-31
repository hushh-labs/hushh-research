import { describe, expect, it } from "vitest";

import { isVoiceEligibleRouteScreen } from "@/lib/voice/voice-route-eligibility";

describe("voice-route-eligibility", () => {
  it("keeps voice eligible on supported shared and investor screens when the command bar is visible", () => {
    expect(isVoiceEligibleRouteScreen("dashboard", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("profile", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("profile_receipts", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("consents", false)).toBe(true);
  });

  it("rejects hidden chrome and unknown app surfaces", () => {
    expect(isVoiceEligibleRouteScreen("profile", true)).toBe(false);
    expect(isVoiceEligibleRouteScreen("app", false)).toBe(false);
    expect(isVoiceEligibleRouteScreen("unknown", false)).toBe(false);
  });
});
