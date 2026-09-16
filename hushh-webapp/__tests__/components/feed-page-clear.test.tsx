import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { FeedRow as RealFeedRow } from "@/components/feed/feed-row";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const user = {
    uid: "feed-user",
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
  return {
    user,
    listRequests: vi.fn(),
    acceptRequest: vi.fn(),
    rejectRequest: vi.fn(),
    connectionChanged: vi.fn(),
    data: {
      items: [
        {
          id: "5",
          source_domain: "connections",
          event_type: "connection_accepted",
          actor_label: "Alex",
          metadata: {},
          read: false,
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      next_cursor: null,
      unread_count: 1,
    },
    refresh: vi.fn().mockResolvedValue(undefined),
    retryActionables: vi.fn().mockResolvedValue(undefined),
    clearSmsEmergencies: vi.fn(),
    markRead: vi.fn().mockResolvedValue(undefined),
    readStarted: vi.fn(),
    readSettled: vi.fn(),
    readFailed: vi.fn(),
    dispatchFeedStateChanged: vi.fn(),
    routerPush: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    feedRowRender: vi.fn(),
    useRealFeedRow: false,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
  // FeedPage publishes its voice surface, and the publisher reads the current
  // pathname to scope its route lease. Without this the whole tree throws
  // before any Clear behaviour runs.
  usePathname: () => "/one/feed",
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));

vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: () => ({
    data: mocks.data,
    loading: false,
    error: null,
    refresh: mocks.refresh,
  }),
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConnectionCapabilityMutated: mocks.connectionChanged,
    onFeedReadStarted: mocks.readStarted,
    onFeedReadSettled: mocks.readSettled,
    onFeedReadFailed: mocks.readFailed,
  },
}));

vi.mock("@/lib/services/cache-service", () => ({
  CACHE_KEYS: { FEED_LIST: (userId: string) => `feed:${userId}` },
}));

vi.mock("@/lib/services/feed-service", () => ({
  FeedService: { markRead: mocks.markRead, list: vi.fn() },
}));

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

vi.mock("@/lib/feed/use-feed-live-refresh", () => ({
  useFeedLiveRefresh: vi.fn(),
}));

vi.mock("@/lib/feed/use-feed-actionables", () => ({
  useFeedActionables: () => ({
    actionables: [],
    loading: false,
    error: null,
    retry: mocks.retryActionables,
    hasClearableSmsEmergencies: true,
    clearSmsEmergencies: mocks.clearSmsEmergencies,
  }),
}));

vi.mock("@/components/feed/feed-row", async (importOriginal) => {
  const { FeedRow } =
    await importOriginal<typeof import("@/components/feed/feed-row")>();
  return {
    FeedRow: (props: Parameters<typeof RealFeedRow>[0]) => {
      mocks.feedRowRender(props.item.id);
      return mocks.useRealFeedRow ? (
        <FeedRow {...props} />
      ) : (
        <div>row-{props.item.id}</div>
      );
    },
  };
});

vi.mock("@/components/feed/feed-actionable-row", () => ({
  FeedActionableRow: () => null,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageContentRegion: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));

vi.mock("@/components/app-ui/typography", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/app-ui/typography")>()),
  SectionLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

import { FeedPage } from "@/components/feed/feed-page";
import { resolveLocalOnboardingHandler, prepareLocalOnboardingAction } from "@/lib/agent/local-onboarding-actions";

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    listRequests: mocks.listRequests,
    accept: mocks.acceptRequest,
    reject: mocks.rejectRequest,
  },
}));

describe("Feed connection action ID binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRequests.mockResolvedValue([
      { id: "req-a", counterpartDisplayName: "Alex" },
      { id: "req-b", counterpartDisplayName: "Alex" },
      { id: "req-c", counterpartDisplayName: "Casey" },
    ]);
    mocks.acceptRequest.mockResolvedValue(undefined);
    mocks.rejectRequest.mockResolvedValue(undefined);
  });

  it.each(["accept", "reject"])("binds %s to the selected incoming ID", async (verb) => {
    render(<FeedPage />);
    const handler = resolveLocalOnboardingHandler(`connect.${verb}_request`)!;
    expect((await handler({ person: "Alex", requestId: "req-b" })).status).toBe("blocked");
    expect(mocks.listRequests).not.toHaveBeenCalled();
    const slots = { person: "Alex", requestId: "req-b" };
    const preparation = await prepareLocalOnboardingAction(`connect.${verb}_request`, slots);
    expect(preparation?.status).toBe("ready");
    if (preparation?.status !== "ready") throw new Error("Preparation failed");
    expect(preparation.binding).toMatchObject({ owner: "feed-user", requestId: "req-b", person: "Alex" });
    expect(mocks.acceptRequest).not.toHaveBeenCalled();
    expect(mocks.rejectRequest).not.toHaveBeenCalled();
    const result = await handler(slots, { directiveId: "confirmed", preparedBinding: preparation.binding });
    expect(result.status).toBe("succeeded");
    expect(verb === "accept" ? mocks.acceptRequest : mocks.rejectRequest).toHaveBeenCalledWith({
      idToken: "firebase-token", requestId: "req-b",
    });
  });

  it.each([
    { person: "Alex", requestId: "foreign-or-stale" },
    { person: "Casey", requestId: "req-a" },
    { person: "Alex", requestId: "" },
    { person: "Alex" },
  ])("refuses unresolved or mismatched request %j", async (slots) => {
    render(<FeedPage />);
    const handler = resolveLocalOnboardingHandler("connect.accept_request")!;
    expect((await handler(slots, { directiveId: "confirmed" })).status).toBe("blocked");
    expect(mocks.acceptRequest).not.toHaveBeenCalled();
    expect(mocks.rejectRequest).not.toHaveBeenCalled();
  });

  it("retains unique name-only requests", async () => {
    render(<FeedPage />);
    const handler = resolveLocalOnboardingHandler("connect.reject_request")!;
    expect((await handler({ person: "Casey" }, { directiveId: "confirmed" })).status).toBe("succeeded");
    expect(mocks.rejectRequest).toHaveBeenCalledWith({ idToken: "firebase-token", requestId: "req-c" });
  });

  it("rechecks a prepared request and blocks changed or foreign bindings", async () => {
    render(<FeedPage />);
    const slots = { person: "Casey", requestId: "req-c" };
    const preparation = await prepareLocalOnboardingAction("connect.reject_request", slots);
    if (preparation?.status !== "ready") throw new Error("Preparation failed");
    const handler = resolveLocalOnboardingHandler("connect.reject_request")!;
    expect((await handler(slots, { directiveId: "confirmed", preparedBinding: { ...preparation.binding, owner: "someone-else" } })).status).toBe("blocked");
    mocks.listRequests.mockResolvedValue([]);
    expect((await handler(slots, { directiveId: "confirmed", preparedBinding: preparation.binding })).status).toBe("blocked");
    expect(mocks.rejectRequest).not.toHaveBeenCalled();
  });

  it("keeps scope-bearing acceptance in the existing review", async () => {
    mocks.listRequests.mockResolvedValue([{ id: "req-s", counterpartDisplayName: "Sam", scopes: [{ scopeHandle: "private" }] }]);
    render(<FeedPage />);
    expect(await prepareLocalOnboardingAction("connect.accept_request", { person: "Sam", requestId: "req-s" })).toMatchObject({ status: "blocked", gate: "navigation", waitForUser: true });
    expect(mocks.acceptRequest).not.toHaveBeenCalled();
  });
});

async function renderAfterAutomaticRead() {
  const view = render(<FeedPage />);
  await waitFor(() => expect(mocks.markRead).toHaveBeenCalled());
  mocks.markRead.mockClear();
  mocks.readStarted.mockClear();
  mocks.readSettled.mockClear();
  mocks.readFailed.mockClear();
  mocks.dispatchFeedStateChanged.mockClear();
  return view;
}

describe("Feed history interactions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mocks.useRealFeedRow = false;
    mocks.user.getIdToken.mockResolvedValue("firebase-token");
    mocks.markRead.mockResolvedValue(undefined);
    mocks.data = {
      items: [
        {
          id: "5",
          source_domain: "connections",
          event_type: "connection_accepted",
          actor_label: "Alex",
          metadata: {},
          read: false,
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      next_cursor: null,
      unread_count: 1,
    };
  });

  it("opens Shared with me when the actual incoming location Feed row is tapped", async () => {
    mocks.useRealFeedRow = true;
    mocks.data.items = [
      {
        ...mocks.data.items[0],
        source_domain: "location",
        event_type: "location_share_created",
        actor_label: "Ankit",
        metadata: {
          feed_audience: "recipient",
          counterpart_label: "Ankit",
          duration_hours: 2,
        },
      },
    ];
    await renderAfterAutomaticRead();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Ankit Shared location with you for 2 hours/,
      }),
    );

    expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith(
      "/one/location?section=shared",
    );
  });

  it("retires an unsafe legacy timestamp watermark without hiding a later id", async () => {
    window.localStorage.setItem(
      "hushh:feed-cleared-at:feed-user",
      "2026-01-02T00:00:00.000Z",
    );
    mocks.data = {
      ...mocks.data,
      items: [
        {
          ...mocks.data.items[0],
          id: "6",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    await renderAfterAutomaticRead();

    expect(screen.getByText("row-6")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        window.localStorage.getItem("hushh:feed-cleared-at:feed-user"),
      ).toBeNull(),
    );
  });

  it("never renders cached history before hydrating a persisted clear watermark", async () => {
    window.localStorage.setItem("hushh:feed-cleared-through-id:feed-user", "5");

    render(<FeedPage />);

    expect(mocks.feedRowRender).not.toHaveBeenCalled();
    expect(screen.queryByText("row-5")).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("No activity yet")).toBeInTheDocument(),
    );
  });

  it("requires confirmation, commits the read first, and keeps a later id visible despite an older timestamp", async () => {
    const view = await renderAfterAutomaticRead();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear feed notifications on this device",
      }),
    );
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm clear feed notifications on this device",
      }),
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Feed cleared on this device",
      ),
    );

    expect(mocks.markRead).toHaveBeenCalledWith({
      idToken: "firebase-token",
      upToId: "5",
    });
    expect(mocks.markRead.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearSmsEmergencies.mock.invocationCallOrder[0],
    );
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBe("5");

    mocks.data = {
      ...mocks.data,
      items: [
        {
          ...mocks.data.items[0],
          id: "6",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        mocks.data.items[0],
      ],
    };
    await act(async () => view.rerender(<FeedPage />));

    expect(screen.getByText("row-6")).toBeInTheDocument();
    expect(screen.queryByText("row-5")).toBeNull();
  });

  it("does not dismiss revoked SOS cards or persist a watermark when mark-read fails", async () => {
    await renderAfterAutomaticRead();
    mocks.markRead.mockRejectedValueOnce(new Error("backend unavailable"));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear feed notifications on this device",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm clear feed notifications on this device",
      }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't clear your feed.",
      ),
    );
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();
    expect(mocks.readFailed).toHaveBeenCalledWith("feed-user");
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
  });
});
