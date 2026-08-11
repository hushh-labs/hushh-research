// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  usePathname: () => "/one/connect",
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

// The Around-you tab has its own suites; keep its directory services out of
// this render so a failure here can only mean the People tab. Stubbing the
// switch rather than one directory keeps that true as directories are added --
// stubbing `advisors-nearby` alone stopped covering the tab the moment a second
// and third directory hung off it.
vi.mock("@/components/connect/nearby-directories", () => ({
  NearbyDirectories: () => <div data-testid="nearby-directories-stub" />,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import ConnectPageClient from "@/app/connect/page-client";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";

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

    expect(
      await screen.findByText(
        "A few people on Hussh. Search by name to find someone specific.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Person 0")).toBeTruthy();
  });

  it("offers paging and a page size, rather than a sample with no way past it", async () => {
    // A bounded first screenful was the right instinct, but refusing to page
    // left the rest of the directory unreachable. Both now hold: a screenful
    // by default, and a way through it.
    render(<ConnectPageClient />);

    expect(
      await screen.findByText(
        "A few people on Hussh. Search by name to find someone specific.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.getByLabelText("People per page")).toBeTruthy();
    // hasMore is true in the fixture, so forward is offered and back is not.
    expect(screen.getByText("Next").closest("button")?.disabled).toBe(false);
    expect(screen.getByText("Previous").closest("button")?.disabled).toBe(true);
  });

  it("asks the server for the page the reader moved to", async () => {
    // The size control is a Radix popover, which jsdom cannot drive without
    // pointer plumbing that would test the library rather than this surface.
    // Next is a plain button and proves the same contract: the page the reader
    // is on is the page the server is asked for.
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("People per page").textContent).toContain("8");

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      const latest =
        mocks.searchDirectory.mock.calls[
          mocks.searchDirectory.mock.calls.length - 1
        ][0];
      expect(latest).toMatchObject({ page: 2, limit: 8 });
    });
    expect(await screen.findByText("Page 2")).toBeTruthy();
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
    // A search is paged like everything else now. Returning the whole matching
    // set unpaged is the same unbounded list, just filtered.
    expect(searched.limit).toBe(8);
    expect(searched.page).toBe(1);

    // The empty-query description disappearing is the unambiguous signal that
    // this is no longer the bounded discovery surface.
    await waitFor(() =>
      expect(
        screen.queryByText(
          "A few people on Hussh. Search by name to find someone specific.",
        ),
      ).toBeNull(),
    );
    expect(await screen.findByText("Page 1")).toBeTruthy();
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
    let result: Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
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
    let result: Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({ person: "Abdul Rashid" });
    });

    expect(result).toMatchObject({ status: "succeeded" });
    // Searched the longest word, not the whole phrase.
    expect(mocks.searchDirectory.mock.calls[1][0]).toMatchObject({ query: "Rashid" });
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
    let result: Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
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
    let result: Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
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

  it("caps bulk connection requests at 20 people", async () => {
    const bulkPeople = Array.from({ length: 21 }, (_, index) =>
      person(`bulk-${index}`, `Bulk person ${index}`),
    );
    mocks.searchDirectory.mockResolvedValue({
      items: bulkPeople,
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({ id: "request" });
    render(<ConnectPageClient />);
    expect(await screen.findByText("Bulk person 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select people" }));

    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(screen.getByLabelText(`Select Bulk person ${index}`));
    }

    expect(screen.getByText("Connect to Selected (20/20)")).toBeTruthy();
    expect(
      (screen.getByLabelText("Select Bulk person 20") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByLabelText("Select Bulk person 0"));
    expect(
      (screen.getByLabelText("Select Bulk person 20") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByLabelText("Select Bulk person 0"));

    fireEvent.click(screen.getByRole("button", { name: "Connect to Selected (20/20)" }));

    await waitFor(() => expect(mocks.sendRequest).toHaveBeenCalledTimes(20));

    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "bulk-0" }),
    );
    expect(mocks.sendRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "bulk-20" }),
    );
  });

  it("drops a selection that is no longer visible in the directory", async () => {
    render(<ConnectPageClient />);
    expect(await screen.findByText("Person 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select people" }));
    fireEvent.click(screen.getByLabelText("Select Person 0"));
    expect(screen.getByText("Connect to Selected (1/20)")).toBeTruthy();

    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9")],
      hasMore: false,
      page: 1,
    });
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Person 9" },
    });

    expect(await screen.findByText("Person 9")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("Connect to Selected (1/20)")).toBeNull(),
    );
  });
});
