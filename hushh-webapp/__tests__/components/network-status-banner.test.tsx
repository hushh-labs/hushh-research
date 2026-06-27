import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NetworkStatusBanner } from "@/components/system/network-status-banner";
import { useNetworkStatus } from "@/hooks/use-network-status";

vi.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: vi.fn(),
}));

describe("NetworkStatusBanner", () => {
  it("renders offline status with status role", async () => {
    vi.mocked(useNetworkStatus).mockReturnValue({
      online: false,
      offline: true,
    });

    render(<NetworkStatusBanner />);

    const status = await screen.findByRole("status");

    expect(status.getAttribute("aria-live")).toBe("assertive");
    expect(status.textContent).toContain("You are currently offline.");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
