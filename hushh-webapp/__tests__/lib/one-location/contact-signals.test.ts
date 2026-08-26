import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildMarketplaceContactLookups,
  mockSyncContacts,
  mockGetPermissionState,
  mockOpenAppSettings,
} = vi.hoisted(() => ({
  mockBuildMarketplaceContactLookups: vi.fn(),
  mockSyncContacts: vi.fn(),
  mockGetPermissionState: vi.fn(),
  mockOpenAppSettings: vi.fn(),
}));

vi.mock("@/lib/marketplace/contact-matching", () => ({
  CONTACT_SYNC_BATCH_SIZE: 1000,
  CONTACT_SYNC_MAX_LOOKUPS: 5000,
  buildMarketplaceContactLookups: mockBuildMarketplaceContactLookups,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    getPermissionState: mockGetPermissionState,
    openAppSettings: mockOpenAppSettings,
  },
}));

vi.mock("@/lib/services/connections-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/connections-service")>()),
  ConnectionsService: { syncContacts: mockSyncContacts },
}));

import {
  OneLocationContactSyncError,
  openContactPermissionSettings,
  syncOneLocationContactSignals,
} from "@/lib/one-location/contact-signals";
import { ConnectionsServiceRequestError } from "@/lib/services/connections-service";

function lookupResult(count: number) {
  return {
    totalContacts: count,
    readContactCount: count,
    unreadContactCount: 0,
    uncheckableContactCount: 0,
    excludedSelfContactCount: 0,
    lookupLimitExceeded: false,
    lookupLimitedContactCount: 0,
    sourcePlatform: "android" as const,
    region: "IN",
    limited: false,
    truncated: false,
    lookups: Array.from({ length: count }, (_, index) => ({
      lookupId: `lookup_${index + 1}`,
      hash: String(index).padStart(64, "a").slice(-64),
      last4: String(index).padStart(4, "0").slice(-4),
    })),
    contacts: Array.from({ length: count }, (_, index) => ({
      contactKey: `contact_${index + 1}`,
      displayName: `Local ${index + 1}`,
      lookupIds: [`lookup_${index + 1}`],
      coverageComplete: true,
    })),
  };
}

describe("one location contact signals", () => {
  beforeEach(() => {
    mockBuildMarketplaceContactLookups.mockReset();
    mockSyncContacts.mockReset();
    mockGetPermissionState.mockReset();
    mockOpenAppSettings.mockReset();
    mockGetPermissionState.mockResolvedValue({ state: "granted" });
  });

  it("batches a large book exactly and classifies contacts rather than profile rows", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2501));
    mockSyncContacts
      .mockResolvedValueOnce({
        matches: [
          {
            lookupId: "lookup_2",
            userId: "user_a",
            displayName: "Asha",
            photoUrl: null,
            outcome: "auto_connected",
          },
        ],
      })
      .mockResolvedValueOnce({
        matches: [
          {
            lookupId: "lookup_1001",
            userId: "user_b",
            displayName: "Bo",
            photoUrl: null,
            outcome: "request_required",
          },
        ],
      })
      .mockResolvedValueOnce({ matches: [] });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(mockSyncContacts).toHaveBeenCalledTimes(3);
    expect(mockSyncContacts.mock.calls.map(([arg]) => arg.lookups.length)).toEqual([
      1000,
      1000,
      501,
    ]);
    expect(result).toMatchObject({
      checkedContactCount: 2501,
      matchedContactCount: 2,
      unmatchedContactCount: 2499,
      uncheckableContactCount: 0,
      unknownContactCount: 0,
      mutationOutcomeUnknown: false,
      uncheckedContactCount: 0,
      autoConnectedCount: 1,
      requestRequiredCount: 1,
      partial: false,
    });
  });

  it("dispatches at most five batches and leaves lookup overflow unchecked", async () => {
    const base = lookupResult(5001);
    base.contacts[5000]!.coverageComplete = false;
    base.lookupLimitExceeded = true;
    base.lookupLimitedContactCount = 1;
    mockBuildMarketplaceContactLookups.mockResolvedValue(base);
    mockSyncContacts.mockResolvedValue({ matches: [] });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(mockSyncContacts).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      checkedContactCount: 5000,
      unmatchedContactCount: 5000,
      uncheckedContactCount: 1,
      lookupLimitedContactCount: 1,
      lookupLimitExceeded: true,
      inviteCandidateCount: 5000,
    });
  });

  it("lets a selected-number match win over overflow coverage", async () => {
    const base = lookupResult(1);
    base.contacts[0]!.coverageComplete = false;
    base.lookupLimitExceeded = true;
    base.lookupLimitedContactCount = 1;
    mockBuildMarketplaceContactLookups.mockResolvedValue(base);
    mockSyncContacts.mockResolvedValue({
      matches: [
        {
          lookupId: "lookup_1",
          userId: "matched-user",
          displayName: "Matched",
          photoUrl: null,
          outcome: "auto_connected",
        },
      ],
    });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result).toMatchObject({
      matchedContactCount: 1,
      uncheckedContactCount: 0,
      lookupLimitedContactCount: 0,
      partial: true,
    });
  });

  it("counts a multi-number contact once and matches when any lookup matches", async () => {
    const base = lookupResult(1);
    base.lookups.push({
      lookupId: "lookup_2",
      hash: "b".repeat(64),
      last4: "2020",
    });
    base.contacts[0]!.lookupIds = ["lookup_1", "lookup_2"];
    mockBuildMarketplaceContactLookups.mockResolvedValue(base);
    mockSyncContacts.mockResolvedValue({
      matches: [
        {
          lookupId: "lookup_2",
          userId: "user_a",
          displayName: "Asha",
          photoUrl: null,
          outcome: "already_connected",
        },
      ],
    });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result.matchedContactCount).toBe(1);
    expect(result.unmatchedContactCount).toBe(0);
    expect(result.alreadyConnectedCount).toBe(1);
  });

  it("classifies duplicate address-book rows exactly when they share one lookup", async () => {
    const base = lookupResult(1);
    base.totalContacts = 2;
    base.readContactCount = 2;
    base.contacts = [
      {
        contactKey: "contact_a",
        displayName: "Asha",
        lookupIds: ["lookup_1"],
      },
      {
        contactKey: "contact_b",
        displayName: "Asha duplicate",
        lookupIds: ["lookup_1"],
      },
    ];
    mockBuildMarketplaceContactLookups.mockResolvedValue(base);
    mockSyncContacts.mockResolvedValue({
      matches: [
        {
          lookupId: "lookup_1",
          userId: "user_a",
          displayName: "Asha",
          photoUrl: null,
          outcome: "auto_connected",
        },
      ],
    });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result.matchedContactCount).toBe(2);
    expect(result.unmatchedContactCount).toBe(0);
    expect(result.matchedUserIds).toEqual(["user_a"]);
  });

  it("keeps no-phone and unread rows out of unmatched invite candidates", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue({
      ...lookupResult(2),
      totalContacts: 4,
      readContactCount: 2,
      unreadContactCount: 2,
      uncheckableContactCount: 1,
      lookups: [lookupResult(1).lookups[0]],
      contacts: [
        { contactKey: "a", displayName: "No phone", lookupIds: [] },
        { contactKey: "b", displayName: "Checked", lookupIds: ["lookup_1"] },
      ],
    });
    mockSyncContacts.mockResolvedValue({ matches: [] });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result).toMatchObject({
      checkedContactCount: 1,
      unmatchedContactCount: 1,
      inviteCandidateCount: 1,
      uncheckableContactCount: 1,
      uncheckedContactCount: 2,
      partial: true,
    });
  });

  it("classifies server-indeterminate lookups as unknown, never inviteable", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2));
    mockSyncContacts.mockResolvedValue({
      matches: [],
      indeterminateLookupIds: ["lookup_1"],
    });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result).toMatchObject({
      checkedContactCount: 1,
      unmatchedContactCount: 1,
      unknownContactCount: 1,
      inviteCandidateCount: 1,
      mutationOutcomeUnknown: false,
      partial: true,
    });
  });

  it("returns a truthful partial result when a later batch fails", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2001));
    mockSyncContacts
      .mockResolvedValueOnce({
        matches: [
          {
            lookupId: "lookup_1",
            userId: "user_a",
            displayName: "Asha",
            photoUrl: null,
            outcome: "auto_connected",
          },
        ],
      })
      .mockRejectedValueOnce(new Error("rate limited"));

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result).toMatchObject({
      completedBatchCount: 1,
      totalBatchCount: 3,
      checkedContactCount: 1000,
      matchedContactCount: 1,
      unmatchedContactCount: 999,
      unknownContactCount: 1000,
      mutationOutcomeUnknown: true,
      uncheckedContactCount: 1,
      partial: true,
    });
    expect(result.partialFailureMessage).toContain("may have completed");
  });

  it("does not call a multi-number contact unmatched when one lookup is outcome-unknown", async () => {
    const base = lookupResult(1001);
    base.totalContacts = 1000;
    base.readContactCount = 1000;
    base.contacts = [
      {
        contactKey: "multi",
        displayName: "Multi number",
        lookupIds: ["lookup_1", "lookup_1001"],
      },
      ...base.contacts.slice(1, 1000),
    ];
    mockBuildMarketplaceContactLookups.mockResolvedValue(base);
    mockSyncContacts
      .mockResolvedValueOnce({ matches: [] })
      .mockRejectedValue(new Error("network lost"));

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result).toMatchObject({
      checkedContactCount: 999,
      unmatchedContactCount: 999,
      unknownContactCount: 1,
      inviteCandidateCount: 999,
      mutationOutcomeUnknown: true,
    });
  });

  it("never returns contact hashes, last-four values, or unmatched names", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2));
    mockSyncContacts.mockResolvedValue({
      matches: [
        {
          lookupId: "lookup_1",
          userId: "user_a",
          displayName: "Server identity",
          photoUrl: null,
          outcome: "auto_connected",
        },
      ],
    });

    const result = await syncOneLocationContactSignals({ idToken: "token" });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("Local 1");
    expect(serialized).not.toContain("Local 2");
    expect(serialized).not.toContain("last4");
    expect(serialized).not.toContain("hash");
    expect(result.matches[0]?.displayName).toBe("Server identity");
  });

  it("uses only a matched row's first deterministic local alias when the server has no name", async () => {
    const base = lookupResult(2);
    base.contacts = [
      { contactKey: "first", displayName: "First alias", lookupIds: ["lookup_1"] },
      { contactKey: "duplicate", displayName: "Later alias", lookupIds: ["lookup_1"] },
      { contactKey: "unmatched", displayName: "Must stay local", lookupIds: ["lookup_2"] },
    ];
    base.totalContacts = 3;
    base.readContactCount = 3;
    mockBuildMarketplaceContactLookups.mockResolvedValue(base);
    mockSyncContacts.mockResolvedValue({
      matches: [
        {
          lookupId: "lookup_1",
          userId: "user_a",
          displayName: null,
          photoUrl: null,
          outcome: "auto_connected",
        },
      ],
    });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(result.matches[0]?.displayName).toBe("First alias");
    expect(JSON.stringify(result)).not.toContain("Later alias");
    expect(JSON.stringify(result)).not.toContain("Must stay local");
  });

  it("returns outcome-unknown when the first dispatched batch loses its response", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2));
    mockSyncContacts.mockRejectedValue(new Error("offline"));

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(mockSyncContacts).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      checkedContactCount: 0,
      unmatchedContactCount: 0,
      inviteCandidateCount: 0,
      unknownContactCount: 2,
      uncheckedContactCount: 0,
      mutationOutcomeUnknown: true,
      partial: true,
    });
    expect(JSON.stringify(result)).not.toContain("Local 1");
    expect(JSON.stringify(result)).not.toContain("Local 2");
  });

  it("retries only the unresolved network-failed batch without replaying a completed prefix", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(5000));
    mockSyncContacts
      .mockResolvedValueOnce({ matches: [] })
      .mockResolvedValueOnce({ matches: [] })
      .mockResolvedValueOnce({ matches: [] })
      .mockResolvedValueOnce({ matches: [] })
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce({ matches: [] });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(mockSyncContacts).toHaveBeenCalledTimes(6);
    expect(mockSyncContacts.mock.calls.slice(0, 4).map(([arg]) => arg.lookups[0].lookupId)).toEqual([
      "lookup_1",
      "lookup_1001",
      "lookup_2001",
      "lookup_3001",
    ]);
    expect(mockSyncContacts.mock.calls[4][0].lookups).toEqual(
      mockSyncContacts.mock.calls[5][0].lookups,
    );
    expect(mockSyncContacts.mock.calls[4][0].lookups[0].lookupId).toBe("lookup_4001");
    expect(result).toMatchObject({
      completedBatchCount: 5,
      checkedContactCount: 5000,
      mutationOutcomeUnknown: false,
      partial: false,
    });
  });

  it("retries a transient 5xx response once with the same lookup ids", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2));
    mockSyncContacts
      .mockRejectedValueOnce(
        new ConnectionsServiceRequestError(503, "temporarily unavailable"),
      )
      .mockResolvedValueOnce({ matches: [] });

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(mockSyncContacts).toHaveBeenCalledTimes(2);
    expect(mockSyncContacts.mock.calls[0][0].lookups).toEqual(
      mockSyncContacts.mock.calls[1][0].lookups,
    );
    expect(result).toMatchObject({
      checkedContactCount: 2,
      mutationOutcomeUnknown: false,
      partial: false,
    });
  });

  it("does not retry a first-batch 429 and surfaces its actionable error", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2));
    mockSyncContacts.mockRejectedValue(
      new ConnectionsServiceRequestError(429, "temporarily limited"),
    );

    await expect(
      syncOneLocationContactSignals({ idToken: "token" }),
    ).rejects.toThrow("temporarily limited");

    expect(mockSyncContacts).toHaveBeenCalledTimes(1);
  });

  it("keeps a post-prefix 429 batch and all later contacts unchecked", async () => {
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(2001));
    mockSyncContacts
      .mockResolvedValueOnce({ matches: [] })
      .mockRejectedValueOnce(
        new ConnectionsServiceRequestError(429, "temporarily limited"),
      );

    const result = await syncOneLocationContactSignals({ idToken: "token" });

    expect(mockSyncContacts).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      checkedContactCount: 1000,
      unmatchedContactCount: 1000,
      inviteCandidateCount: 1000,
      unknownContactCount: 0,
      mutationOutcomeUnknown: false,
      uncheckedContactCount: 1001,
      partial: true,
    });
    expect(result.partialFailureMessage).toContain("temporarily limited");
  });

  it("reports denied and restricted permission as typed failures", async () => {
    mockGetPermissionState.mockResolvedValue({ state: "denied" });
    await expect(
      syncOneLocationContactSignals({ idToken: "token" }),
    ).rejects.toMatchObject({ failure: "denied" });
    expect(mockBuildMarketplaceContactLookups).not.toHaveBeenCalled();

    mockGetPermissionState.mockResolvedValue({ state: "restricted" });
    const error = await syncOneLocationContactSignals({ idToken: "token" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OneLocationContactSyncError);
    expect((error as OneLocationContactSyncError).failure).toBe("restricted");
  });

  it("skips the device pre-flight for an injected Google source", async () => {
    mockGetPermissionState.mockResolvedValue({ state: "unavailable" });
    mockBuildMarketplaceContactLookups.mockResolvedValue(lookupResult(0));
    const source = vi.fn();

    const result = await syncOneLocationContactSignals({
      idToken: "token",
      source,
    });

    expect(result.sourcePlatform).toBe("android");
    expect(mockGetPermissionState).not.toHaveBeenCalled();
  });

  it("reports whether the settings page actually opened", async () => {
    mockOpenAppSettings.mockResolvedValue({ opened: true });
    await expect(openContactPermissionSettings()).resolves.toBe(true);
    mockOpenAppSettings.mockRejectedValue(new Error("unsupported"));
    await expect(openContactPermissionSettings()).resolves.toBe(false);
  });
});
