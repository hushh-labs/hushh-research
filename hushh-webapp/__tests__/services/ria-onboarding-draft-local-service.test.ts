import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
}));

import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";

describe("RiaOnboardingDraftLocalService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a normalized per-user draft", async () => {
    await RiaOnboardingDraftLocalService.save("uid-1", {
      currentStepId: "review",
      requestedCapabilities: ["brokerage", "advisory"],
      displayName: "Kai Advisor",
      individualLegalName: "",
      individualCrd: "",
      advisoryFirmName: "",
      advisoryFirmIapdNumber: "",
      brokerFirmName: "",
      brokerFirmCrd: "",
      headline: "",
      strategySummary: "",
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "ria_onboarding_draft_v1:uid-1",
        value: expect.stringContaining("\"currentStepId\":\"review\""),
      })
    );
  });

  it("loads and normalizes invalid drafts safely", async () => {
    getMock.mockResolvedValueOnce({
      value: JSON.stringify({
        currentStepId: "not-real",
        requestedCapabilities: ["invalid"],
        displayName: "Kai Advisor",
      }),
    });

    const draft = await RiaOnboardingDraftLocalService.load("uid-1");
    expect(draft).toEqual(
      expect.objectContaining({
        currentStepId: "capabilities",
        requestedCapabilities: ["advisory"],
        displayName: "Kai Advisor",
      })
    );
  });

  it("clears a persisted draft", async () => {
    await RiaOnboardingDraftLocalService.clear("uid-1");

    expect(removeMock).toHaveBeenCalledWith({
      key: "ria_onboarding_draft_v1:uid-1",
    });
  });
});
