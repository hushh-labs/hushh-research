import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";

describe("AgentHistorySidebar", () => {
  it("renders the empty chat history fallback", () => {
    render(
      <AgentHistorySidebar
        conversations={[]}
        activeConversationId={null}
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(screen.getByText("No chats yet")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Conversation history" })).toBeTruthy();
  });
});
