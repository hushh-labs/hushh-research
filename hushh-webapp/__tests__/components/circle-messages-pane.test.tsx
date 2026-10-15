import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CircleMessagesPane } from "@/components/connect/circles/circle-messages-pane";
import { parseLastMessagesSelection, readLastMessagesSelection, writeLastMessagesSelection } from "@/lib/direct-messages/last-selection";

const mocks = vi.hoisted(() => ({ listCircles: vi.fn(), startChat: vi.fn(), stopChat: vi.fn() }));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "viewer" } }) }));
vi.mock("@/lib/vault/vault-context", async () => {
  const { createContext } = await import("react");
  return { VaultContext: createContext({ vaultOwnerToken: "vault-token", vaultKey: "vault-key" }) };
});
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { listCircles: (...args: unknown[]) => mocks.listCircles(...args) } }));
vi.mock("@/components/connect/circles/circle-chat", () => ({
  CircleChat: ({ session }: { session: { circleId: string } }) => {
    useEffect(() => {
      mocks.startChat(session.circleId);
      return () => { mocks.stopChat(session.circleId); };
    }, [session]);
    return <div data-testid="circle-chat">{session.circleId}</div>;
  },
}));
vi.mock("@/components/agent/agent-dock", () => ({ AgentDockPortal: () => null }));

const circle = (id: string) => ({ id, name: id, kind: "custom", role: "owner", memberCount: 2, memberLimit: null });

describe("CircleMessagesPane saved selection", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.listCircles.mockReset();
    mocks.startChat.mockClear();
    mocks.stopChat.mockClear();
  });

  it("reopens a saved Circle only when its membership is returned", async () => {
    writeLastMessagesSelection("viewer", { lane: "circles", circleId: "circle-owned" });
    mocks.listCircles.mockResolvedValue([circle("circle-owned")]);

    render(<CircleMessagesPane active initialCircleId="circle-owned" />);

    expect(await screen.findByTestId("circle-chat")).toHaveTextContent("circle-owned");
    expect(parseLastMessagesSelection(readLastMessagesSelection("viewer"))).toEqual({ lane: "circles", circleId: "circle-owned" });
  });

  it("keeps a chat connection alive through header updates and replaces it for another circle", async () => {
    mocks.listCircles.mockResolvedValue([circle("room"), circle("family")]);
    const view = render(<CircleMessagesPane active initialCircleId="room" theme="light" />);
    expect(await screen.findByTestId("circle-chat")).toHaveTextContent("room");
    // CircleChat starts its connection in a passive effect. findByTestId
    // resolves on the commit that renders it, and a loaded runner can return
    // before React runs that effect: shard 2/3 failed here with 0 calls in
    // runs 38265939592, 38294003568, 38377135031 and 38540199373 (attempt 1),
    // each on a PR that never touched Circles. Flush effects, then count.
    await act(async () => {});
    expect(mocks.startChat).toHaveBeenCalledTimes(1);

    view.rerender(<CircleMessagesPane active initialCircleId="room" theme="dark" headerActions={<span>Updated header</span>} />);
    expect(mocks.stopChat).not.toHaveBeenCalled();
    expect(mocks.startChat).toHaveBeenCalledTimes(1);

    view.rerender(<CircleMessagesPane active initialCircleId="family" theme="dark" />);
    await waitFor(() => expect(screen.getByTestId("circle-chat")).toHaveTextContent("family"));
    expect(mocks.stopChat).toHaveBeenCalledWith("room");
    expect(mocks.startChat).toHaveBeenCalledTimes(2);
    expect(mocks.startChat).toHaveBeenLastCalledWith("family");
  });

  it("clears a saved Circle that is absent from current membership", async () => {
    writeLastMessagesSelection("viewer", { lane: "circles", circleId: "circle-revoked" });
    mocks.listCircles.mockResolvedValue([circle("circle-other")]);

    render(<CircleMessagesPane active initialCircleId="circle-revoked" />);

    await waitFor(() => expect(parseLastMessagesSelection(readLastMessagesSelection("viewer")))
      .toEqual({ lane: "circles", circleId: null }));
    expect(screen.queryByTestId("circle-chat")).not.toBeInTheDocument();
  });

  it("excludes system circles from chats and clears an unsupported saved selection", async () => {
    const count = vi.fn();
    writeLastMessagesSelection("viewer", { lane: "circles", circleId: "trusted" });
    mocks.listCircles.mockResolvedValue([
      circle("group"),
      { ...circle("trusted"), systemKind: "trusted", isSystem: false },
      { ...circle("sms"), systemKind: "sms", isSystem: true },
      { ...circle("legacy-sms"), isSystem: true },
    ]);

    render(<CircleMessagesPane active initialCircleId="trusted" onCircleCountChange={count} />);

    expect(await screen.findByRole("button", { name: /group/ })).toBeInTheDocument();
    await waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    expect(screen.queryByRole("button", { name: /trusted|sms/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("circle-chat")).not.toBeInTheDocument();
    expect(parseLastMessagesSelection(readLastMessagesSelection("viewer")))
      .toEqual({ lane: "circles", circleId: null });
  });
  it("filters names without ending the selected chat and refreshes membership", async () => {
    mocks.listCircles.mockResolvedValue([circle("room"), circle("family")]);
    render(<CircleMessagesPane active initialCircleId="room" />);
    expect(await screen.findByTestId("circle-chat")).toHaveTextContent("room");
    const search = screen.getByRole("searchbox", { name: "Search circles" });
    fireEvent.change(search, { target: { value: " FAMILY " } });
    expect(screen.queryByRole("button", { name: "room 2 members" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "family 2 members" })).toBeInTheDocument();
    expect(mocks.startChat).toHaveBeenCalledTimes(1);
    expect(mocks.stopChat).not.toHaveBeenCalled();
    expect(mocks.listCircles).toHaveBeenCalledTimes(1);
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No matching circles")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "room 2 members" })).toBeInTheDocument();
    mocks.listCircles.mockResolvedValue([circle("family")]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh circles" }));
    await waitFor(() => expect(mocks.listCircles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("circle-chat")).not.toBeInTheDocument());
    expect(mocks.listCircles).toHaveBeenLastCalledWith("vault-token");
    expect(mocks.stopChat).toHaveBeenCalledWith("room");
  });

  it("does not restore stale membership when overlapping refreshes finish out of order", async () => {
    let finishOlder!: (items: ReturnType<typeof circle>[]) => void;
    mocks.listCircles.mockResolvedValueOnce([circle("room")])
      .mockImplementationOnce(() => new Promise(resolve => { finishOlder = resolve; }))
      .mockResolvedValueOnce([circle("family")]);
    render(<CircleMessagesPane active />);
    expect(await screen.findByRole("button", { name: "room 2 members" })).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("button", { name: "family 2 members" })).toBeInTheDocument();
    await act(async () => { finishOlder([circle("room")]); });
    // An unguarded older response would replace the newer membership here.
    expect(screen.queryByRole("button", { name: "room 2 members" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "family 2 members" })).toBeInTheDocument();
  });

});
