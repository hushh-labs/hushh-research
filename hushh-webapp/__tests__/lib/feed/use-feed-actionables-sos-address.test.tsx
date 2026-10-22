import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneLocationGrant } from "@/lib/one-location/types";

let receivedGrantsFixture: Array<Partial<OneLocationGrant>> = [];
const mocks = vi.hoisted(() => ({
  clearSosCards: vi.fn(),
  locationRefresh: vi.fn(async () => undefined),
  vaultOwnerToken: "test-vault-token" as string | null,
}));

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
    vaultOwnerToken: mocks.vaultOwnerToken,
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
      invalidate: () => undefined,
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
        refresh: mocks.locationRefresh,
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

vi.mock("@/lib/services/feed-service", () => ({
  FeedService: { clearSosCards: mocks.clearSosCards },
}));

import { useFeedActionables } from "@/lib/feed/use-feed-actionables";

function revokedSos(overrides: Record<string, unknown> = {}) {
  return {
    id: "sos-grant-1",
    ownerUserId: "sender-user",
    recipientUserId: "receiver-user",
    ownerDisplayName: "Test contact",
    status: "revoked",
    shareKind: "sos",
    shareMessage: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function emergencyCard(current: ReturnType<typeof useFeedActionables>) {
  return current.actionables.find((item) => item.id === "sms-emergency:sos-grant-1");
}

describe("useFeedActionables SMS · Save My Soul emergency cards", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.vaultOwnerToken = "test-vault-token";
    mocks.locationRefresh.mockClear();
    mocks.clearSosCards.mockReset();
    mocks.clearSosCards.mockImplementation(
      async ({ grantIds }: { grantIds: string[] }) => grantIds,
    );
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
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("does not present self-addressed or another recipient's SMS as this recipient's alert", async () => {
    receivedGrantsFixture = [
      { ...receivedGrantsFixture[0], ownerUserId: "receiver-user" },
      { ...receivedGrantsFixture[0], id: "other", recipientUserId: "other-recipient" },
    ];
    const { result } = renderHook(() => useFeedActionables());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.actionables.filter((item) => item.smsEmergency)).toEqual([]);
  });

  it("keeps a server-active SMS live despite an ahead device clock, until the server reports expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00Z"));
    receivedGrantsFixture = [
      { ...receivedGrantsFixture[0], expiresAt: "2026-08-10T00:00:01Z" },
      { ...receivedGrantsFixture[0], id: "still-live", expiresAt: "2026-08-10T01:00:00Z" },
    ];
    const { result, rerender } = renderHook(() => useFeedActionables());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.actionables.filter((item) => item.emphasis === "emergency")).toHaveLength(2);
    mocks.locationRefresh.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_050); });
    expect(mocks.locationRefresh).toHaveBeenCalledWith({ force: true });
    expect(emergencyCard(result.current)?.description).toBe("Emergency SMS · Active");
    expect(emergencyCard(result.current)?.href).toBeTruthy();
    expect(result.current.hasClearableSmsEmergencies).toBe(false);
    await act(async () => { await result.current.clearSmsEmergencies(); });
    expect(mocks.clearSosCards).not.toHaveBeenCalled();

    // A refreshed response, rather than the handset clock, ends this alert.
    receivedGrantsFixture = receivedGrantsFixture.map((grant, index) =>
      index === 0 ? { ...grant, status: "expired" } : grant,
    );
    rerender();
    expect(result.current.actionables.find((item) => item.id === "sms-emergency:sos-grant-1")?.description).toBe("Emergency SMS · Expired");
    expect(emergencyCard(result.current)?.href).toBeNull();
    expect(emergencyCard(result.current)?.displayTimestamp).toBe(Date.parse("2026-08-10T00:00:00.000Z"));
    expect(result.current.actionables.find((item) => item.id === "sms-emergency:still-live")?.emphasis).toBe("emergency");
    await act(async () => { await result.current.clearSmsEmergencies(); });
    expect(mocks.clearSosCards).toHaveBeenCalledWith({ vaultOwnerToken: "test-vault-token", grantIds: ["sos-grant-1"] });
    expect(result.current.actionables.find((item) => item.id === "sms-emergency:still-live")).toBeDefined();
  });

  it("shows a plain 'Emergency SMS · Active' body with no address for a live SOS share", async () => {
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      const emergency = result.current.actionables.find(
        (item) => item.id === "sms-emergency:sos-grant-1",
      );
      expect(emergency?.description).toBe("Emergency SMS · Active");
    });

    const emergency = result.current.actionables.find(
      (item) => item.id === "sms-emergency:sos-grant-1",
    );
    expect(emergency?.description).not.toContain("Last known");
    expect(emergency?.actions).toEqual([]);
    expect(emergency?.emphasis).toBe("emergency");
    expect(emergency?.displayTimestamp).toBe(
      new Date("2026-08-10T00:00:00.000Z").getTime(),
    );
  });

  it("keeps a revoked SOS card visible as 'Emergency SMS · Revoked' instead of dropping it, and drops its emergency emphasis", async () => {
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
      expect(emergency?.description).toBe("Emergency SMS · Revoked");
    });

    const emergency = result.current.actionables.find(
      (item) => item.id === "sms-emergency:sos-grant-1",
    );
    // Ended SMS stays available in its own Feed section, with its sent time.
    expect(emergency?.emphasis).toBeUndefined();
    expect(emergency?.sortAt).toBe(new Date("2026-08-10T00:00:00.000Z").getTime());
    expect(emergency?.displayTimestamp).toBe(
      new Date("2026-08-10T00:00:00.000Z").getTime(),
    );
  });

  it("keeps the original sent time when an SMS is revoked later", async () => {
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
        revokedAt: "2026-08-12T09:30:00.000Z",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      const emergency = result.current.actionables.find(
        (item) => item.id === "sms-emergency:sos-grant-1",
      );
      expect(emergency?.description).toBe("Emergency SMS · Revoked");
    });

    const emergency = result.current.actionables.find(
      (item) => item.id === "sms-emergency:sos-grant-1",
    );
    const sentAtMs = Date.parse("2026-08-10T00:00:00.000Z");
    expect(emergency?.sortAt).toBe(sentAtMs);
    expect(emergency?.displayTimestamp).toBe(sentAtMs);
    expect(emergency?.href).toBeNull();
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

  it("saves the clear on the server first and hides the card only after the server confirms", async () => {
    receivedGrantsFixture = [revokedSos()];
    let confirm: ((ids: string[]) => void) | undefined;
    mocks.clearSosCards.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { confirm = resolve; }),
    );
    const { result } = renderHook(() => useFeedActionables());
    await waitFor(() => {
      expect(result.current.hasClearableSmsEmergencies).toBe(true);
    });

    let clearing: Promise<void> | undefined;
    act(() => {
      clearing = result.current.clearSmsEmergencies();
    });

    expect(mocks.clearSosCards).toHaveBeenCalledWith({
      vaultOwnerToken: "test-vault-token",
      grantIds: ["sos-grant-1"],
    });
    expect(emergencyCard(result.current)).toBeDefined();

    await act(async () => {
      confirm?.(["sos-grant-1"]);
      await clearing;
    });
    expect(emergencyCard(result.current)).toBeUndefined();
    expect(result.current.hasClearableSmsEmergencies).toBe(false);
    // The server is the record now; nothing is kept on this device.
    expect(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user")).toBeNull();
  });

  it("keeps the clear on this device when an older backend has no SOS route, then saves it on a later visit", async () => {
    receivedGrantsFixture = [revokedSos()];
    // A backend that predates the route answers 404.
    mocks.clearSosCards.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const firstVisit = renderHook(() => useFeedActionables());
    await waitFor(() => {
      expect(firstVisit.result.current.hasClearableSmsEmergencies).toBe(true);
    });

    await act(async () => {
      await expect(firstVisit.result.current.clearSmsEmergencies()).resolves.toBeUndefined();
    });

    // The card leaves now, and the clear waits on this device, as it did before.
    expect(emergencyCard(firstVisit.result.current)).toBeUndefined();
    expect(firstVisit.result.current.hasClearableSmsEmergencies).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user") ?? "[]"),
    ).toEqual(["sos-grant-1"]);
    expect(mocks.clearSosCards).toHaveBeenCalledTimes(1);
    firstVisit.unmount();

    // A later visit, once the backend has the route, saves it and forgets it here.
    const laterVisit = renderHook(() => useFeedActionables());
    await waitFor(() => {
      expect(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user")).toBeNull();
    });
    expect(mocks.clearSosCards).toHaveBeenCalledTimes(2);
    expect(mocks.clearSosCards).toHaveBeenLastCalledWith({
      vaultOwnerToken: "test-vault-token",
      grantIds: ["sos-grant-1"],
    });
    expect(emergencyCard(laterVisit.result.current)).toBeUndefined();
  });

  it("keeps the clear on this device while the vault is locked", async () => {
    receivedGrantsFixture = [revokedSos()];
    mocks.vaultOwnerToken = null;
    const { result } = renderHook(() => useFeedActionables());
    await waitFor(() => {
      expect(result.current.hasClearableSmsEmergencies).toBe(true);
    });

    await act(async () => {
      await expect(result.current.clearSmsEmergencies()).resolves.toBeUndefined();
    });

    expect(mocks.clearSosCards).not.toHaveBeenCalled();
    expect(emergencyCard(result.current)).toBeUndefined();
    expect(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user")).toContain(
      "sos-grant-1",
    );
  });

  it("does not drop a clear kept on this device while an older copy is still saving", async () => {
    receivedGrantsFixture = [revokedSos(), revokedSos({ id: "sos-grant-2" })];
    window.localStorage.setItem(
      "hushh:feed-sms-dismissed:receiver-user",
      JSON.stringify(["sos-grant-1"]),
    );
    let finishCopy: ((ids: string[]) => void) | undefined;
    mocks.clearSosCards
      .mockImplementationOnce(
        () => new Promise<string[]>((resolve) => { finishCopy = resolve; }),
      )
      .mockRejectedValueOnce(new Error("backend unavailable"));
    const { result } = renderHook(() => useFeedActionables());
    await waitFor(() => expect(finishCopy).toBeTypeOf("function"));

    // The second card's server clear fails while the first card's copy runs.
    await act(async () => {
      await result.current.clearSmsEmergencies();
    });
    await act(async () => {
      finishCopy?.(["sos-grant-1"]);
    });

    await waitFor(() => {
      expect(
        JSON.parse(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user") ?? "[]"),
      ).toEqual(["sos-grant-2"]);
    });
    expect(
      result.current.actionables.find((item) => item.id === "sms-emergency:sos-grant-2"),
    ).toBeUndefined();
  });

  it("keeps an ended SOS card cleared on a fresh device", async () => {
    // Cleared on another device: this browser has no record of it.
    receivedGrantsFixture = [revokedSos({ recipientClearedAt: "2026-10-15T04:00:00.000Z" })];
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(emergencyCard(result.current)).toBeUndefined();
    expect(result.current.hasClearableSmsEmergencies).toBe(false);
    expect(mocks.clearSosCards).not.toHaveBeenCalled();
  });

  it("never hides a live SOS share, even if a clear was recorded", async () => {
    receivedGrantsFixture = [
      revokedSos({ status: "active", recipientClearedAt: "2026-10-15T04:00:00.000Z" }),
    ];
    window.localStorage.setItem(
      "hushh:feed-sms-dismissed:receiver-user",
      JSON.stringify(["sos-grant-1"]),
    );
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(emergencyCard(result.current)?.emphasis).toBe("emergency");
    });
    expect(result.current.hasClearableSmsEmergencies).toBe(false);
  });

  it("copies an old device-only clear to the server once, then forgets it", async () => {
    receivedGrantsFixture = [revokedSos()];
    window.localStorage.setItem(
      "hushh:feed-sms-dismissed:receiver-user",
      JSON.stringify(["sos-grant-1", "grant-no-longer-listed"]),
    );
    const { result, rerender } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user")).toBeNull();
    });
    expect(mocks.clearSosCards).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "test-vault-token",
      grantIds: ["sos-grant-1"],
    });
    expect(emergencyCard(result.current)).toBeUndefined();
    rerender();
    expect(mocks.clearSosCards).toHaveBeenCalledTimes(1);
  });

  it("keeps an old device-only clear when copying it fails", async () => {
    receivedGrantsFixture = [revokedSos()];
    window.localStorage.setItem(
      "hushh:feed-sms-dismissed:receiver-user",
      JSON.stringify(["sos-grant-1"]),
    );
    mocks.clearSosCards.mockRejectedValueOnce(new Error("backend unavailable"));
    const { result } = renderHook(() => useFeedActionables());

    await waitFor(() => {
      expect(mocks.clearSosCards).toHaveBeenCalledTimes(1);
    });
    expect(window.localStorage.getItem("hushh:feed-sms-dismissed:receiver-user")).toContain(
      "sos-grant-1",
    );
    expect(emergencyCard(result.current)).toBeUndefined();
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
