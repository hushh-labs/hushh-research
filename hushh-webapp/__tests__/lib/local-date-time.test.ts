import { describe, expect, it } from "vitest";

import { formatLocalDateTime } from "@/lib/utils/local-date-time";

describe("formatLocalDateTime", () => {
  it("renders valid instants in the runtime locale without a zone label", () => {
    const formatted = formatLocalDateTime("2026-07-30T03:33:00Z", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    expect(formatted).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date("2026-07-30T03:33:00Z")),
    );
    expect(formatted).not.toMatch(/\b(?:UTC|GMT)\b/i);
  });

  it("returns null for an invalid instant", () => {
    expect(formatLocalDateTime("not-a-date")).toBeNull();
  });
});
