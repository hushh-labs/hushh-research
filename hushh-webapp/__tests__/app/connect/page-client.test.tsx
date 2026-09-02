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

const mocks = vi.hoisted(() => ({
  searchDirectory: vi.fn(),
  listConnections: vi.fn(),
  listConnectionsPage: vi.fn(),
  listRequests: vi.fn(),
  sendRequest: vi.fn(),
  cancel: vi.fn(),
  removeConnection: vi.fn(),
  getScopeCatalog: vi.fn(),
  searchInformationScopes: vi.fn(),
  onConnectionCapabilityMutated: vi.fn(),
  onConnectionGraphMutated: vi.fn(),
  routerPush: vi.fn(),
  searchParams: new URLSearchParams(),
  shareLink: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  isNative: vi.fn(() => false),
  // The real hook hands back the same user across renders. Rebuilding it per
  // render would retrigger every effect keyed on it and spin forever, which
  // would say nothing about the page.
  user: { uid: "me", getIdToken: async () => "id-token" },
  // Contact sync hides its control until it knows a source exists, and the
  // probe below is what decides. jsdom has no `navigator.contacts`, so the real
  // plugin answers "unavailable", the control never renders, and a suite that
  // did not set this would assert nothing while staying green.
  contactsPermissionState: "prompt" as "prompt" | "granted" | "unavailable",
  syncContactSignals: vi.fn(),
  toastInfo: vi.fn(),
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/one/connect",
  // The Circles surface lives in `?tab=`, because a circle is a place you can
  // be sent and a surface that only exists in `useState` cannot be linked to.
  // Directory tabs stay local state.
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: () => ({ user: mocks.user }),
}));

// The debounce itself is covered by its own hook test; collapsing it here keeps
// this suite about which request the surface makes, not about timer plumbing.
vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    searchDirectory: mocks.searchDirectory,
    listConnections: mocks.listConnections,
    listConnectionsPage: mocks.listConnectionsPage,
    listRequests: mocks.listRequests,
    sendRequest: mocks.sendRequest,
    cancel: mocks.cancel,
    removeConnection: mocks.removeConnection,
    getScopeCatalog: mocks.getScopeCatalog,
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
import { ShareUnavailableError } from "@/lib/share/share-link";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import {
  parseVoiceCard,
  parseVoiceConfirm,
} from "@/lib/voice/voice-action-card";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNative.mockReturnValue(false);
  // A leaked search query in sessionStorage would silently seed the next
  // test's render, the same way a leaked `?tab=` would.
  window.sessionStorage.clear();
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

describe("Connect — People", () => {
  it("shows viewer-relative contact provenance on a fresh connection read", async () => {
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-contact",
        userId: "u-contact",
        displayName: "Asha Contact",
        photoUrl: null,
        createdAt: "2026-08-25T00:00:00Z",
        connectedFromContacts: true,
      },
    ]);

    render(<ConnectPageClient />);

    expect(await screen.findByText("Asha Contact")).toBeTruthy();
    expect(screen.getByLabelText("Connected from your contacts")).toBeTruthy();
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

    const myConnections = await screen.findByTestId(
      "connect-my-connections-group",
    );
    const connectionName = await within(myConnections).findByText(
      "Scoped Friend",
    );
    const connectionAction = connectionName.closest("button");
    expect(connectionAction).toBeTruthy();

    fireEvent.click(connectionAction!);

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
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove connection with Scoped Friend",
      }),
    );

    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("loads page 2 in stable server order and keeps its contact badge", async () => {
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

    expect(await screen.findByText("My connections (5000)")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Same Name")).toHaveLength(2),
    );
    expect(screen.getByLabelText("Connected from your contacts")).toBeTruthy();
    expect(mocks.listConnectionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 50, audience: "all" }),
    );
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

    expect(await screen.findByText("Current Person")).toBeTruthy();
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

    expect(await screen.findByText("Current Person")).toBeTruthy();
    expect(mocks.listConnectionsPage).toHaveBeenCalledTimes(1);

    // Refresh is a control, not part of the heading text. It used to be a
    // child of the `title` node, which SettingsGroup renders inside an element
    // carrying `role="heading"` -- a button there is folded into the heading's
    // accessible name and is never offered as something to press. The two
    // assertions below are what keep it out: the heading's name is the plain
    // text, and the button is not a descendant of it.
    const connectionsHeading = screen
      .getAllByRole("heading")
      .find((node) => node.textContent?.includes("connections"));
    expect(connectionsHeading).toBeTruthy();
    expect(
      connectionsHeading?.contains(
        screen.getByRole("button", { name: "Refresh contacts" }),
      ),
    ).toBe(false);
    expect(connectionsHeading?.textContent).not.toContain("Refresh");

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

    expect(await screen.findByText("First Person")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    const remove = await screen.findByRole("button", {
      name: "Remove connection with Remove Me",
    });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

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

    expect(await screen.findByText("Search by name.")).toBeTruthy();
    expect(screen.getByText("Person 0")).toBeTruthy();
  });

  it("offers in-list progressive loading rather than visible pagination", async () => {
    // A bounded first screenful was the right instinct, but refusing to page
    // left the rest of the directory unreachable. Both now hold: a screenful
    // by default, and a way through it.
    render(<ConnectPageClient />);

    expect(await screen.findByText("Search by name.")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Load 20 more people" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("People per page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
    expect(screen.queryByLabelText("Previous page")).toBeNull();
  });

  it("reads heading, then instruction, then the field they describe", async () => {
    // QA, on a phone: "people ke neeche supporting line is search by name, but
    // search bar upar hai". The field was rendered ABOVE the "People" heading,
    // so the sentence telling you how to use it ("Search by name.") appeared
    // UNDERNEATH the box it was instructing -- pointing backwards at a control
    // the reader had already scrolled past -- and the field itself arrived
    // before anything on screen had said what it searched.
    render(<ConnectPageClient />);

    const supporting = await screen.findByText("Search by name.");
    const heading = screen.getByRole("heading", { name: "People", level: 2 });
    const field = screen.getByLabelText("Search people");

    // DOCUMENT_POSITION_FOLLOWING: the argument comes AFTER the node.
    expect(
      heading.compareDocumentPosition(supporting) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      supporting.compareDocumentPosition(field) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And still above the rows it filters, rather than pushed under them.
    expect(
      field.compareDocumentPosition(screen.getByText("Person 0")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps load-more inside the grouped list as a compact row", async () => {
    render(<ConnectPageClient />);

    const row = await screen.findByTestId("connect-load-more-row");
    expect(row.className).not.toContain("flex-col");
    expect(row.className).toContain("min-h-14");
    expect(
      within(row).getByRole("button", { name: "Load 20 more people" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("connect-pager-row")).toBeNull();
  });

  it("asks the server for the next batch the reader loads", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "Load 20 more people" }),
    );

    await waitFor(() => {
      const latest =
        mocks.searchDirectory.mock.calls[
          mocks.searchDirectory.mock.calls.length - 1
        ][0];
      expect(latest).toMatchObject({ page: 2, limit: 20 });
    });
    expect(await screen.findByText("Person 20")).toBeTruthy();
    expect(screen.getByText("Person 0")).toBeTruthy();
  });

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
    expect(await screen.findByText("Person 0")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Load 20 more people" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Loading more…")).toBeTruthy(),
    );
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

    expect(await screen.findByText("Person 20")).toBeTruthy();
    expect(screen.getByText("Person 0")).toBeTruthy();
    expect(screen.queryByText("Loading more…")).toBeNull();
  });

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
      expect(screen.queryByText("Search by name.")).toBeNull(),
    );
    expect(screen.queryByLabelText("People per page")).toBeNull();
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

    fireEvent.click(
      screen.getByRole("button", { name: "Load 20 more people" }),
    );
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
    act(() => {
      expect(search!({ person: "Person 9" })).toMatchObject({
        status: "succeeded",
      });
    });

    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({
      query: "Person 9",
      page: 1,
    });
  });

  it("sends a confirmed request only to one exact spoken name", async () => {
    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9")],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({ id: "request-9" });
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
    });
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        addresseeUserId: "u9",
        requestedScopeHandles: [],
        offeredScopeHandles: [],
      }),
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

  it("offers the duplicates to choose from, captioned the way the list captions them", async () => {
    // The directory usually returns masked variants rather than a raw address,
    // which is why the card first shipped saying "No other details" about rows
    // the list right behind it was captioning correctly. That caption is the
    // ONLY thing telling two identical names apart, so losing it turns the
    // picker back into the dead end it exists to remove.
    mocks.searchDirectory.mockResolvedValue({
      items: [
        {
          userId: "u9",
          displayName: "Ankit Kumar Singh",
          maskedEmail: "a***t@hushh.ai",
          relationship: "none" as const,
        },
        {
          userId: "u10",
          displayName: "Ankit Kumar Singh",
          maskedEmail: "a***3@gmail.com",
          relationship: "pending_outgoing" as const,
        },
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    const result = await sendRequest!({ person: "Ankit Kumar Singh" });

    expect(result).toMatchObject({ status: "blocked" });
    const parsed = parseVoiceCard(result.data);
    expect(parsed?.actionId).toBe("connect.send_request");
    expect(parsed?.resolveSlot).toBe("userId");
    expect(parsed?.candidates.map((c) => c.detail)).toEqual([
      "a***t@hushh.ai",
      "a***3@gmail.com",
    ]);
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
    mocks.sendRequest.mockResolvedValue({ id: "request-10" });
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
    mocks.sendRequest.mockResolvedValue({ id: "request-9" });
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
    mocks.sendRequest.mockResolvedValue({ id: "request-9" });
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

  it("pages advisors as their own audience, not as a filter over everyone", async () => {
    // A filter applied after the page is cut can only subtract from a page that
    // was already chosen wrongly: uneven pages, and every advisor past the
    // first one unreachable. The tab therefore asks the server for its own
    // half of the directory.
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalled());
    expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ audience: "people" }),
    );

    chooseDirectory("RIAs");

    await waitFor(() =>
      expect(mocks.searchDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ audience: "ria", page: 1 }),
      ),
    );
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

    expect(await screen.findByText("My connections (2)")).toBeTruthy();
    expect(screen.getByText("Verified Adviser")).toBeTruthy();
    expect(screen.getByText("Ordinary Person")).toBeTruthy();

    chooseDirectory("RIAs");

    // The heading counts the list it is actually showing. Counting one list
    // and rendering another is the exact shape of the original Connect search
    // bug, so the count is asserted here alongside the rows.
    expect(await screen.findByText("My RIAs (1)")).toBeTruthy();
    expect(screen.getByText("Verified Adviser")).toBeTruthy();
    expect(screen.queryByText("Ordinary Person")).toBeNull();
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

    expect(await screen.findByText("People Only Row")).toBeTruthy();
    chooseDirectory("RIAs");

    expect(await screen.findByText("My RIAs (0)")).toBeTruthy();
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
    expect(await screen.findByText("My connections (1)")).toBeTruthy();

    chooseDirectory("RIAs");

    expect(await screen.findByText("My RIAs (0)")).toBeTruthy();
    expect(screen.queryByText("Unannotated Person")).toBeNull();
    expect(screen.getByText("No RIAs yet")).toBeTruthy();
  });
});

describe("Connect — removing a connection", () => {
  const RASHID = {
    connectionId: "c-1",
    userId: "u-rashid",
    displayName: "Rashid",
    maskedEmail: "r***d@gmail.com",
  };

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
      detail: "r***d@gmail.com",
    });
    // Warning text comes from the action's own contract `meaning`, so it
    // cannot drift away from what the action actually does.
    expect(confirm?.consequence).toContain("share");
  });

  it("removes only when the card confirms it", async () => {
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

  it("keeps a connection's Remove beside the name, not under it", async () => {
    // `stackTrailingOnMobile` puts the trailing control on its own line below
    // `sm:` -- which is 640px, so on every iPhone. It was set here for a single
    // 72px "Remove", and QA read the result as a broken row: "remove neeche aa
    // rha". The People list on the same screen has never stacked.
    mocks.listConnections.mockResolvedValue([
      {
        connectionId: "c-1",
        userId: "u-rashid",
        displayName: "Abdul Rashid",
        maskedEmail: "r***d@gmail.com",
      },
    ]);
    render(<ConnectPageClient />);

    const remove = await screen.findByRole("button", {
      name: "Remove connection with Abdul Rashid",
    });
    const trailing = remove.closest("div");
    expect(trailing).toBeTruthy();

    // Whole class tokens, not substrings: this wrapper already carries
    // `max-w-full`, which contains "w-full" and would make a `toContain` check
    // pass or fail for the wrong reason.
    const classes = new Set(trailing!.className.split(/\s+/));

    // The classes SettingsRow adds only when it is stacking.
    expect(classes.has("justify-between")).toBe(false);
    expect(classes.has("pt-1")).toBe(false);
    expect(classes.has("w-full")).toBe(false);
    // And the one it keeps when it is not.
    expect(classes.has("justify-end")).toBe(true);
  });

  it("keeps My connections scrollable when the list grows", async () => {
    // Three connections fit naturally. A hundred should not turn the top of
    // Connect into a full-page receipt before the search field appears.
    mocks.listConnections.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        connectionId: `c-${index}`,
        userId: `u-${index}`,
        displayName: `Trusted Person ${index + 1}`,
        maskedEmail: `t***${index}@example.com`,
      })),
    );

    const { container } = render(<ConnectPageClient />);
    expect(await screen.findByText("My connections (12)")).toBeTruthy();

    const list = container.querySelector(
      '[data-testid="connect-my-connections-group"] [data-inset-separators="true"]',
    );
    expect(list).toBeTruthy();
    expect(list!.className).toContain("max-h-[232px]");
    expect(list!.className).toContain("overflow-y-auto");
    expect(list!.className).toContain("overscroll-contain");
    expect(list!.className).toContain("sm:max-h-[320px]");
  });

  it("asks for the search field in two words", async () => {
    render(<ConnectPageClient />);
    expect(await screen.findByPlaceholderText("Search people")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search people by name")).toBeNull();
  });

  it("reserves the clear-button gutter only once there is something to clear", async () => {
    // 44px of right padding held back from a field whose only content is its
    // placeholder is 44px the placeholder does not get.
    render(<ConnectPageClient />);
    const field = (await screen.findByPlaceholderText(
      "Search people",
    )) as HTMLInputElement;

    expect(field.className).toContain("pr-3.5");
    expect(field.className).not.toContain("pr-11");

    fireEvent.change(field, { target: { value: "ada" } });
    expect(field.className).toContain("pr-11");
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

  it("offers an invite instead of stopping at the dead end", async () => {
    // The whole point of the issue: "No one matches" is a true statement and
    // an unhelpful one, because the likeliest reason a name is missing is that
    // the person has not joined.
    await searchForNobody();

    expect(await screen.findByText("Invite them to One")).toBeTruthy();
    expect(
      screen.getByText("Send them the app. You can connect once they join."),
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

  it("shares the app itself, with nothing attached to it", async () => {
    await searchForNobody();
    fireEvent.click(await screen.findByText("Invite them to One"));

    await waitFor(() => expect(mocks.shareLink).toHaveBeenCalledTimes(1));
    const sent = mocks.shareLink.mock.calls[0][0];
    // Option B: no token, no code, no pending connection. Nobody is added to
    // anything by receiving this, and consent is still asked for later through
    // the normal request flow.
    expect(sent.url).toBe("https://one.hushh.ai/");
    expect(new URL(sent.url).search).toBe("");
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
    expect(within(menu).getByRole("menuitemradio", { name: "People" }))
      .toBeTruthy();
    expect(within(menu).getByRole("menuitemradio", { name: "RIAs" }))
      .toBeTruthy();
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
  });

  it("opens on People when the URL says nothing", async () => {
    render(<ConnectPageClient />);

    // The default is not written to the URL on mount: doing that would eat one
    // router.back() step for every arrival.
    expect(await screen.findByText("Search by name.")).toBeTruthy();
    expect(screen.queryByTestId("connect-circles-tab")).toBeNull();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("shows circles instead of the directory when the URL asks for them", async () => {
    mocks.searchParams = new URLSearchParams("tab=circles");

    render(<ConnectPageClient />);

    expect(await screen.findByTestId("connect-circles-tab")).toBeTruthy();
    // The whole directory half is gone, not merely scrolled past: the search
    // box drives a paged server query that has nothing to do with this tab.
    expect(screen.queryByLabelText("Search people")).toBeNull();
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

    expect(
      screen.queryByRole("button", { name: "Select people" }),
    ).toBeNull();

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

    expect(
      await screen.findByText("Advisors with a verified profile."),
    ).toBeTruthy();
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

      await screen.findByRole("heading", { name: "People" });
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
    const heading = screen.getByRole("heading", { name: "People" });

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
    expect(
      screen.getByText("No Hushh accounts matched in this sync."),
    ).toBeTruthy();
    expect(mocks.toastInfo.mock.calls[0][0]).toBe(
      "No Hushh users matched this time",
    );
  });
});
