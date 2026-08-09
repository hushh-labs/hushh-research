// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchDirectory: vi.fn(),
  listConnections: vi.fn(),
  listRequests: vi.fn(),
  sendRequest: vi.fn(),
  cancel: vi.fn(),
  removeConnection: vi.fn(),
  getScopeCatalog: vi.fn(),
  searchInformationScopes: vi.fn(),
  onConnectionCapabilityMutated: vi.fn(),
  routerPush: vi.fn(),
  // The real hook hands back the same user across renders. Rebuilding it per
  // render would retrigger every effect keyed on it and spin forever, which
  // would say nothing about the page.
  user: { uid: "me", getIdToken: async () => "id-token" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: vi.fn(), back: vi.fn() }),
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
  },
}));

// The Around-you tab has its own suite; keep its directory services out of this
// render so a failure here can only mean the People tab.
vi.mock("@/components/connect/advisors-nearby", () => ({
  AdvisorsNearby: () => <div data-testid="advisors-nearby-stub" />,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import ConnectPageClient from "@/app/connect/page-client";

function person(userId: string, displayName: string) {
  return {
    userId,
    displayName,
    email: `${userId}@example.com`,
    relationship: "none" as const,
  };
}

/** Ten people, so a limit of 8 is visibly a cap rather than the whole set. */
const EVERYONE = Array.from({ length: 10 }, (_, index) =>
  person(`u${index}`, `Person ${index}`),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConnections.mockResolvedValue([]);
  mocks.listRequests.mockResolvedValue([]);
  mocks.searchDirectory.mockResolvedValue({
    items: EVERYONE.slice(0, 8),
    hasMore: true,
    page: 1,
  });
});

describe("Connect — People", () => {
  it("asks for a bounded sample before anyone has searched", async () => {
    render(<ConnectPageClient />);

    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));
    // The reported problem was the whole register arriving unprompted. The
    // unsearched surface must ask for a capped set, and no query.
    expect(mocks.searchDirectory.mock.calls[0][0]).toMatchObject({
      page: 1,
      limit: 8,
    });
    expect(mocks.searchDirectory.mock.calls[0][0].query).toBe("");

    expect(await screen.findByText("Suggested")).toBeTruthy();
    expect(screen.getByText("Person 0")).toBeTruthy();
  });

  it("never offers to page deeper into the sample, whatever the server says", async () => {
    // hasMore is true in the fixture: a sample that pages is just the register
    // again, one tap further away.
    render(<ConnectPageClient />);

    expect(await screen.findByText("Suggested")).toBeTruthy();
    expect(screen.queryByText("Load more people")).toBeNull();
  });

  it("opens the full directory once a name is typed", async () => {
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Person 9" },
    });

    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(2));
    const searched = mocks.searchDirectory.mock.calls[1][0];
    expect(searched.query).toBe("Person 9");
    // No cap on a real search — the reader has said who they are looking for.
    expect(searched.limit).toBeUndefined();

    // "People" is also the tab label, so the sample heading going away is the
    // unambiguous signal that this is no longer the bounded surface.
    await waitFor(() => expect(screen.queryByText("Suggested")).toBeNull());
    expect(await screen.findByText("Load more people")).toBeTruthy();
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

  /**
   * Bulk selection is deliberately unreachable: the entry point was removed
   * because selecting many people at once was not a clear answer to finding
   * the right one, and it invited fanning out requests instead of searching.
   *
   * This pins the removal rather than the old behaviour. The selection state,
   * the per-row checkboxes and the bulk request handler are all still in the
   * component on purpose, so restoring the control is a one-line change -- but
   * while it is hidden that path has no coverage, and the previous test for it
   * ("drops selections the new result set no longer shows") went with the
   * button. Reinstating the control should reinstate that test.
   */
  it("does not offer bulk selection", async () => {
    render(<ConnectPageClient />);
    expect(await screen.findByText("Person 0")).toBeTruthy();

    expect(screen.queryByText("Select")).toBeNull();
    expect(screen.queryByText("Select All")).toBeNull();
    expect(screen.queryByLabelText("Select Person 0")).toBeNull();
  });
});
