import { describe, it, expect } from "vitest";
import { normalizeInput } from "@/lib/utils/input-normalizer";

describe("normalizeInput", () => {
  it("trims string values", () => {
    const input = { name: "  John  " };
    expect(normalizeInput(input)).toEqual({ name: "John" });
  });

  it("removes empty strings", () => {
    const input = { name: "" };
    expect(normalizeInput(input)).toEqual({});
  });

  it("removes null and undefined", () => {
    const input = { a: null, b: undefined };
    expect(normalizeInput(input)).toEqual({});
  });

  it("keeps numbers and booleans", () => {
    const input = { age: 20, active: true };
    expect(normalizeInput(input)).toEqual({ age: 20, active: true });
  });
});