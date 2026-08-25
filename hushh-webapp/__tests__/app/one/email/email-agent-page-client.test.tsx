import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const push = vi.fn();
const openAgent = vi.fn();
let connected = false;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1", getIdToken: vi.fn() },
    loading: false,
  }),
}));

vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({ openAgent }),
}));

vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    loadingStatus: false,
    presentation: { isConnected: connected },
  }),
}));

import { EmailAgentPageClient } from "@/app/one/email/email-agent-page-client";

describe("EmailAgentPageClient", () => {
  it("offers the canonical Gmail workspace when Gmail is disconnected", () => {
    connected = false;
    render(<EmailAgentPageClient />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    expect(push).toHaveBeenCalledWith("/one/gmail");
    expect(screen.getByRole("heading", { name: "Connect Gmail" })).toBeTruthy();
  });

  it("opens One's approval-gated Gmail draft when Gmail is connected", () => {
    connected = true;
    render(<EmailAgentPageClient />);

    expect(screen.getByText("Gmail connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try Email Agent with One" }));

    expect(openAgent).toHaveBeenCalledWith({
      handoff: expect.objectContaining({
        reason: "user_requested",
        emailDraftInstruction:
          "Help me draft an email. I will review and approve it before anything is sent.",
      }),
    });
  });
});
