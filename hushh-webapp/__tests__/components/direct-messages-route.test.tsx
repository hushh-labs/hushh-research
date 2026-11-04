import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectMessagesRoute } from "@/components/direct-messages/direct-messages-route";
import { writeLastMessagesSelection } from "@/lib/direct-messages/last-selection";
import { CacheService } from "@/lib/services/cache-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  query: "", replace: vi.fn(), push: vi.fn(), routeSelection: vi.fn(), renders: [] as [string, string | null][],
  user: { uid: "viewer", getIdToken: vi.fn().mockResolvedValue("auth") },
}));
const router = { replace: mocks.replace, push: mocks.push };
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.query), useRouter: () => router }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, userId: mocks.user?.uid ?? null, loading: false }) }));
vi.mock("@/lib/services/direct-messages-service", () => ({ DirectMessagesService: { routeSelection: (...args: unknown[]) => mocks.routeSelection(...args) } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdTokenWithRetry: async () => "auth" } }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn() } }));
vi.mock("@/components/system/route-suspense-fallback", () => ({ RouteSuspenseFallback: () => <div>Loading</div> }));
vi.mock("@/components/direct-messages/direct-messages-page", () => ({ DirectMessagesPage: ({ selection, onSelect, onClearSelection }: { selection: { ref: string } | null; onSelect: (selection: { kind: "conversation"; ref: string }) => void; onClearSelection: () => void }) => {
  mocks.renders.push([mocks.user.uid, selection?.ref || null]);
  return <><div data-testid="messages">{JSON.stringify(selection)}</div>
    <button onClick={() => onSelect({ kind: "conversation", ref: "thread-a" })}>Open A</button>
    <button onClick={() => onSelect({ kind: "conversation", ref: "thread-b" })}>Open B</button>
    <button onClick={onClearSelection}>Cancel opening</button></>;
} }));

describe("DirectMessagesRoute", () => {
  beforeEach(() => CacheService.getInstance().clear());
  beforeEach(() => { mocks.push.mockReset(); publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner("viewer"); });
  beforeEach(() => { window.history.replaceState(null, "", "/one/messages"); window.sessionStorage.clear(); mocks.query = ""; mocks.replace.mockReset(); mocks.routeSelection.mockReset(); mocks.user.uid = "viewer"; mocks.renders.length = 0; });
  it("restores the bare inbox", () => {
    render(<DirectMessagesRoute />);
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
    expect(mocks.routeSelection).not.toHaveBeenCalled();
  });
  it("selects immediately, then opens a newly minted token without resolving it again", async () => {
    let finish!: (value: unknown) => void;
    mocks.routeSelection.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<DirectMessagesRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Open A" }));
    expect(screen.getByTestId("messages")).toHaveTextContent("thread-a");
    await waitFor(() => expect(mocks.routeSelection).toHaveBeenCalledTimes(1));
    await act(async () => finish({ token: "dm1.fresh", kind: "conversation", ref: "thread-a" }));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/one/messages?token=dm1.fresh");
    mocks.renders.length = 0;
    mocks.query = "token=dm1.fresh";
    view.rerender(<DirectMessagesRoute />);
    expect(mocks.renders.length).toBeGreaterThan(0);
    expect(mocks.renders.every(([, ref]) => ref === "thread-a")).toBe(true);
    expect(mocks.routeSelection).toHaveBeenCalledTimes(1);
  });
  it.each(["newer selection", "Back", "account switch"])("retires an unfinished opening after %s", async (event) => {
    let finish!: (value: unknown) => void;
    mocks.routeSelection.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ token: "dm1.b", kind: "conversation", ref: "thread-b" });
    const view = render(<DirectMessagesRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Open A" }));
    await waitFor(() => expect(mocks.routeSelection).toHaveBeenCalledTimes(1));
    if (event === "newer selection") fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    else if (event === "Back") fireEvent.click(screen.getByRole("button", { name: "Cancel opening" }));
    else { mocks.user.uid = "other-owner"; publishValidatedAuthSessionOwner("other-owner"); view.rerender(<DirectMessagesRoute />); }
    await act(async () => finish({ token: "dm1.a", kind: "conversation", ref: "thread-a" }));
    expect(mocks.push).not.toHaveBeenCalledWith("/one/messages?token=dm1.a");
    if (event === "newer selection") {
      expect(screen.getByTestId("messages")).toHaveTextContent("thread-b");
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/one/messages?token=dm1.b");
    } else expect(screen.getByTestId("messages")).toHaveTextContent("null");
  });
  it("retains a resolved source selection when a newer opening fails", async () => {
    let finishSource!: (value: unknown) => void;
    let failOpening!: (reason: Error) => void;
    mocks.query = "token=dm1.source";
    mocks.routeSelection.mockReturnValueOnce(new Promise(resolve => { finishSource = resolve; }))
      .mockReturnValueOnce(new Promise((_, reject) => { failOpening = reject; }));
    render(<DirectMessagesRoute />);
    await waitFor(() => expect(mocks.routeSelection).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    await waitFor(() => expect(mocks.routeSelection).toHaveBeenCalledTimes(2));
    await act(async () => finishSource({ token: "dm1.source", kind: "conversation", ref: "thread-a" }));
    expect(screen.getByTestId("messages")).toHaveTextContent("thread-b");
    await act(async () => failOpening(new Error("Synthetic mint failure")));
    expect(screen.getByTestId("messages")).toHaveTextContent("thread-a");
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("preserves a newer tap when an earlier pushed destination commits late", async () => {
    let finishB!: (value: unknown) => void;
    mocks.routeSelection.mockResolvedValueOnce({ token: "dm1.a", kind: "conversation", ref: "thread-a" })
      .mockReturnValueOnce(new Promise(resolve => { finishB = resolve; }));
    const view = render(<DirectMessagesRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Open A" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/one/messages?token=dm1.a"));
    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    await waitFor(() => expect(mocks.routeSelection).toHaveBeenCalledTimes(2));
    mocks.query = "token=dm1.a";
    view.rerender(<DirectMessagesRoute />);
    expect(screen.getByTestId("messages")).toHaveTextContent("thread-b");
    await act(async () => finishB({ token: "dm1.b", kind: "conversation", ref: "thread-b" }));
    expect(mocks.push).toHaveBeenLastCalledWith("/one/messages?token=dm1.b");
    mocks.query = "token=dm1.b";
    view.rerender(<DirectMessagesRoute />);
    expect(screen.getByTestId("messages")).toHaveTextContent("thread-b");
  });
  it("resolves an opaque token after refresh", async () => {
    mocks.query = "token=dm1.opaque";
    mocks.routeSelection.mockResolvedValue({ token: "dm1.opaque", kind: "conversation", ref: "internal-id" });
    render(<DirectMessagesRoute />);
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("internal-id"));
    expect(mocks.routeSelection).toHaveBeenCalledWith({ idToken: "auth", token: "dm1.opaque" });
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("migrates a legacy selection without adding a history entry", async () => {
    mocks.query = "conversation=internal-id";
    mocks.routeSelection.mockResolvedValue({ token: "dm1.opaque", kind: "conversation", ref: "internal-id" });
    render(<DirectMessagesRoute />);
    await waitFor(() => expect(window.history.state.directMessageSelection).toEqual({ owner: "viewer", token: "dm1.opaque" }));
    expect(window.location.search).toBe("");
  });
  it("restores a hidden encrypted selection after refresh", async () => {
    window.history.replaceState({ directMessageSelection: { owner: "viewer", token: "dm1.hidden" }, unrelated: "preserved" }, "", "/one/messages");
    mocks.routeSelection.mockResolvedValue({ token: "dm1.hidden", kind: "conversation", ref: "restored-thread" });
    render(<DirectMessagesRoute />);
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("restored-thread"));
    expect(window.location.search).toBe("");
    expect(window.history.state.unrelated).toBe("preserved");
    expect(mocks.routeSelection).toHaveBeenCalledWith({ idToken: "auth", token: "dm1.hidden" });
  });
  it("restores the saved People thread on a bare route without history state", async () => {
    writeLastMessagesSelection("viewer", { lane: "people", token: "dm1.saved" });
    mocks.routeSelection.mockResolvedValue({ token: "dm1.saved", kind: "conversation", ref: "saved-thread" });

    render(<DirectMessagesRoute />);

    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("saved-thread"));
    expect(mocks.routeSelection).toHaveBeenCalledWith({ idToken: "auth", token: "dm1.saved" });
    expect(window.location.search).toBe("");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("lets an explicit URL selection override the saved thread", async () => {
    writeLastMessagesSelection("viewer", { lane: "people", token: "dm1.saved" });
    mocks.query = "token=dm1.url";
    mocks.routeSelection.mockResolvedValue({ token: "dm1.url", kind: "conversation", ref: "linked-thread" });

    render(<DirectMessagesRoute />);

    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("linked-thread"));
    expect(mocks.routeSelection).toHaveBeenCalledWith({ idToken: "auth", token: "dm1.url" });
    expect(mocks.routeSelection).not.toHaveBeenCalledWith({ idToken: "auth", token: "dm1.saved" });
  });
  it("never restores another owner's saved People thread", () => {
    writeLastMessagesSelection("someone-else", { lane: "people", token: "dm1.private" });

    render(<DirectMessagesRoute />);

    expect(mocks.routeSelection).not.toHaveBeenCalled();
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
  });
  it("restores the hidden selection on native trailing-slash routes", async () => {
    window.history.replaceState({ directMessageSelection: { owner: "viewer", token: "dm1.native" } }, "", "/one/messages/");
    mocks.routeSelection.mockResolvedValue({ token: "dm1.native", kind: "conversation", ref: "native-thread" });
    render(<DirectMessagesRoute />);
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("native-thread"));
  });
  it("restores clean-address selections on history navigation and clears invalid selections", async () => {
    mocks.routeSelection.mockImplementation(async ({ token }: { token: string }) => {
      if (token === "dm1.invalid") throw new Error("Invalid link");
      return { token, kind: "conversation", ref: token === "dm1.a" ? "thread-a" : "thread-b" };
    });
    const navigate = (token: string | null) => act(() => {
      window.history.replaceState({ directMessageSelection: token ? { owner: "viewer", token } : null }, "", "/one/messages");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    render(<DirectMessagesRoute />);
    for (const token of ["dm1.a", "dm1.b", "dm1.a", "dm1.b"]) {
      navigate(token);
      await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent(token === "dm1.a" ? "thread-a" : "thread-b"));
      expect(window.location.search).toBe("");
    }
    navigate("dm1.invalid");
    await waitFor(() => expect(window.history.state.directMessageSelection).toBeNull());
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
  });
  it("does not restore another owner's hidden selection", () => {
    window.history.replaceState({ directMessageSelection: { owner: "someone-else", token: "dm1.private" } }, "", "/one/messages");
    render(<DirectMessagesRoute />);
    expect(mocks.routeSelection).not.toHaveBeenCalled();
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
  });
  it("returns a tampered token to the inbox", async () => {
    mocks.query = "token=dm1.tampered";
    mocks.routeSelection.mockRejectedValue(new Error("Invalid link"));
    render(<DirectMessagesRoute />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/messages", { scroll: false }));
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
  });
  it("restores a verified token immediately on revisit without a second resolution round trip", async () => {
    mocks.query = "token=dm1.known";
    mocks.routeSelection.mockResolvedValue({ token: "dm1.known", kind: "conversation", ref: "known-thread" });
    const view = render(<DirectMessagesRoute />);
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("known-thread"));
    view.unmount();
    mocks.renders.length = 0;
    mocks.routeSelection.mockImplementation(() => new Promise(() => {}));
    render(<DirectMessagesRoute />);
    expect(mocks.renders[0]).toEqual(["viewer", "known-thread"]);
    expect(mocks.routeSelection).toHaveBeenCalledTimes(1);
  });
  it("never paints a prior owner's selection during account switching", async () => {
    mocks.query = "token=dm1.opaque";
    mocks.routeSelection.mockResolvedValueOnce({ token: "dm1.opaque", kind: "conversation", ref: "owner-a-thread" });
    const view = render(<DirectMessagesRoute />);
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("owner-a-thread"));
    mocks.user.uid = "other-owner";
    mocks.routeSelection.mockImplementation(() => new Promise(() => {}));
    view.rerender(<DirectMessagesRoute />);
    expect(mocks.renders).not.toContainEqual(["other-owner", "owner-a-thread"]);
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
  });

});
