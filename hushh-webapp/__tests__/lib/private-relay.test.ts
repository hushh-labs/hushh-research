import { describe, expect, it } from "vitest";

import { isApplePrivateRelayEmail } from "@/lib/auth/private-relay";

describe("isApplePrivateRelayEmail", () => {
  it("detects a private relay address (@privaterelay.appleid.com)", () => {
    expect(
      isApplePrivateRelayEmail("abc123def@privaterelay.appleid.com"),
    ).toBe(true);
  });

  it("detects a private relay address (@private.icloud.com)", () => {
    expect(
      isApplePrivateRelayEmail("abc123def@private.icloud.com"),
    ).toBe(true);
  });

  it("is case-insensitive for both relay domains", () => {
    expect(
      isApplePrivateRelayEmail("ABC123DEF@PrivateRelay.AppleID.com"),
    ).toBe(true);
    expect(
      isApplePrivateRelayEmail("ABC123DEF@Private.ICloud.com"),
    ).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(
      isApplePrivateRelayEmail("  abc123def@privaterelay.appleid.com  "),
    ).toBe(true);
    expect(
      isApplePrivateRelayEmail("  abc123def@private.icloud.com  "),
    ).toBe(true);
  });

  it("returns false for a real email", () => {
    expect(isApplePrivateRelayEmail("person@example.com")).toBe(false);
    expect(isApplePrivateRelayEmail("person@gmail.com")).toBe(false);
  });

  it("returns false for standard iCloud email (not private relay)", () => {
    expect(isApplePrivateRelayEmail("person@icloud.com")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isApplePrivateRelayEmail(null)).toBe(false);
    expect(isApplePrivateRelayEmail(undefined)).toBe(false);
    expect(isApplePrivateRelayEmail("")).toBe(false);
  });
});
