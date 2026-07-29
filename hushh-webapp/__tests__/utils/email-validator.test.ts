import { describe, it, expect } from "vitest";
import { isValidEmail } from "../../src/lib/utils/email-validator";

describe("isValidEmail", () => {
  it("accepts valid email", () => {
    expect(isValidEmail("test@example.com")).toBe(true);
  });

  it("rejects invalid email", () => {
    expect(isValidEmail("wrong-email")).toBe(false);
  });
});