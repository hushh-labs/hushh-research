import { describe, it, expect } from "vitest";
import { reverseString } from "../../src/lib/utils/reverse-string";

describe("reverseString", () => {
  it("reverses text", () => {
    expect(reverseString("hello")).toBe("olleh");
  });
});