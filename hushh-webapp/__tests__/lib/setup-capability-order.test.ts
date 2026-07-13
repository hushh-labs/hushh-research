import { describe, expect, it } from "vitest";

import { groupSetupCapabilities } from "@/lib/onboarding/setup-capability-order";

describe("setup capability presentation order", () => {
  it("moves completed rows to the bottom without reordering either group", () => {
    const groups = groupSetupCapabilities(
      [
        { id: "gmail", complete: false },
        { id: "location", complete: true },
        { id: "email", complete: false },
        { id: "finance", complete: true },
      ],
      (item) => item.complete,
    );

    expect(groups.remaining.map((item) => item.id)).toEqual(["gmail", "email"]);
    expect(groups.complete.map((item) => item.id)).toEqual([
      "location",
      "finance",
    ]);
    expect(groups.visible.map((item) => item.id)).toEqual([
      "gmail",
      "email",
      "location",
      "finance",
    ]);
  });

  it("keeps the complete group empty until one capability is complete", () => {
    const groups = groupSetupCapabilities(
      [{ id: "gmail", complete: false }],
      (item) => item.complete,
    );
    expect(groups.complete).toEqual([]);
    expect(groups.visible).toEqual(groups.remaining);
  });
});
