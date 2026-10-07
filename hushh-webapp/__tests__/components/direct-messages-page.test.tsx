import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  AgentDockProvider,
  AgentDockVoiceBoundary,
} from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { DirectMessagesPage } from "@/components/direct-messages/direct-messages-page";
import { ROUTES } from "@/lib/navigation/routes";
import type { ComponentProps } from "react";
import type { AppPageShell } from "@/components/app-ui/app-page-shell";

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
    search: "person=person-1",
    signedIn: true,
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
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.signedIn ? mocks.user : null, loading: false }),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children, nativeTest }: ComponentProps<typeof AppPageShell>) => (
    <div data-testid="route-readiness" data-state={nativeTest?.dataState}
      data-error-code={nativeTest?.errorCode}>{children}</div>
  ),
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

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: mocks.morphyToast,
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

function connectionThread() {
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
  return render(connectionThread());
}

describe("DirectMessagesPage", () => {
  beforeEach(() => {
    for (const item of toast.getToasts()) toast.dismiss(item.id);
    mocks.user = { ...mocks.user, uid: "viewer-1" };
    mocks.search = "person=person-1";
    mocks.signedIn = true;
    mocks.router.push.mockReset();
    mocks.router.replace.mockReset();
    mocks.user.getIdToken.mockReset().mockResolvedValue("test-token");
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
    vi.clearAllMocks();
  });

  it("uses the shared Chat dock while sending to the selected connection", async () => {
    const view = renderConnectionThread();

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
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalled());
    // Navigation may settle on a later frame. The server-accepted message
    // must remain visible on the source route too, not blink out meanwhile.
    expect(screen.getByText("Hello Ankit")).toBeVisible();
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockImplementationOnce(() => new Promise(() => undefined));
    view.rerender(connectionThread());
    expect(screen.getByText("Hello Ankit")).toBeVisible();
    expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "loading");
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

  it("does not admit an empty thread until its owner-bound read succeeds, or accept a failed read", async () => {
    let resolvePeer!: (value: unknown) => void;
    mocks.getConversationWithPerson.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePeer = resolve; }),
    );
    const view = renderConnectionThread();
    expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "loading");
    await waitFor(() => expect(resolvePeer).toBeDefined());
    await act(async () => resolvePeer({
      conversation: null, peerPersonRef: "person-1", peerDisplayName: "Connection",
      peerPhotoUrl: null, canSend: true, disconnectedNotice: null,
    }));
    await waitFor(() => expect(screen.getByTestId("route-readiness"))
      .toHaveAttribute("data-state", "empty-valid"));

    mocks.search = "person=person-2";
    mocks.getConversationWithPerson.mockRejectedValueOnce(new Error("synthetic provider failure"));
    view.rerender(connectionThread());
    expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "loading");
    await waitFor(() => expect(screen.getByTestId("route-readiness"))
      .toHaveAttribute("data-state", "error"));
    expect(screen.getByTestId("route-readiness"))
      .toHaveAttribute("data-error-code", "direct_messages_read");
  });

  it("does not continue a pending history read after its owner signs out", async () => {
    let resolveOldPeer!: (value: unknown) => void;
    mocks.getConversationWithPerson.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOldPeer = resolve; }),
    );
    const view = renderConnectionThread();
    await waitFor(() => expect(resolveOldPeer).toBeDefined());
    mocks.signedIn = false;
    view.rerender(connectionThread());
    await waitFor(() => expect(screen.getByTestId("route-readiness"))
      .toHaveAttribute("data-state", "unavailable-valid"));
    await act(async () => resolveOldPeer({
      conversation: mocks.conversation, peerPersonRef: "old-owner-person",
      peerDisplayName: "Old owner connection", peerPhotoUrl: null, canSend: true,
      disconnectedNotice: null,
    }));
    expect(screen.queryByText("Old owner connection")).not.toBeInTheDocument();
    expect(mocks.getConversationMessages).not.toHaveBeenCalled();
  });

  it("does not re-admit the previous owner's messages when the new owner's same-route read fails", async () => {
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation,
      items: [{ id: "old-message", conversationId: "conversation-1", senderIsViewer: false,
        content: "Previous owner's private message", createdAt: "2026-10-06T10:01:00.000Z", readAt: null }],
      canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    const view = renderConnectionThread();
    expect(await screen.findByText("Previous owner's private message")).toBeVisible();

    mocks.user = { ...mocks.user, uid: "viewer-2" };
    mocks.getConversationMessages.mockRejectedValueOnce(new Error("synthetic read failure"));
    view.rerender(connectionThread());
    expect(screen.queryByText("Previous owner's private message")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error"));
    expect(screen.queryByText("Previous owner's private message")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message Ankit Kumar Singh" })).not.toBeInTheDocument();
  });

  it.each(["send", "pagination"] as const)("ignores a %s completion from an owner that no longer owns the screen", async (operation) => {
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [], canSend: true,
      disconnectedNotice: null, nextBefore: "earlier-page",
    });
    const view = renderConnectionThread();
    const composer = await screen.findByRole("textbox", { name: "Message Ankit Kumar Singh" });
    let finishOldOperation!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finishOldOperation = resolve; });
    if (operation === "send") {
      mocks.sendMessage.mockReturnValueOnce(pending);
      fireEvent.change(composer, { target: { value: "Old owner's draft" } });
      fireEvent.submit(composer.closest("form")!);
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
    } else {
      mocks.getConversationMessages.mockReturnValueOnce(pending);
      fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
      await waitFor(() => expect(mocks.getConversationMessages).toHaveBeenCalledTimes(2));
    }
    mocks.user = { ...mocks.user, uid: "viewer-2" };
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [], canSend: true,
      disconnectedNotice: null, nextBefore: null,
    });
    view.rerender(connectionThread());
    await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "empty-valid"));
    await act(async () => finishOldOperation({
      conversation: mocks.conversation,
      message: { id: "late-message", conversationId: "conversation-1", senderIsViewer: true,
        content: "Old owner's private result", createdAt: "2026-10-06T10:01:00.000Z", readAt: null },
      items: [{ id: "late-message", conversationId: "conversation-1", senderIsViewer: false,
        content: "Old owner's private result", createdAt: "2026-10-06T10:01:00.000Z", readAt: null }],
      canSend: true, disconnectedNotice: null, nextBefore: null,
    }));
    expect(screen.queryByText("Old owner's private result")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toHaveValue("");
    expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "empty-valid");
    expect(mocks.router.replace).not.toHaveBeenCalled();
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

  it.each((["edit", "reaction", "delete"] as const).flatMap((action) =>
    (["result", "failure", "authorization"] as const).map((outcome) => ({ action, outcome })),
  ))("retires an old owner's $action selection and $outcome", async ({ action, outcome }) => {
    mocks.search = "conversation=conversation-1";
    const message = { id: "message-1", conversationId: "conversation-1", senderIsViewer: true,
      content: "Synthetic owner A message", createdAt: "2026-10-06T10:01:00.000Z", readAt: null };
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [message], canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    const view = renderConnectionThread();
    fireEvent.click(await screen.findByText(message.content));
    let finish!: (value: unknown) => void;
    let fail!: (reason: Error) => void;
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const operation = action === "edit" ? mocks.editMessage : action === "reaction" ? mocks.reactToMessage : mocks.deleteMessage;
    const tokenReads = mocks.user.getIdToken.mock.calls.length;
    if (outcome === "authorization") mocks.user.getIdToken.mockReturnValueOnce(pending);
    else operation.mockReturnValueOnce(pending);
    if (action === "reaction") {
      fireEvent.click(screen.getByRole("button", { name: "Choose a reaction" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Use 😀" })[0]!);
    } else {
      fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitem", { name: action === "edit" ? "Edit" : "Delete for me" }));
      if (action === "edit") {
        fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), { target: { value: "Synthetic A edit" } });
        fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
      } else fireEvent.click(screen.getByRole("button", { name: "Delete message", exact: true }));
    }
    await waitFor(() => outcome === "authorization"
      ? expect(mocks.user.getIdToken.mock.calls.length).toBeGreaterThan(tokenReads)
      : expect(operation).toHaveBeenCalled());
    mocks.user = { ...mocks.user, uid: "viewer-2" };
    // The same identifier makes stale replacement/deletion observable.
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [{ ...message, senderIsViewer: false, content: "Synthetic owner B message" }],
      canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    view.rerender(connectionThread());
    expect(await screen.findByText("Synthetic owner B message")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => {
      if (outcome === "failure") fail(new Error("Synthetic retired action"));
      else if (outcome === "authorization") finish("retired-owner-token");
      else finish(action === "delete" ? { scope: "me", message: null } : { ...message, content: "Synthetic stale A result" });
    });
    if (outcome === "authorization") expect(operation).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn’t (update this message|add that reaction|delete this message)/)).not.toBeInTheDocument();
    expect(screen.getByText("Synthetic owner B message")).toBeVisible();
    expect(screen.queryByText("Synthetic stale A result")).not.toBeInTheDocument();
    expect(toast.getToasts().map((item) => item.title)).not.toContain(
      action === "edit" ? "Message edited" : action === "reaction" ? "Reaction added" : "Message deleted for you",
    );
  });

  it.each(["owner", "route"] as const)("retires reply and deletion presentations when the %s changes", async (change) => {
    mocks.search = "conversation=conversation-1";
    const message = { id: "message-1", conversationId: "conversation-1", senderIsViewer: true,
      content: "Synthetic selected reply", createdAt: "2026-10-06T10:01:00.000Z", readAt: null };
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [message], canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    const view = renderConnectionThread();
    await screen.findByText(message.content);
    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
    const frames: FrameRequestCallback[] = [];
    const scheduleFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
      expect(screen.getByText("Replying to yourself")).toBeVisible();
      // Force the reported ordering: the reply frame runs before Radix's
      // deferred close focus. Focus must remain in the composer afterward.
      await act(async () => {
        for (const callback of frames.splice(0)) callback(performance.now());
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toHaveFocus());
    } finally {
      scheduleFrame.mockRestore();
    }
    const options = screen.getByRole("button", { name: "Message options" });
    fireEvent.keyDown(options, { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(options).toHaveFocus());
    fireEvent.keyDown(options, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete for me" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    if (change === "owner") mocks.user = { ...mocks.user, uid: "viewer-2" };
    else mocks.search = "conversation=conversation-2";
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: { ...mocks.conversation, id: change === "route" ? "conversation-2" : "conversation-1" },
      items: [], canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    view.rerender(connectionThread());
    await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "empty-valid"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Replying to yourself")).not.toBeInTheDocument();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });
});
