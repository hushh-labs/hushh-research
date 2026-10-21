import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  AgentDockProvider,
  AgentDockVoiceBoundary,
} from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { DirectMessagesPage as ProductionDirectMessagesPage } from "@/components/direct-messages/direct-messages-page";
import type { ComponentProps } from "react";
import type { AppPageShell } from "@/components/app-ui/app-page-shell";
import { DirectMessageVoiceRecorder } from "@/components/direct-messages/direct-message-voice-recorder";
import { DirectMessageVoicePlayer } from "@/components/direct-messages/direct-message-voice-player";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { CacheService } from "@/lib/services/cache-service";
import { DirectMessagesServiceRequestError } from "@/lib/services/direct-messages-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";

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
    user: {
      uid: "viewer-1",
      getIdToken: vi.fn().mockResolvedValue("test-token"),
    },
    conversation,
    search: "person=person-1",
    signedIn: true,
    listConversations: vi.fn(),
    listConnectionsPage: vi.fn(),
    getConversationWithPerson: vi.fn(),
    getConversationMessages: vi.fn(),
    getAttachment: vi.fn(),
    getViewerProfile: vi.fn(),
    markConversationRead: vi.fn(),
    acknowledgeDelivery: vi.fn(),
    captureStart: vi.fn(), captureFinish: vi.fn(), captureCancel: vi.fn(),
    captureInstances: [] as unknown[],
    openEvents: vi.fn(),
    liveMessageEvents: false,
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    deleteConversation: vi.fn(),
    reactToMessage: vi.fn(),
    removeReaction: vi.fn(),
    morphyToast: { error: vi.fn(), info: vi.fn(), promise: vi.fn() },
    requestAgentConversationAfterRoute: vi.fn(),
  };
});
vi.mock("@/lib/voice/command-capture", () => ({ CommandCapture: class {
  constructor() { mocks.captureInstances.push(this); }
  start(...args: unknown[]) { return mocks.captureStart(...args); }
  finish() { return mocks.captureFinish(); }
  cancel() { return mocks.captureCancel(); }
} }));

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
  OneChatBubble: ({ children, tone: _tone, ...props }: { children: React.ReactNode; tone?: string } & React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@/lib/direct-messages/direct-message-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/direct-messages/direct-message-events")>();
  return {
    dispatchDirectMessagesUpdated: (...args: Parameters<typeof actual.dispatchDirectMessagesUpdated>) => {
      if (mocks.liveMessageEvents) actual.dispatchDirectMessagesUpdated(...args);
    },
    subscribeToDirectMessagesUpdated: (...args: Parameters<typeof actual.subscribeToDirectMessagesUpdated>) =>
      mocks.liveMessageEvents ? actual.subscribeToDirectMessagesUpdated(...args) : () => undefined,
  };
});

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
    getAttachment: (...args: unknown[]) => mocks.getAttachment(...args),
    markConversationRead: (...args: unknown[]) =>
      mocks.markConversationRead(...args),
    acknowledgeDelivery: (...args: unknown[]) => mocks.acknowledgeDelivery(...args),
    openEvents: (...args: unknown[]) => mocks.openEvents(...args),
    sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
    editMessage: (...args: unknown[]) => mocks.editMessage(...args),
    deleteMessage: (...args: unknown[]) => mocks.deleteMessage(...args),
    deleteConversation: (...args: unknown[]) => mocks.deleteConversation(...args),
    reactToMessage: (...args: unknown[]) => mocks.reactToMessage(...args),
    removeReaction: (...args: unknown[]) => mocks.removeReaction(...args),
  },
}));

vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: { getViewer: (...args: unknown[]) => mocks.getViewerProfile(...args) },
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: { listConnectionsPage: (...args: unknown[]) => mocks.listConnectionsPage(...args) },
}));

const messageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validVoiceWav() {
  const bytes = new Uint8Array(32044), view = new DataView(bytes.buffer);
  for (const [offset, tag] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) bytes.set(new TextEncoder().encode(tag), offset);
  view.setUint32(4, 32036, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 32000, true);
  return bytes;
}
const visibleMessage = {
  id: "visible-message", conversationId: "conversation-1", senderIsViewer: false,
  content: "Visible unread message", createdAt: "2026-10-06T10:01:00.000Z", readAt: null,
};

function exposeLatestMessage() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.dataset.testid === "direct-message-list") return new DOMRect(0, 0, 320, 400);
    if (this.parentElement?.dataset.testid === "direct-message-list" && this === this.parentElement.lastElementChild) return new DOMRect(0, 399, 320, 1);
    return measure.call(this);
  });
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

function connectionThread() { return <ConnectionThread />; }

function DirectMessagesPage() {
  const params = new URLSearchParams(mocks.search);
  const conversation = params.get("conversation");
  const person = params.get("person");
  return <ProductionDirectMessagesPage selection={conversation ? { kind: "conversation", ref: conversation } : person ? { kind: "person", ref: person } : null} />;
}

describe("DirectMessagesPage", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    for (const item of toast.getToasts()) toast.dismiss(item.id);
    mocks.user = { uid: "viewer-1", getIdToken: vi.fn().mockResolvedValue("test-token") };
    mocks.search = "person=person-1";
    mocks.signedIn = true;
    mocks.commandActive = false;
    mocks.commandPhase = "idle";
    mocks.voiceActive = false;
    mocks.router.push.mockReset();
    mocks.router.replace.mockReset();
    mocks.liveMessageEvents = false;
    mocks.user.getIdToken.mockClear();
    mocks.getViewerProfile.mockReset().mockResolvedValue({ personRef: "person-1", relationship: { status: "connected" }, contactEmail: null, contactPhoneNumber: null });
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
    mocks.acknowledgeDelivery.mockReset().mockResolvedValue(undefined);
    mocks.getAttachment.mockReset().mockResolvedValue(new Blob(["synthetic document"]));
    mocks.captureStart.mockReset().mockResolvedValue(undefined);
    mocks.captureCancel.mockReset().mockResolvedValue(undefined);
    mocks.captureFinish.mockReset(); mocks.captureInstances.length = 0;
    appInteractionCoordinator.handleLifecycle("active");
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
    mocks.deleteConversation.mockReset().mockResolvedValue({ conversationId: "conversation-1", deleted: true, scope: "me" });
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

  function arrangePhoto() {
    const decode = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = 400;
      naturalHeight = 300;
      decode = decode;
    });
    const observers = new Map<Element, IntersectionObserverCallback>();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { observers.set(target, this.callback); }
      unobserve(target: Element) { observers.delete(target); }
      disconnect() {}
    });
    const create = vi.fn(() => "blob:fixture-photo"), revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation,
      items: [{ ...visibleMessage, attachment: { kind: "photo", name: "Photo", mimeType: "image/png", size: 24 } }],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    const enterViewport = () => {
      const target = [...observers.keys()].find(node => node.querySelector('button[aria-label="Load photo"]'))!;
      act(() => observers.get(target)!([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    };
    return { create, revoke, enterViewport, decode };
  }

  it("confirms whole-chat deletion and removes it only after acknowledgment", async () => {
    const invalidateFeed = vi.spyOn(CacheSyncService, "onFeedHistoryMutated");
    let finish!: () => void;
    mocks.deleteConversation.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    renderConnectionThread();
    const group = await screen.findByRole("group", { name: "Ankit Kumar Singh chat" });
    fireEvent.keyDown(within(group).getByRole("button", { name: "Chat options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("The other person keeps their copy");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete chat", exact: true }));
    await waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledTimes(1));
    expect(group).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("group", { name: "Ankit Kumar Singh chat" })).not.toBeInTheDocument());
    expect(mocks.router.replace).toHaveBeenCalledWith("/one/messages", { scroll: false });
    expect(mocks.deleteConversation).toHaveBeenCalledWith({ idToken: "test-token", conversationId: "conversation-1" });
    expect(invalidateFeed).toHaveBeenCalledWith("viewer-1");
  });

  it("keeps the whole chat on cancellation or failed deletion and permits retry", async () => {
    renderConnectionThread();
    const group = await screen.findByRole("group", { name: "Ankit Kumar Singh chat" });
    const openDelete = async () => {
      fireEvent.keyDown(within(group).getByRole("button", { name: "Chat options" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    };
    await openDelete();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
    await openDelete();
    mocks.deleteConversation.mockRejectedValueOnce(new Error("Synthetic failure"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat", exact: true }));
    await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat", exact: true })).toBeEnabled());
    expect(group).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat", exact: true }));
    await waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Ankit Kumar Singh chat" })).not.toBeInTheDocument());
  });

  it("does not close another selected conversation when an older chat deletion completes", async () => {
    let finish!: () => void;
    mocks.deleteConversation.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const other = { ...mocks.conversation, id: "conversation-2", peerPersonRef: "person-2", peerDisplayName: "Divya" };
    mocks.listConversations.mockResolvedValue({ items: [mocks.conversation, other], unreadCount: 0 });
    const view = renderConnectionThread();
    const group = await screen.findByRole("group", { name: "Ankit Kumar Singh chat" });
    fireEvent.keyDown(within(group).getByRole("button", { name: "Chat options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat", exact: true }));
    await waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledTimes(1));
    mocks.search = "conversation=conversation-2";
    mocks.getConversationMessages.mockResolvedValueOnce({ conversation: other, items: [], canSend: true, disconnectedNotice: null, nextBefore: null });
    view.rerender(connectionThread());
    expect(await screen.findByRole("textbox", { name: "Message Divya" })).toBeEnabled();
    const otherGroup = await screen.findByRole("group", { name: "Divya chat" });
    fireEvent.keyDown(within(otherGroup).getByRole("button", { name: "Chat options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete chat with Divya?");
    mocks.router.replace.mockClear();
    await act(async () => finish());
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete chat with Divya?");
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat", exact: true })).toBeEnabled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Message Divya" })).toBeEnabled();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("retires a pending chat deletion when its account changes", async () => {
    let finish!: () => void;
    mocks.deleteConversation.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const view = renderConnectionThread();
    const group = await screen.findByRole("group", { name: "Ankit Kumar Singh chat" });
    fireEvent.keyDown(within(group).getByRole("button", { name: "Chat options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete chat" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat", exact: true }));
    await waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledTimes(1));
    mocks.user = { ...mocks.user, uid: "viewer-2" };
    view.rerender(connectionThread());
    expect(await screen.findByRole("group", { name: "Ankit Kumar Singh chat" })).toBeInTheDocument();
    mocks.user = { ...mocks.user, uid: "viewer-1" };
    view.rerender(connectionThread());
    expect(await screen.findByRole("group", { name: "Ankit Kumar Singh chat" })).toBeInTheDocument();
    mocks.router.replace.mockClear();
    await act(async () => finish());
    expect(screen.getByRole("group", { name: "Ankit Kumar Singh chat" })).toBeInTheDocument();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("repairs missed messages immediately on a stream resync", async () => {
    mocks.liveMessageEvents = true;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    mocks.openEvents.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
    const view = renderConnectionThread();
    try {
      await screen.findByText("Start the conversation with Ankit Kumar Singh.");
      const received = { ...visibleMessage, id: "recovered-message", senderIsViewer: false, content: "Recovered without waiting for polling" };
      mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [received], canSend: true, disconnectedNotice: null, nextBefore: null });
      await act(async () => { stream.enqueue(new TextEncoder().encode("event: resync\ndata: {}\n\n")); });
      expect(await screen.findByText(received.content)).toBeVisible();
    } finally {
      view.unmount();
      stream.close();
    }
  });

  it("does not render an empty conversation before the selected person's history resolves", () => {
    mocks.getConversationWithPerson.mockReturnValueOnce(new Promise(() => {}));
    renderConnectionThread();
    expect(screen.queryByText(/Start the conversation with/)).not.toBeInTheDocument();
    expect(screen.queryByText("Messaging unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    expect(screen.getByTestId("direct-message-list")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("link", { name: /View .*profile/ })).not.toBeInTheDocument();
  });

  it.each([true, false])("links the name and peer avatars to the existing profile when canSend is %s", async (canSend) => {
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation,
      items: [visibleMessage], canSend,
      disconnectedNotice: canSend ? null : "Connection ended", nextBefore: null,
    });
    renderConnectionThread();
    expect(await screen.findByText(visibleMessage.content)).toBeVisible();
    const profileLinks = () => screen.getAllByRole("link", { name: "View Ankit Kumar Singh's profile" });
    expect(profileLinks()).toHaveLength(2);
    await openContactInfo();
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "View Ankit Kumar Singh's profile" }))
      .toHaveAttribute("href", "/people/person-1?from=%2Fone%2Fmessages");
    for (const link of document.querySelectorAll('a[aria-label="View Ankit Kumar Singh\'s profile"]')) {
      expect(link).toHaveAttribute("href", "/people/person-1?from=%2Fone%2Fmessages");
    }
  });

  it("keeps avatars noninteractive when no public person reference is available", async () => {
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: { ...mocks.conversation, peerPersonRef: null },
      items: [visibleMessage], canSend: false,
      disconnectedNotice: "Messaging unavailable", nextBefore: null,
    });
    renderConnectionThread();
    expect(await screen.findByText(visibleMessage.content)).toBeVisible();
    expect(screen.queryByRole("link", { name: /View .*profile/ })).not.toBeInTheDocument();
  });

  it("opens a new connected person's chat with their identity before the first message", async () => {
    mocks.getConversationWithPerson.mockResolvedValue({
      conversation: null,
      peerPersonRef: "person-1",
      peerDisplayName: "Ankit Kumar Singh",
      peerPhotoUrl: "https://example.com/ankit.jpg",
      canSend: true,
      disconnectedNotice: null,
    });
    renderConnectionThread();

    expect(await screen.findByRole("heading", { name: "Ankit Kumar Singh", exact: true })).toBeVisible();
    expect(screen.getByText("Connected", { exact: true })).toBeVisible();
    expect(screen.getByText("Start the conversation with Ankit Kumar Singh.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh", exact: true })).toBeEnabled();
    expect(mocks.getConversationWithPerson).toHaveBeenCalledWith({ idToken: "test-token", personRef: "person-1" });
    expect(mocks.getConversationMessages).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Conversation", exact: true })).not.toBeInTheDocument();
  });

  it("opens the selected connected person's existing history using its conversation ID", async () => {
    mocks.getConversationMessages.mockResolvedValue({
      conversation: mocks.conversation,
      items: [visibleMessage],
      canSend: true,
      disconnectedNotice: null,
      nextBefore: null,
    });
    renderConnectionThread();

    expect(await screen.findByText(visibleMessage.content)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ankit Kumar Singh", exact: true })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh", exact: true })).toBeEnabled();
    expect(mocks.getConversationWithPerson).toHaveBeenCalledWith({ idToken: "test-token", personRef: "person-1" });
    expect(mocks.getConversationMessages).toHaveBeenCalledWith({ idToken: "test-token", conversationId: "conversation-1", limit: 60 });
    expect(screen.queryByText(/Start the conversation with/)).not.toBeInTheDocument();
  });

  it("restores a visited thread immediately while checking permission again", async () => {
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    const view = renderConnectionThread();
    await screen.findByText(visibleMessage.content);
    mocks.search = "conversation=another-thread";
    mocks.getConversationMessages.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ConnectionThread />);
    expect(screen.queryByText(visibleMessage.content)).not.toBeInTheDocument();
    mocks.search = "person=person-1";
    mocks.getConversationWithPerson.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ConnectionThread />);
    expect(screen.getByText(visibleMessage.content)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toBeDisabled();
    expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument();
    expect(screen.queryByText("You are no longer connected.")).not.toBeInTheDocument();
  });

  it("primes the selected person's header from the inbox before history arrives", async () => {
    mocks.getConversationWithPerson.mockImplementation(() => new Promise(() => {}));
    renderConnectionThread();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toBeDisabled());
    expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument();
  });

  it("keeps a cached transcript on transport failure and offers retry", async () => {
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    const view = renderConnectionThread();
    await screen.findByText(visibleMessage.content);
    view.unmount();
    mocks.getConversationWithPerson.mockRejectedValue(new TypeError("Offline"));
    renderConnectionThread();
    expect(screen.getByText(visibleMessage.content)).toBeInTheDocument();
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText(visibleMessage.content)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toBeDisabled();
  });

  it.each([401, 403, 404])("clears cached history after an authoritative %s response", async (status) => {
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    const view = renderConnectionThread();
    await screen.findByText(visibleMessage.content);
    view.unmount();
    mocks.getConversationWithPerson.mockRejectedValue(new DirectMessagesServiceRequestError(status, "Unavailable"));
    renderConnectionThread();
    await screen.findByText("This conversation is not available right now.");
    expect(screen.queryByText(visibleMessage.content)).not.toBeInTheDocument();
  });

  it("does not restore a denied transcript from an earlier pagination response", async () => {
    const history = { conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: "older-cursor" };
    let finishOlder!: (value: unknown) => void;
    mocks.getConversationMessages.mockResolvedValueOnce(history)
      .mockReturnValueOnce(new Promise(resolve => { finishOlder = resolve; }))
      .mockRejectedValueOnce(new DirectMessagesServiceRequestError(403, "Unavailable"));
    renderConnectionThread();
    fireEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(mocks.getConversationMessages).toHaveBeenCalledTimes(2));
    fireEvent(window, new Event("focus"));
    await screen.findByText("This conversation is not available right now.");
    await act(async () => finishOlder(history));
    expect(screen.queryByText(visibleMessage.content)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
  });

  it("never restores another account's cached transcript", async () => {
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    const view = renderConnectionThread();
    await screen.findByText(visibleMessage.content);
    mocks.user.uid = "viewer-2";
    mocks.getConversationWithPerson.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ConnectionThread />);
    expect(screen.queryByText(visibleMessage.content)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message Ankit Kumar Singh" })).not.toBeInTheDocument();
  });

  it("does not cache an optimistic reaction when navigation interrupts its rollback", async () => {
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [{ ...visibleMessage, reactions: [] }],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    let reject!: (error: Error) => void;
    mocks.reactToMessage.mockImplementation(() => new Promise((_, failure) => { reject = failure; }));
    const view = renderConnectionThread();
    fireEvent.click(await screen.findByText(visibleMessage.content));
    fireEvent.click(screen.getByRole("button", { name: "React to message" }));
    fireEvent.change(await screen.findByPlaceholderText("Search emoji"), { target: { value: "heart" } });
    fireEvent.click(screen.getByRole("button", { name: "Use ❤️" }));
    await waitFor(() => expect(mocks.reactToMessage).toHaveBeenCalled());
    mocks.search = "conversation=another-thread";
    mocks.getConversationMessages.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ConnectionThread />);
    await act(async () => reject(new Error("Offline")));
    mocks.search = "person=person-1";
    mocks.getConversationWithPerson.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ConnectionThread />);
    expect(screen.getByText(visibleMessage.content)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "❤️ reaction, 1" })).not.toBeInTheDocument();
  });

  it("starts cached photo loading only after fresh read admission succeeds", async () => {
    arrangePhoto();
    const view = renderConnectionThread();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toBeEnabled());
    const history = await mocks.getConversationMessages.mock.results[0]!.value;
    view.unmount();
    const photo = arrangePhoto();
    let finish!: (value: unknown) => void;
    mocks.getConversationMessages.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mocks.getAttachment.mockResolvedValue(new Blob(["synthetic-photo"], { type: "image/png" }));
    renderConnectionThread();
    await screen.findByRole("button", { name: "Load photo" });
    photo.enterViewport();
    expect(mocks.getAttachment).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.getConversationMessages).toHaveBeenCalledTimes(2));
    await act(async () => finish(history));
    expect(await screen.findByRole("img", { name: "Photo" })).toBeVisible();
    expect(mocks.getAttachment).toHaveBeenCalledOnce();
  });

  it("downloads an inline photo only near the viewport and releases its preview on unmount", async () => {
    const photo = arrangePhoto();
    mocks.getAttachment.mockResolvedValue(new Blob(["synthetic-photo"], { type: "image/png" }));
    const view = renderConnectionThread();
    await screen.findByRole("button", { name: "Load photo" });
    expect(mocks.getAttachment).not.toHaveBeenCalled();
    photo.enterViewport();
    expect(await screen.findByRole("img", { name: "Photo" })).toHaveAttribute("src", "blob:fixture-photo");
    expect(mocks.getAttachment).toHaveBeenCalledOnce();
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open photo", exact: true }));
    expect(await screen.findByRole("img", { name: "Shared photo" })).toBeVisible();
    act(() => { expect(unwindBackLayer("/one/messages")).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open photo", exact: true })).toBeVisible();
    view.unmount();
    expect(photo.revoke).toHaveBeenCalledWith("blob:fixture-photo");
  });

  it.each(["download", "decode"])("keeps Open available after an automatic photo %s failure and retries explicitly", async (failure) => {
    const photo = arrangePhoto();
    mocks.getAttachment.mockResolvedValue(new Blob(["synthetic-photo"], { type: "image/png" }));
    if (failure === "download") mocks.getAttachment.mockRejectedValueOnce(new Error("Temporary download failure"));
    else photo.decode.mockRejectedValueOnce(new Error("Temporary decode failure"));
    const view = renderConnectionThread();
    await screen.findByRole("button", { name: "Load photo" });
    photo.enterViewport();
    const open = screen.getByRole("button", { name: /Loading photo|Load photo/ });
    await waitFor(() => expect(mocks.getAttachment).toHaveBeenCalledOnce());
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(await screen.findByRole("img", { name: "Photo" })).toHaveAttribute("src", "blob:fixture-photo");
    expect(mocks.getAttachment).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it.each(["automatic", "retry"])("releases a decoding photo immediately when its conversation unmounts (%s)", async (mode) => {
    const photo = arrangePhoto();
    let finish!: () => void;
    photo.decode.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    mocks.getAttachment.mockResolvedValue(new Blob(["synthetic-photo"], { type: "image/png" }));
    if (mode === "retry") mocks.getAttachment.mockRejectedValueOnce(new Error("Temporary download failure"));
    const view = renderConnectionThread();
    await screen.findByRole("button", { name: "Load photo" });
    photo.enterViewport();
    if (mode === "retry") {
      const retry = await screen.findByRole("button", { name: "Load photo" });
      await waitFor(() => expect(retry).toBeEnabled());
      fireEvent.click(retry);
    }
    await waitFor(() => expect(photo.decode).toHaveBeenCalledOnce());
    expect(screen.queryByRole("img", { name: "Photo" })).not.toBeInTheDocument();
    view.unmount();
    expect(photo.revoke).toHaveBeenCalledWith("blob:fixture-photo");
    await act(async () => finish());
    expect(screen.queryByRole("img", { name: "Photo" })).not.toBeInTheDocument();
  });

  it("discards a pending inline photo when its conversation unmounts", async () => {
    const photo = arrangePhoto();
    let finish!: (value: Blob) => void;
    mocks.getAttachment.mockImplementation(() => new Promise<Blob>(resolve => { finish = resolve; }));
    const view = renderConnectionThread();
    await screen.findByRole("button", { name: "Load photo" });
    photo.enterViewport();
    await waitFor(() => expect(mocks.getAttachment).toHaveBeenCalledOnce());
    const input = mocks.getAttachment.mock.calls[0]![0];
    view.unmount();
    expect(input.isEffectCurrent()).toBe(false);
    await act(async () => { finish(new Blob(["synthetic-photo"])); });
    expect(photo.create).not.toHaveBeenCalled();
  });

  it("previews selected photos instead of filenames and releases their local URLs", async () => {
    const create = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second"), revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const view = renderConnectionThread();
    await screen.findByRole("textbox", { name: "Message Ankit Kumar Singh" });
    const input = document.querySelector('input[accept="image/jpeg,image/png,image/webp"]')!;
    fireEvent.change(input, { target: { files: [new File(["photo"], "private-photo.png", { type: "image/png" })] } });
    expect(await screen.findByRole("img", { name: "Photo ready to send" })).toHaveAttribute("src", "blob:first");
    expect(screen.queryByText(/private-photo.png/)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { files: [new File(["second"], "second.png", { type: "image/png" })] } });
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:first"));
    expect(screen.getByRole("img", { name: "Photo ready to send" })).toHaveAttribute("src", "blob:second");
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:second"));
    expect(screen.queryByRole("img", { name: "Photo ready to send" })).not.toBeInTheDocument();
    view.unmount();
  });

  it("sends a finished voice note immediately and freezes an uncertain empty-content retry", async () => {
    mocks.captureFinish.mockResolvedValue({ audioBase64: btoa(String.fromCharCode(...validVoiceWav())), mimeType: "audio/wav" });
    mocks.sendMessage.mockRejectedValueOnce(new Error("Response lost"));
    renderConnectionThread();
    fireEvent.click(await screen.findByRole("button", { name: "Record voice message" }));
    const send = await screen.findByRole("button", { name: "Send voice message" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());
    const original = mocks.sendMessage.mock.calls[0]![0];
    expect(original.content).toBe("");
    expect(original.attachment).toMatchObject({ type: "audio/wav", size: 32044 });
    const retry = await screen.findByRole("button", { name: "Retry", exact: true });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.getByRole("button", { name: "Remove attachment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toHaveAttribute("readonly");
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocks.sendMessage.mock.calls[1]![0]).toEqual(original);
    expect(mocks.sendMessage.mock.calls[1]![0].attachment).toBe(original.attachment);
  });

  async function openContactInfo() {
    const options = await screen.findByRole("button", { name: "Conversation options", exact: true });
    await waitFor(() => expect(options).toBeEnabled());
    fireEvent.keyDown(options, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Contact info", exact: true }));
  }

  it("opens authorized contact details from the conversation menu and retires them on connection changes", async () => {
    mocks.getViewerProfile.mockResolvedValue({ personRef: "person-1", relationship: { status: "connected" },
      contactEmail: "ankit@example.com", contactPhoneNumber: "+15551234567" });
    renderConnectionThread();
    const identity = await screen.findByRole("link", { name: "View Ankit Kumar Singh's profile", exact: true });
    expect(identity).toHaveTextContent("Ankit Kumar Singh");
    await openContactInfo();
    expect(await screen.findByRole("link", { name: "ankit@example.com" })).toHaveAttribute("href", "mailto:ankit@example.com");
    expect(screen.getByRole("link", { name: "+15551234567" })).toHaveAttribute("href", "tel:+15551234567");
    expect(mocks.getViewerProfile).toHaveBeenCalledWith("person-1", "test-token");
    mocks.getViewerProfile.mockResolvedValue({ personRef: "person-1", relationship: { status: "none" },
      contactEmail: "must-not-project@example.com", contactPhoneNumber: "+15551234567" });
    act(() => window.dispatchEvent(new CustomEvent("hushh:connection-graph-changed", { detail: { userId: "viewer-1", changedAt: Date.now() } })));
    await waitFor(() => expect(mocks.getViewerProfile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByText(/Loading contact details/)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("link", { name: "ankit@example.com" })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "must-not-project@example.com" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "+15551234567" })).not.toBeInTheDocument();
  });

  it("does not request contact details for a read-only thread or project a late result after closing", async () => {
    let finish!: (value: unknown) => void;
    mocks.getViewerProfile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderConnectionThread();
    await openContactInfo();
    await waitFor(() => expect(mocks.getViewerProfile).toHaveBeenCalledOnce());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await act(async () => finish({ personRef: "person-1", relationship: { status: "connected" }, contactEmail: "late@example.com" }));
    expect(screen.queryByText("late@example.com")).not.toBeInTheDocument();
    view.unmount();
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [visibleMessage], canSend: false, disconnectedNotice: "Blocked", nextBefore: null });
    renderConnectionThread();
    await openContactInfo();
    expect(await screen.findByRole("dialog")).toHaveTextContent("Blocked");
    expect(mocks.getViewerProfile).toHaveBeenCalledOnce();
  });

  it("acknowledges received inbox bodies, without treating sender messages or push hints as delivery", async () => {
    mocks.search = "";
    mocks.listConversations.mockResolvedValue({ items: [{ ...mocks.conversation, latestMessage: visibleMessage }], unreadCount: 1 });
    render(<DirectMessagesPage />);
    await waitFor(() => expect(mocks.acknowledgeDelivery).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation-1", messageIds: ["visible-message"], isEffectCurrent: expect.any(Function) })));
  });

  it("reuses a permission-granted capture on retry and discards a late finished recording after backgrounding", async () => {
    mocks.captureStart.mockRejectedValueOnce(new Error("Microphone permission updated. Tap Talk to One to record."));
    const onRecorded = vi.fn(), onRecordingChange = vi.fn();
    render(<DirectMessageVoiceRecorder disabled={false} onRecorded={onRecorded} onRecordingChange={onRecordingChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(mocks.morphyToast.error).toHaveBeenCalledWith("Microphone enabled. Tap the mic again to record."));
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send voice message" })).toBeEnabled());
    expect(mocks.captureInstances).toHaveLength(1);
    let finish!: (value: unknown) => void;
    mocks.captureFinish.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    act(() => appInteractionCoordinator.handleLifecycle("background"));
    await act(async () => { finish({ audioBase64: "invalid-stale-bytes" }); });
    expect(onRecorded).not.toHaveBeenCalled();
    expect(mocks.captureCancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled();
  });

  it("never lets a pending voice download supersede a newer recording", async () => {
    let loaded!: (blob: Blob) => void;
    const loadAudio = vi.fn(() => new Promise<Blob>(resolve => { loaded = resolve; }));
    const createObjectURL = vi.fn(); vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; });
    render(<DirectMessageVoicePlayer durationMs={1000} loadAudio={loadAudio} />);
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    const recording = appInteractionCoordinator.acquireVoiceLease({ owner: "new-recording", onRevoked: vi.fn() });
    await act(async () => { loaded({ arrayBuffer: async () => validVoiceWav().buffer } as Blob); });
    expect(recording.isCurrent()).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
    recording.release();
  });

  it("validates a bounded WAV before handing it to the send owner and releases the microphone", async () => {
    mocks.captureFinish.mockResolvedValue({ audioBase64: btoa(String.fromCharCode(...validVoiceWav())), mimeType: "audio/wav" });
    const onRecorded = vi.fn(), onRecordingChange = vi.fn();
    render(<DirectMessageVoiceRecorder disabled={false} onRecorded={onRecorded} onRecordingChange={onRecordingChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send voice message" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
    expect(onRecorded.mock.calls[0]![0]).toMatchObject({ name: "Voice message.wav", type: "audio/wav", size: 32044 });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(onRecordingChange).toHaveBeenLastCalledWith(false);
    expect(mocks.captureCancel).toHaveBeenCalled();
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
    expect(await screen.findByText("Hello Ankit")).toBeVisible();
    // Accepted sends remain on the authenticated selection; no raw ID route.
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("keeps the inbox available and opens a selected chat from its row", async () => {
    mocks.search = "";
    renderConnectionThread();
    expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "loading");

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
    mocks.search = "";
    renderConnectionThread();
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    const picker = await screen.findByRole("dialog", { name: "New chat" });
    expect(picker).toHaveAttribute("aria-modal", "true");
    expect(mocks.listConnectionsPage).toHaveBeenCalledWith({
      idToken: "test-token", page: 1, limit: 50, query: "",
    });
    fireEvent.click(await within(picker).findByRole("button", { name: "Message Divya" }));
    expect(mocks.navigateSelection).toHaveBeenCalledWith({ personRef: "person-new" });
  });

  it.each(["voice", "command", "command-result"] as const)("keeps the inbox free of an active %s composer", async (owner) => {
    mocks.search = "";
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
    mocks.search = "";
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
    mocks.search = "conversation=conversation-1";
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

  it.each(["authentication", "response"] as const)(
    "does not publish an attachment whose owner changes during %s",
    async (phase) => {
      mocks.getConversationMessages.mockResolvedValue({
        conversation: mocks.conversation,
        items: [{ ...visibleMessage, attachment: {
          kind: "document", name: "synthetic.txt", mimeType: "text/plain", size: 18,
        } }],
        canSend: true, disconnectedNotice: null, nextBefore: null,
      });
      const createUrl = vi.fn(() => "blob:synthetic-document");
      vi.stubGlobal("URL", class extends URL {
        static createObjectURL = createUrl;
        static revokeObjectURL = vi.fn();
      });
      const view = renderConnectionThread();
      const download = await screen.findByRole("button", { name: "Download synthetic.txt" });
      let finish!: (value: unknown) => void;
      const pending = new Promise((resolve) => { finish = resolve; });
      if (phase === "authentication") mocks.user.getIdToken.mockImplementationOnce(() => pending);
      else mocks.getAttachment.mockImplementationOnce(() => pending);
      fireEvent.click(download);
      if (phase === "response") await waitFor(() => expect(mocks.getAttachment).toHaveBeenCalledTimes(1));
      mocks.user = { uid: "viewer-2", getIdToken: vi.fn().mockResolvedValue("next-owner-token") };
      view.rerender(connectionThread());
      await act(async () => finish(phase === "authentication" ? "previous-owner-token" : new Blob(["synthetic document"])));
      expect(mocks.getAttachment).toHaveBeenCalledTimes(phase === "authentication" ? 0 : 1);
      expect(createUrl).not.toHaveBeenCalled();
      expect(mocks.morphyToast.error).not.toHaveBeenCalled();
    },
  );

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
    await openContactInfo();
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), {
      target: { value: "budget" },
    });
    expect(screen.getByText("Budget review tomorrow")).toBeVisible();
    expect(screen.getByText("1 match")).toBeVisible();
    expect(screen.queryByText("See you then")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Start voice call" })).toBeDisabled();
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
    await openContactInfo();
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), { target: { value: "synthetic-encrypted-payload" } });
    expect(screen.queryByRole("region", { name: "Shared payment card" })).toBeNull();
  });

  it.each(["authentication", "response"] as const)(
    "conceals the old owner's inbox and ignores its late %s after a new owner's read fails",
    async (phase) => {
      mocks.search = "";
      const view = renderConnectionThread();
      await screen.findByRole("button", { name: /Ankit Kumar Singh/ });
      fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "Ankit" } });
      let finishOldRead!: (value: unknown) => void;
      const pending = new Promise((resolve) => { finishOldRead = resolve; });
      if (phase === "authentication") mocks.user.getIdToken.mockImplementationOnce(() => pending);
      else mocks.listConversations.mockImplementationOnce(() => pending);
      const beforeRefresh = phase === "authentication"
        ? mocks.user.getIdToken.mock.calls.length : mocks.listConversations.mock.calls.length;
      fireEvent.focus(window);
      await waitFor(() => expect(phase === "authentication"
        ? mocks.user.getIdToken.mock.calls.length : mocks.listConversations.mock.calls.length)
        .toBeGreaterThan(beforeRefresh));

      mocks.user = { uid: "viewer-2", getIdToken: vi.fn().mockResolvedValue("next-owner-token") };
      mocks.listConversations.mockRejectedValueOnce(new Error("Synthetic inbox read failure"));
      view.rerender(connectionThread());
      expect(screen.getByLabelText("Search conversations")).toHaveValue("");
      expect(screen.queryByRole("button", { name: /Ankit Kumar Singh/ })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error"));
      const settledCalls = mocks.listConversations.mock.calls.length;
      await act(async () => finishOldRead(phase === "authentication" ? "previous-owner-token"
        : { items: [mocks.conversation], unreadCount: 0 }));
      expect(mocks.listConversations).toHaveBeenCalledTimes(settledCalls);
      expect(screen.queryByRole("button", { name: /Ankit Kumar Singh/ })).not.toBeInTheDocument();
      expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error");
    },
  );

  it.each(["failed", "pending"] as const)(
    "does not turn an initially %s inbox read into empty success when background refresh also fails",
    async (initial) => {
      mocks.search = "";
      let finishInitial!: (value: unknown) => void;
      if (initial === "failed") mocks.listConversations.mockRejectedValueOnce(new Error("Synthetic initial failure"));
      else mocks.listConversations.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }));
      renderConnectionThread();
      await waitFor(() => expect(mocks.listConversations).toHaveBeenCalledTimes(1));
      if (initial === "failed") await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error"));
      mocks.listConversations.mockRejectedValueOnce(new Error("Synthetic refresh failure"));
      fireEvent.focus(window);
      await waitFor(() => expect(mocks.listConversations).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error"));
      if (initial === "pending") await act(async () => finishInitial({ items: [mocks.conversation], unreadCount: 0 }));
      expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error");
      mocks.listConversations.mockRejectedValueOnce(new Error("Synthetic repeated refresh failure"));
      fireEvent.focus(window);
      await waitFor(() => expect(mocks.listConversations).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error"));
      expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
    },
  );

  it("offers the full emoji picker and opens One chat for voice", async () => {
    const view = renderConnectionThread();

    const composer = await screen.findByRole("textbox", {
      name: "Message Ankit Kumar Singh",
    });
    expect(
      screen.queryByLabelText("Video calls are not available in Messages yet"),
    ).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled();
    expect(mocks.requestAgentConversationAfterRoute).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Choose emoji" }));
    expect(screen.getByLabelText("Emoji picker")).toBeVisible();
    expect(within(screen.getByRole("tablist", { name: "Emoji categories" })).getAllByRole("tab")).toHaveLength(9);
    expect(
      screen.getByRole("tab", { name: "Animals and nature" }),
    ).toBeInTheDocument();
    const emojiSearch = screen.getByPlaceholderText("Search emoji");
    fireEvent.change(emojiSearch, { target: { value: "cat" } });
    expect(screen.getByRole("button", { name: "Use 🐱" })).toBeVisible();
    fireEvent.change(emojiSearch, { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Use 😀" })[0]!);
    expect(composer).toHaveValue("😀");
    fireEvent.click(screen.getByRole("button", { name: "Choose emoji" }));
    fireEvent.change(screen.getByPlaceholderText("Search emoji"), { target: { value: "cat" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Use 🐱" })[0]!);
    expect(composer).toHaveValue("😀🐱");
    expect(screen.queryByRole("button", { name: "Talk to One" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose emoji" }));
    fireEvent.change(composer, { target: { value: "A draft update" } });
    expect(screen.getByLabelText("Emoji picker")).toBeVisible();
    mocks.user = { ...mocks.user, uid: "viewer-2" };
    view.rerender(connectionThread());
    await waitFor(() => expect(screen.queryByLabelText("Emoji picker")).not.toBeInTheDocument());
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
    expect(screen.queryByRole("link", { name: "View Ankit Kumar Singh's profile" })).not.toBeInTheDocument();
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

  it("keeps the long-press menu action-only and reactions in the full picker", async () => {
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
    const bubble = await screen.findByText("Hello Ankit");
    const pointer = (type: string, x = 20) => fireEvent(bubble, Object.assign(new Event(type, { bubbles: true }), { pointerType: "touch", button: 0, clientX: x, clientY: 20 }));
    vi.useFakeTimers();
    try {
      pointer("pointerdown"); pointer("pointerup");
      act(() => vi.advanceTimersByTime(1_100));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      pointer("pointerdown"); pointer("pointermove", 40);
      act(() => vi.advanceTimersByTime(1_100));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      pointer("pointerdown");
      act(() => vi.advanceTimersByTime(999));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      pointer("pointerup");
    } finally { vi.useRealTimers(); }
    expect(within(screen.getByRole("menu")).queryByRole("group", { name: "Quick reactions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "React", exact: true })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "React to message", exact: true }));
    fireEvent.change(await screen.findByPlaceholderText("Search emoji"), { target: { value: "heart" } });
    fireEvent.click(screen.getByRole("button", { name: "Use ❤️" }));
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

    // Reply must work from the direct long-press opening too; changing a
    // controlled Radix `open` prop does not call its onOpenChange callback.
    vi.useFakeTimers();
    try {
      pointer("pointerdown");
      act(() => vi.advanceTimersByTime(1_000));
      pointer("pointerup");
    } finally { vi.useRealTimers(); }
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

  it.each(["edit", "delete"] as const)("reconciles the selected reply quote after a remote %s", async (change) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const history = { conversation: mocks.conversation, items: [visibleMessage], canSend: true, disconnectedNotice: null, nextBefore: null };
    mocks.getConversationMessages.mockResolvedValue(history);
    renderConnectionThread();
    const content = await screen.findByText(visibleMessage.content);
    fireEvent.click(content);
    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply", exact: true }));
    expect(await screen.findByText("Replying to Ankit Kumar Singh")).toBeVisible();
    mocks.getConversationMessages.mockResolvedValue({ ...history, items: [{ ...visibleMessage,
      content: change === "edit" ? "Updated original" : "", deletedForEveryoneAt: change === "delete" ? "2026-10-06T10:02:00Z" : null }] });
    act(() => window.dispatchEvent(new Event("focus")));
    if (change === "delete") await waitFor(() => expect(screen.queryByText("Replying to Ankit Kumar Singh")).not.toBeInTheDocument());
    else await waitFor(() => expect(document.querySelector('[class*="composerReplyPreview"]')).toHaveTextContent("Updated original"));
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

  it.each((["edit", "reaction", "delete"] as const).flatMap((action) =>
    (["success", "failure"] as const).map((outcome) => ({ action, outcome })),
  ))("retires an old owner's $action selection and $outcome outcome", async ({ action, outcome }) => {
    mocks.search = "conversation=conversation-1";
    const message = { id: "message-1", conversationId: "conversation-1", senderIsViewer: true,
      content: "Synthetic owner A message", createdAt: "2026-10-06T10:01:00.000Z", readAt: null };
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [message], canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    const view = renderConnectionThread();
    fireEvent.click(await screen.findByText(message.content));
    let finish!: (value: unknown) => void;
    let fail!: (cause: Error) => void;
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const operation = action === "edit" ? mocks.editMessage : action === "reaction" ? mocks.reactToMessage : mocks.deleteMessage;
    operation.mockReturnValueOnce(pending);
    if (action === "reaction") {
      fireEvent.click(screen.getByRole("button", { name: "React to message" }));
      fireEvent.change(screen.getByPlaceholderText("Search emoji"), { target: { value: "heart" } });
      fireEvent.click(screen.getByRole("button", { name: "Use ❤️" }));
    } else {
      fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitem", { name: action === "edit" ? "Edit" : "Delete for me" }));
      if (action === "edit") {
        fireEvent.change(await screen.findByRole("textbox", { name: "Edit message" }), { target: { value: "Synthetic A edit" } });
        fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
      } else fireEvent.click(screen.getByRole("button", { name: "Yes, delete", exact: true }));
    }
    await waitFor(() => expect(operation).toHaveBeenCalled());
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
      if (outcome === "failure") fail(new Error("Synthetic stale A failure"));
      else finish(action === "delete" ? { scope: "me", message: null } : { ...message, content: "Synthetic stale A result" });
    });
    expect(screen.getByText("Synthetic owner B message")).toBeVisible();
    expect(screen.queryByText("Synthetic stale A result")).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t (?:update this message|add that reaction|delete this message)/)).not.toBeInTheDocument();
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
    const reply = await screen.findByRole("menuitem", { name: "Reply" });
    // Force the observed CI ordering: Reply's frame runs before Radix's
    // deferred close autofocus. The latter must not steal composer focus.
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.useFakeTimers();
    try {
      fireEvent.click(reply);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      act(() => { for (const callback of [...frames]) callback(0); });
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toHaveFocus();
    } finally {
      vi.useRealTimers();
      frame.mockRestore();
    }
    expect(screen.getByText("Replying to yourself")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "Enter" });
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

  it("settles Reply focus for the latest menu opening and preserves Escape focus return", async () => {
    mocks.search = "conversation=conversation-1";
    const message = { id: "message-1", conversationId: "conversation-1", senderIsViewer: true,
      content: "Synthetic menu reopen", createdAt: "2026-10-06T10:01:00.000Z", readAt: null };
    mocks.getConversationMessages.mockResolvedValueOnce({
      conversation: mocks.conversation, items: [message], canSend: true, disconnectedNotice: null, nextBefore: null,
    });
    renderConnectionThread();
    await screen.findByText(message.content);
    const trigger = screen.getByRole("button", { name: "Message options" });
    const composer = screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const reply = await screen.findByRole("menuitem", { name: "Reply" });
    const focus = vi.spyOn(composer, "focus");
    vi.useFakeTimers();
    try {
      fireEvent.click(reply);
      // Reopen and choose again before the previous menu's close callback runs.
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      expect(composer).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      expect(trigger).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      focus.mockRestore();
    }
  });
});
