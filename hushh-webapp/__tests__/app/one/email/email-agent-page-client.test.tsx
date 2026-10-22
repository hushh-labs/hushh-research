import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const navigateToAgentChat = vi.hoisted(() => vi.fn());
const createHandoff = vi.hoisted(() => vi.fn());
let connected = false;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1", email: "owner@example.com", getIdToken: vi.fn() },
    loading: false,
  }),
}));

vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat,
}));

vi.mock("@/lib/agent/one-conversation-session", () => ({
  useOneConversationSession: (selector: (state: { createHandoff: typeof createHandoff }) => unknown) =>
    selector({ createHandoff }),
}));

vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    loadingStatus: false,
    presentation: { isConnected: connected },
  }),
}));

import { EmailAgentPageClient } from "@/app/one/email/email-agent-page-client";

describe("EmailAgentPageClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("offers the canonical Gmail workspace when Gmail is disconnected", () => {
    connected = false;
    render(<EmailAgentPageClient />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Mail" }));

    expect(push).toHaveBeenCalledWith("/one/gmail");
    expect(screen.getByRole("heading", { name: "Connect Mail" })).toBeTruthy();
  });

  it("opens an empty One composer without starting an unrequested mail turn", () => {
    connected = true;
    render(<EmailAgentPageClient />);

    expect(screen.getByText("Mail connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask One about Mail" }));

    expect(navigateToAgentChat).toHaveBeenCalledWith();
    expect(createHandoff).not.toHaveBeenCalled();
  });
});
