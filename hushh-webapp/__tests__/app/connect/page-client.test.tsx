// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  shareLink: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

// The ladder itself (native sheet -> Web Share -> clipboard) is proved in
// __tests__/share/share-link.test.ts. What belongs here is the page's half of
// the contract: when an invite is offered, and what it hands over.
vi.mock("@/lib/share/share-link", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/share/share-link")>(
      "@/lib/share/share-link",
    );
  return { ...actual, shareLink: mocks.shareLink };
});

import ConnectPageClient from "@/app/connect/page-client";
import { ShareUnavailableError } from "@/lib/share/share-link";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { parseVoiceCard, parseVoiceConfirm } from "@/lib/voice/voice-action-card";

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
  mocks.getScopeCatalog.mockResolvedValue({
    counterpartUserId: "u0",
    items: [],
    offerableItems: [],
  });
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
        "Search by name.",
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
        "Search by name.",
      ),
    ).toBeTruthy();
    // The pager paints a tick after the empty-state copy, so a synchronous
    // read here fails whenever the machine is loaded -- it went 3-for-5 under
    // parallel CI load while passing 4-for-4 on an idle laptop. This file is
    // now a required check on every Connect PR, so an assertion that depends
    // on scheduler luck would train people to re-run CI instead of reading it.
    expect(await screen.findByText("Page 1")).toBeTruthy();
    expect(screen.getByLabelText("People per page")).toBeTruthy();
    // hasMore is true in the fixture, so forward is offered and back is not.
    expect(screen.getByText("Next").closest("button")?.disabled).toBe(false);
    expect(screen.getByText("Prev").closest("button")?.disabled).toBe(true);
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
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();

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
          "Search by name.",
        ),
      ).toBeNull(),
    );
    expect(await screen.findByText("Page 1")).toBeTruthy();
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
      limit: 8,
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

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
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
        { userId: "u9", displayName: "Ankit Kumar Singh", relationship: "none" as const },
        { userId: "u10", displayName: "Ankit Kumar Singh", relationship: "none" as const },
      ],
      hasMore: false,
      page: 1,
    });
    mocks.sendRequest.mockResolvedValue({ id: "request-10" });
    render(<ConnectPageClient />);
    await waitFor(() => expect(mocks.searchDirectory).toHaveBeenCalledTimes(1));

    const sendRequest = resolveLocalOnboardingHandler("connect.send_request");
    let result: Awaited<ReturnType<NonNullable<typeof sendRequest>>> | undefined;
    await act(async () => {
      result = await sendRequest!({ person: "Ankit Kumar Singh", userId: "u10" });
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

  it("caps bulk connection requests at 8 people", async () => {
    const bulkPeople = Array.from({ length: 9 }, (_, index) =>
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

    fireEvent.click(screen.getByRole("button", { name: "Select many people" }));

    expect(
      screen.getByText("Pick up to 8, across pages."),
    ).toBeTruthy();

    for (let index = 0; index < 8; index += 1) {
      fireEvent.click(screen.getByLabelText(`Select Bulk person ${index}`));
    }

    expect(screen.getByText("Review 8 of 8")).toBeTruthy();
    expect(
      (screen.getByLabelText("Select Bulk person 8") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByLabelText("Select Bulk person 0"));
    expect(
      (screen.getByLabelText("Select Bulk person 8") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByLabelText("Select Bulk person 0"));

    fireEvent.click(screen.getByRole("button", { name: "Review 8 of 8" }));
    expect(await screen.findByRole("heading", { name: "Send connection requests" })).toBeTruthy();
    // Not "This only sends a connection request." any more: the bulk path can
    // now carry RIA Picks, so that sentence would be false the moment one is
    // ticked. This wording is accurate whether or not any are.
    expect(
      screen.getByText("Start safe. Add sharing only if you choose."),
    ).toBeTruthy();
    expect(screen.queryByText("Included now")).toBeNull();
    // Nobody here has a capability to grant, and the sheet says so rather than
    // leaving the reader to infer it from an absent section.
    expect(await screen.findByText("No access yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send requests" }));

    await waitFor(() => expect(mocks.sendRequest).toHaveBeenCalledTimes(8));

    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "bulk-0" }),
    );
    expect(mocks.sendRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "bulk-8" }),
    );
  }, 10_000);

  it("keeps a selection after the reader pages away from it", async () => {
    // The reported bug, exactly: pick four on page one, go to page two, pick
    // two more, and the counter reads "2 of 8" -- the first four were dropped
    // the moment their page stopped being rendered, and the send that followed
    // asked two people instead of six.
    //
    // Selections used to be a set of ids re-read against whatever the current
    // page happened to show, so a selection only existed while its own row did.
    // Paging is not deselecting.
    render(<ConnectPageClient />);
    expect(await screen.findByText("Person 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select many people" }));
    fireEvent.click(screen.getByLabelText("Select Person 0"));
    expect(screen.getByText("Review 1 of 8")).toBeTruthy();

    mocks.searchDirectory.mockResolvedValue({
      items: [person("u9", "Person 9")],
      hasMore: false,
      page: 1,
    });
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Person 9" },
    });

    expect(await screen.findByText("Person 9")).toBeTruthy();
    // Still one, and still counted, though its row is nowhere on screen.
    expect(screen.getByText("Review 1 of 8")).toBeTruthy();

    // Picking someone from the new result set adds to the first, and the sheet
    // names both -- nothing is promised that the reader cannot see listed.
    fireEvent.click(screen.getByLabelText("Select Person 9"));
    expect(screen.getByText("Review 2 of 8")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review 2 of 8" }));
    await waitFor(() =>
      expect(screen.getByText("Selected people")).toBeTruthy(),
    );
    const sheet = screen.getByText("Selected people").closest("div");
    expect(sheet).toBeTruthy();
    expect(screen.getAllByText("Person 0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Person 9").length).toBeGreaterThan(0);
  });

  it("says why an ineligible person's checkbox can't be checked, instead of a mute disabled box", async () => {
    // The reported bug: a few rows in selection mode showed a disabled
    // checkbox and nothing else, so clicking looked like it "did nothing"
    // with no way to tell an already-connected person from a bug. A row
    // that isn't a real choice now carries no checkbox at all -- just its
    // reason, in place of one.
    mocks.searchDirectory.mockResolvedValue({
      items: [
        { ...person("u1", "Connected Carl"), relationship: "connected" as const },
        {
          ...person("u2", "Requested Rita"),
          relationship: "pending_outgoing" as const,
        },
        person("u3", "Selectable Sam"),
      ],
      hasMore: false,
      page: 1,
    });
    render(<ConnectPageClient />);
    expect(await screen.findByText("Connected Carl")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select many people" }));

    // Eligible: a real, enabled checkbox.
    expect(
      (screen.getByLabelText("Select Selectable Sam") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // Already connected: no checkbox to click -- its reason stands in for one.
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByLabelText("Select Connected Carl")).toBeNull();

    // Request already out: same treatment, its own reason.
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.queryByLabelText("Select Requested Rita")).toBeNull();
  });

  it("says a one-person request grants nothing, instead of sending it silently", async () => {
    // This used to send straight through whenever the catalog came back empty,
    // which made the two outcomes indistinguishable from the outside: a request
    // that carried access and a request that carried none were both one tap and
    // a toast. So "the sheet didn't come up" read as a broken sheet rather than
    // as the answer, and the page's own surface contract -- an explicit
    // capability review for every connection request -- was failing against it.
    render(<ConnectPageClient />);
    expect(await screen.findByText("Person 0")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]!);

    expect(
      await screen.findByRole("heading", { name: "Send connection request" }),
    ).toBeTruthy();
    expect(screen.getByText("No access yet")).toBeTruthy();
    expect(screen.getByText("This only sends a request.")).toBeTruthy();
    // Nothing is sent until the reader says so.
    expect(mocks.sendRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(mocks.sendRequest).toHaveBeenCalledTimes(1));
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ addresseeUserId: "u0" }),
    );
  });

  it("asks each advisor for their own capability, with their own handle", async () => {
    // A capability handle is derived per owner: the same "RIA Picks" has a
    // different handle for every advisor, and the server drops an unrecognised
    // handle and still answers 200. So reusing one advisor's handle for another
    // reports eight asks and delivers one, with nothing anywhere saying so.
    //
    // The bulk path used to send `requestedScopeHandles: []` outright -- no
    // catalog fetched, no sheet, no picks -- which is why selecting several
    // advisors could never ask any of them for Picks.
    const advisors = [
      { ...person("ria-1", "Ada Advisor"), isRia: true },
      { ...person("ria-2", "Ben Advisor"), isRia: true },
    ];
    mocks.searchDirectory.mockResolvedValue({
      items: advisors,
      hasMore: false,
      page: 1,
    });
    mocks.getScopeCatalog.mockImplementation(
      async ({ counterpartUserId }: { counterpartUserId: string }) => ({
        counterpartUserId,
        items: [
          {
            handle: `scp-${counterpartUserId}`,
            label: "RIA Picks",
            description: "Their published picks.",
          },
        ],
        offerableItems: [],
      }),
    );
    mocks.sendRequest.mockResolvedValue({ id: "request" });

    render(<ConnectPageClient />);
    expect(await screen.findByText("Ada Advisor")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select many people" }));
    fireEvent.click(screen.getByLabelText("Select Ada Advisor"));
    fireEvent.click(screen.getByLabelText("Select Ben Advisor"));
    fireEvent.click(screen.getByRole("button", { name: "Review 2 of 8" }));

    // One row per advisor, because each is a separate ask.
    expect(
      await screen.findByLabelText("Ask Ada Advisor for RIA Picks"),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Ask Ada Advisor for RIA Picks"));
    fireEvent.click(screen.getByLabelText("Ask Ben Advisor for RIA Picks"));

    fireEvent.click(screen.getByRole("button", { name: "Send requests" }));
    await waitFor(() => expect(mocks.sendRequest).toHaveBeenCalledTimes(2));

    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        addresseeUserId: "ria-1",
        requestedScopeHandles: ["scp-ria-1"],
      }),
    );
    expect(mocks.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        addresseeUserId: "ria-2",
        requestedScopeHandles: ["scp-ria-2"],
      }),
    );
  }, 10_000);

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

    fireEvent.click(screen.getByRole("button", { name: "RIAs" }));

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

    fireEvent.click(screen.getByRole("button", { name: "RIAs" }));

    // The heading counts the list it is actually showing. Counting one list
    // and rendering another is the exact shape of the original Connect search
    // bug, so the count is asserted here alongside the rows.
    expect(await screen.findByText("My RIAs (1)")).toBeTruthy();
    expect(screen.getByText("Verified Adviser")).toBeTruthy();
    expect(screen.queryByText("Ordinary Person")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "RIAs" }));

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
  });

  it("offers a picker before it offers a confirmation when the name is ambiguous", async () => {
    // Removing the WRONG person because two share a name is the worst version
    // of the duplicate bug, not a milder one. Which-one comes first, then the
    // are-you-sure for whoever was picked.
    mocks.listConnections.mockResolvedValue([
      RASHID,
      { ...RASHID, connectionId: "c-2", userId: "u-2", maskedEmail: "r***2@gmail.com" },
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

  it("says on its face that the toggle selects more than one person", async () => {
    // This used to assert the label was exactly "Select", on width grounds.
    // It fit, and it read as "select this one" — the opposite of what the
    // control does — so a tester asked whether anyone would know it starts
    // multi-select. The durable invariant underneath that test is WCAG 2.5.3,
    // not the word count: the accessible name must start with the visible
    // label, or "tap Select many" is an instruction voice control cannot
    // follow. Both are asserted here; the width is proved in a real browser by
    // e2e/connect-circle-cta.layout.spec.ts, which jsdom cannot do.
    render(<ConnectPageClient />);
    const toggle = await screen.findByRole("button", {
      name: "Select many people",
    });
    expect(toggle.textContent).toBe("Select many");
    expect(toggle.getAttribute("aria-label")!.startsWith(toggle.textContent!)).toBe(
      true,
    );
    // Not a single bare verb: the label has to carry the plural.
    expect(toggle.textContent!.split(/\s+/).length).toBeGreaterThan(1);
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

    fireEvent.click(screen.getByRole("button", { name: "RIAs" }));
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
