import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const user = {
    uid: "feed-user",
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
  return {
    user,
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
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
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

vi.mock("@/components/feed/feed-row", () => ({
  FeedRow: ({ item }: { item: { id: string } }) => <div>row-{item.id}</div>,
}));

vi.mock("@/components/feed/feed-actionable-row", () => ({
  FeedActionableRow: () => null,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));

vi.mock("@/components/app-ui/typography", () => ({
  SectionLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

import { FeedPage } from "@/components/feed/feed-page";

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

describe("Feed Clear transaction", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
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

  it("requires confirmation, commits the read first, and keeps a later id visible despite an older timestamp", async () => {
    const view = await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "Clear feed notifications" }));
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm clear feed notifications" }),
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Feed cleared"));

    expect(mocks.markRead).toHaveBeenCalledWith({
      idToken: "firebase-token",
      upToId: "5",
    });
    expect(mocks.markRead.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearSmsEmergencies.mock.invocationCallOrder[0],
    );
    expect(window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user")).toBe("5");

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

    fireEvent.click(screen.getByRole("button", { name: "Clear feed notifications" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm clear feed notifications" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Couldn't clear your feed."),
    );
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();
    expect(mocks.readFailed).toHaveBeenCalledWith("feed-user");
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
  });
});
