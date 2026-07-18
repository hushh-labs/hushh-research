import { describe, expect, it } from "vitest";

describe("token-utils", () => {
  it("truncates token signature at exact 8-char boundary", async () => {
    const { truncateSignature } = await import("@/lib/token-utils");
    expect(truncateSignature("abcdefgh")).toBe("abcdefgh");
    expect(truncateSignature("abcdefghi")).toBe("abcdefgh...");
  });
});
