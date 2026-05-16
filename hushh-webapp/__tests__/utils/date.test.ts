import { formatIsoDateOrFallback, parseDateOrNull } from "@/lib/utils/date";

describe("date utils", () => {
  it("parses ISO timestamps and preserves their instant", () => {
    const parsed = parseDateOrNull("2026-05-16T03:30:00.000+05:30");

    expect(parsed?.toISOString()).toBe("2026-05-15T22:00:00.000Z");
  });

  it("parses numeric timestamps", () => {
    const parsed = parseDateOrNull(1778882400000);

    expect(parsed?.toISOString()).toBe("2026-05-15T22:00:00.000Z");
  });

  it("rejects invalid, null, and undefined values", () => {
    expect(parseDateOrNull("not-a-date")).toBeNull();
    expect(parseDateOrNull(null)).toBeNull();
    expect(parseDateOrNull(undefined)).toBeNull();
  });

  it("formats valid dates as ISO strings and falls back for bad input", () => {
    expect(formatIsoDateOrFallback("2026-05-16T03:30:00.000+05:30")).toBe(
      "2026-05-15T22:00:00.000Z"
    );
    expect(formatIsoDateOrFallback("bad-date", "unavailable")).toBe("unavailable");
  });
});
