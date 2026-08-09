import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceHarness = vi.hoisted(() => ({
  viewEnvelope: vi.fn(),
  reverseGeocode: vi.fn(),
}));

const encryptionHarness = vi.hoisted(() => ({
  decryptLocationEnvelope: vi.fn(),
  ensureVaultSyncedRecipientKey: vi.fn(),
}));

const envelope = {
  ciphertext: "ciphertext",
  iv: "iv",
  tag: "tag",
  algorithm: "AES-GCM",
  recipientKeyId: "recipient-key",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => undefined,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "receiver-user",
      getIdToken: async () => "test-id-token",
    },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "test-vault-key",
    vaultOwnerToken: "test-vault-token",
  }),
}));

vi.mock("@/lib/services/cache-service", () => ({
  CACHE_KEYS: {
    CONSENT_CENTER_SUMMARY: (userId: string) =>
      `consent-summary:${userId}`,
    CONSENT_CENTER_LIST: (userId: string) =>
      `consent-list:${userId}`,
    ONE_LOCATION_STATE: (userId: string) =>
      `location:${userId}`,
    CONNECTIONS_INCOMING: (userId: string) =>
      `connections:${userId}`,
  },
  CACHE_TTL: {
    SHORT: 1,
  },
  CacheService: {
    getInstance: () => ({
      set: () => undefined,
    }),
  },
}));

vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: ({ cacheKey }: { cacheKey: string }) => {
    const refresh = async () => undefined;

    if (cacheKey.startsWith("location:")) {
      return {
        data: {
          requests: [],
          receivedGrants: [
            {
              id: "sos-grant-1",
              ownerUserId: "sender-user",
              recipientUserId: "receiver-user",
              ownerDisplayName: "Test contact",
              status: "active",
              shareKind: "sos",
              shareMessage: null,
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ],
          myRecipientKey: null,
        },
        loading: false,
        refresh,
      };
    }

    if (cacheKey.startsWith("consent-summary:")) {
      return {
        data: {
          counts: {
            pending: 0,
          },
        },
        loading: false,
        refresh,
      };
    }

    return {
      data: null,
      loading: false,
      refresh,
    };
  },
}));

vi.mock("@/lib/services/debate-run-manager", () => ({
  DebateRunManagerService: {
    getState: () => ({
      tasks: [],
    }),
    subscribe: () => () => undefined,
  },
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    getState: () => ({
      tasks: [],
    }),
    subscribe: () => () => undefined,
  },
  isAppBackgroundTaskVisible: () => false,
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  CONSENT_CENTER_PAGE_SIZE: 20,
  ConsentCenterService: {
    getSummary: async () => ({
      counts: {
        pending: 0,
      },
    }),
    listEntries: async () => ({
      items: [],
    }),
  },
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    listRequests: async () => [],
  },
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: async () => ({
      requests: [],
      receivedGrants: [],
    }),
    viewEnvelope: serviceHarness.viewEnvelope,
    reverseGeocode: serviceHarness.reverseGeocode,
  },
}));

vi.mock("@/lib/one-location/encryption", () => ({
  RECIPIENT_KEY_UNAVAILABLE_MESSAGE:
    "Recipient key unavailable for this location share.",
  decryptLocationEnvelope: encryptionHarness.decryptLocationEnvelope,
  ensureVaultSyncedRecipientKey:
    encryptionHarness.ensureVaultSyncedRecipientKey,
}));

import { useFeedActionables } from "@/lib/feed/use-feed-actionables";

describe("useFeedActionables SOS last-known address", () => {
  beforeEach(() => {
    serviceHarness.viewEnvelope.mockReset();
    serviceHarness.reverseGeocode.mockReset();
    encryptionHarness.decryptLocationEnvelope.mockReset();
    encryptionHarness.ensureVaultSyncedRecipientKey.mockReset();

    serviceHarness.viewEnvelope.mockResolvedValue({
      grant: {
        id: "sos-grant-1",
      },
      envelope,
    });

    encryptionHarness.decryptLocationEnvelope.mockResolvedValue({
      latitude: 12.3456,
      longitude: 78.9012,
      accuracyM: 18,
      capturedAt: "2026-08-10T00:00:00.000Z",
      sourcePlatform: "web",
    });

    serviceHarness.reverseGeocode.mockResolvedValue({
      name: "Test Place",
      formattedAddress: "100 Test Lane, Example City",
      countryCode: "IN",
    });
  });

  it("decrypts an active SOS point and adds its last-known address to the Feed tile", async () => {
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(serviceHarness.viewEnvelope).toHaveBeenCalledWith({
        vaultOwnerToken: "test-vault-token",
        grantId: "sos-grant-1",
      });
    });

    await waitFor(() => {
      const emergency = result.current.actionables.find(
        (item) => item.id === "sms-emergency:sos-grant-1",
      );

      expect(emergency?.description).toContain(
        "Last known: 100 Test Lane, Example City",
      );
    });

    expect(encryptionHarness.decryptLocationEnvelope).toHaveBeenCalledWith({
      userId: "receiver-user",
      envelope,
    });

    expect(serviceHarness.reverseGeocode).toHaveBeenCalledWith({
      vaultOwnerToken: "test-vault-token",
      lat: 12.3456,
      lng: 78.9012,
    });

    expect(
      encryptionHarness.ensureVaultSyncedRecipientKey,
    ).not.toHaveBeenCalled();
  });
});