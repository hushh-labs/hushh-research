import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { FeedRow as RealFeedRow } from "@/components/feed/feed-row";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const user = {
    uid: "feed-user",
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
  return {
    user,
    // Who useAuth reports; a test switches it to sign out or change account.
    currentUser: user as typeof user | null,
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
    resourceMissing: false,
    historyLoading: false,
    historyError: null as string | null,
    actionablesLoading: false,
    actionablesError: null as string | null,
    progressLoading: false,
    progressError: null as string | null,
    retryActionables: vi.fn().mockResolvedValue(undefined),
    actionables: [] as FeedActionable[],
    clearSmsEmergencies: vi.fn(),
    markRead: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue({ token: "dismissal-token", itemIds: null }),
    restore: vi.fn().mockResolvedValue(true),
    readStarted: vi.fn(),
    readSettled: vi.fn(),
    readFailed: vi.fn(),
    dispatchFeedStateChanged: vi.fn(),
    routerPush: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastDismiss: vi.fn(),
    feedRowRender: vi.fn(),
    useRealFeedRow: false,
    useActionTestRow: false,
    // Undefined leaves the Feed on its closed default price step.
    documentPricePrompt: undefined as Record<string, unknown> | undefined,
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
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    dismiss: mocks.toastDismiss,
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.currentUser, loading: false }),
}));

vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: () => ({
    data: mocks.resourceMissing ? null : mocks.data,
    loading: mocks.historyLoading,
    error: mocks.historyError,
    refresh: mocks.refresh,
  }),
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConnectionCapabilityMutated: mocks.connectionChanged,
    onConnectionGraphMutated: mocks.connectionChanged,
    onFeedReadStarted: mocks.readStarted,
    onFeedReadSettled: mocks.readSettled,
    onFeedReadFailed: mocks.readFailed,
  },
}));

vi.mock("@/lib/services/cache-service", async (original) => {
  const actual = await original<typeof import("@/lib/services/cache-service")>();
  return { ...actual, CACHE_KEYS: { ...actual.CACHE_KEYS, FEED_LIST: (userId: string) => `feed:${userId}` } };
});

vi.mock("@/lib/services/feed-service", () => ({
  FeedService: {
    markRead: mocks.markRead,
    clear: mocks.clear,
    dismiss: mocks.dismiss,
    restore: mocks.restore,
    list: vi.fn(),
  },
}));

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

vi.mock("@/lib/feed/use-feed-live-refresh", () => ({
  useFeedLiveRefresh: vi.fn(),
}));

vi.mock("@/lib/feed/use-feed-briefing", () => ({
  useFeedBriefing: () => ({
    upcomingEvents: [],
    pendingKyc: null,
    needsReplyCount: 0,
  }),
}));

vi.mock("@/lib/feed/use-feed-actionables", () => ({
  useFeedActionables: () => ({
    actionables: mocks.actionables,
    loading: mocks.actionablesLoading,
    error: mocks.actionablesError,
    progressLoading: mocks.progressLoading,
    progressError: mocks.progressError,
    retry: mocks.retryActionables,
    hasClearableSmsEmergencies: true,
    clearSmsEmergencies: mocks.clearSmsEmergencies,
    consentUnlockPrompt: {
      open: false,
      title: "",
      description: "",
      cancel: () => undefined,
    },
    documentPricePrompt: mocks.documentPricePrompt,
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
      ) : mocks.useActionTestRow ? (
        <button type="button" onClick={() => { void props.onRemove?.(props.item); }}>
          row-{props.item.id}
        </button>
      ) : (
        <div>row-{props.item.id}</div>
      );
    },
  };
});

// The push prompt reads the app-wide notification provider; this suite only
// covers clearing, and feed-push-prompt.test.tsx owns the prompt.
vi.mock("@/components/feed/feed-shared-files-sheet", () => ({
  FeedSharedFilesSheet: ({ requestId, sharedCount }: { requestId: string; sharedCount: number }) => (
    <div data-testid="shared-files-sheet" data-request-id={requestId} data-count={sharedCount} />
  ),
}));

vi.mock("@/components/feed/feed-push-prompt", () => ({
  FeedPushPrompt: () => null,
}));

vi.mock("@/components/feed/feed-actionable-row", () => ({
  FeedActionableRow: () => null,
}));

vi.mock("@/components/consent/document-payout-account", () => ({
  DocumentBankPayoutStatusCard: () => null,
  DocumentPayoutAccountCard: () => null,
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
import { CacheService } from "@/lib/services/cache-service";

beforeEach(() => {
  CacheService.getInstance().clear();
  mocks.resourceMissing = false;
  mocks.historyLoading = false;
  mocks.historyError = null;
  mocks.actionablesLoading = false;
  mocks.actionablesError = null;
  mocks.progressLoading = false;
  mocks.progressError = null;
});
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
  it("keeps loaded history usable while another lane is still loading", async () => {
    mocks.actionablesLoading = true;
    render(<FeedPage />);
    await screen.findByText("row-5");
    expect(screen.getByRole("region", { name: "Needs you status" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(screen.queryByLabelText("Loading feed")).toBeNull();
  });

  it("offers recovery for a failed lane while another cold lane is pending", () => {
    mocks.resourceMissing = true;
    mocks.historyLoading = true;
    mocks.actionablesError = "Unavailable";
    render(<FeedPage />);
    expect(screen.getByText("Some activity could not load. Other updates are still loading.")).toBeVisible();
    expect(screen.queryByText("No activity yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.retryActionables).toHaveBeenCalled();
  });
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mocks.useRealFeedRow = false;
    mocks.actionables = [];
    mocks.useActionTestRow = false;
    mocks.currentUser = mocks.user;
    mocks.user.getIdToken.mockResolvedValue("firebase-token");
    mocks.markRead.mockResolvedValue(undefined);
    mocks.clear.mockResolvedValue(undefined);
    mocks.clearSmsEmergencies.mockResolvedValue(undefined);
    mocks.dismiss.mockResolvedValue({ token: "dismissal-token", itemIds: null });
    mocks.restore.mockResolvedValue(true);
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

  it("keeps ended SMS out of Needs you and groups a live sender's earlier incidents in Live", async () => {
    const sms = (id: string, sender: string, live = false): FeedActionable => ({
      id, title: sender, person: { displayName: sender, photoUrl: null },
      description: live ? "Emergency SMS · Active" : "Emergency SMS · Revoked",
      icon: () => null, iconTone: "capability", actions: [], sortAt: 1,
      smsEmergency: { senderId: sender }, emphasis: live ? "emergency" : undefined,
      displayTimestamp: Date.parse("2026-08-12T09:00:00Z"),
    });
    mocks.actionables = [sms("a1", "Alex", true), sms("a2", "Alex"), sms("b1", "Blair"), sms("b2", "Blair"), {
      id: "request", title: "Pending request", description: "Needs a decision", icon: () => null,
      iconTone: "capability", actions: [], sortAt: 0,
    }];
    await renderAfterAutomaticRead();
    expect(within(screen.getByRole("region", { name: "Live" })).getByText("2 recent SMS alerts · 1 active")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Recent SMS alerts" })).getByText("2 recent SMS alerts · All ended")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Needs you" })).queryByText(/SMS alerts/)).toBeNull();
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
        name: "Open Ankit",
      }),
    );

    expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith(
      "/one/location?section=shared",
    );
  });

  it("opens the owner's shared files in place instead of routing", async () => {
    mocks.useRealFeedRow = true;
    mocks.data.items = [
      {
        ...mocks.data.items[0],
        source_domain: "connected_systems",
        event_type: "document_share_files_sent",
        actor_label: "Ankit",
        metadata: {
          request_id: "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e",
          counterpart_label: "Ankit",
          shared_count: 12,
        },
      },
    ];
    await renderAfterAutomaticRead();
    expect(screen.queryByTestId("shared-files-sheet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open One sent 12 files to Ankit" }));

    const sheet = screen.getByTestId("shared-files-sheet");
    expect(sheet).toHaveAttribute("data-request-id", "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e");
    expect(sheet).toHaveAttribute("data-count", "12");
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("refreshes the displayed details when the server updates an existing notification", async () => {
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
    const view = await renderAfterAutomaticRead();
    expect(
      screen.getByText("Shared location with you for 2 hours"),
    ).toBeInTheDocument();

    mocks.data = {
      ...mocks.data,
      items: [
        {
          ...mocks.data.items[0],
          metadata: { ...mocks.data.items[0].metadata, duration_hours: 3 },
        },
      ],
    };
    await act(async () => view.rerender(<FeedPage />));

    expect(
      screen.getByText("Shared location with you for 3 hours"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Shared location with you for 2 hours")).toBeNull();
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

  it("keeps an old device clear hidden while transferring it to the server", async () => {
    window.localStorage.setItem("hushh:feed-cleared-through-id:feed-user", "5");
    mocks.clear.mockImplementation(() => new Promise(() => undefined));

    render(<FeedPage />);

    expect(mocks.feedRowRender).not.toHaveBeenCalled();
    expect(screen.queryByText("row-5")).toBeNull();
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith({
      idToken: "firebase-token",
      userId: "feed-user", isEffectCurrent: expect.any(Function),
      upToId: "5",
    }));
    await waitFor(() =>
      expect(screen.getByText("No activity yet")).toBeInTheDocument(),
    );
  });

  it("requires confirmation, commits Clear to the server, and keeps a later id visible", async () => {
    const view = await renderAfterAutomaticRead();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear feed notifications",
      }),
    );
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm clear feed notifications",
      }),
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Feed cleared",
      ),
    );

    expect(mocks.clear).toHaveBeenCalledWith({
      idToken: "firebase-token",
      userId: "feed-user", isEffectCurrent: expect.any(Function),
      upToId: "5",
    });
    expect(mocks.clear.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearSmsEmergencies.mock.invocationCallOrder[0],
    );
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBeNull();

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

  it("removes only after server acknowledgement and restores through Undo", async () => {
    mocks.useActionTestRow = true;
    let confirmDismiss: (() => void) | undefined;
    mocks.dismiss.mockImplementationOnce(() => new Promise((resolve) => {
      confirmDismiss = () => resolve({ token: "dismissal-token", itemIds: ["5"] });
    }));
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "5",
    }));
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();

    await act(async () => { confirmDismiss?.(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-5" })).toBeNull());
    const undo = mocks.toastSuccess.mock.calls.find((call) => call[0] === "Removed from Feed")?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    expect(undo?.action?.onClick).toBeTypeOf("function");
    await act(async () => { undo?.action?.onClick?.(); });
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "5",
      dismissalToken: "dismissal-token",
    }));
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();
  });

  it("keeps a row hidden when its Undo token is stale", async () => {
    mocks.useActionTestRow = true;
    mocks.restore.mockResolvedValueOnce(false);
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-5" })).toBeNull());
    const undo = mocks.toastSuccess.mock.calls.find((call) => call[0] === "Removed from Feed")?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    await act(async () => { undo?.action?.onClick?.(); });

    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({
      itemId: "5", dismissalToken: "dismissal-token",
    }));
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith("This item can no longer be restored.");
  });

  it("leaves a row visible when server dismissal fails", async () => {
    mocks.useActionTestRow = true;
    mocks.dismiss.mockRejectedValueOnce(new Error("backend unavailable"));
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't remove this item. Try again.",
    ));
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();
  });

  it("does not claim removal when the server acknowledges no dismissed row", async () => {
    mocks.useActionTestRow = true;
    mocks.dismiss.mockResolvedValueOnce(null);
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't confirm removal. Try again.",
    ));
    expect(mocks.refresh).toHaveBeenCalledWith({ force: true });
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
      "Removed from Feed", expect.anything(),
    );
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalledWith("action");
  });

  it("does not reveal an older consent bundle row from stale cache after dismissal", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "6", source_domain: "consent", event_type: "consent_granted", metadata: { bundle_id: "same-request" } },
      { ...mocks.data.items[0], id: "5", source_domain: "consent", event_type: "consent_granted", metadata: { bundle_id: "same-request" } },
    ];
    await renderAfterAutomaticRead();
    expect(screen.getByRole("button", { name: "row-6" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-6" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "6",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-6" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();
  });

  it("does not reveal an older Drive outcome after removing the displayed outcome", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "6", source_domain: "connected_systems", event_type: "document_share_outcome", metadata: { request_id: "request-1", user_facing_status: "completed" } },
      { ...mocks.data.items[0], id: "5", source_domain: "connected_systems", event_type: "document_share_outcome", metadata: { request_id: "request-1", user_facing_status: "no_match" } },
    ];
    await renderAfterAutomaticRead();
    expect(screen.getByRole("button", { name: "row-6" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-6" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "6",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-6" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();
  });

  it("does not show the older Drive decision after removing 'No files were shared'", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "11", source_domain: "connected_systems", event_type: "document_share_outcome", metadata: { request_id: "request-x", user_facing_status: "no_files_shared" } },
      { ...mocks.data.items[0], id: "10", source_domain: "connected_systems", event_type: "document_share_decided", metadata: { request_id: "request-x", user_facing_status: "pending" } },
    ];
    // The server hides the decision it was folding behind the outcome.
    mocks.dismiss.mockResolvedValueOnce({ token: "dismissal-token", itemIds: ["10", "11"] });
    await renderAfterAutomaticRead();
    expect(screen.getByRole("button", { name: "row-11" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "row-10" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-11" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "row-11" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-10" })).toBeNull();
  });

  it("does not show the old Pay row after removing the payment confirmation", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "31", source_domain: "connected_systems", event_type: "document_share_payment_confirmed", metadata: { request_id: "request-y" } },
      { ...mocks.data.items[0], id: "30", source_domain: "connected_systems", event_type: "document_share_payment_ready", metadata: { request_id: "request-y", user_facing_status: "pending" } },
    ];
    mocks.dismiss.mockResolvedValueOnce({ token: "dismissal-token", itemIds: ["30", "31"] });
    await renderAfterAutomaticRead();
    expect(screen.queryByRole("button", { name: "row-30" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-31" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "row-31" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-30" })).toBeNull();
  });

  it("retires a pending Undo when the account signs out", async () => {
    mocks.useActionTestRow = true;
    mocks.toastSuccess.mockReturnValueOnce("undo-toast");
    const view = await renderAfterAutomaticRead();
    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-5" })).toBeNull());
    const undo = mocks.toastSuccess.mock.calls.find((call) => call[0] === "Removed from Feed")?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;

    try {
      mocks.currentUser = null;
      await act(async () => view.rerender(<FeedPage />));
      expect(mocks.toastDismiss).toHaveBeenCalledWith("undo-toast");
      mocks.currentUser = { uid: "next-user", getIdToken: vi.fn().mockResolvedValue("next-token") };
      await act(async () => view.rerender(<FeedPage />));
      await act(async () => { undo?.action?.onClick?.(); });

      expect(undo?.action?.onClick).toBeTypeOf("function");
      expect(mocks.restore).not.toHaveBeenCalled();
    } finally {
      mocks.currentUser = mocks.user;
    }
  });

  it("saves the SOS clear even when only SOS cards are showing", async () => {
    mocks.data.items = [];
    render(<FeedPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Clear feed notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear feed notifications" }));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Feed cleared"));
    expect(mocks.clearSmsEmergencies).toHaveBeenCalledTimes(1);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("says the Feed was not cleared if the SOS clear throws", async () => {
    await renderAfterAutomaticRead();
    // A server failure does not reject (the hook keeps the clear on this
    // device); any unexpected error still reaches the page as a failed Clear.
    mocks.clearSmsEmergencies.mockRejectedValueOnce(new Error("unexpected"));

    fireEvent.click(screen.getByRole("button", { name: "Clear feed notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear feed notifications" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Couldn't clear your feed."));
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith("Feed cleared");
  });

  it("keeps the clear action compact on phone and desktop layouts", async () => {
    await renderAfterAutomaticRead();

    const clearButton = screen.getByRole("button", {
      name: "Clear feed notifications",
    });
    expect(clearButton).toHaveClass("w-auto", "max-w-full", "px-4");
    expect(clearButton).not.toHaveClass("w-full");
  });

  // Regression (localhost run 2026-09-28): the red Clear action
  // sat directly under the Needs you row, reading as an answer to it.
  it("keeps Clear quiet and after the history, destructive only once armed", async () => {
    const view = await renderAfterAutomaticRead();
    const clearButton = screen.getByRole("button", { name: "Clear feed notifications" });
    const daySections = view.container.querySelectorAll("section[aria-label]");
    const lastHistorySection = daySections[daySections.length - 1]!;
    expect(lastHistorySection).toBeTruthy();
    expect(lastHistorySection.contains(clearButton)).toBe(false);
    expect(lastHistorySection.compareDocumentPosition(clearButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(clearButton.className).not.toMatch(/text-destructive/);
    fireEvent.click(clearButton);
    expect(screen.getByRole("button", { name: "Confirm clear feed notifications" }).className)
      .toMatch(/text-destructive/);
  });

  it("does not dismiss revoked SOS cards or hide history when server Clear fails", async () => {
    await renderAfterAutomaticRead();
    mocks.clear.mockRejectedValueOnce(new Error("backend unavailable"));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear feed notifications",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm clear feed notifications",
      }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't clear your feed.",
      ),
    );
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
  });
});

describe("Feed document price step", () => {
  function pricePrompt(overrides: Record<string, unknown> = {}) {
    return {
      open: true,
      requesterLabel: "Kushal Trivedi",
      paymentRequired: true,
      lockedAmountCents: null,
      initialAmountCents: null,
      priceOnly: false,
      purpose: "Tax returns",
      recipientEmail: "kushal@example.invalid",
      periodStart: null,
      periodEnd: null,
      detailsPending: false,
      busy: false,
      error: null,
      submit: vi.fn(),
      cancel: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentPricePrompt = undefined;
  });

  it("shows the owner the estimate the requester saw, and still sends the owner's price", () => {
    const prompt = pricePrompt({ estimateCents: 2500 });
    mocks.documentPricePrompt = prompt;
    render(<FeedPage />);

    expect(screen.getByText("Requester saw an estimate of $25")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Allow · $10" }));
    expect(prompt.submit).toHaveBeenCalledExactlyOnceWith(1000);
  });

  it("prices normally when no estimate is known", () => {
    const prompt = pricePrompt();
    mocks.documentPricePrompt = prompt;
    render(<FeedPage />);

    expect(screen.queryByText(/Requester saw an estimate/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow · $10" }));
    expect(prompt.submit).toHaveBeenCalledExactlyOnceWith(1000);
  });
});
