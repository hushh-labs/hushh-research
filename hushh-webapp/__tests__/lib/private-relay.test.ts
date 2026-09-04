import { describe, expect, it } from "vitest";

import { isApplePrivateRelayEmail } from "@/lib/auth/private-relay";

describe("isApplePrivateRelayEmail", () => {
  it("detects a private relay address", () => {
    expect(
      isApplePrivateRelayEmail("abc123def@privaterelay.appleid.com"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isApplePrivateRelayEmail("ABC123DEF@PrivateRelay.AppleID.com"),
    ).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(
      isApplePrivateRelayEmail("  abc123def@privaterelay.appleid.com  "),
    ).toBe(true);
  });

  it("returns false for a real email", () => {
    expect(isApplePrivateRelayEmail("person@example.com")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isApplePrivateRelayEmail(null)).toBe(false);
    expect(isApplePrivateRelayEmail(undefined)).toBe(false);
    expect(isApplePrivateRelayEmail("")).toBe(false);
  });
});
