import type { ReactNode } from "react";
import type { FeedRow as RealFeedRow } from "@/components/feed/feed-row";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import { vi } from "vitest";

vi.mock("@/lib/persona/persona-context", () => ({ usePersonaState: () => ({ activePersona: "investor" }) }));

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
      next_cursor: null as string | null,
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
    list: vi.fn(),
    activityDetail: vi.fn().mockResolvedValue(null),
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
  useAuth: () => ({ user: mocks.currentUser, userId: mocks.currentUser?.uid ?? null, loading: false }),
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
    list: mocks.list,
    activityDetail: mocks.activityDetail,
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
        <div data-feed-history-row="">row-{props.item.id}</div>
      );
    },
  };
});

vi.mock("@/components/feed/feed-shared-files-sheet", () => ({
  FeedSharedFilesSheet: ({ requestId, sharedCount }: { requestId: string; sharedCount: number }) => (
    <div data-testid="shared-files-sheet" data-request-id={requestId} data-count={sharedCount} />
  ),
}));

vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({
  useFinanceShareContext: () => ({ ready: false, session: "", capture: () => null }),
}));

// The device registration behavior is covered in feed-push-prompt.test.tsx.
vi.mock("@/components/feed/feed-push-prompt", () => ({
  FeedPushPrompt: () => <div>Reconnect notifications</div>,
}));

vi.mock("@/components/feed/feed-actionable-row", () => ({
  FeedActionableRow: ({ item }: { item: FeedActionable }) => <div data-testid={`feed-actionable-${item.id}`}>{item.title}</div>,
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

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    listRequests: mocks.listRequests,
    accept: mocks.acceptRequest,
    reject: mocks.rejectRequest,
  },
}));

export function feedPageTestMocks() { return mocks; }
