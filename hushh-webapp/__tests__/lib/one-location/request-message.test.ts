import { describe, expect, it } from "vitest";

import { buildOneLocationRequestMessage } from "@/lib/one-location/request-message";

describe("buildOneLocationRequestMessage", () => {
  it("preserves the selected reason when the optional message is blank", () => {
    expect(buildOneLocationRequestMessage("Safety check-in", "")).toBe(
      "Safety check-in",
    );
  });

  it("composes the selected reason with the optional message", () => {
    expect(
      buildOneLocationRequestMessage(
        "Meeting nearby",
        "I'm near the entrance",
      ),
    ).toBe("Meeting nearby — I'm near the entrance");
  });

  it("trims both fields without inventing content", () => {
    expect(
      buildOneLocationRequestMessage(
        "  Pick-up  ",
        "  Outside gate  ",
      ),
    ).toBe("Pick-up — Outside gate");
  });

  it("preserves legacy message-only callers and fails empty input closed", () => {
    expect(buildOneLocationRequestMessage(null, "Please share")).toBe(
      "Please share",
    );
    expect(buildOneLocationRequestMessage(null, "   ")).toBeUndefined();
  });
});
