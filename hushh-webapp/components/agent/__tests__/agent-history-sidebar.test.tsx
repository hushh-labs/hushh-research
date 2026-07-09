import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";

const conversations: AgentChatConversation[] = [
  {
    id: "conv_1",
    title: "What needs a reply today?",
    status: "active",
    message_count: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  },
];

function renderSidebar() {
  return render(
    <AgentHistorySidebar
      conversations={conversations}
      activeConversationId="conv_1"
      mode="mobile"
      onClose={vi.fn()}
      onToggleCollapsed={vi.fn()}
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />
  );
}

describe("AgentHistorySidebar", () => {
  it("uses glass chrome in mobile mode and omits desktop collapse controls", () => {
    renderSidebar();

    const sidebar = screen.getByLabelText("Agent chat history");
    expect(sidebar).toHaveClass("chrome-glass-surface");
    expect(screen.getByRole("button", { name: "Create new Agent chat" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse chat history" })).not.toBeInTheDocument();
  });
});
