import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "token") }, generation: 1,
  list: vi.fn(), mutuals: vi.fn(), summary: vi.fn(), visibility: vi.fn(), update: vi.fn(),
  Error: class extends Error { constructor(public status: number) { super("Unavailable"); } },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user, userId: "acct_recreated_owner" }) }));
vi.mock("@/lib/auth/session-owner", () => ({ getAuthSessionGeneration: () => state.generation, subscribeAuthSessionGeneration: () => () => {} }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { listNetwork: state.list, listMutualConnections: state.mutuals, getNetworkSummary: state.summary, getNetworkVisibility: state.visibility, updateNetworkVisibility: state.update }, ConnectionsServiceRequestError: state.Error }));
vi.mock("@/components/connections/connection-person-avatar", () => ({ ConnectionPersonAvatar: () => <span /> }));
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
    state.list.mockReset().mockImplementation(async (opts: { page: number }) => page(opts.page));
    state.mutuals.mockReset(); state.summary.mockReset(); state.visibility.mockReset(); state.update.mockReset();
  });
  afterEach(cleanup);

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

  it("keeps sharing off until the server confirms and ignores a late save after auth changes", async () => {
    state.visibility.mockResolvedValue({ shareConnectionList: false });
    let finish!: (value: unknown) => void;
    state.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<NetworkVisibilitySetting />);
    const toggle = screen.getByRole("switch", { name: "Share my connection list" });
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
