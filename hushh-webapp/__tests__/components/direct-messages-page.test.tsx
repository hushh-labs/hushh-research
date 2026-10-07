import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentDockProvider,
  AgentDockVoiceBoundary,
} from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { DirectMessagesPage } from "@/components/direct-messages/direct-messages-page";
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
    router: { push: vi.fn(), replace: vi.fn() },
    query: "person=person-1",
    user: {
      uid: "viewer-1",
      getIdToken: vi.fn().mockResolvedValue("test-token"),
    },
    conversation,
    listConversations: vi.fn(),
    getConversationWithPerson: vi.fn(),
    getConversationMessages: vi.fn(),
    markConversationRead: vi.fn(),
    openEvents: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    reactToMessage: vi.fn(),
    morphyToast: { error: vi.fn(), info: vi.fn(), promise: vi.fn() },
    requestAgentConversationAfterRoute: vi.fn(),
  };
});

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

vi.mock("@/lib/services/direct-messages-service", () => ({
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
  },
}));

function renderConnectionThread() {
  return render(
    <AgentDockProvider>
      <AgentDockVoiceBoundary>
        <AgentBarSurface data-testid="shared-chat-dock">
          <span>Talk to One</span>
        </AgentBarSurface>
      </AgentDockVoiceBoundary>
      <DirectMessagesPage />
    </AgentDockProvider>,
  );
}

describe("DirectMessagesPage", () => {
  beforeEach(() => {
    mocks.router.push.mockReset();
    mocks.router.replace.mockReset();
    mocks.query = "person=person-1";
    mocks.user.getIdToken.mockClear();
    mocks.listConversations.mockResolvedValue({
      items: [mocks.conversation],
      unreadCount: 0,
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
      reactions: [{ emoji: "😀", count: 1, reactedByViewer: true }],
    });
    });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses the shared Chat dock while sending to the selected connection", async () => {
    renderConnectionThread();

    expect(await screen.findByRole("button", { name: /Ankit Kumar Singh/ })).toBeVisible();
    const composer = await screen.findByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    expect(screen.getByTestId("shared-chat-dock")).toHaveAttribute(
      "data-agent-dock-surface",
      "text",
    );
    expect(screen.getByText("Talk to One")).not.toBeVisible();

    fireEvent.change(composer, { target: { value: "Hello Ankit" } });
    fireEvent.submit(composer.closest("form")!);

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        idToken: "test-token",
        content: "Hello Ankit",
        recipientPersonRef: "person-1",
      }),
    );
  });

  it("keeps the inbox available and opens a selected chat from its row", async () => {
    mocks.query = "";
    renderConnectionThread();

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeVisible();
    expect(screen.getByLabelText("Search conversations")).toBeVisible();
    expect(screen.getByText("Select a conversation to see the chat here.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /Message/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ankit Kumar Singh/ }));
    expect(mocks.router.replace).toHaveBeenCalledWith(
      "/one/messages?conversation=conversation-1",
      { scroll: false },
    );
  });

  it("offers the full emoji picker and opens One chat for voice", async () => {
    renderConnectionThread();

    const composer = await screen.findByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    expect(
      screen.queryByLabelText("Video calls are not available in Messages yet"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose emoji" }));
    expect(screen.getByLabelText("Emoji picker")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(8);
    expect(
      screen.getByRole("tab", { name: "Animals and nature" }),
    ).toBeInTheDocument();
    const emojiSearch = screen.getByPlaceholderText("Search emoji");
    fireEvent.change(emojiSearch, { target: { value: "cat" } });
    expect(screen.getByRole("button", { name: "Use 🐱" })).toBeVisible();
    fireEvent.change(emojiSearch, { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Use 😀" })[0]!);
    expect(composer).toHaveValue("😀");

    fireEvent.click(screen.getByRole("button", { name: "Talk to One" }));
    expect(mocks.requestAgentConversationAfterRoute).toHaveBeenCalledWith(
      ROUTES.HOME,
    );
    expect(mocks.router.push).toHaveBeenCalledWith(ROUTES.HOME);
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

  it("reveals bubble timestamps only after a left swipe", async () => {
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
    const messageList = screen.getByTestId("direct-message-list");
    expect(messageList).not.toHaveAttribute("data-show-message-times");
    fireEvent.touchStart(article, {
      changedTouches: [{ clientX: 220, clientY: 100 }],
    });
    fireEvent.touchEnd(article, {
      changedTouches: [{ clientX: 140, clientY: 104 }],
    });
    expect(messageList).toHaveAttribute("data-show-message-times", "true");
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

    fireEvent.click(screen.getByRole("button", { name: "Choose a reaction" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Use 😀" })[0]!);
    await waitFor(() =>
      expect(mocks.reactToMessage).toHaveBeenCalledWith({
        idToken: "test-token",
        conversationId: "conversation-1",
        messageId: "message-1",
        emoji: "😀",
      }),
    );
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
  });
});
