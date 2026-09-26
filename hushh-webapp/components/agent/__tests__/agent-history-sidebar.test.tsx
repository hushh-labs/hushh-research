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
  it("uses the compact Chats drawer in mobile mode and omits desktop collapse controls", () => {
    renderSidebar();

    const sidebar = screen.getByLabelText("Agent chat history");
    expect(sidebar).toHaveClass("chrome-glass-surface");
    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close chat history" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse chat history" })).not.toBeInTheDocument();
  });

  it("uses consumer-safe labels for stored conversation titles", () => {
    render(
      <AgentHistorySidebar
        conversations={[{ ...conversations[0], title: "summarize my pkm" }]}
        activeConversationId="conv_1"
        mode="mobile"
        onClose={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(screen.getByText("Summarize my personal details")).toBeInTheDocument();
    expect(screen.queryByText(/pkm/i)).not.toBeInTheDocument();
  });

  it("renders desktop mode with header, conversation counter, and collapse button", () => {
    render(
      <AgentHistorySidebar
        conversations={conversations}
        activeConversationId="conv_1"
        mode="desktop"
        onToggleCollapsed={vi.fn()}
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    const sidebar = screen.getByLabelText("Agent chat history");
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // Count badge
    expect(screen.getByRole("button", { name: "Create new chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse chat history" })).toBeInTheDocument();
    expect(screen.getByText("What needs a reply today?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^What needs a reply today/i })).toHaveAttribute("aria-current", "page");
  });

  it("renders collapsed rail in desktop mode with expand control and compact icons", () => {
    render(
      <AgentHistorySidebar
        conversations={conversations}
        activeConversationId="conv_1"
        collapsed
        mode="desktop"
        onToggleCollapsed={vi.fn()}
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    const sidebar = screen.getByLabelText("Agent chat history");
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand chat history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new chat" })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search chats" })).not.toBeInTheDocument();
  });

  it("renders friendly empty state when there are no conversations", () => {
    render(
      <AgentHistorySidebar
        conversations={[]}
        activeConversationId={null}
        mode="desktop"
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    expect(screen.getByText("No chats yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeInTheDocument();
  });

  it("highlights the active chat with a neutral selected surface and omits repetitive row icons", () => {
    render(
      <AgentHistorySidebar
        conversations={conversations}
        activeConversationId="conv_1"
        mode="desktop"
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    const activeItem = screen.getByRole("listitem");
    expect(activeItem).toHaveClass("bg-[color:var(--app-settings-icon-surface)]");
    expect(activeItem).toHaveClass("text-foreground");
    expect(activeItem).not.toHaveClass("border-[color:var(--app-accent)]/25");

    // In expanded mode, the button directly displays the title without a leading icon
    const chatButton = screen.getByRole("button", { name: /^What needs a reply today/i });
    expect(chatButton.querySelector("svg")).toBeNull();
  });
});
