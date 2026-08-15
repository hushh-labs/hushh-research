import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let receivedGrantsFixture: unknown[] = [];

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
          receivedGrants: receivedGrantsFixture,
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
  },
}));

import { useFeedActionables } from "@/lib/feed/use-feed-actionables";

describe("useFeedActionables SMS · Save My Soul emergency cards", () => {
  beforeEach(() => {
    window.localStorage.clear();
    receivedGrantsFixture = [
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
    ];
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("shows a plain 'Emergency SMS - Sent.' body with no address for a live SOS share", async () => {
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      const emergency = result.current.actionables.find(
        (item) => item.id === "sms-emergency:sos-grant-1",
      );
      expect(emergency?.description).toBe("Emergency SMS - Sent.");
    });

    const emergency = result.current.actionables.find(
      (item) => item.id === "sms-emergency:sos-grant-1",
    );
    expect(emergency?.description).not.toContain("Last known");
    expect(emergency?.actions).toEqual([]);
  });

  it("keeps a revoked SOS card visible as 'Emergency SMS - Revoked' instead of dropping it", async () => {
    receivedGrantsFixture = [
      {
        id: "sos-grant-1",
        ownerUserId: "sender-user",
        recipientUserId: "receiver-user",
        ownerDisplayName: "Test contact",
        status: "revoked",
        shareKind: "sos",
        shareMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      const emergency = result.current.actionables.find(
        (item) => item.id === "sms-emergency:sos-grant-1",
      );
      expect(emergency?.description).toBe("Emergency SMS - Revoked");
    });
  });

  it("does NOT put a Clear action on the card itself — the Feed page's existing Clear button owns it", async () => {
    receivedGrantsFixture = [
      {
        id: "sos-grant-1",
        ownerUserId: "sender-user",
        recipientUserId: "receiver-user",
        ownerDisplayName: "Test contact",
        status: "revoked",
        shareKind: "sos",
        shareMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(result.current.hasClearableSmsEmergencies).toBe(true);
    });

    const emergency = result.current.actionables.find(
      (item) => item.id === "sms-emergency:sos-grant-1",
    );
    expect(emergency?.actions).toEqual([]);
  });

  it("removes a revoked SOS card once clearSmsEmergencies() runs, and persists the clear", async () => {
    receivedGrantsFixture = [
      {
        id: "sos-grant-1",
        ownerUserId: "sender-user",
        recipientUserId: "receiver-user",
        ownerDisplayName: "Test contact",
        status: "revoked",
        shareKind: "sos",
        shareMessage: null,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(result.current.hasClearableSmsEmergencies).toBe(true);
    });

    act(() => {
      result.current.clearSmsEmergencies();
    });

    await waitFor(() => {
      expect(
        result.current.actionables.find(
          (item) => item.id === "sms-emergency:sos-grant-1",
        ),
      ).toBeUndefined();
      expect(result.current.hasClearableSmsEmergencies).toBe(false);
    });

    expect(
      window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user"),
    ).toContain("sos-grant-1");
  });

  it("does NOT offer a clear for a live (still-active) SOS share", async () => {
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(
        result.current.actionables.find(
          (item) => item.id === "sms-emergency:sos-grant-1",
        ),
      ).toBeDefined();
    });

    expect(result.current.hasClearableSmsEmergencies).toBe(false);
  });
});
