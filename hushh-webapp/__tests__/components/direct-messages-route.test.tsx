import { render, screen, waitFor } from "@testing-library/react";
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
  beforeEach(() => { mocks.query = ""; mocks.replace.mockReset(); mocks.routeSelection.mockReset(); mocks.user.uid = "viewer"; mocks.renders.length = 0; });
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
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/messages?token=dm1.opaque", { scroll: false }));
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
