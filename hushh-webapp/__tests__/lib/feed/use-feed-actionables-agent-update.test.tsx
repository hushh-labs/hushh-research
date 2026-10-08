/**
 * The Feed's "Update now" for an Azure agent records the exact release first.
 *
 * The hub's Azure `upgrade/begin` refuses without a recorded approval, so the
 * Feed card must bind the release the person saw, under its per-release key,
 * before the Microsoft sign-in starts. A Google agent keeps scheduling with the
 * caller's key.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELEASE = `rel_${"e".repeat(32)}`;
const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=f";
const follow = vi.hoisted(() => ({ deploymentTarget: "user_azure" as string | null }));
const navigation = vi.hoisted(() => ({ assign: vi.fn() }));

vi.mock("@/lib/feed/use-agent-deployment-follow", () => ({
  useAgentDeploymentFollow: () => ({
    update: {
      available: true, offerable: true, inProgress: false, failed: false, error: null,
      running: null, target: null, releaseId: RELEASE, summary: "Keeps your agent current.",
      presentationState: "ready", phase: null, remindAt: null, operationId: null, verified: false,
    },
    deploymentTarget: follow.deploymentTarget,
  }),
}));

vi.mock("@/lib/utils/browser-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/browser-navigation")>()),
  assignWindowLocation: navigation.assign,
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
          receivedGrants: [],
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
import { ApiService } from "@/lib/services/api-service";

async function approveFromFeed() {
  const { result } = renderHook(() => useFeedActionables());
  let card: ReturnType<typeof useFeedActionables>["actionables"][number] | undefined;
  await waitFor(() => {
    card = result.current.actionables.find((item) => item.id === `personal-agent-update:${RELEASE}`);
    expect(card).toBeTruthy();
  });
  const approve = card?.actions?.find((action) => action.key === "approve");
  await act(async () => {
    await approve?.run();
  });
}

describe("useFeedActionables software update approval", () => {
  let approve: ReturnType<typeof vi.spyOn>;
  let upgrade: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    navigation.assign.mockReset();
    follow.deploymentTarget = "user_azure";
    approve = vi
      .spyOn(ApiService, "approvePersonalAgentUpdate")
      .mockResolvedValue({ operationId: "op", releaseId: RELEASE, status: "scheduled" });
    upgrade = vi
      .spyOn(ApiService, "beginAzureByocUpgrade")
      .mockResolvedValue({ authorizationUrl: SIGN_IN });
    // A blocked popup: the sign-in continues in this tab (the popup path has its own tests).
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("records the exact Azure release before the Microsoft sign-in", async () => {
    await approveFromFeed();
    expect(approve).toHaveBeenCalledWith({ releaseId: RELEASE, idempotencyKey: `azure-update.${RELEASE}` });
    expect(upgrade).toHaveBeenCalledOnce();
    expect(approve.mock.invocationCallOrder[0]).toBeLessThan(upgrade.mock.invocationCallOrder[0]);
    expect(navigation.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("keeps scheduling a Google agent's update through the hub alone", async () => {
    follow.deploymentTarget = "user_gcp";
    await approveFromFeed();
    expect(approve).toHaveBeenCalledWith({ releaseId: RELEASE, idempotencyKey: expect.any(String) });
    expect(upgrade).not.toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();
  });
});
