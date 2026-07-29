import { describe, it, expect } from "vitest";
import { toLowercase } from "../../src/lib/utils/to-lowercase";

describe("toLowercase", () => {
  it("converts text to lowercase", () => {
    expect(toLowercase("HELLO")).toBe("hello");
  });
});