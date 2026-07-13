import { describe, expect, it } from "vitest";

import { getCapabilityStatusDisplay } from "@/lib/onboarding/capability-status-display";

describe("getCapabilityStatusDisplay", () => {
  it("keeps the authored capability action visible before vault setup", () => {
    expect(
      getCapabilityStatusDisplay(
        {
          id: "gmail",
          state: "unknown",
          pendingCount: 0,
          prerequisite: "vault",
          requiresUnlock: true,
        },
        { actionLabel: "Connect Gmail", resumeActionLabel: "Finish Gmail" },
      ),
    ).toMatchObject({ label: "Connect Gmail", isActionable: true });
  });

  it("uses the authored continuation after partial setup", () => {
    expect(
      getCapabilityStatusDisplay(
        {
          id: "gmail",
          state: "in-progress",
          pendingCount: 0,
          prerequisite: null,
          requiresUnlock: false,
        },
        { actionLabel: "Connect Gmail", resumeActionLabel: "Finish Gmail" },
      ),
    ).toMatchObject({ label: "Finish Gmail", isActionable: true });
  });
});
