import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GmailChatPanel from "@/components/gmail/gmail-chat-panel";

vi.mock("@/lib/services/email-chat-service", () => ({
  EmailChatService: { chat: vi.fn() },
}));

describe("GmailChatPanel", () => {
  it("keeps inbox actions accessible and touch-sized", () => {
    render(<GmailChatPanel vaultOwnerToken="vault-owner-token" />);

    expect(screen.getByRole("textbox", { name: "Ask your inbox" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send inbox question" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").some((button) => button.className.includes("min-h-11"))).toBe(true);
  });
});
