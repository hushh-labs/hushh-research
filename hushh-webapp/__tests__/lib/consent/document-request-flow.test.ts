import { describe, expect, it } from "vitest";

import { periodConflictNote } from "@/lib/consent/document-request-flow";

describe("periodConflictNote", () => {
  it("quotes the phrase longer than the picked dates, as the server flags it", () => {
    // The server flags "2 months"; "1 week" fits inside the picked month.
    expect(periodConflictNote("1 week of standups, last 2 months", "2026-09-02", "2026-10-02", "requester"))
      .toBe("Your note says 2 months. We used your dates: 2 Sep – 2 Oct.");
    expect(periodConflictNote(
      "notes from our 2 day offsite over the last 6 months", "2026-09-02", "2026-10-02", "owner",
    )).toBe("The note says 6 months. We used the picked dates: 2 Sep – 2 Oct.");
    expect(periodConflictNote("last 3 months meeting notes", "2026-09-02", "2026-10-02", "requester"))
      .toBe("Your note says 3 months. We used your dates: 2 Sep – 2 Oct.");
  });

  it("never quotes a span that fits the picked dates", () => {
    expect(periodConflictNote("1 month of meeting notes", "2026-09-02", "2026-10-02", "requester"))
      .toBe("We used your dates: 2 Sep – 2 Oct.");
  });
});
