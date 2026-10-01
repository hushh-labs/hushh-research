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

function renderSidebar(extra: Partial<Parameters<typeof AgentHistorySidebar>[0]> = {}) {
  return render(
    <AgentHistorySidebar
      conversations={conversations}
      activeConversationId="conv_1"
      mode="mobile"
      onClose={vi.fn()}
      onOpenConnectors={vi.fn()}
      {...extra}
      onToggleCollapsed={vi.fn()}
      onCreateNew={vi.fn()}
      onSelectConversation={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />
  );
}

describe("AgentHistorySidebar", () => {
  it("places Drive activity above chats on One and hides it on Puppy", () => {
    const activity = <div data-testid="drive-activity">Drive sharing update</div>;
    const first = renderSidebar({ driveActivity: activity });
    const row = screen.getByTestId("drive-activity");
    const today = screen.getByRole("list", { name: "Today conversations" });
    expect(row.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    first.unmount();
    renderSidebar({ driveActivity: activity, surface: "puppy" });
    expect(screen.queryByTestId("drive-activity")).toBeNull();
  });

  it("pins Get the app and Connectors in a footer below the scrollable chat list", () => {
    const onGetApp = vi.fn();
    const onOpenConnectors = vi.fn();
    renderSidebar({ onGetApp, onOpenConnectors, getAppOpen: false });
    const connectors = screen.getByRole("button", { name: "Open Connectors" });
    const getApp = screen.getByRole("button", { name: "Get the app" });
    expect(connectors).toHaveClass("min-h-11");
    const footer = connectors.closest("[data-agent-history-footer]");
    expect(footer).toHaveClass("shrink-0", "border-t");
    expect(footer?.contains(getApp)).toBe(true);
    // Get the app first, Connectors last, as in the reference layout.
    expect(getApp.compareDocumentPosition(connectors) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Agent chat history").lastElementChild).toBe(footer);
    expect(footer?.contains(screen.getByRole("searchbox", { name: "Search chats" }))).toBe(false);

    expect(getApp).toHaveAttribute("aria-haspopup", "dialog");
    expect(getApp).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(getApp);
    expect(onGetApp).toHaveBeenCalledWith(getApp);
    // Connectors keeps its own action, handed the trigger for focus return.
    fireEvent.click(connectors);
    expect(onOpenConnectors).toHaveBeenCalledWith(connectors);
  });

  it("omits Get the app where it is not offered, such as inside the installed app", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "Get the app" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Connectors" })).toBeInTheDocument();
  });

  it("reads ADK epoch-second times, so a chat from minutes ago is Today with its age", () => {
    // Regression: the list sends `last_message_at` as epoch seconds. Parsing
    // it as a date string gave NaN, so every chat grouped as "Older" and no
    // row showed its time.
    const seconds = (Date.now() - 19 * 60_000) / 1000;
    render(
      <AgentHistorySidebar
        conversations={[{ ...conversations[0], created_at: null, updated_at: seconds, last_message_at: seconds }]}
        activeConversationId="conv_1"
        mode="desktop"
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );
    const today = screen.getByRole("list", { name: "Today conversations" });
    expect(within(today).getByText("19m")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Older conversations" })).not.toBeInTheDocument();
    // Desktop reveals the age and the actions control together on hover or
    // focus (founder direction, 2026-09-29), and holds them while the menu is open.
    const age = within(today).getByText("19m");
    const actions = within(today).getByRole("button", { name: "Open actions for What needs a reply today?" });
    // Keep both widths reserved so hover and focus do not bounce the row.
    for (const element of [age, actions.parentElement!]) {
      expect(element.className).toContain("opacity-0");
      expect(element.className).toContain("group-hover:opacity-100");
      expect(element.className).toContain("group-focus-within:opacity-100");
      expect(element.className).toContain("motion-reduce:transition-none");
    }
  });

  it("keeps a row's age and actions visible on touch", () => {
    const seconds = (Date.now() - 5 * 60_000) / 1000;
    renderSidebar({
      conversations: [{ ...conversations[0], last_message_at: seconds, updated_at: seconds }],
    });
    expect(screen.getByText("5m").className).not.toMatch(/(^|\s)hidden(\s|$)/);
    const actions = screen.getByRole("button", { name: "Open actions for What needs a reply today?" });
    expect(actions.parentElement!.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("keeps the row menu on the shared transient tier, above the phone drawer", async () => {
    // A literal z-[560] once put this menu under the drawer's sheet tier
    // (712), so on phones it opened invisibly behind the drawer.
    renderSidebar();
    fireEvent.keyDown(screen.getByRole("button", { name: "Open actions for What needs a reply today?" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("z-(--z-transient)");
    expect(menu.className).not.toMatch(/z-\[\d+\]/);
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteConversation).toHaveBeenCalledWith("conv_1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("uses the compact Chats drawer in mobile mode and omits desktop collapse controls", () => {
    renderSidebar();

    const sidebar = screen.getByLabelText("Agent chat history");
    expect(sidebar).toHaveClass("bg-[color:var(--one-chat-sidebar)]");
    expect(sidebar).toHaveAttribute("data-agent-history-sidebar", "drawer");
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

  it("renders the persistent desktop column with search first and New chat beside it", () => {
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
    expect(sidebar).toHaveAttribute("data-agent-history-sidebar", "persistent");
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    const newChat = screen.getByRole("button", { name: "Create new chat" });
    expect(search.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The header's menu control shows and hides the column; no second toggle,
    // and no keyboard hint for a shortcut nothing handles.
    expect(screen.queryByRole("button", { name: "Collapse chat history" })).not.toBeInTheDocument();
    expect(screen.queryByText("⌘N")).not.toBeInTheDocument();
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

  it("highlights the active chat with a quiet neutral fill and omits repetitive row icons", () => {
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
    expect(activeItem).toHaveClass("bg-[color:var(--one-chat-row-active)]");
    expect(activeItem).toHaveClass("text-foreground");
    expect(activeItem).not.toHaveClass("bg-[color:var(--app-accent)]");

    // In expanded mode, the button directly displays the title without a leading icon
    const chatButton = screen.getByRole("button", { name: /^What needs a reply today/i });
    expect(chatButton.querySelector("svg")).toBeNull();
  });
});
