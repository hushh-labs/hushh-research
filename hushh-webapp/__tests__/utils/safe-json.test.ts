import { safeJsonParse, safeJsonStringify } from "@/lib/utils/safe-json";

describe("safe json utils", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"enabled":true}', { enabled: false })).toEqual({
      enabled: true,
    });
  });

  it("returns the fallback for malformed JSON", () => {
    expect(safeJsonParse("{bad", { enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("stringifies values and falls back for circular input", () => {
    expect(safeJsonStringify({ enabled: true })).toBe('{"enabled":true}');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJsonStringify(circular, "{}")).toBe("{}");
  });
});
