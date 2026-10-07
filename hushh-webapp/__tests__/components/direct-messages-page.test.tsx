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
    user: {
      uid: "viewer-1",
      getIdToken: vi.fn().mockResolvedValue("test-token"),
    },
    conversation,
    getConversationWithPerson: vi.fn(),
    getConversationMessages: vi.fn(),
    markConversationRead: vi.fn(),
    openEvents: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    reactToMessage: vi.fn(),
    requestAgentConversationAfterRoute: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams("person=person-1"),
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
  OneChatBubble: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/direct-messages/direct-message-events", () => ({
  dispatchDirectMessagesUpdated: vi.fn(),
  subscribeToDirectMessagesUpdated: () => () => undefined,
}));

vi.mock("@/lib/agent/agent-voice-settings", () => ({
  requestAgentConversationAfterRoute: (...args: unknown[]) =>
    mocks.requestAgentConversationAfterRoute(...args),
}));

vi.mock("@/lib/services/direct-messages-service", () => ({
  DIRECT_MESSAGE_MAX_LENGTH: 2_000,
  DirectMessagesService: {
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
    mocks.user.getIdToken.mockClear();
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
    vi.clearAllMocks();
  });

  it("uses the shared Chat dock while sending to the selected connection", async () => {
    renderConnectionThread();

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
    fireEvent.click(screen.getAllByRole("button", { name: "Use 😀" })[0]!);
    expect(composer).toHaveValue("😀");

    fireEvent.click(screen.getByRole("button", { name: "Talk to One" }));
    expect(mocks.requestAgentConversationAfterRoute).toHaveBeenCalledWith(
      ROUTES.HOME,
    );
    expect(mocks.router.push).toHaveBeenCalledWith(ROUTES.HOME);
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

    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
    expect(screen.getByText("Replying to yourself")).toBeVisible();
  });
});
