import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectMessagesRoute } from "@/components/direct-messages/direct-messages-route";

const mocks = vi.hoisted(() => ({
  query: "", replace: vi.fn(), routeSelection: vi.fn(), renders: [] as [string, string | null][],
  user: { uid: "viewer", getIdToken: vi.fn().mockResolvedValue("auth") },
}));
const router = { replace: mocks.replace };
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.query), useRouter: () => router }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("@/lib/services/direct-messages-service", () => ({ DirectMessagesService: { routeSelection: (...args: unknown[]) => mocks.routeSelection(...args) } }));
vi.mock("@/components/system/route-suspense-fallback", () => ({ RouteSuspenseFallback: () => <div>Loading</div> }));
vi.mock("@/components/direct-messages/direct-messages-page", () => ({ DirectMessagesPage: ({ selection }: { selection: { ref: string } | null }) => { mocks.renders.push([mocks.user.uid, selection?.ref || null]); return <div data-testid="messages">{JSON.stringify(selection)}</div>; } }));

describe("DirectMessagesRoute", () => {
  beforeEach(() => { window.history.replaceState(null, "", "/one/messages"); mocks.query = ""; mocks.replace.mockReset(); mocks.routeSelection.mockReset(); mocks.user.uid = "viewer"; mocks.renders.length = 0; });
  it("restores the bare inbox", () => {
    render(<DirectMessagesRoute />);
    expect(screen.getByTestId("messages")).toHaveTextContent("null");
    expect(mocks.routeSelection).not.toHaveBeenCalled();
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
