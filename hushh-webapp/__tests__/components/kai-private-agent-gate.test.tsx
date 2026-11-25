import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  placement: "private" as "checking" | "shared" | "private" | "unverified",
  switchHostingMode: vi.fn(),
  bootstrapState: vi.fn(),
  dispatchFeedStateChanged: vi.fn(),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "owner-1" },
    loading: false,
    accountPrincipal: {
      firebaseUid: "owner-1",
      ownerId: "owner-1",
      accountGeneration: 1,
    },
  }),
}));

vi.mock("@/lib/kai/kai-placement", () => ({
  useKaiPlacement: (_principal: unknown, attempt = 0) =>
    attempt > 0 ? "shared" : mocks.placement,
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    switchHostingMode: mocks.switchHostingMode,
  },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: mocks.bootstrapState,
  },
}));

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

import { KaiPrivateAgentGate } from "@/components/kai/kai-private-agent-gate";

describe("KaiPrivateAgentGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placement = "private";
    mocks.switchHostingMode.mockResolvedValue({
      hostingMode: "shared",
      detachedPriorHost: true,
    });
    mocks.bootstrapState.mockResolvedValue({});
  });

  it("switches to Hussh Shared in 1 click and opens Finance in place without losing state", async () => {
    render(
      <KaiPrivateAgentGate>
        <div data-testid="kai-finance-workspace">Finance workspace ready</div>
      </KaiPrivateAgentGate>,
    );

    expect(screen.getByText("Kai is coming to your agent")).toBeInTheDocument();
    const trigger = screen.getByTestId("kai-switch-to-shared");
    expect(trigger).toHaveTextContent("Switch to Hussh Shared");

    fireEvent.click(trigger);

    await waitFor(() =>
      expect(mocks.switchHostingMode).toHaveBeenCalledWith({ target: "shared" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("kai-finance-workspace")).toBeInTheDocument(),
    );
    expect(mocks.bootstrapState).toHaveBeenCalledWith("owner-1", { force: true });
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
  });
});
