import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CircleMessagesPane } from "@/components/connect/circles/circle-messages-pane";
import { parseLastMessagesSelection, readLastMessagesSelection, writeLastMessagesSelection } from "@/lib/direct-messages/last-selection";

const mocks = vi.hoisted(() => ({ listCircles: vi.fn() }));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "viewer" } }) }));
vi.mock("@/lib/vault/vault-context", async () => {
  const { createContext } = await import("react");
  return { VaultContext: createContext({ vaultOwnerToken: "vault-token", vaultKey: "vault-key" }) };
});
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { listCircles: (...args: unknown[]) => mocks.listCircles(...args) } }));
vi.mock("@/components/connect/circles/circle-chat", () => ({
  CircleChat: ({ session }: { session: { circleId: string } }) => <div data-testid="circle-chat">{session.circleId}</div>,
}));
vi.mock("@/components/agent/agent-dock", () => ({ AgentDockPortal: () => null }));

const circle = (id: string) => ({ id, name: id, kind: "custom", role: "owner", memberCount: 2, memberLimit: null });

describe("CircleMessagesPane saved selection", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.listCircles.mockReset();
  });

  it("reopens a saved Circle only when its membership is returned", async () => {
    writeLastMessagesSelection("viewer", { lane: "circles", circleId: "circle-owned" });
    mocks.listCircles.mockResolvedValue([circle("circle-owned")]);

    render(<CircleMessagesPane active initialCircleId="circle-owned" />);

    expect(await screen.findByTestId("circle-chat")).toHaveTextContent("circle-owned");
    expect(parseLastMessagesSelection(readLastMessagesSelection("viewer"))).toEqual({ lane: "circles", circleId: "circle-owned" });
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
});
