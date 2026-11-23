import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "token") }, generation: 1,
  list: vi.fn(), mutuals: vi.fn(), summary: vi.fn(),
  Error: class extends Error { constructor(public status: number) { super("Unavailable"); } },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user, userId: "acct_recreated_owner" }) }));
vi.mock("@/lib/auth/session-owner", () => ({ getAuthSessionGeneration: () => state.generation, subscribeAuthSessionGeneration: () => () => {} }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { listNetwork: state.list, listMutualConnections: state.mutuals, getNetworkSummary: state.summary }, ConnectionsServiceRequestError: state.Error }));
vi.mock("@/components/connections/connection-person-avatar", () => ({ ConnectionPersonAvatar: () => <span /> }));
import { NetworkPeopleList } from "@/components/connect/network-people-list";
import { PersonNetworkSummary } from "@/components/connections/person-network-summary";
import { PERSON_PROFILE_PREVIEW_EVENT } from "@/lib/connections/person-profile-preview";
import { dispatchConnectionGraphChanged } from "@/lib/connections/connection-graph-events";

const row = (ref: string) => ({ publicPersonRef: ref, displayName: ref, photoUrl: null, networkDegree: 2 });
const page = (number = 1) => ({ person: { publicPersonRef: "target", displayName: "Target" }, items: [row(`Person ${number}`)], page: number, hasMore: number === 1 });
describe("network permission and journey return @feature_connected_profiles", () => {
  beforeEach(() => {
    state.generation++;
    state.list.mockReset().mockImplementation(async (opts: { page: number }) => page(opts.page));
    state.mutuals.mockReset(); state.summary.mockReset();
  });
  afterEach(cleanup);

  it("keeps Extended network limited to third-degree profiles from a mixed response", async () => {
    state.list.mockResolvedValue({ ...page(), hasMore: false, items: [
      { ...row("Direct"), networkDegree: 1 },
      { ...row("Mutual"), networkDegree: 2 },
      { ...row("John"), networkDegree: 3 },
    ] });
    render(<NetworkPeopleList mode="discovery" visitKey="exact-third" />);
    await screen.findByRole("button", { name: "Open John's profile" });
    fireEvent.click(screen.getByRole("button", { name: "3rd", exact: true }));
    await screen.findByRole("button", { name: "Open John's profile" });
    expect(screen.queryByRole("button", { name: "Open Direct's profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Mutual's profile" })).toBeNull();
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
    await act(async () => finish(page()));
    await screen.findByRole("button", { name: "Open Person 2's profile" });
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


});
