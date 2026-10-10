import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentDockProvider,
  AgentDockVoiceBoundary,
} from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { DirectMessagesPage as ProductionDirectMessagesPage } from "@/components/direct-messages/direct-messages-page";
import { ROUTES } from "@/lib/navigation/routes";

const mocks = vi.hoisted(() => {
  const conversation = {
    id: "conversation-1",
    peerPersonRef: "person-1",
    peerDisplayName: "Ankit Kumar Singh",
    peerPhotoUrl: null,
    createdAt: "2026-10-06T10:00:00.000Z",
    lastMessageAt: null,
    latestMessage: null,
    unreadCount: 0,
  };

  return {
    commandActive: false,
    commandPhase: "idle",
    voiceActive: false,
    navigateSelection: vi.fn(),
    router: { push: vi.fn(), replace: vi.fn() },
    query: "person=person-1",
    user: {
      uid: "viewer-1",
      getIdToken: vi.fn().mockResolvedValue("test-token"),
    },
    conversation,
    listConversations: vi.fn(),
    listConnectionsPage: vi.fn(),
    getConversationWithPerson: vi.fn(),
    getConversationMessages: vi.fn(),
    markConversationRead: vi.fn(),
    openEvents: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    reactToMessage: vi.fn(),
    removeReaction: vi.fn(),
    morphyToast: { error: vi.fn(), info: vi.fn(), promise: vi.fn() },
    requestAgentConversationAfterRoute: vi.fn(),
  };
});

vi.mock("@/components/agent/location-command-provider", () => ({
  useOptionalLocationCommand: () => ({ active: mocks.commandActive, view: { phase: mocks.commandPhase } }),
}));

vi.mock("@/components/one-voice/voice-session-provider", () => ({
  useOptionalVoiceSession: () => ({ state: { phase: mocks.voiceActive ? "live" : "idle", error: null } }),
}));

vi.mock("@/lib/direct-messages/navigate-direct-message", () => ({
  navigateDirectMessage: (router: { push: (href: string) => void }, selection: unknown) => {
    mocks.navigateSelection(selection);
    router.push("/one/messages?token=dm1.fixture");
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/connections/connection-person-avatar", () => ({
  ConnectionPersonAvatar: ({ label }: { label: string }) => <span>{label}</span>,
}));

vi.mock("@/components/agent/chat-message-styles", () => ({
  OneChatBubble: ({ children, tone: _tone, ...props }: { children: React.ReactNode; tone?: string } & React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@/lib/direct-messages/direct-message-events", () => ({
  dispatchDirectMessagesUpdated: vi.fn(),
  subscribeToDirectMessagesUpdated: () => () => undefined,
}));

vi.mock("@/lib/agent/agent-voice-settings", () => ({
  requestAgentConversationAfterRoute: (...args: unknown[]) =>
    mocks.requestAgentConversationAfterRoute(...args),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: mocks.morphyToast,
}));

// The recipient viewer's unlock/decryption lifecycle has its own production
// component tests. This suite verifies Chat never renders/indexes its envelope.
vi.mock("@/components/wallet/wallet-shared-card-message", () => ({
  WalletSharedCardMessage: () => <section aria-label="Shared payment card">Shared payment card</section>,
}));

vi.mock("@/lib/services/direct-messages-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/direct-messages-service")>()),
  DIRECT_MESSAGE_MAX_LENGTH: 2_000,
  DirectMessagesService: {
    listConversations: (...args: unknown[]) => mocks.listConversations(...args),
    getConversationWithPerson: (...args: unknown[]) =>
      mocks.getConversationWithPerson(...args),
    getConversationMessages: (...args: unknown[]) =>
      mocks.getConversationMessages(...args),
    markConversationRead: (...args: unknown[]) =>
      mocks.markConversationRead(...args),
    openEvents: (...args: unknown[]) => mocks.openEvents(...args),
    sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
    editMessage: (...args: unknown[]) => mocks.editMessage(...args),
    deleteMessage: (...args: unknown[]) => mocks.deleteMessage(...args),
    reactToMessage: (...args: unknown[]) => mocks.reactToMessage(...args),
    removeReaction: (...args: unknown[]) => mocks.removeReaction(...args),
  },
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: { listConnectionsPage: (...args: unknown[]) => mocks.listConnectionsPage(...args) },
}));

const messageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const visibleMessage = {
  id: "visible-message", conversationId: "conversation-1", senderIsViewer: false,
  content: "Visible unread message", createdAt: "2026-10-06T10:01:00.000Z", readAt: null,
};

function exposeLatestMessage() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
  });
}

function ConnectionThread() {
  return (
    <AgentDockProvider>
      <AgentDockVoiceBoundary>
        <AgentBarSurface data-testid="shared-chat-dock">
          <span>Talk to One</span>
        </AgentBarSurface>
      </AgentDockVoiceBoundary>
      <DirectMessagesPage />
    </AgentDockProvider>
  );
}

function renderConnectionThread() {
  return render(<ConnectionThread />);
}

function DirectMessagesPage() {
  const params = new URLSearchParams(mocks.query);
  const conversation = params.get("conversation");
  const person = params.get("person");
  return <ProductionDirectMessagesPage selection={conversation ? { kind: "conversation", ref: conversation } : person ? { kind: "person", ref: person } : null} />;
}

describe("DirectMessagesPage", () => {
  beforeEach(() => {
    mocks.commandActive = false;
    mocks.commandPhase = "idle";
    mocks.voiceActive = false;
    mocks.router.push.mockReset();
    mocks.router.replace.mockReset();
    mocks.query = "person=person-1";
    mocks.user.getIdToken.mockClear();
    mocks.listConversations.mockResolvedValue({
      items: [mocks.conversation],
      unreadCount: 0,
    });
    mocks.listConnectionsPage.mockResolvedValue({
      items: [{ connectionId: "connection-new", userId: "viewer-2", publicPersonRef: "person-new",
        displayName: "Divya", photoUrl: null, createdAt: null }],
      page: 1, hasMore: false, totalCount: 1, audience: "all",
    });
    mocks.getConversationWithPerson.mockResolvedValue({
      conversation: mocks.conversation,
      peerPersonRef: "person-1",
      peerDisplayName: "Ankit Kumar Singh",
      peerPhotoUrl: null,
      canSend: true,
      disconnectedNotice: null,
    });
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });
    mocks.markConversationRead.mockResolvedValue({ readCount: 0, readAt: null });
    mocks.openEvents.mockImplementation(() => new Promise(() => undefined));
    mocks.morphyToast.error.mockReset();
    mocks.morphyToast.info.mockReset();
    mocks.morphyToast.promise.mockReset();
    mocks.sendMessage.mockResolvedValue({
      conversation: mocks.conversation,
      message: {
        id: "message-1",
        conversationId: "conversation-1",
        senderIsViewer: true,
        content: "Hello Ankit",
        createdAt: "2026-10-06T10:01:00.000Z",
        readAt: null,
      },
    });
    mocks.editMessage.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      senderIsViewer: true,
      content: "Edited message",
      createdAt: "2026-10-06T10:01:00.000Z",
      readAt: null,
      editedAt: "2026-10-06T10:02:00.000Z",
      reactions: [],
    });
    mocks.deleteMessage.mockResolvedValue({ scope: "me", message: null });
    mocks.reactToMessage.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      senderIsViewer: true,
      content: "Hello Ankit",
      createdAt: "2026-10-06T10:01:00.000Z",
      readAt: null,
      reactions: [{ emoji: "❤️", count: 1, reactedByViewer: true }],
    });
    mocks.removeReaction.mockResolvedValue({
      id: "message-1", conversationId: "conversation-1", senderIsViewer: true,
      content: "Hello Ankit", createdAt: "2026-10-06T10:01:00.000Z",
      readAt: null, reactions: [],
    });
    });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the composer in the conversation while sending to the selected connection", async () => {
    renderConnectionThread();

    expect(await screen.findByRole("button", { name: /Ankit Kumar Singh/ })).toBeVisible();
    const composer = await screen.findByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    expect(composer.closest("form")?.parentElement).not.toBe(screen.getByTestId("shared-chat-dock"));

    fireEvent.change(composer, { target: { value: "Hello Ankit" } });
    fireEvent.submit(composer.closest("form")!);

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        idToken: "test-token",
        content: "Hello Ankit",
        recipientPersonRef: "person-1",
        clientMessageId: expect.stringMatching(messageIdPattern),
        replyToMessageId: undefined,
      }),
    );
  });

  it("keeps the inbox available and opens a selected chat from its row", async () => {
    mocks.query = "";
    renderConnectionThread();

    expect(await screen.findByRole("heading", { name: "Messages" })).toBeVisible();
    const lanes = within(screen.getByRole("complementary", { name: "Conversations" }))
      .getByRole("tablist", { name: "Message lanes" });
    const laneTabs = within(lanes);
    expect(laneTabs.getByRole("tab", { name: "People 1" })).toHaveAttribute("aria-selected", "true");
    expect(laneTabs.getByRole("tab", { name: "Circles 0" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Search conversations")).toBeVisible();
    expect(screen.getByText("Select a conversation to see the chat here.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.getByTestId("shared-chat-dock")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Ankit Kumar Singh/ }));
    expect(mocks.navigateSelection).toHaveBeenCalledWith({ conversationId: "conversation-1" });
    expect(mocks.router.push).toHaveBeenCalledWith("/one/messages?token=dm1.fixture");
  });

  it("starts a chat with an accepted connection that has no conversation yet", async () => {
    mocks.query = "";
    renderConnectionThread();
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    const picker = await screen.findByRole("dialog", { name: "New chat" });
    expect(mocks.listConnectionsPage).toHaveBeenCalledWith({
      idToken: "test-token", page: 1, limit: 50, query: "",
    });
    fireEvent.click(await within(picker).findByRole("button", { name: "Message Divya" }));
    expect(mocks.navigateSelection).toHaveBeenCalledWith({ personRef: "person-new" });
  });

  it.each(["voice", "command", "command-result"] as const)("keeps the inbox free of an active %s composer", async (owner) => {
    mocks.query = "";
    mocks.voiceActive = owner === "voice";
    mocks.commandActive = owner === "command";
    mocks.commandPhase = owner === "command-result" ? "result" : owner === "command" ? "working" : "idle";
    renderConnectionThread();

    expect(await screen.findByRole("heading", { name: "Messages" })).toBeVisible();
    expect(screen.getByTestId("shared-chat-dock")).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the inbox disabled when a pending send finishes after leaving its chat", async () => {
    let finishSend!: (value: unknown) => void;
    mocks.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve; }));
    const view = renderConnectionThread();
    const input = await screen.findByRole("textbox", { name: "Message Ankit Kumar Singh" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "Hello Ankit" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    mocks.query = "";
    view.rerender(<ConnectionThread />);
    await act(async () => finishSend({
      conversation: mocks.conversation,
      message: { id: "late-message", conversationId: "conversation-1", senderIsViewer: true,
        content: "Hello Ankit", createdAt: "2026-10-06T10:01:00.000Z", readAt: null },
    }));
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.getByTestId("shared-chat-dock")).not.toBeVisible();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("clears the active chat badge while its messages are visible", async () => {
    exposeLatestMessage();
    const unreadConversation = { ...mocks.conversation, unreadCount: 3 };
    mocks.listConversations.mockResolvedValue({
      items: [unreadConversation],
      unreadCount: 3,
    });
    mocks.getConversationWithPerson.mockResolvedValue({
      conversation: unreadConversation,
      peerPersonRef: "person-1",
      peerDisplayName: "Ankit Kumar Singh",
      peerPhotoUrl: null,
      canSend: true,
      disconnectedNotice: null,
    });
    mocks.getConversationMessages.mockResolvedValue({
      conversation: unreadConversation,
      items: [visibleMessage],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });

    renderConnectionThread();

    expect(await screen.findByRole("button", { name: /Ankit Kumar Singh/ })).toBeVisible();
    await waitFor(() => expect(mocks.markConversationRead).toHaveBeenCalledWith({
      idToken: "test-token",
      ownerUserId: "viewer-1",
      conversationId: "conversation-1",
      throughMessageId: visibleMessage.id,
      throughCreatedAt: visibleMessage.createdAt,
    }));
    expect(screen.queryByLabelText("3 unread")).not.toBeInTheDocument();
  });

  it("acknowledges visible history and preserves later server unread counts", async () => {
    exposeLatestMessage();
    mocks.query = "conversation=conversation-1";
    mocks.listConversations
      .mockResolvedValueOnce({
        items: [{ ...mocks.conversation, unreadCount: 2 }],
        unreadCount: 2,
      })
      .mockResolvedValue({
        items: [{ ...mocks.conversation, unreadCount: 0 }],
        unreadCount: 0,
      });
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [visibleMessage],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });

    renderConnectionThread();

    expect(await screen.findByRole("heading", { name: "Ankit Kumar Singh" })).toBeVisible();
    await waitFor(() =>
      expect(mocks.markConversationRead).toHaveBeenCalledWith({
        idToken: "test-token",
        ownerUserId: "viewer-1",
        conversationId: "conversation-1",
        throughMessageId: visibleMessage.id,
        throughCreatedAt: visibleMessage.createdAt,
      }),
    );
    expect(screen.queryByLabelText("2 unread")).not.toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(mocks.listConversations).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("2 unread")).not.toBeInTheDocument();
    // A new server count is not cleared just because this conversation is open;
    // those unseen messages have not crossed the visible read boundary.
    mocks.listConversations.mockResolvedValue({
      items: [{ ...mocks.conversation, unreadCount: 2 }], unreadCount: 2,
    });
    fireEvent(window, new Event("focus"));
    expect(await screen.findByLabelText("2 unread")).toBeInTheDocument();
    expect(mocks.markConversationRead).toHaveBeenCalledTimes(1);
  });

  it("searches the open thread and keeps voice access in the header", async () => {
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [
        {
          id: "message-search-match",
          conversationId: "conversation-1",
          senderIsViewer: false,
          content: "Budget review tomorrow",
          createdAt: "2026-10-06T10:01:00.000Z",
          readAt: null,
          reactions: [],
        },
        {
          id: "message-search-miss",
          conversationId: "conversation-1",
          senderIsViewer: true,
          content: "See you then",
          createdAt: "2026-10-06T10:02:00.000Z",
          readAt: null,
          reactions: [],
        },
      ],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });

    renderConnectionThread();

    expect(await screen.findByText("Budget review tomorrow")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), {
      target: { value: "budget" },
    });
    expect(screen.getByText("Budget review tomorrow")).toBeVisible();
    expect(screen.getByText("1 match")).toBeVisible();
    expect(screen.queryByText("See you then")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start voice call" }));
    expect(mocks.morphyToast.info).toHaveBeenCalledWith("Calls are not available yet.");
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it("keeps encrypted card envelopes out of message previews, search, replies, and editing", async () => {
    const content = 'hushh-wallet-card:v1:{"ciphertext":"synthetic-encrypted-payload"}';
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [{ id: "encrypted-card", conversationId: "conversation-1", senderIsViewer: true, content, createdAt: "2026-10-10T10:00:00Z", readAt: null, reactions: [] }], canSend: true, disconnectedNotice: null, nextBefore: null });
    renderConnectionThread();
    await screen.findByRole("region", { name: "Shared payment card" });
    expect(document.body).not.toHaveTextContent(content);
    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
    await screen.findByRole("menuitem", { name: "Reply" });
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
    expect(document.body).not.toHaveTextContent("synthetic-encrypted-payload");
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), { target: { value: "synthetic-encrypted-payload" } });
    expect(screen.queryByRole("region", { name: "Shared payment card" })).toBeNull();
  });

  it("offers the full emoji picker and opens One chat for voice", async () => {
    renderConnectionThread();

    const composer = await screen.findByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    expect(
      screen.queryByLabelText("Video calls are not available in Messages yet"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Talk to One" }));
    expect(mocks.requestAgentConversationAfterRoute).toHaveBeenCalledWith(ROUTES.HOME);
    expect(mocks.router.push).toHaveBeenCalledWith(ROUTES.HOME);

    fireEvent.click(screen.getByRole("button", { name: "Choose emoji" }));
    expect(screen.getByLabelText("Emoji picker")).toBeVisible();
    expect(within(screen.getByRole("tablist", { name: "Emoji categories" })).getAllByRole("tab")).toHaveLength(8);
    expect(
      screen.getByRole("tab", { name: "Animals and nature" }),
    ).toBeInTheDocument();
    const emojiSearch = screen.getByPlaceholderText("Search emoji");
    fireEvent.change(emojiSearch, { target: { value: "cat" } });
    expect(screen.getByRole("button", { name: "Use 🐱" })).toBeVisible();
    fireEvent.change(emojiSearch, { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Use 😀" })[0]!);
    expect(composer).toHaveValue("😀");
    expect(screen.queryByRole("button", { name: "Talk to One" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("keeps day separators and delivery state inside the conversation bubbles", async () => {
    const messages = [
      {
        id: "message-yesterday",
        conversationId: "conversation-1",
        senderIsViewer: false,
        content: "Older message",
        createdAt: "2026-10-06T10:01:00.000Z",
        readAt: null,
        reactions: [],
      },
      {
        id: "message-today",
        conversationId: "conversation-1",
        senderIsViewer: true,
        content: "Read message",
        createdAt: "2026-10-07T10:02:00.000Z",
        readAt: "2026-10-07T10:03:00.000Z",
        reactions: [],
      },
      {
        id: "message-sent",
        conversationId: "conversation-1",
        senderIsViewer: true,
        content: "Sent message",
        createdAt: "2026-10-07T10:04:00.000Z",
        readAt: null,
        reactions: [],
      },
    ];
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: messages,
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });

    renderConnectionThread();

    const dayLabel = (value: string) => {
      const date = new Date(value);
      const now = new Date();
      if (date.toDateString() === now.toDateString()) return "Today";
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
      return date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
      });
    };
    expect(await screen.findByText(dayLabel(messages[0].createdAt))).toBeVisible();
    expect(screen.getByText(dayLabel(messages[1].createdAt))).toBeVisible();
    expect(screen.getByLabelText("Read")).toHaveAttribute("title", "Read");
    expect(screen.getByLabelText("Sent")).toHaveAttribute("title", "Sent");
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("renders bubble timestamps beside delivery status without a gesture", async () => {
    const message = {
      id: "message-time",
      conversationId: "conversation-1",
      senderIsViewer: true,
      content: "Swipe me",
      createdAt: "2026-10-07T10:04:00.000Z",
      readAt: null,
      reactions: [],
    };
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [message],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });

    renderConnectionThread();

    const article = await screen.findByRole("article");
    const timestamp = article.querySelector(
      `time[datetime="${message.createdAt}"]`,
    );
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toBeVisible();
    expect(timestamp?.parentElement?.parentElement).toContainElement(screen.getByLabelText("Sent"));
  });

  it("exposes message reactions and replies after a bubble is tapped", async () => {
    const message = {
      id: "message-1",
      conversationId: "conversation-1",
      senderIsViewer: true,
      content: "Hello Ankit",
      createdAt: "2026-10-06T10:01:00.000Z",
      readAt: null,
      reactions: [],
    };
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [message],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });

    renderConnectionThread();
    fireEvent.click(await screen.findByText("Hello Ankit"));

    fireEvent.click(screen.getByRole("button", { name: "React to message" }));
    fireEvent.click(screen.getByRole("button", { name: "React ❤️" }));
    await waitFor(() =>
      expect(mocks.reactToMessage).toHaveBeenCalledWith({
        idToken: "test-token",
        conversationId: "conversation-1",
        messageId: "message-1",
        emoji: "❤️",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "❤️ reaction, 1" }));
    await waitFor(() => expect(mocks.removeReaction).toHaveBeenCalledWith({
      idToken: "test-token", conversationId: "conversation-1", messageId: "message-1", emoji: "❤️",
    }));
    expect(mocks.morphyToast.promise).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
    expect(screen.getByText("Replying to yourself")).toBeVisible();

    const composer = screen.getByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    fireEvent.change(composer, { target: { value: "Thanks" } });
    fireEvent.submit(composer.closest("form")!);

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        idToken: "test-token",
        content: "Thanks",
        recipientPersonRef: "person-1",
        clientMessageId: expect.stringMatching(messageIdPattern),
        replyToMessageId: "message-1",
      }),
    );
  });

  it("keeps a failed reply in the composer without a toast", async () => {
    const message = {
      id: "message-1",
      conversationId: "conversation-1",
      senderIsViewer: false,
      content: "Can you review this?",
      createdAt: "2026-10-06T10:01:00.000Z",
      readAt: null,
      reactions: [],
    };
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [message],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });
    mocks.sendMessage.mockRejectedValueOnce(new Error("temporary failure"));

    renderConnectionThread();
    fireEvent.click(await screen.findByText("Can you review this?"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));

    const composer = screen.getByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    fireEvent.change(composer, { target: { value: "Yes, I can." } });
    fireEvent.submit(composer.closest("form")!);

    expect(
      await screen.findByText("Couldn’t send this reply. Your message is ready to try again."),
    ).toBeVisible();
    expect(composer).toHaveValue("Yes, I can.");
    expect(screen.getByText("Replying to Ankit Kumar Singh")).toBeVisible();
    expect(mocks.morphyToast.error).not.toHaveBeenCalled();
    const originalAttempt = mocks.sendMessage.mock.calls[0]?.[0];
    expect(originalAttempt.clientMessageId).toMatch(messageIdPattern);
    fireEvent.submit(composer.closest("form")!);
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocks.sendMessage.mock.calls[1]?.[0]).toEqual(originalAttempt);
    await waitFor(() => expect(composer).toHaveValue(""));
  });
});
