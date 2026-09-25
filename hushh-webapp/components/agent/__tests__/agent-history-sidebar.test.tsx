import { fireEvent, render, screen, within } from "@testing-library/react";
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
      onOpenConnectors={vi.fn()}
      onToggleCollapsed={vi.fn()}
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />
  );
}

describe("AgentHistorySidebar", () => {
  it("keeps Connectors in a dedicated footer below the scrollable chat list", () => {
    renderSidebar();
    const button = screen.getByRole("button", { name: "Open Connectors" });
    expect(button).toHaveClass("min-h-11", "text-[13px]");
    const footer = button.parentElement;
    expect(footer).toHaveClass("shrink-0", "border-t");
    expect(screen.getByLabelText("Agent chat history").lastElementChild).toBe(footer);
    expect(footer?.contains(screen.getByRole("searchbox", { name: "Search chats" }))).toBe(false);
  });

  it("groups chats quietly by last activity", () => {
    const older = new Date();
    older.setDate(older.getDate() - 15);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    render(<AgentHistorySidebar
      conversations={[
        conversations[0],
        { ...conversations[0], id: "conv_2", title: "Yesterday", last_message_at: yesterday.toISOString() },
        { ...conversations[0], id: "conv_3", title: "Two weeks ago", last_message_at: older.toISOString() },
      ]}
      activeConversationId="conv_1"
      mode="mobile"
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />);
    expect(within(screen.getByRole("list", { name: "Today conversations" })).getByText("What needs a reply today?")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Yesterday conversations" })).getByText("Yesterday")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Last 30 days conversations" })).getByText("Two weeks ago")).toBeInTheDocument();
  });

  it("shows deletion progress in place of the menu while the request is pending", () => {
    const { rerender } = render(<AgentHistorySidebar
      conversations={conversations}
      activeConversationId={null}
      actionPendingId="conv_1"
      mode="desktop"
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />);
    expect(screen.getByRole("status", { name: "Deleting What needs a reply today?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open actions for/ })).not.toBeInTheDocument();
    rerender(<AgentHistorySidebar
      conversations={conversations}
      activeConversationId={null}
      mode="desktop"
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: /Open actions for/ })).toBeInTheDocument();
  });

  it("closes confirmation immediately while deletion continues asynchronously", async () => {
    const onDeleteConversation = vi.fn(() => new Promise<void>(() => undefined));
    render(<AgentHistorySidebar
      conversations={conversations}
      activeConversationId="conv_1"
      mode="mobile"
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={onDeleteConversation}
    />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Open actions for What needs a reply today?" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteConversation).toHaveBeenCalledWith("conv_1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

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

  it("highlights the active chat with a solid filled accent background and omits repetitive row icons", () => {
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
    expect(activeItem).toHaveClass("bg-[color:var(--app-accent)]");
    expect(activeItem).toHaveClass("text-white");
    expect(activeItem).not.toHaveClass("border-[color:var(--app-accent)]/25");

    // In expanded mode, the button directly displays the title without a leading icon
    const chatButton = screen.getByRole("button", { name: /^What needs a reply today/i });
    expect(chatButton.querySelector("svg")).toBeNull();
  });
});
