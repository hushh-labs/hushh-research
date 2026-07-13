import { fireEvent, render, screen } from "@testing-library/react";
import { Mail } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { CapabilitySetupTile } from "@/components/onboarding/setup/capability-setup-tile";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

describe("CapabilitySetupTile", () => {
  it("navigates the whole setup row through the Next router on tap", () => {
    render(
      <CapabilitySetupTile
        title="Gmail"
        description="Bring in receipts."
        actionLabel="Connect Gmail"
        resumeActionLabel="Finish Gmail"
        href="/one/setup/gmail"
        voiceControlId="one_setup_tile_gmail"
        icon={Mail}
        tone="gmail"
        status={{
          id: "gmail",
          state: "not-started",
          pendingCount: 0,
          prerequisite: null,
          requiresUnlock: false,
        }}
      />,
    );

    const row = screen.getByRole("button", { name: "Gmail: Connect Gmail" });

    expect(row).toHaveAttribute("data-href", "/one/setup/gmail");
    expect(row).toHaveAttribute(
      "data-voice-control-id",
      "one_setup_tile_gmail",
    );
    fireEvent.click(row);

    expect(mocks.push).toHaveBeenCalledWith("/one/setup/gmail", {
      scroll: false,
    });
  });

  it("keeps a capability-specific action visible while vault state resolves", () => {
    render(
      <CapabilitySetupTile
        title="Connect Gmail"
        description="Bring in receipts."
        actionLabel="Connect Gmail"
        resumeActionLabel="Finish Gmail"
        href="/one/setup/gmail"
        voiceControlId="one_setup_tile_gmail"
        icon={Mail}
        tone="gmail"
        status={{
          id: "gmail",
          state: "unknown",
          pendingCount: 0,
          prerequisite: "vault",
          requiresUnlock: true,
        }}
      />,
    );

    expect(screen.getAllByText("Connect Gmail")).toHaveLength(2);
    expect(screen.queryByText("Set up vault")).toBeNull();
  });
});
