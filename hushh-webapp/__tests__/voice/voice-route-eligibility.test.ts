import { describe, expect, it } from "vitest";

import { isVoiceEligibleRouteScreen } from "@/lib/voice/voice-route-eligibility";

describe("voice-route-eligibility", () => {
  it("keeps voice eligible on supported shared and investor screens when the command bar is visible", () => {
    expect(isVoiceEligibleRouteScreen("dashboard", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("profile", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("profile_receipts", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("consents", false)).toBe(true);
    expect(isVoiceEligibleRouteScreen("one_kyc", false)).toBe(true);
  });

  it("rejects hidden chrome and unknown app surfaces", () => {
    expect(isVoiceEligibleRouteScreen("profile", true)).toBe(false);
    expect(isVoiceEligibleRouteScreen("app", false)).toBe(false);
    expect(isVoiceEligibleRouteScreen("unknown", false)).toBe(false);
  });

  it("normalizes screen names and rejects empty route values", () => {
   expect(isVoiceEligibleRouteScreen(" Dashboard ", false)).toBe(true);
   expect(isVoiceEligibleRouteScreen("PROFILE", false)).toBe(true);

   expect(isVoiceEligibleRouteScreen("", false)).toBe(false);
   expect(isVoiceEligibleRouteScreen("   ", false)).toBe(false);
   expect(isVoiceEligibleRouteScreen(null, false)).toBe(false);
   expect(isVoiceEligibleRouteScreen(undefined, false)).toBe(false);
  });
});
