import { render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { toast } from "sonner";

import {
  AgentDockProvider,
  AgentDockVoiceBoundary,
} from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { DirectMessagesPage as ProductionDirectMessagesPage } from "@/components/direct-messages/direct-messages-page";
import type { ComponentProps } from "react";
import type { AppPageShell } from "@/components/app-ui/app-page-shell";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { CacheService } from "@/lib/services/cache-service";

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
  resolveDirectMessageHref: async () => "/one/messages?token=dm1.fixture",
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

export function setupDirectMessagePageTests() {
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
    mocks.user.getIdToken.mockReset().mockResolvedValue("test-token");
    mocks.query = "person=person-1";
    mocks.liveMessageEvents = false;
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
    mocks.getAttachment.mockResolvedValue(new Blob(["synthetic document"]));
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

}

export { mocks, messageIdPattern, validVoiceWav, visibleMessage, exposeLatestMessage, ConnectionThread, DirectMessagesPage, renderConnectionThread, connectionThread };
