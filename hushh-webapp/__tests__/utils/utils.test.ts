import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn", () => {
  it("returns an empty string for empty input", () => {
    expect(cn()).toBe("");
  });
});