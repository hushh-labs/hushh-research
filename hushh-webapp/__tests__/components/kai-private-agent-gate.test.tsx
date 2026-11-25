import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  placement: "private" as "checking" | "shared" | "private" | "unverified",
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

import { KaiPrivateAgentGate } from "@/components/kai/kai-private-agent-gate";

describe("KaiPrivateAgentGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placement = "private";
  });

  it("renders private-agent notice without exposing any Hussh Shared switcher", () => {
    render(
      <KaiPrivateAgentGate>
        <div data-testid="kai-finance-workspace">Finance workspace ready</div>
      </KaiPrivateAgentGate>,
    );

    expect(screen.getByText("Kai is coming to your agent")).toBeInTheDocument();
    expect(screen.queryByTestId("kai-switch-to-shared")).toBeNull();
    expect(screen.queryByText(/Hussh Shared/i)).toBeNull();
    expect(screen.queryByTestId("kai-finance-workspace")).toBeNull();
  });

  it("retries placement check when unverified and opens Finance when shared", () => {
    mocks.placement = "unverified";
    render(
      <KaiPrivateAgentGate>
        <div data-testid="kai-finance-workspace">Finance workspace ready</div>
      </KaiPrivateAgentGate>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByTestId("kai-finance-workspace")).toBeInTheDocument();
  });
});
