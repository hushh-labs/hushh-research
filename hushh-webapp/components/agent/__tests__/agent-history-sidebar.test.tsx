import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import { nativeHistoryProjection } from "@/components/agent/native-history-presentation";
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
  it("never retargets native actions when activity order or the agent surface changes", async () => {
    const handles = new Map<string, string>();
    const rename = vi.fn(), remove = vi.fn();
    const second = { ...conversations[0], id: "conv_2", title: "Second public sample", last_message_at: new Date(Date.now() - 60_000).toISOString() };
    const port = { owner: "synthetic-owner", vaultEpoch: 1, ready: true, open: true, surface: "one" as const,
      conversations: [...conversations, second], selected: "conv_1", pending: null, loading: false,
      create: vi.fn(), select: vi.fn(), rename, remove, setOpen: vi.fn() };
    const first = nativeHistoryProjection(port, handles).sections.flatMap(section => section.rows).find(row => row.selected)!;
    const reordered = nativeHistoryProjection({ ...port, conversations: [second, { ...conversations[0], last_message_at: new Date(Date.now() - 120_000).toISOString() }] }, handles);
    expect(reordered.sections.flatMap(section => section.rows).find(row => row.selected)?.id).toBe(first.id);
    const choice = { documentId: "public", ownerEpoch: "opaque", ownerGeneration: 1, revision: 1, family: "history" as const,
      updateSequence: 1, privacyGeneration: 0, sequence: 1, interactionGeneration: 1, action: "row" as const };
    await reordered.actions.rows.get(first.deleteActionId!)?.({ ...choice, rowId: first.deleteActionId });
    expect(remove).toHaveBeenCalledWith("conv_1");
    const puppy = nativeHistoryProjection({ ...port, surface: "puppy" }, handles);
    expect(puppy.actions.rows.has(first.deleteActionId!)).toBe(false);
  });
  it("keeps native row handles opaque and delegates normalized edits to the existing owner", async () => {
    const rename = vi.fn(), select = vi.fn(), remove = vi.fn(), create = vi.fn();
    const { sections, actions } = nativeHistoryProjection({ owner: "synthetic-owner", vaultEpoch: 1, ready: true, open: true,
      surface: "one", conversations, selected: "conv_1", pending: null, loading: false,
      create, select, rename, remove, setOpen: vi.fn() });
    expect(JSON.stringify(sections)).not.toContain("conv_1");
    const row = sections.flatMap(section => section.rows).find(row => row.selected)!;
    const choice = { documentId: "public", ownerEpoch: "opaque", ownerGeneration: 1, revision: 1, family: "history" as const,
      updateSequence: 1, privacyGeneration: 0, sequence: 1, interactionGeneration: 1, action: "row" as const };
    await actions.rows.get(row.id)?.({ ...choice, rowId: row.id });
    await actions.rows.get(row.renameActionId!)?.({ ...choice, rowId: row.renameActionId, text: "  Public   title  " });
    await actions.rows.get(row.deleteActionId!)?.({ ...choice, rowId: row.deleteActionId });
    expect(select).toHaveBeenCalledWith("conv_1");
    expect(rename).toHaveBeenCalledWith("conv_1", "Public title");
    expect(remove).toHaveBeenCalledWith("conv_1");
    await actions.rows.get(row.renameActionId!)?.({ ...choice, text: " " });
    expect(rename).toHaveBeenCalledTimes(1);
  });
  it.each([
    { mode: "mobile" as const, collapsed: false },
    { mode: "desktop" as const, collapsed: false },
    { mode: "desktop" as const, collapsed: true },
  ])("allows only local creation while $mode history is locked (collapsed=$collapsed)", layout => {
    const create = vi.fn();
    const select = vi.fn();
    const props = { ...layout, conversations, activeConversationId: "conv_1", disabled: true,
      onCreateNew: create, onSelectConversation: select, onRenameConversation: vi.fn(), onDeleteConversation: vi.fn() };
    const view = render(<AgentHistorySidebar {...props} />);
    expect(screen.getByRole("button", { name: "Create new chat" })).toBeDisabled();
    view.rerender(<AgentHistorySidebar {...props} createNewDisabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new chat" }));
    expect(create).toHaveBeenCalledOnce();
    const history = screen.getByRole("button", { name: /^What needs a reply today/ });
    expect(history).toBeDisabled();
    fireEvent.click(history);
    expect(select).not.toHaveBeenCalled();
    view.rerender(<AgentHistorySidebar {...props} createNewDisabled />);
    expect(screen.getByRole("button", { name: "Create new chat" })).toBeDisabled();
  });

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

  it("pins only Get the app and Connectors below the scrollable chat list", () => {
    const onGetApp = vi.fn();
    const onOpenConnectors = vi.fn();
    renderSidebar({ onGetApp, onOpenConnectors, getAppOpen: false });
    const connectors = screen.getByRole("button", { name: "Open Connectors" });
    const getApp = screen.getByRole("button", { name: "Get the app" });
    expect(screen.queryByRole("button", { name: "Open To-do List" })).not.toBeInTheDocument();
    expect(connectors).toHaveClass("min-h-11");
    const footer = connectors.closest("[data-agent-history-footer]");
    expect(footer).toHaveClass("shrink-0", "border-t");
    expect(footer?.contains(getApp)).toBe(true);
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T12:30:00.000Z"));
    try {
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
      // Keep both widths reserved so hover, focus, and an open menu do not
      // shift the title while the controls appear.
      for (const element of [age, actions.parentElement!]) {
        expect(element).toHaveClass("opacity-0");
        expect(element).toHaveClass("group-hover:opacity-100");
        expect(element).toHaveClass("group-focus-within:opacity-100");
        expect(element).toHaveClass("group-has-[[data-state=open]]:opacity-100");
        expect(element).toHaveClass("motion-reduce:transition-none");
      }
      expect(actions.parentElement).toHaveClass("w-8", "shrink-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a row's age and actions visible on touch", () => {
    const seconds = (Date.now() - 5 * 60_000) / 1000;
    renderSidebar({
      conversations: [{ ...conversations[0], last_message_at: seconds, updated_at: seconds }],
    });
    expect(screen.getByText("5m")).not.toHaveClass("opacity-0");
    const actions = screen.getByRole("button", { name: "Open actions for What needs a reply today?" });
    expect(actions.parentElement).not.toHaveClass("opacity-0");
    expect(actions.parentElement!.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(actions).toHaveClass("h-11", "w-11");
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
    const close = screen.getByRole("button", { name: "Close chat history" });
    const heading = screen.getByRole("heading", { name: "Chats" });
    expect(close.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(close).toHaveClass("rounded-full", "size-11");
    const age = screen.getByText("now");
    expect(age.tagName).toBe("TIME");
    expect(age).toHaveAttribute("datetime", conversations[0].last_message_at);
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
