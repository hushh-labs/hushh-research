import { describe, expect, it } from "vitest";

import {
  isPersonalGmailEmail,
  shouldUseGoogleBrandMark,
} from "@/lib/profile/profile-auth-provider-presentation";

describe("Profile auth-provider presentation", () => {
  it("recognizes Gmail's consumer domains regardless of casing or whitespace", () => {
    expect(isPersonalGmailEmail("  person@gmail.com ")).toBe(true);
    expect(isPersonalGmailEmail("person@GOOGLEMAIL.COM")).toBe(true);
  });

  it("keeps the Google brand mark for personal Gmail Google sign-ins only", () => {
    expect(shouldUseGoogleBrandMark("google", "person@gmail.com")).toBe(true);
    expect(shouldUseGoogleBrandMark("google.com", "person@googlemail.com")).toBe(
      true,
    );
    expect(shouldUseGoogleBrandMark("google", "person@hushh.ai")).toBe(false);
    expect(shouldUseGoogleBrandMark("google", "person@example.com")).toBe(false);
    expect(shouldUseGoogleBrandMark("apple", "person@gmail.com")).toBe(false);
  });

  it("fails closed to the work-profile presentation for missing or malformed email", () => {
    expect(shouldUseGoogleBrandMark("google", null)).toBe(false);
    expect(shouldUseGoogleBrandMark("google", "not-an-email")).toBe(false);
  });
});
