import { describe, it, expect } from "vitest";
import { isKaiAuthStatus } from "@/lib/services/kai-token-guard";

describe("isKaiAuthStatus", () => {
  it("returns true for status 401", () => {
    expect(isKaiAuthStatus(401)).toBe(true);
  });

  it("returns true for status 403", () => {
    expect(isKaiAuthStatus(403)).toBe(true);
  });

  it("returns false for status 200", () => {
    expect(isKaiAuthStatus(200)).toBe(false);
  });

  it("returns false for status 404", () => {
    expect(isKaiAuthStatus(404)).toBe(false);
  });

  it("returns false for status 500", () => {
    expect(isKaiAuthStatus(500)).toBe(false);
  });

  it("returns false for status 0", () => {
    expect(isKaiAuthStatus(0)).toBe(false);
  });

  it("returns false for a negative number", () => {
    expect(isKaiAuthStatus(-401)).toBe(false);
  });

  it("always returns a boolean", () => {
    expect(typeof isKaiAuthStatus(401)).toBe("boolean");
    expect(typeof isKaiAuthStatus(200)).toBe("boolean");
  });
});