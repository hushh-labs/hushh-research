import { fireEvent, render, screen } from "@testing-library/react";
import { Mail } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { CapabilitySetupTile } from "@/components/onboarding/setup/capability-setup-tile";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";
import {
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

describe("CapabilitySetupTile", () => {
  it("navigates the whole setup row through the Next router on tap", () => {
    let navigationRequest: InternalAppNavigationRequest | null = null;
    const captureNavigation = (event: Event) => {
      navigationRequest = (event as CustomEvent<InternalAppNavigationRequest>).detail;
    };
    window.addEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      captureNavigation,
    );
    render(
      <CapabilitySetupTile
        capabilityId="gmail"
        title="Gmail"
        description="Bring in receipts."
        actionLabel="Connect Gmail"
        resumeActionLabel="Finish Gmail"
        href="/one/setup/gmail"
        voiceControlId="one_setup_tile_gmail"
        icon={lucideCapabilityIcon(Mail)}
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
    expect(row.querySelector(".morphy-ripple-host")).not.toBeNull();
    expect(row.querySelector('[data-testid="one-agent-icon-gmail"]')).not.toBeNull();
    fireEvent.click(row);

    expect(navigationRequest).toEqual({
      href: "/one/setup/gmail",
      scroll: false,
      source: "tap",
      transitionMode: "full",
    });
    expect(mocks.push).not.toHaveBeenCalled();
    window.removeEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      captureNavigation,
    );
  });

  it("keeps a capability-specific action visible while vault state resolves", () => {
    render(
      <CapabilitySetupTile
        capabilityId="gmail"
        title="Connect Gmail"
        description="Bring in receipts."
        actionLabel="Connect Gmail"
        resumeActionLabel="Finish Gmail"
        href="/one/setup/gmail"
        voiceControlId="one_setup_tile_gmail"
        icon={lucideCapabilityIcon(Mail)}
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

    expect(screen.getAllByText("Connect Gmail")).toHaveLength(1);
    expect(screen.queryByText("Set up vault")).toBeNull();
  });
});
