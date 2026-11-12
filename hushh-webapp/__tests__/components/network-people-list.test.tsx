import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "token") }, generation: 1,
  list: vi.fn(), mutuals: vi.fn(), summary: vi.fn(), visibility: vi.fn(), update: vi.fn(), connect: vi.fn(), invalidate: vi.fn(),
  Error: class extends Error { constructor(public status: number) { super("Unavailable"); } },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user, userId: "acct_recreated_owner" }) }));
vi.mock("@/lib/auth/session-owner", () => ({ getAuthSessionGeneration: () => state.generation, subscribeAuthSessionGeneration: () => () => {} }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { listNetwork: state.list, listMutualConnections: state.mutuals, getNetworkSummary: state.summary, getNetworkVisibility: state.visibility, updateNetworkVisibility: state.update }, ConnectionsServiceRequestError: state.Error }));
vi.mock("@/components/connections/connection-person-avatar", () => ({ ConnectionPersonAvatar: () => <span /> }));
vi.mock("@/lib/services/person-profile-service", () => ({ PersonProfileService: { connect: state.connect } }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onConnectionGraphMutated: state.invalidate } }));
import { NetworkPeopleList } from "@/components/connect/network-people-list";
import { PersonNetworkSummary } from "@/components/connections/person-network-summary";
import { NetworkVisibilitySetting } from "@/components/profile/network-visibility-setting";
import { PERSON_PROFILE_PREVIEW_EVENT } from "@/lib/connections/person-profile-preview";
import { dispatchConnectionGraphChanged } from "@/lib/connections/connection-graph-events";

const row = (ref: string) => ({ publicPersonRef: ref, displayName: ref, photoUrl: null, networkDegree: 2 });
const page = (number = 1) => ({ person: { publicPersonRef: "target", displayName: "Target" }, items: [row(`Person ${number}`)], page: number, hasMore: number === 1 });
describe("network permission and journey return @feature_connected_profiles", () => {
  beforeEach(() => {
    state.generation++;
    state.user.getIdToken.mockReset().mockResolvedValue("token");
    state.list.mockReset().mockImplementation(async (opts: { page: number }) => page(opts.page));
    state.mutuals.mockReset(); state.summary.mockReset(); state.visibility.mockReset(); state.update.mockReset();
    state.connect.mockReset(); state.invalidate.mockReset();
  });
  afterEach(cleanup);

  it.each(["token", "response"])("retires a Connect action after reauthentication while awaiting %s", async stage => {
    state.list.mockResolvedValue({ ...page(), hasMore: false, items: [{ ...row("Person"), relationship: "none" }] });
    let finish!: () => void;
    if (stage === "token") state.user.getIdToken.mockResolvedValueOnce("token").mockImplementationOnce(() => new Promise<string>(resolve => { finish = () => resolve("token"); }));
    else state.connect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<NetworkPeopleList mode="discovery" visitKey={`retired-${stage}`} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect with Person" }));
    await waitFor(() => expect(finish).toBeDefined());
    state.generation++;
    view.rerender(<NetworkPeopleList mode="discovery" visitKey={`retired-${stage}`} />);
    await act(async () => finish());
    await screen.findByRole("button", { name: "Connect with Person" });
    expect(state.connect).toHaveBeenCalledTimes(stage === "token" ? 0 : 1);
    expect(state.invalidate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("allows retry after a failed connection request", async () => {
    state.list.mockResolvedValue({ ...page(), hasMore: false, items: [{ ...row("Person"), relationship: "none" }] });
    state.connect.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ status: "pending_outgoing" });
    render(<NetworkPeopleList mode="discovery" visitKey="retry-connect" />);
    const button = await screen.findByRole("button", { name: "Connect with Person" });
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(state.invalidate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["request", "token"])("retains pending intent and reconciles concurrent Connect actions while awaiting %s", async stage => {
    const sent = new Set<string>();
    const finish: Record<string, () => void> = {};
    let finishToken!: () => void;
    if (stage === "token") state.user.getIdToken.mockResolvedValueOnce("token").mockResolvedValueOnce("token").mockImplementationOnce(() => new Promise<string>(resolve => { finishToken = () => resolve("token"); }));
    state.list.mockImplementation(async () => ({ ...page(), hasMore: false, items: ["First", "Second"].map(ref => ({ ...row(ref), relationship: sent.has(ref) ? "pending_outgoing" : "none" })) }));
    state.connect.mockImplementation((ref: string) => new Promise<void>(resolve => { finish[ref] = () => { sent.add(ref); resolve(); }; }));
    state.invalidate.mockImplementation(owner => dispatchConnectionGraphChanged(owner));
    render(<NetworkPeopleList mode="discovery" visitKey="parallel-connect" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect with First" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect with Second" }));
    await waitFor(() => expect(state.connect).toHaveBeenCalledTimes(stage === "token" ? 1 : 2));
    await act(async () => finish.First());
    await screen.findByText("Request sent");
    const second = await screen.findByRole("button", { name: "Connect with Second" });
    expect(second).toBeDisabled();
    fireEvent.click(second);
    if (stage === "token") {
      await act(async () => finishToken());
      await waitFor(() => expect(state.connect).toHaveBeenCalledTimes(2));
    }
    await act(async () => finish.Second());
    await waitFor(() => expect(screen.getAllByText("Request sent")).toHaveLength(2));
    expect(state.invalidate).toHaveBeenCalledTimes(2);
    expect(state.connect).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the mutual control with its search and scroll intact", async () => {
    state.list.mockResolvedValue({ ...page(), hasMore: false, items: [{ ...row("Person"), relationship: "connected", mutualConnectionCount: 3 }] });
    const opened = (event: Event) => event.preventDefault();
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened);
    try {
      const view = () => <div data-network-scroll-owner><NetworkPeopleList mode="connections" personRef="target" visitKey="mutual-control-memory" /></div>;
      let mounted = render(view());
      await screen.findByRole("button", { name: "View all 3 mutual connections with Person" });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Per" } });
      const mutual = await screen.findByRole("button", { name: "View all 3 mutual connections with Person" });
      mounted.container.firstElementChild!.scrollTop = 144;
      mutual.focus(); fireEvent.click(mutual);
      mounted.unmount(); mounted = render(view());
      expect(screen.getByRole("textbox")).toHaveValue("Per");
      await waitFor(() => expect(screen.getByRole("button", { name: "View all 3 mutual connections with Person" })).toHaveFocus());
      expect(mounted.container.firstElementChild!.scrollTop).toBe(144);
    } finally { window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened); }
  });

  it("shows real mutual previews at every level and keeps Connect separate from profile navigation", async () => {
    const previews = [{ publicPersonRef: "mutual-a", displayName: "A", photoUrl: null }, { publicPersonRef: "mutual-b", displayName: "B", photoUrl: null }];
    state.list.mockResolvedValue({ ...page(), hasMore: false, items: [
      { ...row("Direct"), networkDegree: 1, relationship: "connected", mutualConnectionCount: 7, mutualConnectionPreviews: previews },
      { ...row("Second"), relationship: "none", mutualConnectionCount: 3, mutualConnectionPreviews: previews },
      { ...row("Third"), networkDegree: 3, relationship: "pending_outgoing", mutualConnectionCount: 0 },
    ] });
    let finish!: () => void;
    state.connect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const opened = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened);
    try {
      render(<NetworkPeopleList mode="discovery" visitKey="row-actions" />);
      const connect = await screen.findByRole("button", { name: "Connect with Second" });
      expect(screen.getAllByTestId("mutual-avatar-stack")).toHaveLength(2);
      expect(screen.getByText("7 mutual connections")).toBeVisible();
      expect(screen.getByText("3 mutual connections")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Connect with Direct" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Connect with Third" })).toBeNull();
      expect(screen.getByText("Request sent")).toBeVisible();
      fireEvent.click(connect); fireEvent.click(connect);
      await waitFor(() => expect(state.connect).toHaveBeenCalledExactlyOnceWith("Second", "token"));
      expect(opened).not.toHaveBeenCalled();
      expect(connect).toBeDisabled();
      await act(async () => finish());
      expect(state.invalidate).toHaveBeenCalledWith("acct_recreated_owner");
      fireEvent.click(screen.getByRole("button", { name: "View all 3 mutual connections with Second" }));
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ personRef: "Second", networkList: "mutuals" });
      fireEvent.click(screen.getByRole("button", { name: "Open Direct's profile" }));
      expect((opened.mock.calls[1][0] as CustomEvent).detail).toMatchObject({ personRef: "Direct" });
      const throughConnections = screen.getByRole("button", { name: "Through connections", exact: true });
      fireEvent.click(throughConnections);
      expect(throughConnections).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText("People who share a connection with you.")).toBeNull();
      await waitFor(() => expect(state.list).toHaveBeenCalledWith(expect.objectContaining({ degree: 2 })));
    } finally { window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened); }
  });

  it("shows up to two mutual portraits beside the Profile's mutual count, like a connection row", async () => {
    const previews = [{ publicPersonRef: "mutual-a", displayName: "A", photoUrl: null }, { publicPersonRef: "mutual-b", displayName: "B", photoUrl: null }];
    state.summary.mockResolvedValue({ person: { publicPersonRef: "target" }, mutualConnectionCount: 4, mutualConnectionPreview: previews[0], mutualConnectionPreviews: previews, networkDegree: 1, canBrowseConnections: false });
    const view = render(<PersonNetworkSummary personRef="target" />);
    const button = await screen.findByRole("button", { name: "4 mutual connections" });
    // The portraits are decorative: the count stays the accessible name.
    expect(button.querySelector('[data-testid="mutual-avatar-stack"]')?.children).toHaveLength(2);
    view.unmount();
    // An older server sends one preview and no list: still one portrait, not none.
    state.summary.mockResolvedValue({ person: { publicPersonRef: "target" }, mutualConnectionCount: 4, mutualConnectionPreview: previews[0], networkDegree: 1, canBrowseConnections: false });
    render(<PersonNetworkSummary personRef="target" />);
    const single = await screen.findByRole("button", { name: "4 mutual connections" });
    expect(single.querySelector('[data-testid="mutual-avatar-stack"]')?.children).toHaveLength(1);
  });

  it("invalidates network rows and summaries for the canonical recreated account owner", async () => {
    state.summary.mockResolvedValue({ person: { publicPersonRef: "target" }, mutualConnectionCount: 2, networkDegree: 1, canBrowseConnections: true });
    render(<><NetworkPeopleList mode="discovery" visitKey="canonical-owner" /><PersonNetworkSummary personRef="target" /></>);
    await screen.findByRole("button", { name: "Open Person 1's profile" });
    await screen.findByRole("button", { name: "2 mutual connections" });
    state.list.mockResolvedValue({ ...page(), items: [] });
    state.summary.mockResolvedValue({ person: { publicPersonRef: "target" }, mutualConnectionCount: 0, networkDegree: null, canBrowseConnections: false });
    act(() => dispatchConnectionGraphChanged("acct_recreated_owner"));
    await screen.findByText("No profiles to show right now.");
    expect(screen.queryByRole("button", { name: "2 mutual connections" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View connections" })).toBeNull();
  });

  it("restores query, pages, scroll and row focus only after current permission is checked, and clears denied people", async () => {
    const view = () => <div data-network-scroll-owner><NetworkPeopleList mode="connections" personRef="target" visitKey="retained" /></div>;
    let mounted = render(view());
    await screen.findByRole("button", { name: "Open Person 1's profile" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search network by name" }), { target: { value: "Person" } });
    await screen.findByRole("button", { name: "Open Person 1's profile" });
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    const second = await screen.findByRole("button", { name: "Open Person 2's profile" });
    mounted.container.firstElementChild!.scrollTop = 180;
    fireEvent.click(second);
    mounted.unmount();
    let resolve!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mounted = render(view());
    expect(screen.getByRole("textbox", { name: "Search network by name" })).toHaveValue("Person");
    expect(screen.queryByRole("button", { name: "Open Person 2's profile" })).toBeNull();
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => resolve(page()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Person 2's profile" })).toHaveFocus());
    expect(mounted.container.firstElementChild!.scrollTop).toBe(180);
    state.list.mockRejectedValue(new state.Error(403));
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Open Person 2's profile" })).toBeNull();
  });

  it("retires an in-flight page after same-account reauthentication", async () => {
    let finish!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<NetworkPeopleList mode="discovery" visitKey="auth-race" />);
    await waitFor(() => expect(finish).toBeDefined());
    state.generation++;
    state.list.mockResolvedValue({ ...page(), items: [] });
    rerender(<NetworkPeopleList mode="discovery" visitKey="auth-race" />);
    await act(async () => finish(page()));
    await screen.findByText("No profiles to show right now.");
    expect(screen.queryByText("Person 1")).toBeNull();
  });

  it("warms the filters and updates a sent request without reloading the open list", async () => {
    state.list.mockImplementation(async ({ degree }) => ({
      ...page(), hasMore: false,
      items: [{ ...row(degree === 1 ? "Direct" : "Peer"), relationship: degree === 1 ? "connected" : "none" }],
    }));
    state.connect.mockResolvedValue({ status: "pending_outgoing" });
    state.invalidate.mockImplementation((owner: string) => dispatchConnectionGraphChanged(owner));
    render(<NetworkPeopleList mode="discovery" visitKey="warm-filters" />);
    await screen.findByRole("button", { name: "Open Peer's profile" });
    expect(state.list.mock.calls.map(([options]) => options.degree)).toEqual([undefined, 1, 2, 3]);
    fireEvent.click(screen.getByRole("button", { name: "My connections" }));
    expect(screen.getByRole("button", { name: "Open Direct's profile" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Through connections" }));
    const peer = screen.getByRole("button", { name: "Open Peer's profile" });
    fireEvent.click(screen.getByRole("button", { name: "Connect with Peer" }));
    await screen.findByText("Request sent");
    expect(screen.getByRole("button", { name: "Open Peer's profile" })).toBe(peer);
    fireEvent.click(screen.getByRole("button", { name: "Extended network" }));
    expect(screen.getByText("Request sent")).toBeVisible();
    expect(state.list).toHaveBeenCalledTimes(4);

    state.list.mockResolvedValue({ ...page(), hasMore: false, items: [] });
    act(() => dispatchConnectionGraphChanged("acct_recreated_owner"));
    expect(screen.queryByRole("button", { name: "Open Peer's profile" })).toBeNull();
    await screen.findByText("No people to show yet. Search by name to get started.");
  });

  it("keeps suggestions after loading more and prefers a newly qualified network row", async () => {
    const third = (name: string) => ({ ...row(name), networkDegree: 3 });
    state.list.mockImplementation(async ({ degree, page: requestedPage }) => {
      if (degree !== 3) return { ...page(), hasMore: false };
      if (requestedPage === 2) {
        return { ...page(2), items: [third("Now third degree")] };
      }
      return {
        ...page(),
        items: [third("Third degree")],
        suggestions: ["Now third degree", "Advisor"].map(name => ({
          ...row(name), networkDegree: null, suggestionReason: "verified_advisor",
        })),
      };
    });
    render(<NetworkPeopleList mode="discovery" visitKey="extended-pages" />);
    fireEvent.click(screen.getByRole("button", { name: "Extended network" }));
    await screen.findByRole("button", { name: "Open Advisor's profile" });
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Now third degree's profile" })).not.toHaveAccessibleDescription());
    expect(screen.getAllByRole("button", { name: /^Open .* profile$/ }).map(
      button => button.getAttribute("aria-label"),
    )).toEqual(["Open Third degree's profile", "Open Now third degree's profile", "Open Advisor's profile"]);
    expect(screen.getByRole("button", { name: "Open Advisor's profile" })).toHaveAccessibleDescription("Suggested · Verified advisor");
    expect(state.list).toHaveBeenCalledWith(expect.objectContaining({ degree: 3, page: 1, includeSuggestions: true }));
    expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ degree: 3, page: 2 }));
  });

  it("keeps authorized rows and scroll while a next-page request settles", async () => {
    const { container } = render(<div data-network-scroll-owner><NetworkPeopleList mode="connections" personRef="target" visitKey="append" /></div>);
    const first = await screen.findByRole("button", { name: "Open Person 1's profile" });
    container.firstElementChild!.scrollTop = 95;
    let finish!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(screen.getByRole("button", { name: "Open Person 1's profile" })).toBe(first);
    expect(container.firstElementChild!.scrollTop).toBe(95);
    expect(state.list.mock.calls.map(([options]) => options.page)).toEqual([1, 2]);
    await act(async () => finish(page(2)));
    await screen.findByRole("button", { name: "Open Person 2's profile" });
    expect(screen.getByRole("button", { name: "Open Person 1's profile" })).toBe(first);
  });

  it.each([
    { status: 403, message: "This connection list is unavailable." },
    { status: 503, message: "Could not load connections. Please try again." },
  ])("retries a rate-limited page without replay and clears rows after $status", async ({ status, message }) => {
    render(<NetworkPeopleList mode="connections" personRef="target" visitKey="page-retry" />);
    const first = await screen.findByRole("button", { name: "Open Person 1's profile" });
    state.list.mockRejectedValueOnce(new state.Error(429));
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    await screen.findByText("Could not load connections. Please try again.");
    expect(screen.getByRole("button", { name: "Open Person 1's profile" })).toBe(first);

    state.list.mockResolvedValueOnce({ ...page(2), hasMore: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Open Person 2's profile" });
    expect(state.list.mock.calls.map(([options]) => options.page)).toEqual([1, 2, 2]);

    state.list.mockRejectedValueOnce(new state.Error(status));
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    await screen.findByText(message);
    expect(screen.queryByRole("button", { name: /Open Person .* profile/ })).toBeNull();
  });

  it("accepts server-false after a sharing request and exposes failed updates without changing the switch", async () => {
    state.visibility.mockResolvedValue({ shareConnectionList: false });
    state.update.mockResolvedValueOnce({ shareConnectionList: false }).mockRejectedValueOnce(new Error("Offline"));
    render(<NetworkVisibilitySetting />);
    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await screen.findByRole("alert");
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("uses the mutual endpoint for a missing single preview and never labels a hidden path or offers a private list", async () => {
    state.summary.mockResolvedValue({ person: { publicPersonRef: "target" }, mutualConnectionCount: 1, mutualConnectionPreview: null, networkDegree: null, canBrowseConnections: false });
    state.mutuals.mockResolvedValue({ ...page(), totalCount: 1, hasMore: false });
    const opened = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened);
    try {
      render(<PersonNetworkSummary personRef="target" />);
      fireEvent.click(await screen.findByRole("button", { name: "1 mutual connection" }));
      await waitFor(() => expect(opened).toHaveBeenCalledOnce());
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ personRef: "Person 1" });
      expect((opened.mock.calls[0][0] as CustomEvent).detail.networkList).toBeUndefined();
      expect(screen.queryByRole("button", { name: "View connections" })).toBeNull();
      expect(screen.queryByText(/1st|2nd|3rd/)).toBeNull();
    } finally { window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened); }
  });

  it("hides zero mutuals and enables wider browsing only with server permission", async () => {
    state.summary.mockResolvedValue({ person: { publicPersonRef: "target" }, mutualConnectionCount: 0, mutualConnectionPreview: null, networkDegree: 1, canBrowseConnections: true });
    render(<PersonNetworkSummary personRef="target" />);
    await screen.findByRole("button", { name: "View connections" });
    expect(screen.queryByRole("button", { name: /mutual connection/ })).toBeNull();
    expect(screen.getByText("1st connection")).toBeVisible();
  });

  it.each([
    [0, "0 connections"], [1, "1 connection"], [500, "500 connections"], [501, "500+ connections"],
  ] as const)("opens the shared list from the count for %i visible connections", async (visibleConnectionCount, label) => {
    state.summary.mockResolvedValue({ networkDegree: 1, mutualConnectionCount: 0, canBrowseConnections: true, visibleConnectionCount });
    const opened = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened);
    try {
      render(<PersonNetworkSummary personRef="target" />);
      const trigger = await screen.findByRole("button", { name: label, exact: true });
      expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      fireEvent.click(trigger);
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        personRef: "target", networkList: "connections", returnFocus: trigger,
      });
    } finally { window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened); }
  });

  it("clears the count when the server withdraws access to the shared list", async () => {
    state.summary.mockResolvedValue({ networkDegree: 1, mutualConnectionCount: 0, canBrowseConnections: true, visibleConnectionCount: 21 });
    render(<PersonNetworkSummary personRef="target" />);
    await screen.findByRole("button", { name: "21 connections", exact: true });
    state.summary.mockResolvedValue({ networkDegree: 1, mutualConnectionCount: 0, canBrowseConnections: false, visibleConnectionCount: null });
    act(() => dispatchConnectionGraphChanged("acct_recreated_owner"));
    await screen.findByText("1st connection");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps sharing off until the server confirms and ignores a late save after auth changes", async () => {
    state.visibility.mockResolvedValue({ shareConnectionList: false });
    let finish!: (value: unknown) => void;
    state.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<NetworkVisibilitySetting />);
    const toggle = screen.getByRole("switch", { name: "Extended network discovery" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(finish).toBeDefined());
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
    state.generation++;
    rerender(<NetworkVisibilitySetting />);
    await act(async () => finish({ shareConnectionList: true }));
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    expect(screen.getByRole("switch")).not.toBeChecked();
  });
});
