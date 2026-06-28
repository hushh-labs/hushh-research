import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn", () => {
  it("merges conditional class names", () => {
    expect(cn("flex", false && "hidden", "items-center")).toBe(
      "flex items-center",
    );
  });

  it("lets later tailwind classes override earlier conflicts", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("ignores null, undefined, and empty string values", () => {
  expect(cn("flex", null, undefined, "", "items-center")).toBe(
    "flex items-center",
  );
});
});