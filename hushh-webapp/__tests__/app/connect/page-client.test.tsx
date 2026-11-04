// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  messageSelection: vi.fn(),
  searchDirectory: vi.fn(),
  listMutualConnections: vi.fn(),
  listConnections: vi.fn(),
  listConnectionsPage: vi.fn(),
  listRequests: vi.fn(),
  sendRequest: vi.fn(),
  cancel: vi.fn(),
  removeConnection: vi.fn(),
  getScopeCatalog: vi.fn(),
  getPersonContext: vi.fn(),
  searchInformationScopes: vi.fn(),
  onConnectionCapabilityMutated: vi.fn(),
  onConnectionGraphMutated: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  searchParams: new URLSearchParams(),
  shareLink: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  isNative: vi.fn(() => false),
  // The real hook hands back the same user across renders. Rebuilding it per
  // render would retrigger every effect keyed on it and spin forever, which
  // would say nothing about the page.
  user: { uid: "me", getIdToken: async () => "id-token" },
  // AuthContext hydrates a verified backend phone separately when Firebase's
  // User has no phoneNumber (notably the native UAT verification path).
  authPhoneNumber: null as string | null,
  resolveVerifiedPhoneNumber: vi.fn(),
  // Contact sync hides its control until it knows a source exists, and the
  // probe below is what decides. jsdom has no `navigator.contacts`, so the real
  // plugin answers "unavailable", the control never renders, and a suite that
  // did not set this would assert nothing while staying green.
  contactsPermissionState: "prompt" as "prompt" | "granted" | "unavailable",
  syncContactSignals: vi.fn(),
  toastInfo: vi.fn(),
  requestContactCheck: vi.fn(() => true),
}));

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    getPermissionState: async () => ({
      state: mocks.contactsPermissionState,
    }),
    requestPermission: async () => ({ state: mocks.contactsPermissionState }),
    readContacts: async () => ({
      contacts: [],
      sourcePlatform: "web",
      limited: true,
      truncated: false,
      totalAvailable: 0,
    }),
    openAppSettings: async () => ({ opened: false }),
  },
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: mocks.isNative,
}));

// Only the network-facing call is replaced. `describeContactSyncOutcome` and
// the error types stay real, because they are what turn a result into the copy
// and the remedy a person is actually shown.
vi.mock("@/lib/one-location/contact-signals", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/one-location/contact-signals")
  >()),
  syncOneLocationContactSignals: mocks.syncContactSignals,
}));

vi.mock("@/lib/contacts/use-contact-discoverability-consent", () => ({
  useContactDiscoverabilityConsent: () => ({
    requestContactCheck: mocks.requestContactCheck,
    preference: { status: "decided", enabled: false, ruleVersion: 1 },
    dialogProps: {
      open: false,
      ready: false,
      loading: false,
      savingChoice: null,
      error: null,
      actionLabel: "Sync contacts",
      onOpenChange: vi.fn(),
      onChoose: vi.fn(),
      onRetry: vi.fn(),
    },
  }),
}));

vi.mock("@/lib/direct-messages/navigate-direct-message", () => ({
  navigateDirectMessage: (router: { push: (href: string) => void }, selection: unknown) => {
    mocks.messageSelection(selection);
    router.push("/one/messages?token=opaque-test-token");
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: mocks.routerReplace,
    back: vi.fn(),
  }),
  usePathname: () => "/one/connect",
  // The Circles surface lives in `?tab=`, because a circle is a place you can
  // be sent and a surface that only exists in `useState` cannot be linked to.
  // Directory tabs stay local state.
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: () => ({
    user: mocks.user,
    // Generation-0 accounts: the application owner equals the Firebase UID.
    userId: mocks.user.uid,
    phoneNumber: mocks.authPhoneNumber,
    resolveVerifiedPhoneNumber: mocks.resolveVerifiedPhoneNumber,
  }),
}));

// The debounce itself is covered by its own hook test; collapsing it here keeps
// this suite about which request the surface makes, not about timer plumbing.
vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsServiceRequestError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
  ConnectionsService: {
    searchDirectory: mocks.searchDirectory,
    listMutualConnections: mocks.listMutualConnections,
    listConnections: mocks.listConnections,
    listConnectionsPage: mocks.listConnectionsPage,
    listRequests: mocks.listRequests,
    sendRequest: mocks.sendRequest,
    cancel: mocks.cancel,
    removeConnection: mocks.removeConnection,
    getScopeCatalog: mocks.getScopeCatalog,
    getPersonContext: mocks.getPersonContext,
    searchInformationScopes: mocks.searchInformationScopes,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConnectionCapabilityMutated: mocks.onConnectionCapabilityMutated,
    onConnectionGraphMutated: mocks.onConnectionGraphMutated,
  },
}));

// The Around-you tab has its own suites; keep its directory services out of
// this render so a failure here can only mean the People tab. Stubbing the
// switch rather than one directory keeps that true as directories are added --
// stubbing `advisors-nearby` alone stopped covering the tab the moment a second
// and third directory hung off it.
vi.mock("@/components/connect/nearby-directories", () => ({
  NearbyDirectories: () => <div data-testid="nearby-directories-stub" />,
}));

function chooseDirectory(name: "People" | "RIAs" | "Around you") {
  fireEvent.click(screen.getByRole("button", { name: /Current directory:/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function mockDirectoryObserver() {
  const observers: Array<{
    notify: IntersectionObserverCallback;
    targets: Set<Element>;
  }> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets = new Set<Element>();
      constructor(notify: IntersectionObserverCallback) {
        observers.push({ notify, targets: this.targets });
      }
      observe = (target: Element) => {
        this.targets.add(target);
      };
      unobserve = (target: Element) => {
        this.targets.delete(target);
      };
      disconnect = () => {
        this.targets.clear();
      };
    },
  );
  return () => {
    const sentinel = screen.getByTestId("connect-load-more-row");
    const observer = observers.find((entry) => entry.targets.has(sentinel));
    if (!observer) return false;
    const entries = [
      { target: sentinel, isIntersecting: true },
    ] as IntersectionObserverEntry[];
    observer.notify(entries, {} as IntersectionObserver);
    return true;
  };
}

afterEach(() => vi.unstubAllGlobals());

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    // A third branch the sync flow uses: no matches at all, and the
    // "unavailable" failure. Without it the mock throws instead of the test
    // asserting anything.
    info: mocks.toastInfo,
  },
}));

// The ladder itself (native sheet -> Web Share -> clipboard) is proved in
// __tests__/share/share-link.test.ts. What belongs here is the page's half of
// the contract: when an invite is offered, and what it hands over.
vi.mock("@/lib/share/share-link", async () => {
  const actual = await vi.importActual<typeof import("@/lib/share/share-link")>(
    "@/lib/share/share-link",
  );
  return { ...actual, shareLink: mocks.shareLink };
});

import ConnectPageClient from "@/app/connect/page-client";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { ShareUnavailableError } from "@/lib/share/share-link";
import { dispatchConnectionGraphChanged } from "@/lib/connections/connection-graph-events";
import { OUTGOING_REQUEST_WATCH_INTERVAL_MS } from "@/lib/connections/use-outgoing-request-resolution-watch";
import {
  resolveLocalOnboardingHandler,
  prepareLocalOnboardingAction,
} from "@/lib/agent/local-onboarding-actions";
import {
  parseVoiceCard,
  parseVoiceConfirm,
} from "@/lib/kai/actions/voice-action-card";

function person(userId: string, displayName: string) {
  return {
    userId,
    displayName,
    email: `${userId}@example.com`,
    relationship: "none" as const,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

type TestConnectionPage = {
  items: Array<{
    connectionId: string;
    userId: string;
    displayName: string;
    photoUrl: string | null;
  }>;
  page: number;
  hasMore: boolean;
  totalCount: number;
  audience: "all";
};

/** One hundred people, so the pager range and final-page copy are visible. */
const EVERYONE = Array.from({ length: 100 }, (_, index) =>
  person(`u${index}`, `Person ${index}`),
);

describe("Location command connection prerequisite", () => {
  it("discards the previous person's review and pending catalog when the requested person changes", async () => {
    mocks.searchParams = new URLSearchParams("reviewPerson=u9");
    mocks.getPersonContext
      .mockResolvedValueOnce({
        person: person("u9", "First target"),
        request: null,
      })
      .mockResolvedValue({
        person: {
          ...person("u10", "Already connected"),
          relationship: "connected",
        },
        request: null,
      });
    const catalog = deferred<any>();
    mocks.getScopeCatalog.mockReturnValueOnce(catalog.promise);
    const view = render(<ConnectPageClient />);
    await screen.findByRole("dialog", { name: "Send connection requests" });
    mocks.searchParams = new URLSearchParams("reviewPerson=u10");
    view.rerender(<ConnectPageClient />);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Send connection requests" }),
      ).toBeNull(),
    );
    await act(async () =>
      catalog.resolve({
        counterpartUserId: "u9",
        items: [],
        offerableItems: [],
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Send connection requests" }),
    ).toBeNull();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("correlates a freshly discovered incoming request redirect to its exact person review", async () => {
    mocks.searchParams = new URLSearchParams("reviewPerson=u9");
    mocks.getPersonContext.mockResolvedValue({
      person: { ...person("u9", "Incoming"), relationship: "pending_incoming" },
      request: { id: "request-9", direction: "incoming", status: "pending" },
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const destination = new URL(
      mocks.routerPush.mock.calls[0]![0],
      "https://app.invalid",
    );
    expect(destination.searchParams.get("from")).toBe(
      "/one/connect?reviewPerson=u9",
    );
    expect(destination.searchParams.get("requestId")).toBe("request-9");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });
  it("opens the actual scope review without sending and can reopen after cancellation", async () => {
    mocks.searchParams = new URLSearchParams("reviewPerson=u9");
    mocks.getPersonContext.mockResolvedValue({
      person: person("u9", "Command Person"),
      request: null,
    });
    const view = render(<ConnectPageClient />);
    const dialog = await screen.findByRole("dialog", {
      name: "Send connection requests",
    });
    await within(dialog).findByRole("button", { name: "Send requests" });
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    view.rerender(<ConnectPageClient />);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Send connection requests" }),
      ).toBeNull(),
    );
    expect(mocks.routerReplace).toHaveBeenCalledWith("/one/connect");
    mocks.searchParams = new URLSearchParams("reviewPerson=u9");
    view.rerender(<ConnectPageClient />);
    await screen.findByRole("dialog", { name: "Send connection requests" });
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("discards the old owner's pending catalog even after A to B to A", async () => {
    mocks.searchParams = new URLSearchParams("reviewPerson=u9");
    mocks.getPersonContext
      .mockResolvedValueOnce({
        person: person("u9", "Owner A target"),
        request: null,
      })
      .mockResolvedValue({
        person: {
          ...person("u9", "Pending"),
          relationship: "pending_outgoing",
        },
        request: { id: "r", direction: "outgoing", status: "pending" },
      });
    const catalog = deferred<any>();
    mocks.getScopeCatalog.mockReturnValueOnce(catalog.promise);
    const view = render(<ConnectPageClient />);
    await screen.findByRole("dialog", { name: "Send connection requests" });
    const ownerA = mocks.user;
    mocks.user = { uid: "owner-b", getIdToken: async () => "token-b" };
    view.rerender(<ConnectPageClient />);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Send connection requests" }),
      ).toBeNull(),
    );
    mocks.user = ownerA;
    view.rerender(<ConnectPageClient />);
    await act(async () =>
      catalog.resolve({
        counterpartUserId: "u9",
        items: [],
        offerableItems: [],
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Send connection requests" }),
    ).toBeNull();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("treats a raced reverse request as incoming review, never as a sent or accepted connection", async () => {
    mocks.searchParams = new URLSearchParams("reviewPerson=u9");
    mocks.getPersonContext.mockResolvedValue({
      person: person("u9", "Command Person"),
      request: null,
    });
    mocks.sendRequest.mockResolvedValue({
      id: "incoming-request",
      status: "pending",
      requesterUserId: "u9",
      addresseeUserId: "me",
    });
    render(<ConnectPageClient />);
    const dialog = await screen.findByRole("dialog", {
      name: "Send connection requests",
    });
    const send = await within(dialog).findByRole("button", {
      name: "Send requests",
    });
    await waitFor(() => expect(send).not.toBeDisabled());
    fireEvent.click(send);
    await waitFor(() =>
      expect(mocks.routerPush).toHaveBeenCalledWith(
        expect.stringContaining("incoming-request"),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "1 incoming request needs your review.",
    );
    expect(mocks.sendRequest).toHaveBeenCalledOnce();
  });
});

beforeEach(() => {
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("me");
  vi.clearAllMocks();
  mocks.searchDirectory.mockReset();
  mocks.listMutualConnections.mockReset();
  mocks.user = { uid: "me", getIdToken: async () => "id-token" };
  mocks.getPersonContext.mockReset();
  mocks.routerReplace.mockImplementation((href: string) => {
    mocks.searchParams = new URLSearchParams(href.split("?")[1] || "");
  });
  mocks.requestContactCheck.mockReturnValue(true);
  mocks.authPhoneNumber = "+919000000001";
  mocks.resolveVerifiedPhoneNumber.mockImplementation(
    async () => mocks.authPhoneNumber,
  );
  mocks.isNative.mockReturnValue(false);
  // A leaked search query in sessionStorage would silently seed the next
  // test's render, the same way a leaked `?tab=` would.
  window.sessionStorage.clear();
  // Connect caches its first page per person; a page cached by one test
  // would paint the next test's first render.
  CacheService.getInstance().invalidateUser("me");
  // A fresh URL per test: the outer tab is read from it, so a leaked
  // `?tab=circles` would silently render the wrong surface for everything
  // that ran after it.
  mocks.searchParams = new URLSearchParams();
  mocks.listConnections.mockResolvedValue([]);
  mocks.listConnectionsPage.mockImplementation(async (options) => {
    const allItems = await mocks.listConnections(options);
    const items =
      options.audience === "ria"
        ? allItems.filter((item: { isRia?: boolean }) => item.isRia === true)
        : allItems;
    return {
      items,
      page: options.page ?? 1,
      hasMore: false,
      totalCount: items.length,
      audience: options.audience ?? "all",
    };
  });
  mocks.listRequests.mockResolvedValue([]);
  mocks.getScopeCatalog.mockResolvedValue({
    counterpartUserId: "u0",
    items: [],
    offerableItems: [],
  });
  mocks.searchDirectory.mockImplementation(async (options) => {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.max(1, Number(options.limit) || 20);
    const query = String(options.query || "")
      .trim()
      .toLowerCase();
    const matches = query
      ? EVERYONE.filter((entry) =>
          entry.displayName?.toLowerCase().includes(query),
        )
      : EVERYONE;
    const start = (page - 1) * limit;
    return {
      items: matches.slice(start, start + limit),
      hasMore: start + limit < matches.length,
      page,
      totalCount: matches.length,
    };
  });
});

describe("P0 connection reconciliation", () => {
  it("repairs idle connections without spending directory searches, but retains graph refreshes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
      mocks.searchDirectory.mockClear();
      mocks.listConnectionsPage.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(180_000));
      expect(mocks.listConnectionsPage).toHaveBeenCalled();
      expect(mocks.searchDirectory).not.toHaveBeenCalled();
      act(() => dispatchConnectionGraphChanged("me"));
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledOnce());
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains a graph refresh queued during an idle repair", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
      const repair = deferred<TestConnectionPage>();
      mocks.listConnectionsPage.mockReturnValueOnce(repair.promise);
      mocks.searchDirectory.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(mocks.searchDirectory).not.toHaveBeenCalled();
      act(() => dispatchConnectionGraphChanged("me"));
      await act(async () => {
        repair.resolve({ items: [], page: 1, hasMore: false, totalCount: 0, audience: "all" });
      });
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledOnce());
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("refreshes connection, request, and directory projections after a graph event", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
    await waitFor(() => expect(mocks.listRequests).toHaveBeenCalled());
    mocks.listConnectionsPage.mockClear();
    mocks.listRequests.mockClear();
    mocks.searchDirectory.mockClear();

    act(() => dispatchConnectionGraphChanged("me"));

    await waitFor(() =>
      expect(mocks.listConnectionsPage).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(mocks.listRequests).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
  });

  it("keeps directory cards visible during a background graph refresh", async () => {
    const refreshed = deferred<{ items: ReturnType<typeof person>[]; hasMore: boolean }>();
    mocks.searchDirectory.mockResolvedValueOnce({
      items: [person("first", "Visible Person")],
      hasMore: false,
    }).mockImplementation(() => refreshed.promise);
    render(<ConnectPageClient />);
    await screen.findByText("Visible Person");
    act(() => dispatchConnectionGraphChanged("me"));
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Visible Person")).toBeVisible();
    expect(screen.queryByText("Finding people…")).toBeNull();
    await act(async () => {
      refreshed.resolve({ items: [person("next", "Updated Person")], hasMore: false });
    });
    await screen.findByText("Updated Person");
    expect(screen.queryByText("Visible Person")).toBeNull();
  });

  it("reconciles on foreground focus and coalesces a duplicate focus burst", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
      mocks.listConnectionsPage.mockClear();
      mocks.listRequests.mockClear();

      act(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() =>
        expect(mocks.listConnectionsPage).toHaveBeenCalledOnce(),
      );
      expect(mocks.listRequests).toHaveBeenCalledOnce();
    } finally {
      visibility.mockRestore();
    }
  });

  it("shows an accepted sent request without a push or manual refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    mocks.listRequests.mockResolvedValue([
      { id: "req-accepted", counterpartUserId: "u9" },
    ]);
    try {
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.listRequests).toHaveBeenCalled());
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
      mocks.listConnectionsPage.mockClear();

      // Negative control: a request that is still pending changes nothing.
      await act(() =>
        vi.advanceTimersByTimeAsync(OUTGOING_REQUEST_WATCH_INTERVAL_MS),
      );
      expect(mocks.listConnectionsPage).not.toHaveBeenCalled();

      mocks.listRequests.mockResolvedValue([]);
      await act(() =>
        vi.advanceTimersByTimeAsync(OUTGOING_REQUEST_WATCH_INTERVAL_MS),
      );
      await waitFor(() =>
        expect(mocks.listConnectionsPage).toHaveBeenCalledOnce(),
      );
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("queues an authoritative pass when connectivity returns mid-refresh", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const firstPage = deferred<TestConnectionPage>();
    const page = { items: [], hasMore: false, page: 1, totalCount: 0 };
    try {
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
      mocks.listConnectionsPage.mockClear();
      mocks.listConnectionsPage
        .mockImplementationOnce(() => firstPage.promise)
        .mockResolvedValue(page);

      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() =>
        expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(1),
      );
      act(() => window.dispatchEvent(new Event("online")));
      firstPage.resolve(page);

      await waitFor(() =>
        expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(2),
      );
    } finally {
      visibility.mockRestore();
    }
  });
});

describe("Connect — directory under rate limits", () => {
  const rateLimited = () =>
    Object.assign(new Error("Too many searches. Try again shortly."), {
      status: 429,
    });

  it("keeps the people already shown when a refresh is refused", async () => {
    mocks.searchDirectory
      .mockResolvedValueOnce({ items: [person("first", "Visible Person")], hasMore: false })
      .mockRejectedValue(rateLimited());
    render(<ConnectPageClient />);
    await screen.findByText("Visible Person");

    act(() => dispatchConnectionGraphChanged("me"));
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(screen.getByText("Visible Person")).toBeVisible();
    expect(screen.queryByText("People are unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry loading people" })).toBeNull();
  });

  it("shows the last list on a revisit even when the first read is refused", async () => {
    mocks.searchDirectory.mockResolvedValueOnce({
      items: [person("first", "Visible Person")],
      hasMore: false,
    });
    const first = render(<ConnectPageClient />);
    await screen.findByText("Visible Person");
    first.unmount();

    mocks.searchDirectory.mockReset();
    mocks.searchDirectory.mockRejectedValue(rateLimited());
    render(<ConnectPageClient />);

    expect(await screen.findByText("Visible Person")).toBeVisible();
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByText("Visible Person")).toBeVisible();
    expect(screen.queryByText("People are unavailable")).toBeNull();
  });

  it("does not show another person's saved list", async () => {
    mocks.searchDirectory.mockResolvedValueOnce({
      items: [person("first", "Visible Person")],
      hasMore: false,
    });
    const first = render(<ConnectPageClient />);
    await screen.findByText("Visible Person");
    first.unmount();

    mocks.user = { uid: "someone-else", getIdToken: async () => "id-token" };
    mocks.searchDirectory.mockReset();
    mocks.searchDirectory.mockRejectedValue(rateLimited());
    render(<ConnectPageClient />);

    expect(await screen.findByText("People are taking a moment")).toBeVisible();
    expect(screen.queryByText("Visible Person")).toBeNull();
  });

  it("never offers a button for a rate limit, and says people are slow, not broken", async () => {
    mocks.searchDirectory.mockRejectedValue(rateLimited());
    render(<ConnectPageClient />);

    expect(await screen.findByText("People are taking a moment")).toBeVisible();
    expect(
      screen.getByText("We'll keep trying and show everyone here as soon as they're ready."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("People are unavailable")).toBeNull();
  });

  it("never pads People with connections while refused, then shows the real list on a quiet retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listConnections.mockResolvedValue([
        { connectionId: "c-known", userId: "u-known", displayName: "Known Friend", photoUrl: null },
      ]);
      mocks.searchDirectory
        .mockRejectedValueOnce(rateLimited())
        .mockResolvedValue({ items: [person("n", "Discoverable Person")], hasMore: false });
      render(<ConnectPageClient />);

      expect(await screen.findByText("People are taking a moment")).toBeVisible();
      // People is for people you are not connected to: the connection appears
      // once, in My connections, and is not copied into the refused list.
      expect(screen.getAllByText("Known Friend")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(31_000));
      expect(await screen.findByText("Discoverable Person")).toBeVisible();
      expect(screen.queryByText("People are taking a moment")).toBeNull();
      expect(screen.getAllByText("Known Friend")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still offers Try again for a real failure, which a person can act on", async () => {
    mocks.searchDirectory.mockRejectedValue(new Error("Request failed (500)"));
    render(<ConnectPageClient />);

    expect(await screen.findByText("People are unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("does not spend a directory read every time the window regains focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalled());
      mocks.searchDirectory.mockClear();
      mocks.listConnectionsPage.mockClear();

      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalledOnce());
      // The directory reread, when there is one, lands after the connections
      // read settles; let the whole reconciliation finish before judging.
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(mocks.searchDirectory).not.toHaveBeenCalled();

      // Once the directory has gone stale, coming back rereads it.
      await act(() => vi.advanceTimersByTimeAsync(121_000));
      mocks.searchDirectory.mockClear();
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledOnce());
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("Connect — People", () => {
  it("starts with discovery and keeps saved connections adjacent", async () => {
    render(<ConnectPageClient />);
    await screen.findByText("Person 0");
    const viewTabs = within(screen.getByRole("tablist", { name: "Connection views" })).getAllByRole("tab");
    expect(viewTabs[0]).toHaveTextContent("My connections");
    expect(viewTabs[1]).toHaveTextContent("Find people");
    expect(screen.getByRole("tab", { name: "Find people" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /My connections/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Search people")).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    expect(screen.getByLabelText("Search people")).not.toBeVisible();
    expect(screen.getByLabelText("Search my connections by name, email or phone")).toBeVisible();
  });



  it("keeps discovery and saved queries independent without searching to send", async () => {
    mocks.listConnectionsPage.mockImplementation(async options => ({ items: [], page: 1, hasMore: false, totalCount: 0, audience: options.audience }));
    render(<ConnectPageClient />);
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "Avery" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Search my connections by name, email or phone"), { target: { value: "Rao" } });
    await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenCalledWith(expect.objectContaining({ query: "Rao", audience: "all", page: 1 })));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Find people" }), { button: 0, ctrlKey: false });
    expect(screen.getByLabelText("Search people")).toHaveValue("Avery");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    expect(mocks.syncContactSignals).not.toHaveBeenCalled();
  });

  it("discards a late append after a new search starts", async () => {
    const oldPage = deferred<{
      items: ReturnType<typeof person>[];
      hasMore: boolean;
    }>();
    mocks.searchDirectory
      .mockResolvedValueOnce({
        items: [person("first", "First user")],
        hasMore: true,
      })
      .mockImplementationOnce(() => oldPage.promise)
      .mockResolvedValueOnce({
        items: [person("new", "New search result")],
        hasMore: false,
      });
    render(<ConnectPageClient />);
    await screen.findByText("First user");
    fireEvent.click(screen.getByRole("button", { name: "Load more people" }));
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "New" },
    });
    await screen.findByText("New search result");
    await act(async () => {
      oldPage.resolve({
        items: [person("late", "Old late result")],
        hasMore: true,
      });
    });
    expect(screen.queryByText("First user")).toBeNull();
    expect(screen.queryByText("Old late result")).toBeNull();
    expect(screen.getByText("New search result")).toBeTruthy();
    expect(mocks.searchDirectory.mock.calls.at(-1)?.[0]).toMatchObject({
      page: 1,
      query: "New",
    });
  });

  it("clears accumulated People rows when the RIA directory fails", async () => {
    mocks.searchDirectory
      .mockResolvedValueOnce({
        items: [person("people", "People directory user")],
        hasMore: false,
      })
      .mockRejectedValueOnce(new Error("Temporary directory failure"));
    render(<ConnectPageClient />);
    await screen.findByText("People directory user");
    chooseDirectory("RIAs");
    await screen.findByText("Advisors are unavailable");
    expect(screen.queryByText("People directory user")).toBeNull();
    expect(mocks.searchDirectory.mock.calls.at(-1)?.[0]).toMatchObject({
      page: 1,
      audience: "ria",
    });
  });

  it("restarts the directory from page one after contact sync changes connections", async () => {
    mocks.syncContactSignals.mockResolvedValueOnce({
      ...emptyContactSyncResult(),
      autoConnectedCount: 1,
    });
    render(<ConnectPageClient />);
    await screen.findByText("Person 0");
    fireEvent.click(screen.getByRole("button", { name: "Load more people" }));
    await screen.findByText("Person 20");
    fireEvent.click(
      await screen.findByRole("button", { name: "Sync contacts" }),
    );
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(3));
    expect(
      mocks.searchDirectory.mock.calls.map(([options]) => options.page),
    ).toEqual([1, 2, 1]);
    await waitFor(() => expect(screen.queryByText("Person 20")).toBeNull());
    expect(screen.getByText("Person 0")).toBeTruthy();
  });

  it("shows contact badges in one connection list without changing server order", async () => {
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-contact",
        userId: "u-contact",
        displayName: "Asha Contact",
        photoUrl: null,
        createdAt: "2026-08-25T00:00:00Z",
        connectedFromContacts: true,
      },
      { connectionId: "c-other", userId: "u-other", displayName: "Manual Friend", photoUrl: null, createdAt: "invalid", connectedFromContacts: false },
      { connectionId: "c-legacy", userId: "u-legacy", displayName: "Legacy Friend", photoUrl: null, createdAt: null },
      { connectionId: "c-contact-two", userId: "u-contact-two", displayName: "Second Contact", photoUrl: null, createdAt: "2026-08-26T00:00:00Z", connectedFromContacts: true },
    ]);

    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    await screen.findByText("Asha Contact");
    const list = screen.getByTestId("connect-my-connections-group");
    expect(within(list).queryByRole("heading", { name: /From contacts|Other connections/ })).toBeNull();
    const rows = within(list).getAllByTestId("connect-person-row");
    expect(rows.map(row => row.getAttribute("data-voice-label"))).toEqual([
      "Asha Contact", "Manual Friend", "Legacy Friend", "Second Contact",
    ]);
    expect(within(rows[0]).getByLabelText("Connected from your contacts")).toBeTruthy();
    expect(within(rows[3]).getByLabelText("Connected from your contacts")).toBeTruthy();
    expect(within(rows[1]).queryByLabelText("Connected from your contacts")).toBeNull();
    expect(within(rows[2]).queryByLabelText("Connected from your contacts")).toBeNull();
    expect(within(list).getAllByText("Connected")).toHaveLength(2);
  });

  it("opens a connection's person profile from My connections", async () => {
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-scoped",
        userId: "u-scoped",
        publicPersonRef: "person-ref-scoped",
        displayName: "Scoped Friend",
        photoUrl: null,
        createdAt: null,
      },
    ]);

    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    const myConnections = await screen.findByTestId(
      "connect-my-connections-group",
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    const connectionName =
      await within(myConnections).findByText("Scoped Friend");
    expect(within(myConnections).queryByRole("heading", { name: "From contacts" })).toBeNull();
    expect(within(myConnections).queryByRole("heading", { name: "Other connections" })).toBeNull();
    // The name and avatar are one control that opens the person. The actions sit
    // beside it, never inside it, so a tap on an action cannot open the profile.
    const connectionRow = connectionName.closest<HTMLElement>(
      '[data-testid="connect-person-row"]',
    );
    const openControls = connectionRow?.querySelectorAll(
      "button[aria-label=\"Open Scoped Friend's profile\"]",
    );
    expect(openControls).toHaveLength(1);
    expect(openControls?.[0]).toContainElement(connectionName);

    fireEvent.click(connectionName);

    expect(mocks.routerPush).toHaveBeenCalledWith(
      "/people/person-ref-scoped?from=%2Fone%2Fconnect",
    );
    expect(mocks.routerPush).not.toHaveBeenCalledWith(
      expect.stringContaining("/one/profile/access/connection"),
    );
    expect(mocks.routerPush).not.toHaveBeenCalledWith(
      expect.stringContaining("u-scoped"),
    );

    mocks.routerPush.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Options for Scoped Friend" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Remove Scoped Friend from your connections?");
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("appends page 2 in server order and retains contact badges", async () => {
    mocks.listConnectionsPage.mockImplementation(async (options) => ({
      items:
        options.page === 2
          ? [
              {
                connectionId: "c-51",
                userId: "u-51",
                displayName: "Same Name",
                photoUrl: null,
                connectedFromContacts: true,
              },
            ]
          : [
              {
                connectionId: "c-1",
                userId: "u-1",
                displayName: "Same Name",
                photoUrl: null,
              },
            ],
      page: options.page ?? 1,
      hasMore: options.page !== 2,
      totalCount: 5000,
      audience: options.audience ?? "all",
    }));

    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByRole("tab", { name: /My connections 5000/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more connections" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Same Name")).toHaveLength(2),
    );
    expect(screen.getByRole("tab", { name: /My connections 5000/ })).toBeTruthy();
    const rows = within(screen.getByTestId("connect-my-connections-group")).getAllByTestId("connect-person-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).queryByLabelText("Connected from your contacts")).toBeNull();
    expect(within(rows[1]).getByLabelText("Connected from your contacts")).toBeTruthy();
    expect(mocks.listConnectionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 50, audience: "all" }),
    );
  });

  it("keeps rows on refresh failure and offers a display-only retry", async () => {
    const page = {
      items: [
        {
          connectionId: "c-kept",
          userId: "u-kept",
          displayName: "Kept Friend",
          photoUrl: null,
        },
      ],
      page: 1,
      hasMore: false,
      totalCount: 1,
      audience: "all" as const,
    };
    mocks.listConnectionsPage
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ...page,
        items: [
          ...page.items,
          {
            connectionId: "c-restored",
            userId: "u-restored",
            displayName: "Restored Friend",
            photoUrl: null,
          },
        ],
        totalCount: 2,
      });
    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Kept Friend")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh contacts" }));
    expect(
      await screen.findByText("Could not refresh connections"),
    ).toBeTruthy();
    expect(screen.getByText("Kept Friend")).toBeTruthy();
    fireEvent.click(screen.getByText("Could not refresh connections"));
    expect(await screen.findByText("Restored Friend")).toBeTruthy();
    expect(screen.queryByText("Could not refresh connections")).toBeNull();
    expect(screen.getByRole("tab", { name: /My connections 2/ })).toBeTruthy();
  });

  it("blocks Load More while a removal event refreshes page 1", async () => {
    const refreshedPageOne = deferred<TestConnectionPage>();
    const stalePageThree = deferred<TestConnectionPage>();
    let firstPageCallCount = 0;
    let secondPageCallCount = 0;
    mocks.listConnectionsPage.mockImplementation(async (options) => {
      const page = options.page ?? 1;
      if (page === 1) {
        firstPageCallCount += 1;
        if (firstPageCallCount > 1) return refreshedPageOne.promise;
        return {
          items: [
            {
              connectionId: "c-current",
              userId: "u-current",
              displayName: "Current Person",
              photoUrl: null,
            },
          ],
          page: 1,
          hasMore: true,
          totalCount: 3,
          audience: "all" as const,
        };
      }
      if (page === 2) {
        secondPageCallCount += 1;
        return {
          items: [
            {
              connectionId:
                secondPageCallCount === 1 ? "c-old-page-2" : "c-new-page-2",
              userId:
                secondPageCallCount === 1 ? "u-old-page-2" : "u-new-page-2",
              displayName:
                secondPageCallCount === 1
                  ? "Old Page Two"
                  : "Refreshed Page Two",
              photoUrl: null,
            },
          ],
          page: 2,
          hasMore: true,
          totalCount: 3,
          audience: "all" as const,
        };
      }
      if (page === 3) return stalePageThree.promise;
      throw new Error(`Unexpected connections page ${page}`);
    });

    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByText("Current Person")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    expect(await screen.findByText("Old Page Two")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    expect(
      await screen.findByRole("button", { name: "Loading…" }),
    ).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("consent-state-changed", {
          detail: { action: "connection_removed" },
        }),
      );
    });

    const loadMoreDuringRefresh = await screen.findByRole("button", {
      name: "Load more connections",
    });
    expect((loadMoreDuringRefresh as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(loadMoreDuringRefresh);
    expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(4);
    expect(
      mocks.listConnectionsPage.mock.calls.filter(
        ([options]) => options.page === 3,
      ),
    ).toHaveLength(1);

    await act(async () => {
      stalePageThree.resolve({
        items: [
          {
            connectionId: "c-stale-page-3",
            userId: "u-stale-page-3",
            displayName: "Stale Page Three",
            photoUrl: null,
          },
        ],
        page: 3,
        hasMore: false,
        totalCount: 3,
        audience: "all",
      });
      await stalePageThree.promise;
    });

    expect(screen.queryByText("Stale Page Three")).toBeNull();
    expect((loadMoreDuringRefresh as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      refreshedPageOne.resolve({
        items: [
          {
            connectionId: "c-refreshed",
            userId: "u-refreshed",
            displayName: "Refreshed Person",
            photoUrl: null,
          },
        ],
        page: 1,
        hasMore: true,
        totalCount: 2,
        audience: "all",
      });
      await refreshedPageOne.promise;
    });

    expect(await screen.findByText("Refreshed Person")).toBeTruthy();
    expect(screen.queryByText("Old Page Two")).toBeNull();
    const loadMoreAfterRefresh = screen.getByRole("button", {
      name: "Load more connections",
    });
    expect((loadMoreAfterRefresh as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(loadMoreAfterRefresh);
    expect(await screen.findByText("Refreshed Page Two")).toBeTruthy();
    expect(
      mocks.listConnectionsPage.mock.calls.map(([options]) => options.page),
    ).toEqual([1, 2, 3, 1, 2]);
  }, 10_000);

  it("refreshes My connections from the visible refresh control", async () => {
    const refreshedPageOne = deferred<TestConnectionPage>();
    let firstPageCallCount = 0;
    mocks.listConnectionsPage.mockImplementation(async (_options) => {
      firstPageCallCount += 1;
      if (firstPageCallCount > 1) return refreshedPageOne.promise;
      return {
        items: [
          {
            connectionId: "c-current",
            userId: "u-current",
            displayName: "Current Person",
            photoUrl: null,
          },
        ],
        page: 1,
        hasMore: false,
        totalCount: 1,
        audience: "all",
      };
    });

    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByText("Current Person")).toBeTruthy();
    expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(1);

    // The disclosure and refresh controls are siblings. This prevents an
    // interactive refresh button from being folded into the disclosure's
    // accessible name.
    const connectionsDisclosure = screen.getByRole("tab", {
      name: /My connections/,
    });
    expect(
      connectionsDisclosure.contains(
        screen.getByRole("button", { name: "Refresh contacts" }),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Refresh contacts" }));

    await waitFor(() =>
      expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(2),
    );
    const refreshingButton = screen.getByRole("button", {
      name: "Refresh contacts",
    }) as HTMLButtonElement;
    expect(refreshingButton.disabled).toBe(true);
    expect(refreshingButton).toHaveAttribute("aria-busy", "true");

    fireEvent.click(refreshingButton);
    expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshedPageOne.resolve({
        items: [
          {
            connectionId: "c-refreshed",
            userId: "u-refreshed",
            displayName: "Refreshed Person",
            photoUrl: null,
          },
        ],
        page: 1,
        hasMore: false,
        totalCount: 1,
        audience: "all",
      });
      await refreshedPageOne.promise;
    });

    expect(await screen.findByText("Refreshed Person")).toBeTruthy();
    expect(screen.queryByText("Current Person")).toBeNull();
    const refreshButton = screen.getByRole("button", {
      name: "Refresh contacts",
    }) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton).toHaveAttribute("aria-busy", "false");
    expect(mocks.listConnectionsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, limit: 50, audience: "all" }),
    );
  });

  it("restarts paging after removing a connection loaded beyond page 1", async () => {
    let removed = false;
    mocks.removeConnection.mockImplementation(async () => {
      removed = true;
    });
    mocks.listConnectionsPage.mockImplementation(async (options) => {
      const page = options.page ?? 1;
      const items = !removed
        ? page === 1
          ? [
              {
                connectionId: "c-first",
                userId: "u-first",
                displayName: "First Person",
                photoUrl: null,
              },
            ]
          : [
              {
                connectionId: "c-remove",
                userId: "u-remove",
                displayName: "Remove Me",
                photoUrl: null,
              },
            ]
        : page === 1
          ? [
              {
                connectionId: "c-first",
                userId: "u-first",
                displayName: "First Person",
                photoUrl: null,
              },
              {
                connectionId: "c-shifted",
                userId: "u-shifted",
                displayName: "Shifted Boundary",
                photoUrl: null,
              },
            ]
          : [
              {
                connectionId: "c-tail",
                userId: "u-tail",
                displayName: "Tail Person",
                photoUrl: null,
              },
            ];
      return {
        items,
        page,
        hasMore: page === 1,
        totalCount: removed ? 3 : 2,
        audience: options.audience ?? "all",
      };
    });

    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByText("First Person")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Options for Remove Me" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove", exact: true }));

    expect(await screen.findByText("Shifted Boundary")).toBeTruthy();
    expect(mocks.onConnectionGraphMutated).toHaveBeenCalledWith("me");
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    expect(await screen.findByText("Tail Person")).toBeTruthy();

    const loadedPages = mocks.listConnectionsPage.mock.calls.map(
      ([options]) => options.page,
    );
    expect(loadedPages).toEqual([1, 2, 1, 2]);
  });

  it("asks for a bounded sample before anyone has searched", async () => {
    render(<ConnectPageClient />);

    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));
    // The reported problem was the whole register arriving unprompted. The
    // unsearched surface must ask for a capped set, and no query.
    expect(mocks.searchDirectory.mock.calls[0][0]).toMatchObject({
      page: 1,
      limit: 20,
    });
    expect(mocks.searchDirectory.mock.calls[0][0].query).toBe("");

    expect(screen.getByLabelText("Search people")).toBeVisible();
    expect(screen.getByText("Person 0")).toBeTruthy();
  });

  it.each(["People", "RIAs"] as const)(
    "appends %s users when the scroll sentinel enters view",
    async (directory) => {
      const enter = mockDirectoryObserver();
      render(<ConnectPageClient />);
      await screen.findByText("Person 0");
      if (directory === "RIAs") {
        chooseDirectory("RIAs");
        await screen.findByText("Person 0");
      }
      const before = mocks.searchDirectory.mock.calls.length;
      // Both directories render "Person 0". That text can still belong to
      // the previous list while the new sentinel's observer is attaching.
      await waitFor(() => {
        act(() => {
          expect(enter()).toBe(true);
          enter();
        });
      });
      await screen.findByText("Person 20");
      expect(screen.getByText("Person 0")).toBeTruthy();
      expect(mocks.searchDirectory).toHaveBeenCalledTimes(before + 1);
      expect(mocks.searchDirectory.mock.calls.at(-1)?.[0]).toMatchObject({
        page: 2,
        audience: directory === "RIAs" ? "ria" : "all",
      });
      expect(
        screen.queryByRole("button", { name: /previous page/i }),
      ).toBeNull();
    },
  );



  it("keeps a manual load fallback inside the list", async () => {
    render(<ConnectPageClient />);
    const row = await screen.findByTestId("connect-load-more-row");
    expect(
      within(row).getByRole("button", { name: "Load more people" }),
    ).toBeTruthy();
    expect(row.closest('[data-slot="settings-group-shell"]')).toBeTruthy();
    expect(screen.queryByTestId("connect-pager-row")).toBeNull();
  });

  it("asks the server for the next batch the reader loads", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Load more people" }));

    await waitFor(() => {
      const latest =
        mocks.searchDirectory.mock.calls[
          mocks.searchDirectory.mock.calls.length - 1
        ][0];
      expect(latest).toMatchObject({ page: 2, limit: 20 });
    });
    expect(await screen.findByText("Person 20")).toBeTruthy();
    // The next batch extends the same list, preserving earlier users.
    expect(screen.getByText("Person 0")).toBeTruthy();
    expect(screen.queryByText("Page 2")).toBeNull();
  });

  it("keeps loaded users on failure and retries the failed page without skipping it", async () => {
    const enter = mockDirectoryObserver();
    mocks.searchDirectory
      .mockResolvedValueOnce({ items: EVERYONE.slice(0, 20), hasMore: true })
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ items: EVERYONE.slice(19, 40), hasMore: false });
    render(<ConnectPageClient />);
    await screen.findByText("Person 0", {}, { timeout: 5_000 });
    await waitFor(() => {
      act(() => expect(enter()).toBe(true));
    }, { timeout: 5_000 });
    const retry = await screen.findByRole("button", {
      name: "Retry loading people",
    });
    expect(screen.getByText("Person 0")).toBeTruthy();
    act(() => {
      expect(enter()).toBe(false);
    });
    expect(mocks.searchDirectory).toHaveBeenCalledTimes(2);
    fireEvent.click(retry);
    await screen.findByText("Person 20", {}, { timeout: 5_000 });
    expect(
      mocks.searchDirectory.mock.calls.map(([options]) => options.page),
    ).toEqual([1, 2, 2]);
    expect(screen.getAllByText("Person 19")).toHaveLength(1);
    expect(screen.getByText("Person 0")).toBeTruthy();
    expect(screen.queryByTestId("connect-load-more-row")).toBeNull();
    expect(screen.getByText("All people loaded")).toBeTruthy();
  }, 10_000);

  it("keeps the visible directory stable while the next page loads", async () => {
    const pageTwo = deferred<{
      items: ReturnType<typeof person>[];
      hasMore: boolean;
      page: number;
      totalCount: number;
    }>();
    mocks.searchDirectory.mockImplementation(async (options) => {
      const page = Math.max(1, Number(options.page) || 1);
      const limit = Math.max(1, Number(options.limit) || 20);
      if (page === 2) return pageTwo.promise;
      const start = (page - 1) * limit;
      return {
        items: EVERYONE.slice(start, start + limit),
        hasMore: start + limit < EVERYONE.length,
        page,
        totalCount: EVERYONE.length,
      };
    });

    render(<ConnectPageClient />);
    expect(
      await screen.findByText("Person 0", {}, { timeout: 5_000 }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more people" }));

    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy(), { timeout: 5_000 });
    // The page being left stays put until its replacement arrives, so the list
    // never blanks mid-step.
    expect(screen.getByText("Person 0")).toBeTruthy();
    expect(screen.queryByText("Finding people…")).toBeNull();

    await act(async () => {
      pageTwo.resolve({
        items: EVERYONE.slice(20, 40),
        hasMore: true,
        page: 2,
        totalCount: EVERYONE.length,
      });
    });

    expect(await screen.findByText("Person 20", {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByText("Person 0")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  }, 15_000);

  it("opens the full directory once a name is typed", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Person 9" },
    });
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();

    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    const searched = mocks.searchDirectory.mock.calls[1][0];
    expect(searched.query).toBe("Person 9");
    // A search is paged like everything else now. Returning the whole matching
    // set unpaged is the same unbounded list, just filtered.
    expect(searched.limit).toBe(20);
    expect(searched.page).toBe(1);

    // The empty-query description disappearing is the unambiguous signal that
    // this is no longer the bounded discovery surface.
    await waitFor(() =>
      expect(screen.queryByText("Find by name, email or phone.")).toBeNull(),
    );
    expect(screen.queryByLabelText("People per page")).toBeNull();
  });

  it("keeps directory and mutual-list memory through profile visits, including paged peers and failed refresh", async () => {
    mocks.searchParams = new URLSearchParams("tab=all&view=connections&q=Original");
    const target = { userId: "kushal", publicPersonRef: "person-kushal", displayName: "Kushal", photoUrl: null, email: null,
      relationship: "connected", mutualConnectionCount: 3, mutualConnectionPreview: null };
    mocks.searchDirectory.mockResolvedValue({ items: [target], page: 1, hasMore: false });
    mocks.listMutualConnections.mockImplementation(async ({ page }: { page: number }) => ({
      person: { publicPersonRef: "person-kushal", displayName: "Kushal" }, page, hasMore: page === 1, totalCount: 3,
      items: page === 1 ? [{ publicPersonRef: "person-alex", displayName: "Alex", photoUrl: null }, { publicPersonRef: "person-manish", displayName: "Manish", photoUrl: null }]
        : [{ publicPersonRef: "person-second", displayName: "Second mutual", photoUrl: null }],
    }));
    const root = document.createElement("div");
    root.dataset.appScrollRoot = "true";
    document.body.appendChild(root);
    const view = render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Find people" }), { button: 0, ctrlKey: false });
    await screen.findByText("Kushal");
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "Kushal" } });
    chooseDirectory("RIAs");
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ query: "Kushal", audience: "ria" })));
    root.scrollTop = 480;
    fireEvent.click(screen.getByRole("button", { name: "View all 3 mutual connections with Kushal" }));
    const listHref = mocks.routerPush.mock.calls.at(-1)?.[0] as string;
    expect(listHref).toContain("mutuals=person-kushal");
    expect(listHref).toContain("q=Kushal");
    expect(listHref).not.toContain("view=connections");
    mocks.searchParams = new URLSearchParams(listHref.split("?")[1]);
    view.rerender(<ConnectPageClient />);
    await screen.findByRole("button", { name: "Open Manish's profile" });
    fireEvent.click(screen.getByRole("button", { name: "Load more mutual connections" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Second mutual's profile" }));
    const profileHref = mocks.routerPush.mock.calls.at(-1)?.[0] as string;
    expect(new URL(profileHref, "https://app.test").searchParams.get("from")).toBe(listHref);
    view.unmount();
    // Returning from a profile rehydrates both pages while fresh reads run.
    mocks.listMutualConnections.mockRejectedValue(new Error("offline"));
    const returned = render(<ConnectPageClient />);
    expect(screen.getByRole("button", { name: "Open Manish's profile" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Second mutual's profile" })).toBeVisible();
    await screen.findByRole("alert");
    mocks.searchParams = new URLSearchParams("tab=all");
    returned.rerender(<ConnectPageClient />);
    expect((screen.getByLabelText("Search people") as HTMLInputElement).value).toBe("Kushal");
    expect(screen.getByRole("button", { name: /Current directory: RIAs/ })).toBeVisible();
    await waitFor(() => expect(root.scrollTop).toBe(480));
    returned.unmount();
    root.remove();
  });

  it("opens a single mutual directly with the directory return destination", async () => {
    mocks.searchDirectory.mockResolvedValue({ items: [{ userId: "andrew", publicPersonRef: "person-andrew", displayName: "Andrew", photoUrl: null,
      relationship: "pending_outgoing", mutualConnectionCount: 1,
      mutualConnectionPreview: { publicPersonRef: "person-manish", displayName: "Manish", photoUrl: null } }], page: 1, hasMore: false });
    render(<ConnectPageClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Open mutual connection Manish's profile" }));
    expect(mocks.routerPush).toHaveBeenCalledWith("/people/person-manish?from=%2Fone%2Fconnect%3Ftab%3Dall", { scroll: false });
    expect(mocks.listMutualConnections).not.toHaveBeenCalled();
  });

  it("reconciles a disconnect to one mutual without redirecting, and rejects late results across accounts", async () => {
    mocks.searchParams = new URLSearchParams("tab=all&mutuals=person-target");
    const response = (name: string) => ({ person: { publicPersonRef: "person-target", displayName: "Target" },
      items: [{ publicPersonRef: "person-peer", displayName: name, photoUrl: null }], page: 1, hasMore: false, totalCount: 1 });
    mocks.listMutualConnections.mockResolvedValue(response("Remaining peer"));
    const view = render(<ConnectPageClient />);
    await screen.findByRole("button", { name: "Open Remaining peer's profile" });
    expect(screen.getByTestId("mutual-connections-list")).toBeVisible();
    expect(mocks.routerPush).not.toHaveBeenCalled();
    let finishOld!: (value: ReturnType<typeof response>) => void;
    mocks.listMutualConnections.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("hushh:connection-graph-changed", { detail: { userId: "me", changedAt: 100 } }));
    });
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    publishValidatedAuthSessionOwner("other-owner");
    mocks.user = { uid: "other-owner", getIdToken: async () => "other-token" };
    mocks.listMutualConnections.mockResolvedValue(response("Other account peer"));
    view.rerender(<ConnectPageClient />);
    await screen.findByRole("button", { name: "Open Other account peer's profile" });
    await act(async () => finishOld(response("Stale private peer")));
    expect(screen.queryByText("Stale private peer")).toBeNull();
    expect(screen.queryByText("Remaining peer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Other account peer's profile" }));
    const { ConnectionsServiceRequestError } = await import("@/lib/services/connections-service");
    mocks.listMutualConnections.mockRejectedValue(new ConnectionsServiceRequestError(404, "Unavailable"));
    await act(async () => { window.dispatchEvent(new CustomEvent("hushh:connection-graph-changed", { detail: { userId: "other-owner", changedAt: 200 } })); });
    await screen.findByRole("alert");
    expect(screen.queryByText("Other account peer")).toBeNull();
    view.unmount();
    render(<ConnectPageClient />);
    expect(screen.queryByText("Other account peer")).toBeNull();
  });

  it("restores a typed search query after the page remounts", async () => {
    // Regression: navigating to a person's detail screen and using the
    // shared back control remounts this page. The search box is local
    // React state, not URL state, so it used to come back empty even
    // though the person had just been searching (issue #5921).
    const { unmount } = render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Person 9" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));

    unmount();

    render(<ConnectPageClient />);
    expect(
      (screen.getByLabelText("Search people") as HTMLInputElement).value,
    ).toBe("Person 9");
    await waitFor(() =>
      expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "Person 9" }),
      ),
    );
  });

  it("uses a handoff search query when another flow opens Connect", async () => {
    // Ask for location sends users here only after a miss, with the name they
    // just typed. That first render should search for the same name rather
    // than forcing the person to type it again.
    mocks.searchParams = new URLSearchParams("tab=all&q=Parth");

    render(<ConnectPageClient />);

    expect(
      (screen.getByLabelText("Search people") as HTMLInputElement).value,
    ).toBe("Parth");
    await waitFor(() =>
      expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "Parth" }),
      ),
    );
  });

  it("clears the stored search query once the box is emptied", async () => {
    const { unmount } = render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Person 9" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(3));

    unmount();

    render(<ConnectPageClient />);
    expect(
      (screen.getByLabelText("Search people") as HTMLInputElement).value,
    ).toBe("");
  });

  it("renders every person the directory returned, in the order it returned them", async () => {
    // Matching and ranking belong to the server, which applies them before
    // LIMIT/OFFSET. This screen renders the page it was given.
    //
    // It used to re-filter here instead, keeping only first-name matches. That
    // ran on rows the server had ALREADY cut to a page under a different rule,
    // so it could only ever subtract -- and dropping "Abdul Rashid" from a
    // page of 8 does not promote a ninth row to replace it. The server now
    // ranks first-name matches above surname matches across the whole result
    // set, which is the only place that ranking can be applied truthfully.
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u2", "Rashid Ahmed"), person("u1", "Abdul Rashid")],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "R" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));

    expect(await screen.findByText("Rashid Ahmed")).toBeTruthy();
    expect(screen.getByText("Abdul Rashid")).toBeTruthy();
  });

  it("shows every match for a single typed letter", async () => {
    // The reported bug, as a test. Typing "N" showed nothing at all: the
    // server returned a page of substring matches and the client hid all of
    // them, so real people named Nilesh and Nirmal were invisible behind an
    // empty list with a live "Next" button.
    mocks.searchDirectory.mockResolvedValue({
      items: [
        person("u-nilesh", "Nilesh"),
        person("u-nirmal", "Nirmal"),
        person("u-nolan", "Nolan"),
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "N" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));

    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({
      query: "N",
      page: 1,
      limit: 20,
    });
    for (const name of ["Nilesh", "Nirmal", "Nolan"]) {
      expect(await screen.findByText(name)).toBeTruthy();
    }
    expect(screen.queryByText('No one matches "N"')).toBeNull();
  });

  it("preserves the directory's A-Z order rather than re-sorting the page", async () => {
    // A client sort can only order the rows it can see, so re-sorting one page
    // of a paged list makes the index lie at every page boundary: a name on
    // page 2 could sort ahead of one on page 1. The order arrives correct.
    mocks.searchDirectory.mockResolvedValue({
      items: [
        person("u-a", "Nilesh"),
        person("u-b", "Nirmal"),
        person("u-c", "Abdul Nasser"),
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "N" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));

    await screen.findByText("Abdul Nasser");
    // "Abdul Nasser" is a surname match, ranked last by the server. A local
    // alphabetical sort would pull it to the top, so its position is the whole
    // assertion.
    const order = ["Nilesh", "Nirmal", "Abdul Nasser"].map((name) =>
      screen.getByText(name),
    );
    expect(
      order[0].compareDocumentPosition(order[1]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      order[1].compareDocumentPosition(order[2]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders one letter's whole page, in the server's sequence, with nothing dropped", async () => {
    // The two tests above each hold half of the bug and neither holds it
    // whole. "shows every match for a single typed letter" hands back three
    // names that ALL begin with N, so the client-side prefix filter that
    // caused the original bug passes it untouched. "preserves the directory's
    // A-Z order" names three rows but never counts them, so a filter that
    // drops a row nobody named goes unseen.
    //
    // This is the real server page for "n": a substring-only name the server
    // sends and the old client hid (Anand), the first-name tier A-Z, then the
    // surname tier below it. The contract is that the client renders the page
    // it was handed -- so the COUNT is asserted alongside the SEQUENCE. A
    // re-introduced filter fails the count; a re-introduced sort fails the
    // sequence. Neither can pass by naming the right rows.
    const PAGE_FOR_N = [
      person("u-anand", "Anand"),
      person("u-nilesh", "Nilesh"),
      person("u-nirmal", "Nirmal"),
      person("u-nolan", "Nolan"),
      person("u-abdul", "Abdul Nasser"),
    ];
    mocks.searchDirectory.mockResolvedValue({
      items: PAGE_FOR_N,
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "n" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({
      query: "n",
      page: 1,
    });

    // Every row the server sent is on screen. Counting the per-row action
    // rather than the names is what catches a row nobody thought to name.
    await screen.findByText("Abdul Nasser");
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(
      PAGE_FOR_N.length,
    );

    // ...and in the server's sequence, not a locally-sorted one. A client
    // alphabetical sort would hoist "Abdul Nasser" to the top and drop
    // "Anand" below the N-names; both are pinned here.
    const rendered = PAGE_FOR_N.map((p) => screen.getByText(p.displayName));
    for (let i = 0; i < rendered.length - 1; i += 1) {
      expect(
        rendered[i].compareDocumentPosition(rendered[i + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    expect(screen.queryByText('No one matches "n"')).toBeNull();
  });

  it("says so when a search matches nobody", async () => {
    // The empty state used to be gated on the raw server page while the rows
    // came from a filtered copy of it, so "8 rows, all hidden" rendered as
    // blank space under a heading -- no rows, no message, and a pager.
    mocks.searchDirectory.mockResolvedValue({
      items: [],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Zzz" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));

    expect(await screen.findByText('No one matches "Zzz"')).toBeTruthy();
  });

  it("asks for page one once when the query changes while paged", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Load more people" }));
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({ page: 2 });

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "N" },
    });
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(3));

    // One request, for page 1. Resetting the page in an effect landed a render
    // too late and fired page 2 of the new query first -- a wasted round trip
    // that was also free to resolve last and paint a page nobody asked for.
    expect(mocks.searchDirectory.mock.calls[2][0]).toMatchObject({
      query: "N",
      page: 1,
    });
    expect(mocks.searchDirectory).toHaveBeenCalledTimes(3);
  });

  it("runs a spoken name through the governed Connect search handler", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const search = resolveLocalOnboardingHandler("connect.search_people");
    expect(search).not.toBeNull();
    let result: Awaited<ReturnType<NonNullable<typeof search>>> | undefined;
    await act(async () => {
      result = await search!({ person: "Person 9" });
    });
    expect(result).toMatchObject({ status: "succeeded" });

    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({
      query: "Person 9",
      page: 1,
    });
  });

  it.each(["missing-id", "u-other"])(
    "does not downgrade selected user %s to the spoken name",
    async (userId) => {
      mocks.searchDirectory.mockResolvedValue({
        items: [
          person("u9", "Person 9"),
          person("u-other", "Different Person"),
        ],
        hasMore: false,
        page: 1,
      });
      render(<ConnectPageClient />);
      await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
      const handler = resolveLocalOnboardingHandler("connect.send_request")!;
      let result;
      await act(async () => {
        result = await handler({ person: "Person 9", userId });
      });
      expect(result).toMatchObject({ status: "blocked" });
      expect(mocks.sendRequest).not.toHaveBeenCalled();
    },
  );

  it("sends a confirmed request only to one exact spoken name", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9")],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({
      id: "request-9",
      status: "pending",
      requesterUserId: "me",
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    expect(sendRequest).not.toBeNull();
    let result:
      Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({ person: "Person 9" });
    });

    expect(result).toMatchObject({ status: "succeeded" });
    // Searches ONE word, then decides here. The server predicate is a single
    // substring test on display_name, so sending the whole spoken name makes
    // the entire name have to appear exactly as stored -- "Abdul Rashid"
    // finds nobody when the directory holds "Abdul R.". Sending the longest
    // word maximises what comes back; choosing between candidates happens in
    // the browser, where the full name is available.
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({
      query: "Person",
      page: 1,
      limit: 50,
      nameOnly: true,
    });
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        addresseeUserId: "u9",
        requestedScopeHandles: [],
        offeredScopeHandles: [],
      }),
    );
  });

  it("prepares an exact send without effects and rejects stale preparation", async () => {
    // Contact-only pages must not make a unique name look like a truncated list.
    mocks.searchDirectory.mockImplementation(async ({ nameOnly }) => ({
      items: [person("u9", "Person 9")],
      hasMore: !nameOnly,
      page: 1,
    }));
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    const slots = { person: "Person 9" };
    const prepared = await prepareLocalOnboardingAction(
      "connect.send_request",
      slots,
    );
    expect(prepared?.status).toBe("ready");
    if (prepared?.status !== "ready") throw new Error("Preparation failed");
    expect(prepared.binding).toMatchObject({
      person: "Person 9",
      userId: "u9",
    });
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    mocks.searchDirectory.mockResolvedValue({
      items: [person("other-owner-id", "Person 9")],
      hasMore: false,
      page: 1,
    });
    const result = await resolveLocalOnboardingHandler("connect.send_request")!(
      slots,
      { directiveId: "confirmed", preparedBinding: prepared.binding },
    );
    expect(result.status).toBe("blocked");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("executes a send with the same owner-prepared binding", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9")],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({
      id: "prepared-request",
      status: "pending",
      requesterUserId: "me",
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    const slots = { person: "Person 9", userId: "u9" };
    const prepared = await prepareLocalOnboardingAction(
      "connect.send_request",
      slots,
    );
    if (prepared?.status !== "ready") throw new Error("Preparation failed");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    expect(
      (
        await resolveLocalOnboardingHandler("connect.send_request")!(slots, {
          preparedBinding: prepared.binding,
        })
      ).status,
    ).toBe("blocked");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    let result;
    await act(async () => {
      result = await resolveLocalOnboardingHandler("connect.send_request")!(
        slots,
        { directiveId: "confirmed", preparedBinding: prepared.binding },
      );
    });
    expect(result).toMatchObject({ status: "succeeded" });
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "u9" }),
    );
  });

  it("refuses to guess between similar directory matches before sending", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9"), person("u10", "Person 9")],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    expect(sendRequest).not.toBeNull();
    const result = await sendRequest!({ person: "Person 9" });

    expect(result).toMatchObject({ status: "blocked" });
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("keeps contact identifiers out of directory rows and voice choices without merging duplicate people", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [
        {
          userId: "u9",
          displayName: "Ankit Kumar Singh",
          email: "ankit@example.test",
          maskedEmail: "a***t@hushh.ai",
          maskedPhone: "98******10",
          relationship: "none" as const,
        },
        {
          userId: "u10",
          displayName: "Ankit Kumar Singh",
          maskedPhone: "97******66",
          relationship: "pending_outgoing" as const,
        },
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const directory = screen.getByTestId("connect-directory-group");
    expect(within(directory).getAllByText("Ankit Kumar Singh")).toHaveLength(2);
    expect(within(directory).getByText("Request sent")).toBeVisible();
    for (const identifier of [
      "ankit@example.test",
      "a***t@hushh.ai",
      "98******10",
      "97******66",
    ]) {
      expect(directory).not.toHaveTextContent(identifier);
    }

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    const result = await sendRequest!({ person: "Ankit Kumar Singh" });

    expect(result).toMatchObject({ status: "blocked" });
    const parsed = parseVoiceCard(result.data);
    expect(parsed?.actionId).toBe("connect.send_request");
    expect(parsed?.resolveSlot).toBe("userId");
    expect(parsed?.candidates.map((c) => c.id)).toEqual(["u9", "u10"]);
    expect(parsed?.candidates.map((c) => c.detail)).toEqual([null, null]);
    // Each duplicate keeps its own button. One is connectable and the other
    // already has a request out, so a single shared label would offer an
    // action guaranteed to be refused.
    expect(parsed?.candidates[0]?.actionLabel).toBe("Connect");
    expect(parsed?.candidates[0]?.disabledReason).toBeNull();
    expect(parsed?.candidates[1]?.disabledReason).toBe("Waiting on them");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("sends to the person picked from the card, without re-running the matcher", async () => {
    // The ambiguity was settled by a human. Re-deriving it from the same words
    // would fail identically and bounce the card straight back.
    mocks.searchDirectory.mockResolvedValue({
      items: [
        {
          userId: "u9",
          displayName: "Ankit Kumar Singh",
          relationship: "none" as const,
        },
        {
          userId: "u10",
          displayName: "Ankit Kumar Singh",
          relationship: "none" as const,
        },
      ],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({
      id: "request-10",
      status: "pending",
      requesterUserId: "me",
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    let result:
      Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({
        person: "Ankit Kumar Singh",
        userId: "u10",
      });
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "u10" }),
    );
    // The walkthrough panel reads this to show who the request just went to
    // -- the same name+detail shape the disambiguation card above shows.
    expect(result?.data?.subject).toEqual({
      name: "Ankit Kumar Singh",
      detail: null,
    });
  });

  it("finds someone whose stored name is not how it was spoken", async () => {
    // The bug this whole resolver exists for. The server matches a single
    // substring against display_name, so "Abdul Rashid" reaches nobody when
    // the directory holds "Abdul R." -- and the person is sitting in the list
    // on screen the whole time.
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Abdul R.")],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({
      id: "request-9",
      status: "pending",
      requesterUserId: "me",
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    let result:
      Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({ person: "Abdul Rashid" });
    });

    expect(result).toMatchObject({ status: "succeeded" });
    // Searched the longest word, not the whole phrase.
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({
      query: "Rashid",
    });
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "u9" }),
    );
  });

  it("finds someone whose stored name is longer than what was spoken", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Abdul Kumar Rashid")],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({
      id: "request-9",
      status: "pending",
      requesterUserId: "me",
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    let result:
      Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({ person: "Abdul Rashid" });
    });

    expect(result).toMatchObject({ status: "succeeded" });
  });

  it("still refuses to choose between two people the words could mean", async () => {
    // Widening how names match must never widen who gets a request. Two
    // plausible people is a question, not a coin toss.
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Abdul Rashid"), person("u10", "Abdul Rashida")],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    let result:
      Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({ person: "Abdul" });
    });

    expect(result).toMatchObject({ status: "blocked" });
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("refuses a first-page match when the directory has more results", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9")],
      hasMore: true,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    expect(sendRequest).not.toBeNull();
    const result = await sendRequest!({ person: "Person 9" });

    expect(result).toMatchObject({ status: "blocked" });
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it("says who was searched for when a search matches nobody", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    mocks.searchDirectory.mockResolvedValue({
      items: [],
      hasMore: false,
      page: 1,
    });
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Nobody" },
    });

    expect(await screen.findByText('No one matches "Nobody"')).toBeTruthy();
  });

  it("shows name-only compact directory rows with actions apart from the profile", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [
        {
          ...person("u1", "Avery Stone"),
          publicPersonRef: "person-ref-avery",
          email: null,
          maskedEmail: "a***e@example.com",
          maskedPhone: "98******10",
        },
        {
          ...person("u2", "97******66"),
          email: null,
          maskedEmail: null,
          maskedPhone: "97******66",
        },
        {
          ...person("u3", "member@example.test"),
          email: "member@example.test",
          maskedEmail: "m***r@example.test",
        },
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);

    const rows = await screen.findAllByTestId("directory-person-row");
    expect(rows).toHaveLength(3);
    expect(screen.queryByTestId("directory-person-card")).toBeNull();
    expect(rows[0]).toHaveTextContent("Avery Stone");
    // Ready people can use a contact value as displayName when no name exists.
    expect(rows[1]).toHaveTextContent("Hussh member");
    expect(rows[2]).toHaveTextContent("Hussh member");
    for (const row of rows) {
      expect(row.querySelector('[data-slot="settings-row-description"]')).toBeNull();
      expect(row.textContent).not.toContain("@");
      expect(row.textContent).not.toMatch(/\d{2}\*{4,}\d{2}/);
    }
    // The call to action is a sibling of the control that opens the profile.
    const connect = within(rows[0]).getByRole("button", { name: "Connect" });
    const open = within(rows[0]).getByRole("button", { name: "Open Avery Stone's profile" });
    expect(open).not.toContainElement(connect);
    fireEvent.click(connect);
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("does not expose bulk selection controls on the directory", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u1", "Selectable Sam")],
      hasMore: false,
      page: 1,
    });

    render(<ConnectPageClient />);
    expect(await screen.findByText("Selectable Sam")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Select people" })).toBeNull();
    expect(screen.queryByLabelText("Select Selectable Sam")).toBeNull();
    expect(screen.queryByText(/^Review /)).toBeNull();
  });

  it("sends a one-person request directly without opening the review dialog", async () => {
    mocks.sendRequest.mockResolvedValue({ id: "request" });

    render(<ConnectPageClient />);
    expect(await screen.findByText("Person 0")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]!);

    await waitFor(() => expect(mocks.sendRequest).toHaveBeenCalledTimes(1));
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        addresseeUserId: "u0",
        requestedScopeHandles: [],
        offeredScopeHandles: [],
      }),
    );
    expect(
      screen.queryByRole("heading", { name: "Send connection request" }),
    ).toBeNull();
    expect(mocks.getScopeCatalog).not.toHaveBeenCalled();
  });

  it("searches all profiles in People and narrows RIAs at the server", async () => {
    // A filter applied after the page is cut can only subtract from a page that
    // was already chosen wrongly: uneven pages, and every advisor past the
    // first one unreachable. People asks for the full directory; RIAs narrows
    // it on the server.
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ audience: "all" }),
    );

    chooseDirectory("RIAs");

    await waitFor(() =>
      expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ audience: "ria", page: 1 }),
      ),
    );
  });

  it("shows a verified RIA and a regular profile in the same People search", async () => {
    const matches = [
      { ...person("divya-ria", "Divya Advisor"), isRia: true },
      { ...person("divya-person", "Divya Person"), isRia: false },
    ];
    mocks.searchDirectory.mockImplementation(async ({ query, audience }) => {
      const queried = query === "Divya" ? matches : [];
      const items =
        audience === "ria"
          ? queried.filter((entry) => entry.isRia)
          : audience === "people"
            ? queried.filter((entry) => !entry.isRia)
            : queried;
      return { items, page: 1, hasMore: false, totalCount: items.length };
    });

    render(<ConnectPageClient />);
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Divya" },
    });

    expect(await screen.findByText("Divya Advisor")).toBeTruthy();
    expect(screen.getByText("Divya Person")).toBeTruthy();
    expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "Divya", audience: "all", page: 1 }),
    );

    chooseDirectory("RIAs");
    await waitFor(() =>
      expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "Divya", audience: "ria", page: 1 }),
      ),
    );
    expect(await screen.findByText("Divya Advisor")).toBeTruthy();
    expect(screen.queryByText("Divya Person")).toBeNull();
  });

  it("lists only verified advisers under My connections on the RIAs tab", async () => {
    // Reported from UAT: "RIAs mein People tab mein jo connection(4) ke under
    // hain, same aa rahe… unhone RIA onboarding complete nahi kiya."
    //
    // The directory half below was already audience-split server-side. The
    // connections list above it was not split at all — it rendered the same
    // rows in both tabs — so the RIAs tab listed people who had never finished
    // RIA onboarding under the one heading that claims they had.
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-adviser",
        userId: "u-adviser",
        displayName: "Verified Adviser",
        photoUrl: null,
        createdAt: null,
        isRia: true,
      },
      {
        connectionId: "c-plain",
        userId: "u-plain",
        displayName: "Ordinary Person",
        photoUrl: null,
        createdAt: null,
        isRia: false,
      },
    ]);

    render(<ConnectPageClient />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: /My connections 2/ }), { button: 0, ctrlKey: false });
    expect(screen.getByText("Verified Adviser")).toBeTruthy();
    expect(screen.getByText("Ordinary Person")).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Find people", exact: true }), { button: 0, ctrlKey: false });
    chooseDirectory("RIAs");
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /My RIAs/ }), { button: 0, ctrlKey: false });

    // The heading counts the list it is actually showing. Counting one list
    // and rendering another is the exact shape of the original Connect search
    // bug, so the count is asserted here alongside the rows.
    expect(await screen.findByRole("tab", { name: /My RIAs 1/ })).toBeTruthy();
    expect(screen.getByText("Verified Adviser")).toBeTruthy();
    expect(screen.queryByText("Ordinary Person")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search my connections by name, email or phone" }), { target: { value: "Verified" } });
    await waitFor(() => expect(mocks.listConnectionsPage).toHaveBeenLastCalledWith(expect.objectContaining({ query: "Verified", audience: "ria" })));
    expect(screen.getByText("Verified Adviser")).toBeTruthy();
    expect(screen.queryByText("Ordinary Person")).toBeNull();
  });

  it("does not relabel stale People rows when the RIAs page fails to load", async () => {
    mocks.listConnectionsPage.mockImplementation(async (options) => {
      if (options.audience === "ria") {
        throw new Error("temporary RIAs read failure");
      }
      return {
        items: [
          {
            connectionId: "c-person",
            userId: "u-person",
            displayName: "People Only Row",
            photoUrl: null,
          },
        ],
        page: 1,
        hasMore: false,
        totalCount: 1,
        audience: "all",
      };
    });

    render(<ConnectPageClient />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /My connections 1/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByText("People Only Row")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Find people", exact: true }), { button: 0, ctrlKey: false });
    chooseDirectory("RIAs");
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /My RIAs/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByRole("tab", { name: /My RIAs 0/ })).toBeTruthy();
    expect(screen.queryByText("People Only Row")).toBeNull();
  });

  it("treats a connection with no RIA annotation as not an adviser", async () => {
    // A cached page written before the field existed, or any payload the
    // server has not annotated, must fail CLOSED — hidden from the RIAs tab
    // rather than promoted into it.
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-legacy",
        userId: "u-legacy",
        displayName: "Unannotated Person",
        photoUrl: null,
        createdAt: null,
      },
    ]);

    render(<ConnectPageClient />);
    expect(await screen.findByRole("tab", { name: /My connections 1/ })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Find people", exact: true }), { button: 0, ctrlKey: false });
    chooseDirectory("RIAs");
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /My RIAs/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByRole("tab", { name: /My RIAs 0/ })).toBeTruthy();
    expect(screen.queryByText("Unannotated Person")).toBeNull();
    expect(screen.getByText("No RIAs yet")).toBeTruthy();
  });

  it("renders profile photos in My connections when the connection has one", async () => {
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-photo",
        userId: "u-photo",
        displayName: "Photo Friend",
        photoUrl: "https://cdn.example.test/photo-friend.jpg",
        createdAt: null,
        isRia: false,
      },
    ]);

    const { container } = render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });

    expect(await screen.findByText("Photo Friend")).toBeTruthy();
    const myConnections = container.querySelector(
      '[data-testid="connect-my-connections-group"]',
    );
    expect(
      myConnections?.querySelector(
        '[data-photo-url="https://cdn.example.test/photo-friend.jpg"]',
      ),
    ).toBeTruthy();
  });




});

describe("Connect — removing a connection", () => {
  const RASHID = {
    connectionId: "c-1",
    userId: "u-rashid",
    displayName: "Rashid",
    maskedEmail: "r***d@gmail.com",
  };

  it("rejects a selected connection whose label changed", async () => {
    mocks.listConnections.mockResolvedValue([RASHID]);
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    const handler = resolveLocalOnboardingHandler("connect.remove_connection")!;
    const result = await handler(
      { person: "Someone Else", connectionId: "c-1" },
      { directiveId: "confirmed" },
    );
    expect(result.status).toBe("blocked");
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("prepares removal and revalidates the same binding before executing", async () => {
    mocks.listConnections.mockResolvedValue([RASHID]);
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    const slots = { person: "Rashid", connectionId: "c-1" };
    const prepared = await prepareLocalOnboardingAction(
      "connect.remove_connection",
      slots,
    );
    expect(prepared?.status).toBe("ready");
    if (prepared?.status !== "ready") throw new Error("Preparation failed");
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    await act(async () => {
      await resolveLocalOnboardingHandler("connect.remove_connection")!(slots, {
        directiveId: "confirmed",
        preparedBinding: prepared.binding,
      });
    });
    expect(mocks.removeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c-1" }),
    );
  });

  it("asks before removing, and does not remove on the asking turn", async () => {
    // The one action here that cannot be walked back. A name misheard once is
    // a connection gone with no undo, so the spoken turn may only raise the
    // question -- it must not also answer it.
    mocks.listConnections.mockResolvedValue([RASHID]);
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const remove = resolveLocalOnboardingHandler("connect.remove_connection");
    const result = await remove!({ person: "Rashid" });

    expect(result).toMatchObject({ status: "blocked" });
    expect(mocks.removeConnection).not.toHaveBeenCalled();

    const confirm = parseVoiceConfirm(result.data);
    expect(confirm?.actionId).toBe("connect.remove_connection");
    expect(confirm?.confirmLabel).toBe("Remove");
    expect(confirm?.prompt).toBe("Remove your connection with Rashid?");
    expect(confirm?.subject).toMatchObject({
      name: "Rashid",
      detail: null,
    });
    // Warning text comes from the action's own contract `meaning`, so it
    // cannot drift away from what the action actually does.
    expect(confirm?.consequence).toContain("share");
  });

  it("refuses a model-supplied confirmation slot", async () => {
    mocks.listConnections.mockResolvedValue([RASHID]);
    mocks.removeConnection.mockResolvedValue({});
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const remove = resolveLocalOnboardingHandler("connect.remove_connection");
    let result: Awaited<ReturnType<NonNullable<typeof remove>>> | undefined;
    await act(async () => {
      result = await remove!({
        person: "Rashid",
        connectionId: "c-1",
        confirmed: true,
      });
    });

    expect(result).toMatchObject({ status: "blocked" });
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("removes only after a trusted in-app confirmation", async () => {
    mocks.listConnections.mockResolvedValue([RASHID]);
    mocks.removeConnection.mockResolvedValue({});
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const remove = resolveLocalOnboardingHandler("connect.remove_connection");
    let result: Awaited<ReturnType<NonNullable<typeof remove>>> | undefined;
    await act(async () => {
      result = await remove!(
        {
          person: "Rashid",
          connectionId: "c-1",
        },
        {
          humanConfirmationToken: "test-confirmation-token",
        },
      );
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(mocks.removeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c-1" }),
    );
    const finalConnectionRead =
      mocks.listConnectionsPage.mock.calls.at(-1)?.[0];
    expect(finalConnectionRead).toMatchObject({
      page: 1,
      query: "",
      audience: "all",
    });
    expect(mocks.onConnectionGraphMutated).toHaveBeenCalledWith("me");
  });

  it("offers a picker before it offers a confirmation when the name is ambiguous", async () => {
    // Removing the WRONG person because two share a name is the worst version
    // of the duplicate bug, not a milder one. Which-one comes first, then the
    // are-you-sure for whoever was picked.
    mocks.listConnections.mockResolvedValue([
      RASHID,
      {
        ...RASHID,
        connectionId: "c-2",
        userId: "u-2",
        maskedEmail: "r***2@gmail.com",
      },
    ]);
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const remove = resolveLocalOnboardingHandler("connect.remove_connection");
    const result = await remove!({ person: "Rashid" });

    expect(result).toMatchObject({ status: "blocked" });
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    const card = parseVoiceCard(result.data);
    expect(card?.kind).toBe("choice");
    expect(parseVoiceConfirm(result.data)).toBeNull();
  });
});

describe("Connect — the phone-width geometry QA reported", () => {
  // What a class assertion can and cannot do is the whole point of this block.
  // JSDOM applies no CSS, so none of these prove a pixel. They prove the
  // component still hands the browser the geometry that
  // `e2e/connect-circle-cta.layout.spec.ts` measured and found correct. Neither
  // half is sufficient on its own; that spec is the other half.

  it("opens the tapped connection by person identity when names are identical", async () => {
    mocks.listConnections.mockResolvedValue([
      { connectionId: "ankit-first", userId: "ankit-first-user", publicPersonRef: "ankit-first-person", displayName: "Ankit Kumar Singh" },
      { connectionId: "ankit-second", userId: "ankit-second-user", publicPersonRef: "ankit-second-person", displayName: "Ankit Kumar Singh" },
    ]);
    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    const actions = await screen.findAllByRole("button", { name: "Message Ankit Kumar Singh" });

    fireEvent.click(actions[1]);
    expect(mocks.messageSelection).toHaveBeenLastCalledWith({ personRef: "ankit-second-person" });
    fireEvent.click(actions[0]);
    expect(mocks.messageSelection).toHaveBeenLastCalledWith({ personRef: "ankit-first-person" });
    expect(mocks.routerPush).toHaveBeenCalledWith("/one/messages?token=opaque-test-token");
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("keeps Message and confirmed removal on the exact saved person", async () => {
    mocks.listConnections.mockResolvedValue([{ connectionId: "c-1", userId: "u-rashid", publicPersonRef: "person-ref-rashid", displayName: "Abdul Rashid" }]);
    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", { name: "Message Abdul Rashid" }));
    expect(mocks.messageSelection).toHaveBeenCalledWith({ personRef: "person-ref-rashid" });
    fireEvent.click(screen.getByRole("button", { name: "Options for Abdul Rashid" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Remove connection");
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("keeps My connections in the page scroll, not in a scroller of its own", async () => {
    // A capped list with `overscroll-contain` kept a drag that started on a row
    // inside the list, and refused to hand it to the page at either end, so
    // People and everything below it could not be reached from there. The list
    // now flows in the app scroll root; "Load more connections" still pages it.
    mocks.listConnections.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        connectionId: `c-${index}`,
        userId: `u-${index}`,
        displayName: `Trusted Person ${index + 1}`,
        maskedEmail: `t***${index}@example.com`,
      })),
    );

    const { container } = render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("My connections")).toBeTruthy();

    const list = container.querySelector(
      '#connect-my-connections-panel',
    );
    expect(list).toBeTruthy();
    expect(list!.className).not.toMatch(/(?:^|\s)(?:sm:)?max-h-/);
    expect(list!.className).not.toMatch(/(?:^|\s)(?:sm:)?overflow-y-(?:auto|scroll)(?:\s|$)/);
    // The trap itself: a contained overscroll cannot chain to the page.
    expect(list!.className).not.toContain("overscroll-contain");
  });

  it("asks for the search field in two words", async () => {
    render(<ConnectPageClient />);
    expect(screen.getByLabelText("Search people")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search people by name")).toBeNull();
  });

  it("reserves the clear-button gutter only once there is something to clear", async () => {
    // 44px of right padding held back from a field whose only content is its
    // placeholder is 44px the placeholder does not get.
    render(<ConnectPageClient />);
    const field = (screen.getByLabelText("Search people")) as HTMLInputElement;

    expect(field.className).toContain("pr-3.5");
    expect(field.className).not.toContain("pr-11");

    fireEvent.change(field, { target: { value: "ada" } });
    expect(field.className).toContain("pr-11");
  });

  it("redacts contact-only cancellation summaries without cancelling ambiguous requests", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    const cancelRequest = resolveLocalOnboardingHandler("connect.cancel_request");
    expect(cancelRequest).not.toBeNull();
    const request = { id: "request-private", counterpartDisplayName: "member@example.test" };
    mocks.listRequests.mockResolvedValue([request, { ...request, id: "request-other" }]);

    const ambiguous = await cancelRequest!({ person: "member@example.test" });
    expect(ambiguous.status).toBe("blocked");
    expect(ambiguous.summary).not.toContain("@");
    expect(mocks.cancel).not.toHaveBeenCalled();

    mocks.listRequests.mockResolvedValue([request]);
    let completed: Awaited<ReturnType<NonNullable<typeof cancelRequest>>> | undefined;
    await act(async () => {
      completed = await cancelRequest!({ person: "member@example.test" });
    });
    expect(completed?.status).toBe("succeeded");
    expect(completed?.summary).toBe("Cancelled your connection request to someone.");
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-private" }));
  });

  it("spends one word on cancelling a request, and says whose in the label", async () => {
    // "Cancel request" under a 100px floor sized for "Cancelling…" made the
    // least common row state the widest control on the screen. The visible word
    // is short; the accessible name still carries the whole meaning, and names
    // the person -- which the old fixed label never did.
    mocks.searchDirectory.mockResolvedValue({
      items: [
        {
          ...person("u1", "Smirthika Dharmalingam"),
          relationship: "pending_outgoing" as const,
        },
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);

    const cancel = await screen.findByRole("button", {
      name: "Cancel your request to Smirthika Dharmalingam",
    });
    expect(cancel.textContent).toBe("Cancel");
    // Keep the visible label in the action pill; rendered geometry is covered
    // by the browser layout pack.
    expect(cancel.className).toContain("!h-11");
    expect(
      cancel.querySelector('[data-slot="connect-row-action-pill"]'),
    ).toHaveTextContent("Cancel");
    expect(cancel.getAttribute("data-profile-role")).toBe("action");
    expect(screen.queryByText("Cancel request")).toBeNull();

    // WCAG 2.5.3: the accessible name has to contain the visible label, or
    // "tap Cancel" is an instruction voice control cannot follow.
    expect(
      cancel.getAttribute("aria-label")!.includes(cancel.textContent!),
    ).toBe(true);
  });

  it("does not show the retired selection toggle", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Select people" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Cancel selecting people" }),
    ).toBeNull();
  });
});

describe("Connect — inviting someone who is not on One yet", () => {
  // jsdom serves the page from http://localhost, which is exactly the origin a
  // recipient cannot open, so the build origin stands in for it here the same
  // way it does inside the iOS and Android shells.
  const REAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://one.hushh.ai";
    mocks.shareLink.mockResolvedValue("native-share");
  });

  afterEach(() => {
    if (REAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = REAL_APP_URL;
  });

  async function searchForNobody(query = "Bob Kanjilal") {
    mocks.searchDirectory.mockResolvedValue({
      items: [],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: query },
    });
    return screen.findByText(`No one matches "${query}"`);
  }

  it("offers an invite when People hands off a search with no matches", async () => {
    mocks.searchParams = new URLSearchParams("tab=all&q=Bob%20Kanjilal");
    mocks.searchDirectory.mockResolvedValue({ items: [], hasMore: false, page: 1 });
    render(<ConnectPageClient />);
    expect(await screen.findByText('No one matches "Bob Kanjilal"')).toBeTruthy();
    expect(await screen.findByText("Invite them to One")).toBeTruthy();
    expect(
      screen.getByText("Share an invite link with them."),
    ).toBeTruthy();
  });

  it("leaves the no-results row inert, so only the invite is tappable", async () => {
    // "No one matches Bob" states a fact. Making it a control would mean
    // tapping a sentence to do something it does not describe.
    const row = await searchForNobody();
    const factRow = row.closest("[data-testid='settings-row']");
    expect(factRow).toBeTruthy();
    expect(factRow?.querySelector("button")).toBeNull();
  });

  it("shares only the guest introduction marker, without relationship authority", async () => {
    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalledTimes(1));
    const sent = mocks.shareLink.mock.calls[0][0];
    // Presentation only: no token, no code, no pending connection. Nobody is added to
    // anything by receiving this, and consent is still asked for later through
    // the normal request flow.
    expect(sent.url).toBe("https://one.hushh.ai/?invite=one");
    expect([...new URL(sent.url).searchParams.entries()]).toEqual([["invite", "one"]]);
    // The link lives in `url` only -- WhatsApp and Messages append it to
    // `text`, and a link in both is delivered twice.
    expect(sent.text).not.toContain("http");
  });

  it("does not name the person who was searched for", async () => {
    // The query is a string somebody typed, not a verified identity, and the
    // recipient of the message is not that string. Putting it in the invite
    // would deliver "invite Bob Kanjilal" to whoever the sender picks.
    await searchForNobody("Bob Kanjilal");
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalled());
    expect(JSON.stringify(mocks.shareLink.mock.calls[0][0])).not.toContain(
      "Bob Kanjilal",
    );
  });

  it("says nothing extra when the sheet did the talking", async () => {
    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalled());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("confirms the clipboard fallback, which is the one send nobody sees", async () => {
    mocks.shareLink.mockResolvedValue("copied");
    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Invite link copied."),
    );
  });

  it("treats a dismissed sheet as a decision, not a failure", async () => {
    const cancelled = new Error("Share canceled");
    cancelled.name = "AbortError";
    mocks.shareLink.mockRejectedValue(cancelled);

    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalled());
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("tells a browser that cannot share that there is nothing to retry", async () => {
    mocks.shareLink.mockRejectedValue(new ShareUnavailableError());

    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "This browser cannot share links.",
      ),
    );
  });

  it("reports a share that failed inside a channel that does exist", async () => {
    mocks.shareLink.mockRejectedValue(new Error("Something went wrong"));

    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not share the invite.",
      ),
    );
  });

  it("does not open a second sheet when the row is tapped twice", async () => {
    // On iOS the promise settles only when the sheet is dismissed, and asking
    // to present a second sheet over the first is rejected outright -- so a
    // double tap used to earn an error toast.
    let release: (value: string) => void = () => {};
    mocks.shareLink.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    await searchForNobody();
    const invite = await screen.findByText("Invite them to One");
    fireEvent.click(invite);
    fireEvent.click(invite);

    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalledTimes(1));
    await act(async () => {
      release("native-share");
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("can be used again once the first sheet closes", async () => {
    await searchForNobody();
    const invite = await screen.findByText("Invite them to One");
    fireEvent.click(invite);
    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalledTimes(1));

    fireEvent.click(invite);
    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalledTimes(2));
  });

  it("is not offered before anyone has searched", async () => {
    // Nothing has been looked for, so nothing is missing. The unsearched
    // surface is a starting point, not a failure.
    mocks.searchDirectory.mockResolvedValue({
      items: [],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);

    expect(await screen.findByText("No people yet")).toBeTruthy();
    expect(screen.queryByText("Invite them to One")).toBeNull();
  });

  it("is not offered on RIAs, where a missing name means something else", async () => {
    // A name absent from RIAs means their adviser profile is not verified --
    // very often a person who is already on One. An app link does not fix that
    // and would send someone to invite an existing member.
    mocks.searchDirectory.mockResolvedValue({
      items: [],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());

    chooseDirectory("RIAs");
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Bob Kanjilal" },
    });

    expect(
      await screen.findByText('No one matches "Bob Kanjilal"'),
    ).toBeTruthy();
    expect(screen.queryByText("Invite them to One")).toBeNull();
  });

  it("is not offered when this build has no link a recipient could open", async () => {
    // A native build with no origin baked in. Offering a button that cannot
    // produce a working link is worse than not offering one.
    delete process.env.NEXT_PUBLIC_APP_URL;

    await searchForNobody();
    expect(screen.queryByText("Invite them to One")).toBeNull();
  });
});

describe("Connect — Circles", () => {
  it("opens the directory filter as a portalled material popover on web", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Current directory:/ }));

    const menu = await screen.findByTestId("connect-directory-menu");
    const anchor = screen.getByTestId("connect-directory-menu-anchor");
    expect(anchor.contains(menu)).toBe(false);
    expect(menu).toHaveAttribute("data-slot", "popover-content");
    expect(menu.className).toContain("backdrop-blur-2xl");
    expect(menu.className).toContain("shadow-[0_18px_48px");
    expect(menu.className).not.toContain("absolute");
    expect(
      within(menu).getByRole("menuitemradio", { name: "People" }),
    ).toBeTruthy();
    expect(
      within(menu).getByRole("menuitemradio", { name: "RIAs" }),
    ).toBeTruthy();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Around you" }),
    ).toBeTruthy();
  });

  it("keeps the existing inline directory menu when running in native", async () => {
    mocks.isNative.mockReturnValue(true);
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Current directory:/ }));

    const menu = await screen.findByTestId("connect-directory-menu");
    const anchor = screen.getByTestId("connect-directory-menu-anchor");
    expect(anchor.contains(menu)).toBe(true);
    expect(menu).not.toHaveAttribute("data-slot", "popover-content");
    expect(menu.className).toContain("absolute left-0 top-full");
    expect(menu.className).toContain(
      "bg-[color:var(--app-card-surface-default-solid)]",
    );
    expect(menu.className).not.toContain("app-card-surface-standard");
  });

  it("opens on People when the URL says nothing", async () => {
    render(<ConnectPageClient />);

    // The default is not written to the URL on mount: doing that would eat one
    // router.back() step for every arrival.
    expect(screen.getByLabelText("Search people")).toBeVisible();
    // Both surfaces live in one swipeable pager (as Finance and Consent do);
    // the one the URL did not ask for is present but inert and hidden.
    const circles = screen.getByTestId("connect-circles-tab");
    expect(screen.getByTestId("connect-living-connections").closest('[data-connect-surface="circles"]')).not.toBeNull();
    expect(circles.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(circles.closest("[inert]")).not.toBeNull();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("shows circles instead of the directory when the URL asks for them", async () => {
    mocks.searchParams = new URLSearchParams("tab=circles");

    render(<ConnectPageClient />);

    const circles = await screen.findByTestId("connect-circles-tab");
    expect(circles.closest('[aria-hidden="true"]')).toBeNull();
    // The directory half is the other pane of the pager: still mounted so a
    // swipe back lands on it, but inert and hidden so nothing in it is
    // reachable from this tab.
    const search = screen.getByLabelText("Search people");
    expect(search.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(search.closest("[inert]")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /Current directory:/ }),
    ).toBeNull();
  });

  it("renders Create Circle as a focused task without the Connect dashboard chrome", async () => {
    mocks.searchParams = new URLSearchParams(
      "tab=circles&action=create-circle",
    );

    render(<ConnectPageClient />);

    expect(await screen.findByTestId("connect-circles-tab")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Connections" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Circles" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Current directory:/ }),
    ).toBeNull();
    expect(screen.queryByLabelText("Search people")).toBeNull();
  });

  it("renders Join Circle as a focused task without the Connect dashboard chrome", async () => {
    mocks.searchParams = new URLSearchParams("tab=circles&action=join-circle");

    render(<ConnectPageClient />);

    expect(await screen.findByTestId("connect-circles-tab")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Connections" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Circles" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Current directory:/ }),
    ).toBeNull();
    expect(screen.queryByLabelText("Search people")).toBeNull();
  });

  it("names the default surface explicitly, so back to People navigates", async () => {
    // The App Router refuses a navigation whose only change is that the whole
    // query string disappears -- measured on UAT, recorded in
    // lib/navigation/top-shell-breadcrumbs.ts. `?tab=all` is what makes this a
    // control rather than a dead press.
    mocks.searchParams = new URLSearchParams("tab=circles");
    render(<ConnectPageClient />);

    fireEvent.click(await screen.findByRole("tab", { name: "Connections" }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    expect(String(mocks.routerPush.mock.calls[0][0])).toContain("tab=all");
  });

  it("switches to Circles without exposing selection mode", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Select people" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Circles" }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    expect(String(mocks.routerPush.mock.calls[0][0])).toContain("tab=circles");
    expect(
      screen.queryByRole("button", { name: "Cancel selecting people" }),
    ).toBeNull();
  });

  it("keeps directory tab switches local while Circles stays linkable", async () => {
    // People / RIAs / Around you answer "which directory" inside the hub. Only
    // Circles writes the route-backed surface, so ordinary directory switches
    // do not add browser history noise.
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());

    chooseDirectory("RIAs");

    expect(screen.getByRole("button", { name: "Current directory: RIAs" })).toBeVisible();
    chooseDirectory("Around you");
    expect(screen.getByTestId("nearby-directories-stub")).toBeVisible();
    chooseDirectory("People");
    expect(screen.queryByTestId("nearby-directories-stub")).toBeNull();
    expect(screen.getByRole("button", { name: "Current directory: People" })).toBeVisible();
    // No navigation: the inner strip does not touch the URL.
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });


});

/**
 * A whole `OneLocationContactSignalResult` with nothing matched.
 *
 * Written out in full rather than trimmed to the fields the sheet happens to
 * read today. `__tests__/` sits outside the tsconfig `include`, so
 * `tsc --noEmit` never compiles this file: a missing field fails at render
 * time, or worse, silently does not.
 */
function emptyContactSyncResult() {
  return {
    matches: [],
    matchedUserIds: [],
    totalContacts: 0,
    readContactCount: 0,
    checkedContactCount: 0,
    matchedContactCount: 0,
    unmatchedContactCount: 0,
    uncheckedContactCount: 0,
    uncheckableContactCount: 0,
    excludedSelfContactCount: 0,
    lookupLimitedContactCount: 0,
    lookupLimitExceeded: false,
    inviteCandidateCount: 0,
    autoConnectedCount: 0,
    alreadyConnectedCount: 0,
    requestRequiredCount: 0,
    suppressedCount: 0,
    unknownContactCount: 0,
    completedBatchCount: 0,
    totalBatchCount: 0,
    mutationOutcomeUnknown: false,
    sourcePlatform: "web" as const,
    limited: false,
    truncated: false,
    partial: false,
    region: null,
  };
}

describe("Connect — contact sync", () => {
  // Offered where an address book helps: People. Not on RIAs, where somebody
  // is found by their verified profile rather than by being in your phone,
  // and not on "Around you", which is third-party directories and never
  // reaches this section at all.

  it("offers Sync contacts on People", async () => {
    mocks.listConnections.mockResolvedValue([]);
    render(<ConnectPageClient />);

    expect(
      await screen.findByRole("button", { name: "Sync contacts" }),
    ).toBeTruthy();
  });

  it("preserves connection outcomes and lets the user proceed to the connections list", async () => {
    const matches = [
      {
        lookupId: "new",
        userId: "new",
        displayName: "Asha Rao",
        photoUrl: null,
        outcome: "auto_connected" as const,
      },
      {
        lookupId: "existing",
        userId: "existing",
        displayName: "Meena Shah",
        photoUrl: null,
        outcome: "already_connected" as const,
      },
      {
        lookupId: "removed",
        userId: "removed",
        displayName: "Ravi Kumar",
        photoUrl: null,
        outcome: "suppressed" as const,
      },
    ];
    mocks.syncContactSignals.mockResolvedValueOnce({
      ...emptyContactSyncResult(),
      matches,
      matchedUserIds: matches.map((match) => match.userId),
      totalContacts: 3,
      readContactCount: 3,
      checkedContactCount: 3,
      matchedContactCount: 3,
      autoConnectedCount: 1,
      alreadyConnectedCount: 1,
      suppressedCount: 1,
      partial: true,
      limited: true,
    });
    render(<ConnectPageClient />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sync contacts" }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Contact sync results",
    });

    for (const [name, status] of [
      ["Asha Rao", "Connected now"],
      ["Meena Shah", "Already connected"],
      ["Ravi Kumar", "Kept disconnected"],
    ]) {
      expect(
        within(within(sheet).getByText(name).closest("li")!).getByText(status),
      ).toBeInTheDocument();
    }
    expect(
      within(sheet).getByText("Only part of your contact list was checked."),
    ).toBeInTheDocument();
    expect(mocks.sendRequest).not.toHaveBeenCalled();

    const proceed = within(sheet).getByRole("link", {
      name: "Proceed to connections",
    });
    expect(proceed).toHaveAttribute("href", "/one/connect?tab=all&view=connections");
    proceed.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(proceed);
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    expect(mocks.syncContactSignals).toHaveBeenCalledTimes(1);
  });

  it("uses the verified auth-context phone when Firebase has no phone", async () => {
    // UAT/native phone verification writes the authoritative phone to the
    // backend identity and AuthContext, while Firebase's User can remain
    // phone-less. Dropping this value makes an Indian national contact hash as
    // a plausible US number on an en-US iPhone/browser and silently match 0.
    mocks.authPhoneNumber = "+919000000001";
    mocks.syncContactSignals.mockImplementationOnce(async (options) => {
      await expect(options.resolveAccountPhoneNumber?.()).resolves.toBe(
        "+919000000001",
      );
      await expect(options.resolveIdToken?.()).resolves.toBe("id-token");
      return emptyContactSyncResult();
    });
    render(<ConnectPageClient />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Sync contacts" }),
    );

    await waitFor(() =>
      expect(mocks.syncContactSignals).toHaveBeenCalledWith(
        expect.objectContaining({
          accountPhoneNumber: "+919000000001",
          resolveAccountPhoneNumber: expect.any(Function),
          resolveIdToken: expect.any(Function),
        }),
      ),
    );
  });

  it("does not offer it on the RIAs tab", async () => {
    mocks.listConnections.mockResolvedValue([]);
    render(<ConnectPageClient />);

    await screen.findByRole("button", { name: "Sync contacts" });
    chooseDirectory("RIAs");

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Sync contacts" }),
      ).toBeNull(),
    );
  });

  it("hides it when no contact source is reachable", async () => {
    // A desktop browser with no picker and no Google client configured. A
    // button whose only function is to explain that it cannot work is worse
    // than no button.
    mocks.contactsPermissionState = "unavailable";
    mocks.listConnections.mockResolvedValue([]);
    try {
      render(<ConnectPageClient />);

      await screen.findByRole("button", { name: "Current directory: People" });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Sync contacts" }),
        ).toBeNull(),
      );
    } finally {
      // A plain string on the hoisted object, so `vi.clearAllMocks()` does not
      // touch it. Without the finally, a failure above takes the contact
      // source away from every test that runs after this one.
      mocks.contactsPermissionState = "prompt";
    }
  });

  it("keeps the control out of the section heading", async () => {
    // The rule Refresh follows too. Inside an element with role="heading" a
    // button is folded into the heading's accessible name and is never
    // offered as something to press.
    mocks.listConnections.mockResolvedValue([]);
    render(<ConnectPageClient />);

    const sync = await screen.findByRole("button", {
      name: "Sync contacts",
    });
    const heading = screen.getByRole("button", {
      name: "Current directory: People",
    });

    expect(heading.contains(sync)).toBe(false);
    expect(heading.textContent).not.toContain("Sync");
  });

  it("refuses a second read while one is already running", async () => {
    mocks.listConnections.mockResolvedValue([]);
    let release: (value: unknown) => void = () => {};
    mocks.syncContactSignals.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    render(<ConnectPageClient />);
    const button = await screen.findByRole("button", {
      name: "Sync contacts",
    });

    // Both taps inside ONE act, so React has not committed between them and
    // the fiber still carries disabled={false}. Without that React drops the
    // second click before the handler runs, and the disabled attribute alone
    // passes this test -- which it did: deleting the in-flight ref changed
    // nothing until this was written properly. The attribute cannot be the
    // guard in any case, because the "Check more" and "Sync again" remedies
    // re-enter through a sonner toast button that carries no disabled at all.
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(mocks.syncContactSignals).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sync contacts" }),
      ).toHaveAttribute("aria-busy", "true"),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Sync contacts",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      release(emptyContactSyncResult());
    });

    // The sheet is half of what this change puts on Connect. Without these,
    // deleting its mount breaks no test in this file.
    expect(await screen.findByText("Contact sync results")).toBeTruthy();
    expect(screen.getByText(/No eligible contacts matched/)).toBeTruthy();
    expect(mocks.toastInfo.mock.calls[0][0]).toBe("No contacts matched");
  });
});

// Connect opened on "My connections (0) · No connections yet" and jumped when
// the list landed half a second later (Galaxy S24 Ultra, 2026-09-22).
describe("My connections before the first page answers", () => {
  afterEach(() => {
    CacheService.getInstance().invalidateUser("me");
  });

  it("claims no count and no empty list until the list has answered", async () => {
    const firstPage = deferred<TestConnectionPage>();
    mocks.listConnectionsPage.mockImplementation(() => firstPage.promise);
    render(<ConnectPageClient />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "My connections", exact: true }), { button: 0, ctrlKey: false });
    expect(screen.queryByRole("tab", { name: /My connections 0/ })).toBeNull();
    expect(screen.queryByText("No connections yet")).toBeNull();

    await act(async () =>
      firstPage.resolve({
        items: [],
        page: 1,
        hasMore: false,
        totalCount: 0,
        audience: "all",
      }),
    );
    expect(await screen.findByText("No connections yet")).toBeVisible();
    expect(screen.getByRole("tab", { name: /My connections 0/ })).toBeTruthy();
  });

  it("paints the last first page on the first render of a revisit", () => {
    CacheService.getInstance().set(
      CACHE_KEYS.CONNECTIONS_FIRST_PAGE("me", "all"),
      {
        items: [
          {
            connectionId: "c1",
            userId: "u1",
            displayName: "Cached Friend",
            photoUrl: null,
          },
        ],
        page: 1,
        hasMore: false,
        totalCount: 1,
        audience: "all",
      },
      60_000,
    );
    mocks.listConnectionsPage.mockImplementation(() => new Promise(() => {}));
    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections 1/ }), { button: 0, ctrlKey: false });
    expect(screen.getByText("Cached Friend")).toBeVisible();
    expect(screen.getByRole("tab", { name: /My connections 1/ })).toBeTruthy();
  });
});


describe("Connect saved-roster voice navigation", () => {
  it("keeps the existing my-connections phrase on the complete People roster after RIA browsing", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    chooseDirectory("RIAs");
    await waitFor(() =>
      expect(mocks.listConnectionsPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ audience: "ria" })
      )
    );
    const handler = resolveLocalOnboardingHandler("connect.open_connections");
    expect(handler).not.toBeNull();
    await act(async () => {
      await handler!({}, { directiveId: "open-saved" });
    });
    expect(screen.getByRole("tab", { name: /My connections/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await waitFor(() =>
      expect(mocks.listConnectionsPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ audience: "all" })
      )
    );
  });
});

describe("Connect saved search isolation", () => {
  it("discards a previous query's late page without replacing the browse count or cache", async () => {
    const latePage = deferred<TestConnectionPage>();
    mocks.listConnectionsPage.mockImplementation(async options => {
      if (options.query === "A" && options.page === 2) return latePage.promise;
      const label = options.query === "A" ? "A result" : options.query === "B" ? "B result" : "Browse friend";
      return { items: [{ connectionId: label, userId: label, displayName: label }], page: 1, hasMore: options.query === "A", totalCount: options.query ? 1 : 7, audience: "all" };
    });
    const view = render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    await screen.findByText("Browse friend");
    const field = screen.getByLabelText("Search my connections by name, email or phone");
    fireEvent.change(field, { target: { value: "A" } });
    await screen.findByText("A result");
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    fireEvent.change(field, { target: { value: "B" } });
    await screen.findByText("B result");
    await act(async () => latePage.resolve({ items: [{ connectionId: "stale", userId: "stale", displayName: "Stale A result" }], page: 2, hasMore: false, totalCount: 2, audience: "all" }));
    expect(screen.queryByText("Stale A result")).toBeNull();
    expect(screen.getByRole("tab", { name: /My connections/ })).toHaveTextContent("7");
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    view.unmount();
    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    expect(screen.getByText("Browse friend")).toBeVisible();
    expect(screen.queryByText("B result")).toBeNull();
  });
});


describe("Connect saved view entry and removal", () => {
  it("opens the saved roster from the shared contact-results entry", async () => {
    mocks.searchParams = new URLSearchParams("tab=all&view=connections");
    render(<ConnectPageClient />);
    expect(screen.getByRole("tab", { name: /My connections/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Search people")).not.toBeVisible();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
    expect(mocks.syncContactSignals).not.toHaveBeenCalled();
  });

  it("confirms and removes an exact search match absent from the browse page", async () => {
    mocks.listConnectionsPage.mockImplementation(async options => ({ items: options.query ? [{ connectionId: "off-page-id", userId: "off-page-user", displayName: "Searched Friend" }] : [], page: 1, hasMore: false, totalCount: options.query ? 1 : 0, audience: "all" }));
    render(<ConnectPageClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My connections/ }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Search my connections by name, email or phone"), { target: { value: "Searched" } });
    fireEvent.click(await screen.findByRole("button", { name: "Options for Searched Friend" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Searched Friend");
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove", exact: true }));
    await waitFor(() => expect(mocks.removeConnection).toHaveBeenCalledExactlyOnceWith({ idToken: "id-token", connectionId: "off-page-id" }));
  });
});
