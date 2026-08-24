import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openAgent: vi.fn() }));

vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({ openAgent: mocks.openAgent }),
}));

vi.mock("@/components/gmail/gmail-send-access-card", () => ({
  GmailSendAccessCard: ({
    onConnectionStateChange,
    presentation,
  }: {
    onConnectionStateChange?: (enabled: boolean) => void;
    presentation?: string;
  }) => (
    <button
      type="button"
      data-presentation={presentation}
      onClick={() => onConnectionStateChange?.(true)}
    >
      Connect Gmail
    </button>
  ),
}));

import { EmailAgentPage } from "@/components/email/email-agent-page";

describe("EmailAgentPage", () => {
  it("uses the scroll-safe setup shell and opens One after Gmail connects", () => {
    render(<EmailAgentPage />);

    const shell = document.querySelector('[data-app-shell-width="reading"]');
    expect(shell?.className).toContain("min-h-[calc(100dvh");
    expect(shell?.className).not.toContain("fixed");
    expect(shell?.className).not.toContain("overflow-hidden");
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toHaveAttribute(
      "data-presentation",
      "inline",
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    expect(screen.getByText("Gmail connected")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Try Email Agent with One" }),
    );
    expect(mocks.openAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handoff: expect.objectContaining({
          reason: "user_requested",
          transcript: expect.stringContaining("draft an email"),
        }),
      }),
    );
  });
});
