import { describe, expect, it } from "vitest";
import { clearGeneratedDriveSearchDraft, DEFAULT_DRIVE_SEARCH_DRAFT } from "@/lib/agent/drive-search-draft";

describe("saved Drive result draft", () => {
  it("clears only an untouched generated prompt when the result is removed", () => {
    expect(clearGeneratedDriveSearchDraft(DEFAULT_DRIVE_SEARCH_DRAFT, true)).toBe("");
    expect(clearGeneratedDriveSearchDraft("Share this with my Trusted circle", false))
      .toBe("Share this with my Trusted circle");
    expect(clearGeneratedDriveSearchDraft(DEFAULT_DRIVE_SEARCH_DRAFT, false))
      .toBe(DEFAULT_DRIVE_SEARCH_DRAFT);
  });
});
