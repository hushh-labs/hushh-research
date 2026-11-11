// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  domainData: {} as Record<string, unknown>,
  saveSucceeds: true,
  recordLiveActivity: vi.fn(),
  // The owner snapshot taken before the write must be the one the journal checks.
  origin: { owner: { userId: "user-123" }, reset: 0 },
}));

vi.mock("@/lib/pkm/live-activity/live-activity-journal", () => ({
  recordLiveActivity: mocks.recordLiveActivity,
  snapshotLiveActivityOwner: () => mocks.origin,
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: async (params: {
      build: (context: { currentDomainData: Record<string, unknown>; currentManifest: null }) => {
        domainData: Record<string, unknown>;
      };
    }) => {
      const plan = params.build({ currentDomainData: mocks.domainData, currentManifest: null });
      if (!mocks.saveSucceeds) return { success: false, message: "Vault write failed." };
      mocks.domainData = plan.domainData;
      return { success: true, saveState: "saved" };
    },
  },
}));

import { addSavedLocation, removeSavedLocation, updateSavedLocation } from "@/lib/one-location/saved-locations";

const CONTEXT = { userId: "user-123", vaultKey: "vault-key", vaultOwnerToken: "vault-owner-token" };
const OFFICE = {
  category: "other" as const,
  label: "Office",
  latitude: 37.4275,
  longitude: -122.1697,
  address: "450 Jane Stanford Way, Stanford, CA",
};

describe("saved place live activity", () => {
  beforeEach(() => {
    mocks.domainData = {};
    mocks.saveSucceeds = true;
    mocks.recordLiveActivity.mockReset();
  });

  it("records a committed save with the owner's label and nothing else", async () => {
    await addSavedLocation({ context: CONTEXT, input: OFFICE });

    expect(mocks.recordLiveActivity.mock.calls).toEqual([[{ kind: "place_saved", label: "Office" }, mocks.origin]]);
  });

  it("records the removed place by label only", async () => {
    const [office] = await addSavedLocation({
      context: CONTEXT,
      input: { ...OFFICE, label: "Dezzerto, Shop 9, Tower 1, Pune" },
    });
    mocks.recordLiveActivity.mockReset();

    await removeSavedLocation({ context: CONTEXT, id: office!.id });

    expect(mocks.recordLiveActivity.mock.calls).toEqual([[{ kind: "place_removed", label: "Dezzerto" }, mocks.origin]]);
  });

  it("never records a street address as a place name", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: { ...OFFICE, label: "742 Evergreen Terrace, Springfield", address: "742 Evergreen Terrace, Springfield, OR" },
    });

    expect(mocks.recordLiveActivity.mock.calls).toEqual([[{ kind: "place_saved", label: null }, mocks.origin]]);
  });

  it("never records a street address as a place name when the stored address is composed with a landmark", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: {
        ...OFFICE,
        label: "742 Evergreen Terrace",
        address: "Near City Park, 742 Evergreen Terrace, Springfield, OR",
        addressBase: "742 Evergreen Terrace, Springfield, OR",
      },
    });

    expect(mocks.recordLiveActivity.mock.calls).toEqual([[{ kind: "place_saved", label: null }, mocks.origin]]);
  });

  it("keeps a premise name that its own address merely opens with", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: { ...OFFICE, label: "Phoenix Marketcity", address: "Phoenix Marketcity, Viman Nagar Road, Pune" },
    });

    expect(mocks.recordLiveActivity.mock.calls).toEqual([[{ kind: "place_saved", label: "Phoenix Marketcity" }, mocks.origin]]);
  });

  it("records nothing when an edit moves a place into Home, even though its id changes", async () => {
    await addSavedLocation({ context: CONTEXT, input: { ...OFFICE, category: "home", label: "Home" } });
    const gym = (await addSavedLocation({ context: CONTEXT, input: { ...OFFICE, label: "Gym", latitude: 37.43 } }))
      .find((location) => location.label === "Gym");
    expect(gym?.id).not.toBe("home");
    mocks.recordLiveActivity.mockReset();

    await updateSavedLocation({ context: CONTEXT, id: gym!.id, input: { ...OFFICE, category: "home", label: "Gym", latitude: 37.43 } });

    expect(mocks.recordLiveActivity).not.toHaveBeenCalled();
  });

  it("records nothing when the encrypted write fails", async () => {
    mocks.saveSucceeds = false;

    await expect(addSavedLocation({ context: CONTEXT, input: OFFICE })).rejects.toThrow("Vault write failed.");
    expect(mocks.recordLiveActivity).not.toHaveBeenCalled();
  });
});
