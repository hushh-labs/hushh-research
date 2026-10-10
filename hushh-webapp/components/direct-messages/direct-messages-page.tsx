"use client";

import { replaceMessageHistory } from "@/lib/direct-messages/message-history";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AgentDockPortal, useAgentDockFrame } from "@/components/agent/agent-dock";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { navigateDirectMessage } from "@/lib/direct-messages/navigate-direct-message";
import { OneChatBubble } from "@/components/agent/chat-message-styles";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ConnectionsService, type ConnectionSummaryEntry } from "@/lib/services/connections-service";
import { DirectMessageEmojiPicker } from "@/components/direct-messages/direct-message-emoji-picker";
import { CircleMessagesPane } from "@/components/connect/circles/circle-messages-pane";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/lib/morphy-ux/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Loader2,
  MessageCircle,
  Mic,
  ChevronDown,
  Pencil,
  PhoneCall,
  Quote,
  RefreshCw,
  Search,
  Send,
  MoonIcon,
  SunIcon,
  Plus,
  Image as ImageIcon,
  FileText,
  Trash2,
  X,
} from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import {
  dispatchDirectMessagesUpdated,
  subscribeToDirectMessagesUpdated,
} from "@/lib/direct-messages/direct-message-events";
import {
  DIRECT_MESSAGE_MAX_LENGTH,
  DirectMessagesService,
  DirectMessagesServiceRequestError,
  type DirectMessage,
  type DirectMessageConversation,
} from "@/lib/services/direct-messages-service";
import {
  ROUTES,
} from "@/lib/navigation/routes";
import { requestAgentConversationAfterRoute } from "@/lib/agent/agent-voice-settings";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";

import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { chatReadIsBlocked, subscribeChatLayerChanges } from "@/lib/interaction/chat-read-visibility";
import { useVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

import styles from "./direct-messages-page.module.css";

type ThreadState = {
  conversation: DirectMessageConversation | null;
  peerPersonRef: string | null;
  peerDisplayName: string | null;
  peerPhotoUrl: string | null;
  canSend: boolean;
  disconnectedNotice: string | null;
  nextBefore: string | null;
};

const EMPTY_THREAD: ThreadState = {
  conversation: null,
  peerPersonRef: null,
  peerDisplayName: null,
  peerPhotoUrl: null,
  canSend: false,
  disconnectedNotice: null,
  nextBefore: null,
};

const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🙏"] as const;

function toggleReaction(message: DirectMessage, emoji: string): DirectMessage {
  const reactions = [...(message.reactions ?? [])];
  const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
  if (index < 0) {
    reactions.push({ emoji, count: 1, reactedByViewer: true });
  } else {
    const current = reactions[index]!;
    const count = current.count + (current.reactedByViewer ? -1 : 1);
    if (count < 1) reactions.splice(index, 1);
    else reactions[index] = { ...current, count, reactedByViewer: !current.reactedByViewer };
  }
  return { ...message, reactions };
}

function MessageAttachment({ message, getIdToken }: {
  message: DirectMessage;
  getIdToken: () => Promise<string>;
}) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);
  const attachment = message.attachment;
  if (!attachment) return null;
  const open = async () => {
    try {
      const blob = await DirectMessagesService.getAttachment({
        idToken: await getIdToken(),
        conversationId: message.conversationId,
        messageId: message.id,
      });
      const url = URL.createObjectURL(blob);
      if (attachment.kind === "document") {
        const link = document.createElement("a");
        link.href = url; link.download = attachment.name; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      } else {
        setMediaUrl(url);
      }
    } catch {
      morphyToast.error("This attachment is unavailable. Try again.");
    }
  };
  return <div className={styles.messageAttachment}>
    {mediaUrl && attachment.kind === "photo" ? (
      // Encrypted attachments use short-lived blob URLs, which Next's image optimizer cannot serve.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={mediaUrl} alt={attachment.name} />
    ) : null}
    {mediaUrl && attachment.kind === "video" ? <video src={mediaUrl} controls preload="metadata" aria-label={attachment.name} /> : null}
    {mediaUrl ? <a href={mediaUrl} download={attachment.name}>Save {attachment.kind}</a> :
      <button type="button" onClick={() => void open()}>
        {attachment.kind === "document" ? "Download" : "View"} {attachment.name}
      </button>}
  </div>;
}

/** Per-message metadata always uses a clock time. Repeating a calendar date
 * below every historical bubble makes a thread much harder to scan. */
function formatMessageTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatMessageFeedMarker(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
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
}

function formatConversationTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function conversationLabel(conversation: DirectMessageConversation): string {
  return conversation.peerDisplayName || "Connection";
}

function conversationPreview(conversation: DirectMessageConversation): string {
  const latest = conversation.latestMessage;
  if (!latest) return "Start a conversation";
  if (latest.deletedForEveryoneAt) return "Message deleted";
  const prefix = latest.senderIsViewer ? "You: " : "";
  const preview = `${prefix}${latest.content || (latest.attachment ? latest.attachment.kind[0]!.toUpperCase() + latest.attachment.kind.slice(1) : "")}`.replace(/\s+/g, " ").trim();
  const maxLength = 88;
  return preview.length > maxLength
    ? `${preview.slice(0, maxLength - 1).trimEnd()}…`
    : preview;
}

function isNewMessageDay(
  message: DirectMessage,
  previous: DirectMessage | undefined,
): boolean {
  if (!previous) return true;
  const currentDate = new Date(message.createdAt);
  const previousDate = new Date(previous.createdAt);
  return currentDate.toDateString() !== previousDate.toDateString();
}

function compareMessages(left: DirectMessage, right: DirectMessage): number {
  const fraction = (value: string) => (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0");
  return Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || fraction(left.createdAt).localeCompare(fraction(right.createdAt))
    || left.id.localeCompare(right.id);
}

function sortMessages(items: DirectMessage[]): DirectMessage[] {
  return [...items].sort(compareMessages);
}

function mergeMessages(
  current: DirectMessage[],
  incoming: DirectMessage[],
): DirectMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return sortMessages([...byId.values()]);
}

function parseSseFrames(value: string): Array<{
  event: string;
  data: Record<string, unknown>;
}> {
  return value
    .split(/\r?\n\r?\n/)
    .flatMap((block) => {
      const event = block
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!event || !data) return [];
      try {
        const parsed = JSON.parse(data) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [{ event, data: parsed as Record<string, unknown> }]
          : [];
      } catch {
        return [];
      }
    });
}

function threadFromConversation(
  conversation: DirectMessageConversation,
  overrides?: Partial<ThreadState>,
): ThreadState {
  return {
    conversation,
    peerPersonRef: conversation.peerPersonRef,
    peerDisplayName: conversation.peerDisplayName,
    peerPhotoUrl: conversation.peerPhotoUrl,
    canSend: false,
    disconnectedNotice: null,
    nextBefore: null,
    ...overrides,
  };
}

export function DirectMessagesPage({ selection, resolvingSelection = false }: { selection?: { kind: "conversation" | "person"; ref: string } | null; resolvingSelection?: boolean } = {}) {
  const { user, loading: authLoading } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const router = useRouter();
  const requestedPersonRef = selection?.kind === "person" ? selection.ref : "";
  const requestedConversationId = selection?.kind === "conversation" ? selection.ref : "";
  const [thread, setThread] = useState<ThreadState>(EMPTY_THREAD);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [inboxItems, setInboxItems] = useState<DirectMessageConversation[]>([]);
  const [inboxSearch, setInboxSearch] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatQuery, setNewChatQuery] = useState("");
  const [newChatPage, setNewChatPage] = useState(1);
  const [newChatPeople, setNewChatPeople] = useState<ConnectionSummaryEntry[]>([]);
  const [newChatHasMore, setNewChatHasMore] = useState(false);
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [newChatError, setNewChatError] = useState(false);
  const [lane, setLane] = useState<"people" | "circles">("people");
  const [circleThreadOpen, setCircleThreadOpen] = useState(false);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [unconfirmedDraft, setUnconfirmedDraft] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [openMessageMenu, setOpenMessageMenu] = useState<string | null>(null);
  const [openReactionPicker, setOpenReactionPicker] = useState<string | null>(null);
  const reactionPending = useRef(new Set<string>());
  const [activeMessageActions, setActiveMessageActions] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<DirectMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<DirectMessage | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [deleteRequest, setDeleteRequest] = useState<{
    message: DirectMessage;
    scope: "me" | "everyone";
  } | null>(null);
  const [messageActionError, setMessageActionError] = useState<{
    messageId: string;
    message: string;
  } | null>(null);
  const loadGeneration = useRef(0);
  const inboxLoadGeneration = useRef(0);
  const loadedRouteKey = useRef<string | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const dockFrame = useAgentDockFrame();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const editingInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editDraftGeneration = useRef(0);
  const messageLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const messageSearchRef = useRef(messageSearchQuery); messageSearchRef.current = messageSearchQuery;
  const activeConversationId = thread.conversation?.id ?? null;

  useEffect(() => {
    if (!newChatOpen || !user) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      setNewChatLoading(true);
      setNewChatError(false);
      try {
        const page = await ConnectionsService.listConnectionsPage({
          idToken: await user.getIdToken(),
          page: newChatPage,
          limit: 50,
          query: newChatQuery,
        });
        if (!active) return;
        setNewChatPeople((current) => newChatPage === 1 ? page.items : [
          ...current,
          ...page.items.filter((person) => !current.some((item) => item.userId === person.userId)),
        ]);
        setNewChatHasMore(page.hasMore);
      } catch {
        if (active) setNewChatError(true);
      } finally {
        if (active) setNewChatLoading(false);
      }
    }, newChatQuery ? 180 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [newChatOpen, newChatPage, newChatQuery, user]);

  const routeSelection = `${requestedPersonRef ? "person" : "conversation"}:${requestedPersonRef || requestedConversationId}`;
  useEffect(() => {
    if (requestedPersonRef || requestedConversationId) setLane("people");
  }, [requestedPersonRef, requestedConversationId]);
  const selectionRef = useRef(routeSelection);
  const ownerRef = useRef(user?.uid);
  const selectionGeneration = useRef(0);
  const replyDrafts = useRef(new Map<string, DirectMessage | null>());
  const drafts = useRef(new Map<string, string>());
  const attachmentDrafts = useRef(new Map<string, File>());
  const sendAttempts = useRef(new Map<string, { id: string; content: string; replyId?: string; attachment?: File; unconfirmed?: boolean }>());
  const sendingSelections = useRef(new Set<string>());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const visibleBottom = useRef(false);
  const atBottomRef = useRef(true);
  const prependPosition = useRef<{ top: number; height: number } | null>(null);
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const reading = useRef(false);
  const readThrough = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [readRevision, setReadRevision] = useState(0);
  const blockingLayer = useVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions;
  const foreground = () => document.visibilityState === "visible" && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
  const bottomIsUncovered = useCallback(() => {
    const marker = bottomRef.current?.getBoundingClientRect();
    const transcript = messageListRef.current?.getBoundingClientRect();
    if (!marker || !transcript) return false;
    const dock = dockFrame?.getBoundingClientRect();
    const visibleEnd = dock && dock.height > 0 ? Math.min(transcript.bottom, dock.top) : transcript.bottom;
    return marker.top >= transcript.top && marker.bottom <= visibleEnd + 1;
  }, [dockFrame]);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page || !dockFrame) return;
    const publish = () => {
      page.style.setProperty("--direct-message-dock-height", `${Math.ceil(dockFrame.getBoundingClientRect().height)}px`);
      setReadRevision((value) => value + 1);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(dockFrame);
    return () => observer.disconnect();
  }, [dockFrame]);

  const invalidateSelection = useCallback(() => {
    selectionGeneration.current++;
    loadGeneration.current++;
  }, []);

  useLayoutEffect(() => {
    ownerRef.current = user?.uid; invalidateSelection();
    selectionRef.current = routeSelection;
    readThrough.current = null; reading.current = false; visibleBottom.current = false;
    atBottomRef.current = true; prependPosition.current = null; setAtBottom(true);
    const previousAttempt = sendAttempts.current.get(routeSelection);
    setUnconfirmedDraft(previousAttempt?.unconfirmed ? previousAttempt.content : null);
    setDraft(drafts.current.get(routeSelection) ?? ""); setAttachment(attachmentDrafts.current.get(routeSelection) ?? null); setSending(sendingSelections.current.has(routeSelection));
    setReplyingTo(replyDrafts.current.get(routeSelection) ?? null); setEditingMessage(null); setEditingContent(""); setDeleteRequest(null);
    setMessageActionError(null); setComposerError(null); setOpenMessageMenu(null); setOpenReactionPicker(null); setActiveMessageActions(null);
    setLoadingOlder(false); setMessages([]); setThread(EMPTY_THREAD);
    return invalidateSelection;
  }, [invalidateSelection, routeSelection, user?.uid]);

  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [draft, thread.canSend]);

  useEffect(() => {
    return () => {
      if (messageLongPressTimer.current) clearTimeout(messageLongPressTimer.current);
      inboxLoadGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    setMessageSearchOpen(false);
    setMessageSearchQuery("");
  }, [activeConversationId]);

  const editingMessageId = editingMessage?.id;

  useEffect(() => {
    if (!editingMessageId) return;
    const frame = requestAnimationFrame(() => {
      const input = editingInputRef.current;
      if (!input) return;
      input.focus();
      const caret = input.value.length;
      input.setSelectionRange(caret, caret);
    });
    return () => cancelAnimationFrame(frame);
  }, [editingMessageId]);

  const hasRouteSelection = Boolean(resolvingSelection || requestedPersonRef || requestedConversationId);
  const canCompose = hasRouteSelection && !resolvingSelection && thread.canSend;

  const loadInbox = useCallback(
    async (options?: { preserveItems?: boolean }) => {
      if (!user) return;
      const generation = ++inboxLoadGeneration.current;
      if (!options?.preserveItems) setLoadingInbox(true);
      setInboxError(null);
      try {
        const idToken = await user.getIdToken();
        if (generation !== inboxLoadGeneration.current) return;
        const inbox = await DirectMessagesService.listConversations({ idToken });
        if (generation !== inboxLoadGeneration.current) return;
        setInboxItems(
          inbox.items,
        );
      } catch {
        if (generation !== inboxLoadGeneration.current) return;
        if (!options?.preserveItems) {
          setInboxError("Conversations could not be loaded. Check your connection and try again.");
        }
      } finally {
        if (generation === inboxLoadGeneration.current) setLoadingInbox(false);
      }
    },
    [user],
  );

  const openOneVoiceChat = useCallback(() => {
    requestAgentConversationAfterRoute(ROUTES.HOME);
    router.push(ROUTES.HOME);
  }, [router]);

  const loadThread = useCallback(
    async (options?: { preserveMessages?: boolean }) => {
      if (!user) return;
      const generation = ++loadGeneration.current;
      const requestKey = requestedPersonRef
        ? `person:${requestedPersonRef}`
        : requestedConversationId
          ? `conversation:${requestedConversationId}`
          : null;

      // A route change must never leave the previous connection's messages
      // visible beneath a new header while the next history request is in flight.
      // Background refreshes of the same route keep the readable transcript.
      if (!options?.preserveMessages && loadedRouteKey.current !== requestKey) {
        loadedRouteKey.current = requestKey;
        setMessages([]);
        setThread(EMPTY_THREAD);
      }
      if (!options?.preserveMessages) setLoadingThread(true);
      setThreadError(null);
      try {
        const idToken = await user.getIdToken();
        if (generation !== loadGeneration.current) return;
        const snapshot = options?.preserveMessages ? messagesRef.current : [];
        const snapshotIds = new Set(snapshot.map((message) => message.id));
        let refreshedFrom: DirectMessage | undefined;
        let refreshedToStart = false;
        const fetchHistory = async (conversationId: string) => {
          let history = await DirectMessagesService.getConversationMessages({ idToken, conversationId, limit: 60 });
          const oldest = snapshot.find((message) => message.conversationId === conversationId);
          let items = history.items;
          // Reconcile the window the person already loaded, including rows a
          // different device edited or deleted. Work is bounded by that window.
          const pageBudget = Math.ceil(snapshot.length / 60) + 1;
          for (let page = 1; oldest && history.nextBefore && page < pageBudget; page++) {
            if (generation !== loadGeneration.current || !items.length || compareMessages(items[0]!, oldest) <= 0) break;
            history = await DirectMessagesService.getConversationMessages({ idToken, conversationId, before: history.nextBefore, limit: 60 });
            items = mergeMessages(history.items, items);
          }
          refreshedFrom = items[0];
          refreshedToStart = !history.nextBefore;
          if (oldest) items = items.filter((message) => compareMessages(message, oldest) >= 0);
          return { ...history, items };
        };
        const reconcileHistory = (current: DirectMessage[], incoming: DirectMessage[]) => {
          if (!options?.preserveMessages) return sortMessages(incoming);
          const oldest = snapshot[0];
          return mergeMessages(current.filter((message) => !snapshotIds.has(message.id)
            || (oldest && compareMessages(message, oldest) < 0)
            || (!refreshedToStart && refreshedFrom && compareMessages(message, refreshedFrom) < 0)), incoming);
        };
        if (requestedPersonRef) {
          const peer = await DirectMessagesService.getConversationWithPerson({
            idToken,
            personRef: requestedPersonRef,
          });
          if (generation !== loadGeneration.current) return;
          if (!peer.conversation) {
            setThread({
              conversation: null,
              peerPersonRef: peer.peerPersonRef,
              peerDisplayName: peer.peerDisplayName,
              peerPhotoUrl: peer.peerPhotoUrl,
              canSend: peer.canSend,
              disconnectedNotice: peer.disconnectedNotice,
              nextBefore: null,
            });
            setMessages([]);
            return;
          }
          const history = await fetchHistory(peer.conversation.id);
          if (generation !== loadGeneration.current) return;
          setThread((current) =>
            threadFromConversation(history.conversation, {
              peerPersonRef: peer.peerPersonRef ?? history.conversation.peerPersonRef,
              peerDisplayName:
                peer.peerDisplayName ?? history.conversation.peerDisplayName,
              peerPhotoUrl: peer.peerPhotoUrl ?? history.conversation.peerPhotoUrl,
              canSend: history.canSend,
              disconnectedNotice: history.disconnectedNotice,
              nextBefore: options?.preserveMessages && current.conversation?.id === history.conversation.id ? current.nextBefore : history.nextBefore,
            }),
          );
          setMessages((current) => reconcileHistory(current, history.items));
          return;
        }

        if (!requestedConversationId) {
          loadedRouteKey.current = null;
          setThread(EMPTY_THREAD);
          setMessages([]);
          return;
        }
        const history = await fetchHistory(requestedConversationId);
        if (generation !== loadGeneration.current) return;
        setThread((current) =>
          threadFromConversation(history.conversation, {
            canSend: history.canSend,
            disconnectedNotice: history.disconnectedNotice,
            nextBefore: options?.preserveMessages && current.conversation?.id === history.conversation.id ? current.nextBefore : history.nextBefore,
          }),
        );
        setMessages((current) => reconcileHistory(current, history.items));
      } catch (error) {
        if (generation !== loadGeneration.current) return;
        // A short-lived refresh failure must not replace an already readable
        // conversation with a large error panel. The next focus, SSE update,
        // or explicit refresh will retry while the cached thread stays usable.
        if (options?.preserveMessages) {
          setThreadError(null);
          return;
        }
        if (requestedPersonRef) {
          setThread({
            ...EMPTY_THREAD,
            peerPersonRef: requestedPersonRef,
            peerDisplayName: "Connection",
            disconnectedNotice:
              "This connection is not available for messaging right now.",
          });
        }
        const message = error instanceof Error ? error.message : "";
        setThreadError(
          /not found/i.test(message)
            ? "This connection is not available for messaging right now."
            : "Messages could not be loaded. Check your connection and try again.",
        );
      } finally {
        if (generation === loadGeneration.current) setLoadingThread(false);
      }
    },
    [requestedConversationId, requestedPersonRef, user],
  );

  useEffect(() => {
    if (!user) {
      loadedRouteKey.current = null;
      inboxLoadGeneration.current += 1;
      setInboxItems([]);
      setInboxError(null);
      setThread(EMPTY_THREAD);
      setMessages([]);
      return;
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void loadInbox();
  }, [loadInbox, user]);

  useEffect(() => {
    if (!user) return;
    void loadThread();
  }, [loadThread, user]);

  const refresh = useCallback(() => {
    void loadInbox({ preserveItems: true });
    if (hasRouteSelection) void loadThread({ preserveMessages: true });
  }, [hasRouteSelection, loadInbox, loadThread]);

  useEffect(() => {
    if (!user?.uid) return;
    return subscribeToDirectMessagesUpdated((detail) => {
      if (detail.userId !== user.uid) return;
      if (foreground()) refresh();
    });
  }, [refresh, user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    const refreshVisible = () => {
      if (foreground()) refresh();
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(refreshVisible);
    const interval = window.setInterval(refreshVisible, 30_000);
    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.clearInterval(interval); removeLifecycle();
    };
  }, [refresh, user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    let reconnectAttempt = 0;

    const connect = async () => {
      abortController = new AbortController();
      try {
        const idToken = await user.getIdToken();
        if (cancelled) return;
        const response = await DirectMessagesService.openEvents({
          idToken,
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Message updates unavailable (${response.status})`);
        }
        reconnectAttempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let remainder = "";
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          remainder += decoder.decode(value, { stream: true });
          const splitAt = Math.max(
            remainder.lastIndexOf("\n\n"),
            remainder.lastIndexOf("\r\n\r\n"),
          );
          if (splitAt < 0) continue;
          const complete = remainder.slice(0, splitAt + 2);
          remainder = remainder.slice(splitAt + 2);
          for (const frame of parseSseFrames(complete)) {
            if (frame.event !== "direct_message") continue;
            const conversationId = String(frame.data.conversationId || "").trim() || null;
            const messageId = String(frame.data.messageId || "").trim() || null;
            dispatchDirectMessagesUpdated({
              userId: user.uid,
              conversationId,
              messageId,
              source: "sse",
            });
          }
        }
      } catch {
        // Push, focus refresh and the short reconnect below keep the inbox live
        // when a proxy or network briefly interrupts the stream.
      } finally {
        if (!cancelled) {
          reconnectAttempt += 1;
          const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
          reconnectTimer = setTimeout(() => void connect(), delay);
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      abortController?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [user]);

  useLayoutEffect(() => {
    const node = messageListRef.current;
    if (!node) return;
    if (prependPosition.current) {
      node.scrollTop = prependPosition.current.top + node.scrollHeight - prependPosition.current.height;
      prependPosition.current = null;
    } else if (atBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [activeConversationId, messages]);

  useEffect(() => {
    const node = messageListRef.current;
    const bottom = bottomRef.current;
    if (!node || !bottom) return;
    const resize = new ResizeObserver(() => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    });
    resize.observe(node);
    for (const child of Array.from(node.children)) resize.observe(child);
    const observer = new IntersectionObserver(([entry]) => {
      visibleBottom.current = Boolean(entry?.isIntersecting);
      if (entry?.isIntersecting) setReadRevision((value) => value + 1);
    // Safari rounds scrollTop to pixels while these bounds remain fractional.
    // The 8px scroll-distance guard below owns the exact read boundary.
    }, { threshold: 0 });
    observer.observe(bottom);
    return () => { resize.disconnect(); observer.disconnect(); };
  }, [hasRouteSelection, routeSelection, loadingThread]);

  useEffect(() => {
    const markRead = async () => {
      const last = messages.at(-1);
      const node = messageListRef.current;
      if (messageSearchQuery.trim() || !user || !activeConversationId || !last || loadingThread || reading.current || readThrough.current === last.id
        || !foreground() || !document.hasFocus() || !atBottomRef.current || !visibleBottom.current || !bottomIsUncovered() || !node || chatReadIsBlocked(node) || node.scrollHeight - node.scrollTop - node.clientHeight > 8) return;
      const generation = selectionGeneration.current;
      reading.current = true;
      try {
        const idToken = await user.getIdToken();
        if (generation !== selectionGeneration.current || messageSearchRef.current.trim() || !foreground() || !document.hasFocus()
            || !atBottomRef.current || !visibleBottom.current || !bottomIsUncovered() || !messageListRef.current
            || chatReadIsBlocked(messageListRef.current)
            || messageListRef.current.scrollHeight - messageListRef.current.scrollTop - messageListRef.current.clientHeight > 8) return;
        await DirectMessagesService.markConversationRead({ idToken, ownerUserId: user.uid, conversationId: activeConversationId, throughMessageId: last.id, throughCreatedAt: last.createdAt });
        if (generation !== selectionGeneration.current) return;
        readThrough.current = last.id;
        setInboxItems((current) => current.map((conversation) => conversation.id === activeConversationId && messagesRef.current.at(-1)?.id === last.id ? { ...conversation, unreadCount: 0 } : conversation));
        setThread((current) => current.conversation?.id === activeConversationId && messagesRef.current.at(-1)?.id === last.id
          ? { ...current, conversation: { ...current.conversation, unreadCount: 0 } } : current);
        dispatchDirectMessagesUpdated({ userId: user.uid, conversationId: activeConversationId, messageId: null, source: "read" });
      } catch { /* Retain unread state so the next foreground/read event can retry. */ }
      finally {
        if (generation === selectionGeneration.current) {
          reading.current = false;
          if (readThrough.current === last.id && messagesRef.current.at(-1)?.id !== last.id) setReadRevision((value) => value + 1);
        }
      }
    };
    void markRead();
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => void markRead());
    const removeLayers = subscribeChatLayerChanges(() => void markRead());
    const onFocus = () => void markRead();
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onFocus);
    return () => { removeLifecycle(); removeLayers(); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [activeConversationId, loadingThread, messages, readRevision, thread.conversation?.unreadCount, user, blockingLayer, messageSearchQuery, bottomIsUncovered]);

  const selectedLabel =
    thread.peerDisplayName || thread.conversation?.peerDisplayName || "Conversation";
  const normalizedMessageSearch = messageSearchQuery.trim().toLocaleLowerCase();
  const visibleMessages = normalizedMessageSearch
    ? messages.filter((message) =>
        [message.content, message.replyTo?.content]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedMessageSearch),
      )
    : messages;
  const messageSearchSummary = normalizedMessageSearch
    ? `${visibleMessages.length} ${visibleMessages.length === 1 ? "match" : "matches"}`
    : "";
  const normalizedInboxSearch = inboxSearch.trim().toLocaleLowerCase();
  const visibleConversations = normalizedInboxSearch
    ? inboxItems.filter((conversation) =>
        [conversationLabel(conversation), conversationPreview(conversation)]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedInboxSearch),
      )
    : inboxItems;

  const openConversation = (conversation: DirectMessageConversation) => {
    void navigateDirectMessage(router, { conversationId: conversation.id });
  };

  const backToConnections = () => {
    replaceMessageHistory(null);
    router.replace(ROUTES.ONE_MESSAGES, { scroll: false });
  };

  useBackLayer(ROUTES.ONE_MESSAGES, lane === "people" && hasRouteSelection && messageSearchOpen ? 2 : 0, () => {
    setMessageSearchOpen(false);
    setMessageSearchQuery("");
    return true;
  });
  useBackLayer(ROUTES.ONE_MESSAGES, lane === "people" && hasRouteSelection ? 1 : 0, () => {
    backToConnections();
    return true;
  });
  useBackLayer(ROUTES.ONE_MESSAGES, newChatOpen ? 3 : 0, () => {
    setNewChatOpen(false);
    return true;
  });

  const chooseAttachment = (file: File | undefined) => {
    if (!file) return;
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm",
      "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain",
    ];
    if (!allowed.includes(file.type) || file.size > 5 * 1024 * 1024) {
      morphyToast.error("Choose a photo, video, PDF, Word, or text file up to 5 MB.");
      return;
    }
    attachmentDrafts.current.set(routeSelection, file);
    setAttachment(file);
    setComposerError(null);
  };

  const sendDraft = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!user || sending || !canCompose) return;
    const content = unconfirmedDraft ?? draft;
    if ((!content.trim() && !attachment) || sendingSelections.current.has(routeSelection)) return;
    const generation = selectionGeneration.current;
    const isCurrent = () => generation === selectionGeneration.current && ownerRef.current === user.uid && selectionRef.current === routeSelection;
    const reply = replyingTo;
    const replyId = unconfirmedDraft ? sendAttempts.current.get(routeSelection)?.replyId : reply?.id;
    let attempt = sendAttempts.current.get(routeSelection);
    if (!attempt || attempt.content !== content || attempt.replyId !== replyId || (attempt.attachment ?? null) !== attachment) {
      attempt = { id: crypto.randomUUID(), content, replyId, attachment: attachment ?? undefined }; sendAttempts.current.set(routeSelection, attempt);
    }
    const recipientPersonRef = thread.peerPersonRef || requestedPersonRef;
    if (!recipientPersonRef) {
      morphyToast.error("This recipient is no longer available for messaging.");
      return;
    }
    setComposerError(null);
    setSending(true);
    sendingSelections.current.add(routeSelection);
    try {
      const idToken = await user.getIdToken();
      if (!isCurrent()) return;
      attempt.unconfirmed = true;
      const result = await DirectMessagesService.sendMessage({
        idToken,
        content,
        recipientPersonRef,
        replyToMessageId: replyId,
        clientMessageId: attempt.id,
        ...(attempt.attachment ? { attachment: attempt.attachment } : {}),
      });
      if (!isCurrent()) return;
      drafts.current.delete(routeSelection); attachmentDrafts.current.delete(routeSelection); sendAttempts.current.delete(routeSelection);
      atBottomRef.current = true; setAtBottom(true);
      replyDrafts.current.delete(routeSelection);
      setDraft(""); setAttachment(null); setUnconfirmedDraft(null);
      setReplyingTo(null);
      loadGeneration.current += 1;
      setMessages((current) => mergeMessages(current, [result.message]));
      setThread((current) =>
        threadFromConversation(result.conversation, {
          peerPersonRef: current.peerPersonRef ?? result.conversation.peerPersonRef,
          peerDisplayName:
            current.peerDisplayName ?? result.conversation.peerDisplayName,
          peerPhotoUrl: current.peerPhotoUrl ?? result.conversation.peerPhotoUrl,
          canSend: true,
          nextBefore: current.nextBefore,
        }),
      );
      setInboxItems((current) => {
        const withoutConversation = current.filter(
          (conversation) => conversation.id !== result.conversation.id,
        );
        return [result.conversation, ...withoutConversation];
      });
      dispatchDirectMessagesUpdated({
        userId: user.uid,
        conversationId: result.conversation.id,
        messageId: result.message.id,
        source: "send",
      });
    } catch (error) {
      const definiteRefusal = error instanceof DirectMessagesServiceRequestError && [400, 401, 403, 404, 409, 413, 422, 429].includes(error.status);
      if (definiteRefusal) sendAttempts.current.delete(routeSelection);
      if (!isCurrent()) return;
      setUnconfirmedDraft(definiteRefusal ? null : content);
      setDraft(content);
      setComposerError(
        reply
          ? "Couldn’t send this reply. Your message is ready to try again."
          : "Couldn’t send this message. Your draft is ready to try again.",
      );
      // A 403/409 is authoritative: redraw the thread as read-only instead of
      // leaving a stale connected composer visible.
      void loadThread({ preserveMessages: true });
    } finally {
      sendingSelections.current.delete(routeSelection);
      if (selectionRef.current === routeSelection && ownerRef.current === user.uid) setSending(false);
    }
  };

  const loadOlderMessages = async () => {
    const conversationId = thread.conversation?.id;
    const before = thread.nextBefore;
    if (!user || !conversationId || !before || loadingOlder) return;
    const generation = selectionGeneration.current;
    setLoadingOlder(true);
    try {
      const idToken = await user.getIdToken();
      const history = await DirectMessagesService.getConversationMessages({
        idToken,
        conversationId,
        before,
        limit: 60,
      });
      if (generation !== selectionGeneration.current) return;
      const node = messageListRef.current;
      if (node) prependPosition.current = { top: node.scrollTop, height: node.scrollHeight };
      setMessages((current) => mergeMessages(history.items, current));
      setThread(
        threadFromConversation(history.conversation, {
          canSend: history.canSend,
          disconnectedNotice: history.disconnectedNotice,
          nextBefore: history.nextBefore,
        }),
      );
    } catch {
      if (generation !== selectionGeneration.current) return;
      morphyToast.error("Older messages could not be loaded. Try again.");
    } finally {
      if (generation === selectionGeneration.current) setLoadingOlder(false);
    }
  };

  const replaceMessage = (updated: DirectMessage) => {
    setMessages((current) =>
      current.map((message) => (message.id === updated.id ? updated : message)),
    );
  };

  const startReply = (message: DirectMessage) => {
    setOpenMessageMenu(null);
    setActiveMessageActions(null);
    setComposerError(null);
    replyDrafts.current.set(routeSelection, message);
    setReplyingTo(message);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const startEditing = (message: DirectMessage) => {
    editDraftGeneration.current += 1;
    setOpenMessageMenu(null);
    setActiveMessageActions(null);
    setMessageActionError(null);
    setEditingMessage(message);
    setEditingContent(message.content);
  };

  const clearMessageLongPress = () => {
    if (messageLongPressTimer.current) {
      clearTimeout(messageLongPressTimer.current);
      messageLongPressTimer.current = null;
    }
  };

  const handleMessagePointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    message: DirectMessage,
  ) => {
    if (event.pointerType === "mouse") return;
    if ((event.target as HTMLElement).closest("button, textarea")) return;
    clearMessageLongPress();
    messageLongPressTimer.current = setTimeout(() => {
      setActiveMessageActions(message.id);
      setOpenReactionPicker(message.id);
      window.navigator.vibrate?.(8);
      messageLongPressTimer.current = null;
    }, 450);
  };

  const saveEdit = () => {
    if (!user || !editingMessage || !editingContent.trim()) return;
    const message = editingMessage;
    const draftGeneration = editDraftGeneration.current;
    const generation = selectionGeneration.current;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (generation !== selectionGeneration.current) return;
        const updated = await DirectMessagesService.editMessage({
          idToken,
          conversationId: message.conversationId,
          messageId: message.id,
          content: editingContent,
        });
        if (generation !== selectionGeneration.current) return;
        loadGeneration.current += 1;
        replaceMessage(updated);
        if (draftGeneration !== editDraftGeneration.current) return;
        setMessageActionError(null);
        setActiveMessageActions(null);
        setEditingMessage(null);
        setEditingContent("");
      } catch {
        if (generation !== selectionGeneration.current || draftGeneration !== editDraftGeneration.current) return;
        setMessageActionError({
          messageId: message.id,
          message: "Couldn’t update this message. Try again.",
        });
        morphyToast.error("Couldn’t update this message. Try again.");
      }
    })();
  };

  const saveReaction = (message: DirectMessage, emoji: string) => {
    if (!user) return;
    const reactionKey = `${message.id}:${emoji}`;
    if (reactionPending.current.has(reactionKey)) return;
    reactionPending.current.add(reactionKey);
    const removing = Boolean(message.reactions?.find((reaction) => reaction.emoji === emoji)?.reactedByViewer);
    const generation = selectionGeneration.current;
    setMessages((current) => current.map((item) => item.id === message.id ? toggleReaction(item, emoji) : item));
    setOpenReactionPicker(null);
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (generation !== selectionGeneration.current) return;
        const updated = await DirectMessagesService[removing ? "removeReaction" : "reactToMessage"]({
          idToken,
          conversationId: message.conversationId,
          messageId: message.id,
          emoji,
        });
        if (generation !== selectionGeneration.current) return;
        loadGeneration.current += 1;
        replaceMessage(updated);
        setMessageActionError(null);
        setActiveMessageActions(null);
      } catch {
        if (generation !== selectionGeneration.current) return;
        replaceMessage(message);
        setMessageActionError({
          messageId: message.id,
          message: "Couldn’t update that reaction. Try again.",
        });
      } finally {
        reactionPending.current.delete(reactionKey);
      }
    })();
  };

  const confirmDelete = () => {
    if (!user || !deleteRequest) return;
    const { message, scope } = deleteRequest;
    const generation = selectionGeneration.current;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (generation !== selectionGeneration.current) return;
        const result = await DirectMessagesService.deleteMessage({
          idToken,
          conversationId: message.conversationId,
          messageId: message.id,
          scope,
        });
        if (generation !== selectionGeneration.current) return;
        loadGeneration.current += 1;
        if (result.message) replaceMessage(result.message);
        else setMessages((current) => current.filter((item) => item.id !== message.id));
        setMessageActionError(null);
        setDeleteRequest(null);
        setActiveMessageActions(null);
      } catch {
        if (generation !== selectionGeneration.current) return;
        setDeleteRequest(null);
        setMessageActionError({
          messageId: message.id,
          message: "Couldn’t delete this message. Try again.",
        });
      }
    })();
  };

  if (!user && !authLoading) {
    return (
      <AppPageShell width="agent" fitContent>
        <section className={styles.unauthenticated}>
          <MessageCircle className="h-7 w-7" aria-hidden="true" />
          <h1>Messages</h1>
          <p>Sign in to see conversations with your connections.</p>
          <Button asChild variant="blue-gradient" effect="fill">
            <Link href="/login">Sign in</Link>
          </Button>
        </section>
      </AppPageShell>
    );
  }

  const laneSwitcher = (
    <div className={styles.laneSwitcher} role="tablist" aria-label="Chat lanes">
      <button type="button" role="tab" aria-selected={lane === "people"}
        onClick={() => setLane("people")}>People</button>
      <button type="button" role="tab" aria-selected={lane === "circles"}
        onClick={() => setLane("circles")}>Circles</button>
    </div>
  );
  const themeToggle = (
    <button type="button" className={styles.refreshButton}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      onClick={() => setTheme(isDark ? "light" : "dark")}>
      {isDark ? <SunIcon className="h-5 w-5" aria-hidden="true" /> : <MoonIcon className="h-5 w-5" aria-hidden="true" />}
    </button>
  );

  return (
    <AppPageShell width="expanded" fitContent={false} className={styles.shell}>
      <section
        ref={pageRef}
        className={styles.page}
        data-one-chat-surface
        data-direct-message-page="true"
        data-theme={isDark ? "dark" : "light"}
        data-chat-lane={lane}
        data-chat-open={(lane === "people" ? hasRouteSelection : circleThreadOpen) ? "true" : "false"}

        data-native-route="native-route-direct-messages"
      >
        <aside className={styles.inbox} aria-label="Conversations">
          <header className={styles.inboxHeader}>
            <div className={styles.inboxHeading}>
              <Link href={ROUTES.HOME} className={styles.refreshButton} aria-label="Back to Home">
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </Link>
              <h1>Chat</h1>
            </div>
            <div className={styles.inboxHeaderActions}>
              {themeToggle}
              <button type="button" className={styles.refreshButton} aria-label="New chat" onClick={() => {
                setNewChatQuery(""); setNewChatPage(1); setNewChatPeople([]); setNewChatHasMore(false); setNewChatOpen(true);
              }}><Pencil className="h-5 w-5" aria-hidden="true" /></button>
              <button type="button" className={styles.refreshButton}
                aria-label="Refresh conversations" onClick={() => void loadInbox()} disabled={loadingInbox}>
                <RefreshCw className={cn("h-4 w-4", loadingInbox && "animate-spin motion-reduce:animate-none")}
                  aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className={styles.inboxSearch}>
            <label className={styles.inboxSearchField}>
              <Search className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Search conversations</span>
              <input
                type="search"
                value={inboxSearch}
                onChange={(event) => setInboxSearch(event.target.value)}
                placeholder="Search chats"
                aria-label="Search conversations"
              />
            </label>
          </div>
          {laneSwitcher}
          <nav className={styles.conversationList} aria-label="Conversation list">
            {loadingInbox && inboxItems.length === 0 ? (
              <p className={styles.loading}>Loading conversations…</p>
            ) : null}
            {inboxError && inboxItems.length === 0 ? (
              <div className={styles.errorState} role="alert">
                <p>{inboxError}</p>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  onClick={() => void loadInbox()}
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {!loadingInbox && !inboxError && visibleConversations.length === 0 ? (
              <div className={styles.emptyInbox}>
                <MessageCircle className="h-7 w-7" aria-hidden="true" />
                <h2>{inboxSearch ? "No matching chats" : "No chats yet"}</h2>
                <p>{inboxSearch ? "Try another name or message." : "Choose a connection to start chatting."}</p>
                {!inboxSearch ? <button type="button" className={styles.newChatAction} onClick={() => {
                  setNewChatQuery(""); setNewChatPage(1); setNewChatPeople([]); setNewChatHasMore(false); setNewChatOpen(true);
                }}>New chat</button> : null}
              </div>
            ) : null}
            {visibleConversations.map((conversation) => {
              const active =
                activeConversationId === conversation.id ||
                requestedConversationId === conversation.id ||
                (Boolean(requestedPersonRef) &&
                  requestedPersonRef === conversation.peerPersonRef);
              const lastMessageAt =
                conversation.lastMessageAt || conversation.latestMessage?.createdAt;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  className={styles.conversationRow}
                  data-active={active ? "true" : undefined}
                  onClick={() => openConversation(conversation)}
                >
                  <ConnectionPersonAvatar
                    label={conversationLabel(conversation)}
                    photoUrl={conversation.peerPhotoUrl}
                    size="list"
                    className={styles.conversationAvatar}
                  />
                  <span className={styles.conversationCopy}>
                    <span className={styles.conversationName}>
                      {conversationLabel(conversation)}
                    </span>
                    <span className={styles.conversationPreview}>
                      {conversationPreview(conversation)}
                    </span>
                  </span>
                  <span className={styles.conversationMeta}>
                    <time dateTime={lastMessageAt || undefined}>
                      {formatConversationTime(lastMessageAt)}
                    </time>
                    {conversation.unreadCount > 0 ? (
                      <span className={styles.unreadCount} aria-label={`${conversation.unreadCount} unread`}>
                        {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>
        <main className={styles.thread} aria-live="polite">
          {!hasRouteSelection ? (
            <section className={styles.selectThread} aria-label="Select a conversation">
              <MessageCircle className="h-9 w-9" aria-hidden="true" />
              <h2>Your messages</h2>
              <p>Select a conversation to see the chat here.</p>
            </section>
          ) : null}
          {hasRouteSelection ? (
            <>
              <header className={styles.threadHeader} data-search-open={messageSearchOpen || undefined}>
                <div className={styles.threadHeaderContent}>
                  <button
                    type="button"
                    className={styles.backButton}
                    aria-label="Back to messages"
                    onClick={backToConnections}
                  >
                    <ArrowLeft className="h-6 w-6" aria-hidden="true" />
                  </button>
                  <div className={styles.threadIdentity}>
                    <ConnectionPersonAvatar
                      label={selectedLabel}
                      photoUrl={thread.peerPhotoUrl}
                      size="list"
                      className={styles.threadAvatar}
                    />
                    <div className={styles.threadTitle}>
                      <h2 title={selectedLabel}>{selectedLabel}</h2>
                    </div>
                  </div>
                  <div className={styles.threadHeaderActions}>
                    {messageSearchOpen ? (
                      <label className={styles.threadSearchField}>
                        <Search className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">Search messages</span>
                        <input
                          autoFocus
                          type="search"
                          value={messageSearchQuery}
                          onChange={(event) => setMessageSearchQuery(event.target.value)}
                          placeholder="Search messages"
                          aria-label="Search messages"
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setMessageSearchOpen(false);
                              setMessageSearchQuery("");
                            }
                          }}
                        />
                        {messageSearchSummary ? (
                          <output className={styles.threadSearchCount} aria-live="polite">
                            {messageSearchSummary}
                          </output>
                        ) : null}
                        <button
                          type="button"
                          className={styles.threadSearchClear}
                          aria-label="Close message search"
                          onClick={() => {
                            setMessageSearchOpen(false);
                            setMessageSearchQuery("");
                          }}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </label>
                    ) : (
                      <button
                        type="button"
                        className={styles.headerAction}
                        aria-label="Search messages"
                        title="Search messages"
                        onClick={() => setMessageSearchOpen(true)}
                      >
                        <Search className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.headerAction}
                      aria-label="Start voice call"
                      title="Calls are not available yet"
                      onClick={() => morphyToast.info("Calls are not available yet.")}
                    >
                      <PhoneCall className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </header>

              <div
                className={styles.messageList}
                ref={messageListRef}
                data-testid="direct-message-list"
                role="log"
                aria-live={atBottom && foreground() ? "polite" : "off"}
                onScroll={(event) => {
                  const node = event.currentTarget; const next = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
                  atBottomRef.current = next; setAtBottom(next); if (next) setReadRevision((value) => value + 1);
                }}
                aria-label={`${selectedLabel} message feed`}
              >
                {loadingThread && messages.length === 0 ? (
                  <p className={styles.loading}>Loading messages…</p>
                ) : null}
                {threadError && messages.length === 0 && !thread.disconnectedNotice ? (
                  <div className={styles.threadError} role="alert">
                    <p>{threadError}</p>
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      onClick={() => void loadThread()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : null}
                {thread.nextBefore ? (
                  <Button
                    type="button"
                    variant="none"
                    effect="fade"
                    className={styles.loadOlder}
                    disabled={loadingOlder}
                    onClick={() => void loadOlderMessages()}
                  >
                    {loadingOlder ? "Loading…" : "Load older messages"}
                  </Button>
                ) : null}
                {normalizedMessageSearch && messages.length > 0 && visibleMessages.length === 0 ? (
                  <div className={styles.emptyThread} role="status">
                    <Search className="h-7 w-7" aria-hidden="true" />
                    <p>No messages match “{messageSearchQuery.trim()}”.</p>
                  </div>
                ) : null}
                {!resolvingSelection && !loadingThread && messages.length === 0 && thread.disconnectedNotice ? (
                  <div className={styles.emptyThread} role="status">
                    <MessageCircle className="h-7 w-7" aria-hidden="true" />
                    <p>{thread.disconnectedNotice}</p>
                  </div>
                ) : null}
                {!loadingThread && messages.length === 0 && !threadError && !thread.disconnectedNotice ? (
                  <div className={styles.emptyThread}>
                    <MessageCircle className="h-7 w-7" aria-hidden="true" />
                    <p>Start the conversation with {selectedLabel}.</p>
                  </div>
                ) : null}
                {visibleMessages.map((message, index) => {

                  return (
                    <div key={message.id} className={styles.messageFeedItem} data-group-start={index === 0 || visibleMessages[index - 1]?.senderIsViewer !== message.senderIsViewer || isNewMessageDay(message, visibleMessages[index - 1])}>
                      {isNewMessageDay(message, visibleMessages[index - 1]) ? (
                        <div className={styles.messageDateMarker}>
                          <time dateTime={message.createdAt}>
                            {formatMessageFeedMarker(message.createdAt)}
                          </time>
                        </div>
                      ) : null}
                      <article
                        className={cn(
                          "flex w-full items-end gap-2",
                          message.senderIsViewer ? "justify-end" : "justify-start",
                        )}
                        data-chat-message={message.id}
                        data-message-role={message.senderIsViewer ? "user" : "peer"}
                        data-message-sent-at={message.createdAt}
                        data-actions-visible={
                          activeMessageActions === message.id ? "true" : undefined
                        }
                        onPointerEnter={(event) => {
                          if (event.pointerType === "mouse" && !openMessageMenu) {
                            setActiveMessageActions(message.id);
                          }
                        }}
                        onFocusCapture={() => {
                          if (!openMessageMenu) setActiveMessageActions(message.id);
                        }}
                        onBlurCapture={(event) => {
                          if (!openMessageMenu && !event.currentTarget.matches(":hover") &&
                            !event.currentTarget.contains(event.relatedTarget)) {
                            setActiveMessageActions((current) =>
                              current === message.id ? null : current,
                            );
                          }
                        }}
                        onPointerDown={(event) => handleMessagePointerDown(event, message)}
                        onPointerUp={clearMessageLongPress}
                        onPointerCancel={clearMessageLongPress}
                        onPointerLeave={(event) => {
                          clearMessageLongPress();
                          if (event.pointerType === "mouse" && !openMessageMenu &&
                            !event.currentTarget.contains(document.activeElement)) {
                            setActiveMessageActions((current) =>
                              current === message.id ? null : current,
                            );
                          }
                        }}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("button, textarea")) return;
                          setActiveMessageActions(message.id);
                        }}
                      >
                        {!message.senderIsViewer ? (
                          <ConnectionPersonAvatar
                            label={selectedLabel}
                            photoUrl={thread.peerPhotoUrl}
                            size="list"
                            className={styles.messagePeerAvatar}
                          />
                        ) : null}
                        <div
                          className={cn(
                            styles.messageCluster,
                            "group relative flex min-w-0 items-end gap-1",
                            message.senderIsViewer && "flex-row-reverse",
                          )}
                        >
                          <div className={styles.messageContent}>
                            <div className={styles.messageBubbleWrap}>
                              <OneChatBubble
                                data-chat-bubble="true"
                                tone={message.senderIsViewer ? "user" : "assistant"}
                                className={cn(
                                  styles.messageBubble,
                                  !message.senderIsViewer && styles.peerMessageBubble,
                                )}
                              >
                                {message.deletedForEveryoneAt ? (
                                  <p className={styles.deletedMessage}>This message was deleted.</p>
                                ) : (
                                  <>
                                    {message.replyTo ? (
                                      <div className={styles.replyPreview}>
                                        <span>{message.replyTo.senderIsViewer ? "You" : selectedLabel}</span>
                                        <p>{message.replyTo.content}</p>
                                      </div>
                                    ) : null}
                                    {message.content ? <p className="whitespace-pre-wrap break-words">
                                      {message.content}
                                    </p> : null}
                                    <MessageAttachment message={message} getIdToken={() => {
                                      if (!user) throw new Error("Sign in to open this attachment.");
                                      return user.getIdToken();
                                    }} />
                                  </>
                                )}
                                  <div className={styles.messageBubbleMeta}>
                                    {message.editedAt ? <span>Edited</span> : null}
                                    <span className={styles.messageTimestamp}>
                                      <time
                                        dateTime={message.createdAt}
                                        title={new Date(message.createdAt).toLocaleString()}
                                      >
                                        {formatMessageTime(message.createdAt)}
                                      </time>
                                    </span>
                                    {message.senderIsViewer ? (
                                      <span
                                        className={styles.messageDeliveryState}
                                        aria-label={message.readAt ? "Read" : "Sent"}
                                        title={message.readAt ? "Read" : "Sent"}
                                      >
                                        {message.readAt ? (
                                          <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
                                        ) : (
                                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                                        )}
                                      </span>
                                    ) : null}
                                  </div>
                              </OneChatBubble>
                              <div className={styles.messageActions} aria-label="Message actions">
                                {!message.deletedForEveryoneAt ? (
                                  <Popover open={openReactionPicker === message.id}
                                    onOpenChange={(open) => setOpenReactionPicker(open ? message.id : null)}>
                                    <PopoverTrigger asChild>
                                      <button type="button" className={styles.messageActionButton}
                                        aria-label="React to message" aria-expanded={openReactionPicker === message.id}>
                                        <span aria-hidden="true">☺</span>
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent side="top" align={message.senderIsViewer ? "end" : "start"}
                                      collisionPadding={12} className={styles.reactionPicker} aria-label="Choose a reaction">
                                      {QUICK_REACTIONS.map((emoji) => (
                                        <button key={emoji} type="button" aria-label={`React ${emoji}`}
                                          onClick={() => saveReaction(message, emoji)}>{emoji}</button>
                                      ))}
                                    </PopoverContent>
                                  </Popover>
                                ) : null}
                                <DropdownMenu
                                  modal={false}
                                  open={openMessageMenu === message.id}
                                  onOpenChange={(open) => {
                                    setOpenMessageMenu(open ? message.id : null);
                                    if (open) setActiveMessageActions(message.id);
                                  }}
                                >
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      className={styles.messageActionButton}
                                      aria-label="Message options"
                                      aria-expanded={openMessageMenu === message.id}
                                    >
                                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    side="top"
                                    align={message.senderIsViewer ? "end" : "start"}
                                    collisionPadding={12}
                                    className={styles.messageMenu}
                                  >
                                    {!message.deletedForEveryoneAt ? (
                                      <DropdownMenuItem onSelect={() => startReply(message)}>
                                        <Quote className="h-3.5 w-3.5" aria-hidden="true" />
                                        Reply
                                      </DropdownMenuItem>
                                    ) : null}
                                    {message.senderIsViewer && !message.deletedForEveryoneAt ? (
                                      <DropdownMenuItem onSelect={() => startEditing(message)}>
                                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                        Edit
                                      </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onSelect={() => {
                                        setOpenMessageMenu(null);
                                        setDeleteRequest({ message, scope: "me" });
                                      }}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                      Delete for me
                                    </DropdownMenuItem>
                                    {message.senderIsViewer && !message.deletedForEveryoneAt ? (
                                      <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={() => {
                                          setOpenMessageMenu(null);
                                          setDeleteRequest({ message, scope: "everyone" });
                                        }}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                        Delete for everyone
                                      </DropdownMenuItem>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </div>
                            {message.reactions?.length ? (
                              <div className={styles.messageReactions} aria-label="Message reactions">
                                {message.reactions.map((reaction) => (
                                  <button
                                    key={reaction.emoji}
                                    type="button"
                                    className={styles.reactionChip}
                                    data-reacted-by-viewer={reaction.reactedByViewer || undefined}
                                    aria-label={`${reaction.emoji} reaction, ${reaction.count}`}
                                    onClick={() => saveReaction(message, reaction.emoji)}
                                  >
                                    <span>{reaction.emoji}</span>
                                    <span>{reaction.count}</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            {messageActionError?.messageId === message.id ? (
                              <p className={styles.messageActionError} role="status">
                                {messageActionError.message}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    </div>
                  );
                })}
                <div ref={bottomRef} className={styles.bottomMarker} />
              </div>

                {!atBottom && messages.length > 0 ? <button type="button" className={styles.latestControl} onClick={() => {
                  atBottomRef.current = true; setAtBottom(true); if (messageListRef.current) messageListRef.current.scrollTop = messageListRef.current.scrollHeight; setReadRevision((value) => value + 1);
                }}>Go to latest messages</button> : null}
            </>
          ) : null}
                  {lane === "people" ? <AgentDockPortal enabled visible={hasRouteSelection}
                    suppressed={!hasRouteSelection}>
                  <form
                    className={styles.composer}
                    data-direct-message-inbox-composer={!hasRouteSelection || undefined}
                    onSubmit={(event) => void sendDraft(event)}
                  >
                    <input ref={photoInputRef} hidden type="file" accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => { chooseAttachment(event.target.files?.[0]); event.target.value = ""; }} />
                    <input ref={videoInputRef} hidden type="file" accept="video/mp4,video/webm"
                      onChange={(event) => { chooseAttachment(event.target.files?.[0]); event.target.value = ""; }} />
                    <input ref={documentInputRef} hidden type="file"
                      accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,.pdf,.docx,.txt"
                      onChange={(event) => { chooseAttachment(event.target.files?.[0]); event.target.value = ""; }} />
                    {hasRouteSelection && !thread.canSend && messages.length > 0 ? (
                      <div className={styles.readOnlyNotice} role="status">
                        {thread.disconnectedNotice || "You are no longer connected."}
                      </div>
                    ) : null}
                    {replyingTo ? (
                      <div className={styles.composerReplyPreview}>
                        <div>
                          <strong>Replying to {replyingTo.senderIsViewer ? "yourself" : selectedLabel}</strong>
                          <span>{replyingTo.content}</span>
                        </div>
                        <button
                          type="button"
                          aria-label="Cancel reply"
                          disabled={sending || Boolean(unconfirmedDraft)}
                          onClick={() => { replyDrafts.current.delete(routeSelection); setReplyingTo(null); }}
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                    {attachment ? <div className={styles.attachmentPreview} role="status">
                      <span title={attachment.name}>{attachment.name} · {(attachment.size / 1024 / 1024).toFixed(1)} MB</span>
                      <button type="button" aria-label="Remove attachment" onClick={() => {
                        attachmentDrafts.current.delete(routeSelection); setAttachment(null);
                      }}><X className="h-4 w-4" aria-hidden="true" /></button>
                    </div> : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className={styles.attachButton} aria-label="Add attachment"
                          disabled={sending || !canCompose || Boolean(unconfirmedDraft)}>
                          <Plus className="h-5 w-5" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top" className={styles.attachmentMenu}>
                        <DropdownMenuItem onSelect={() => photoInputRef.current?.click()}>
                          <ImageIcon className="h-4 w-4" aria-hidden="true" /> Photo
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => videoInputRef.current?.click()}>
                          <ImageIcon className="h-4 w-4" aria-hidden="true" /> Video
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => documentInputRef.current?.click()}>
                          <FileText className="h-4 w-4" aria-hidden="true" /> Document
                        </DropdownMenuItem>
                        <p className={styles.attachmentLimit}>Up to 5 MB</p>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <label className="sr-only" htmlFor="direct-message-draft">
                      {hasRouteSelection ? `Message ${selectedLabel}` : "Message"}
                    </label>
                    <textarea
                      id="direct-message-draft"
                      ref={composerRef}
                      value={draft}
                      onChange={(event) => {
                        setComposerError(null);
                        drafts.current.set(routeSelection, event.target.value);
                        setDraft(event.target.value);
                      }}
                      placeholder={hasRouteSelection ? `Message ${selectedLabel}` : "Message"}
                      maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                      disabled={!canCompose}
                      readOnly={sending || Boolean(unconfirmedDraft)}
                      rows={1}
                      className={styles.composerInput}
                      data-direct-message-composer-input="true"
                      onFocus={(event) => {
                        const input = event.currentTarget;
                        requestAnimationFrame(() => {
                          input.scrollIntoView?.({ block: "nearest" });
                        });
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.shiftKey ||
                          event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || window.matchMedia("(pointer: coarse)").matches
                        ) {
                          return;
                        }
                        event.preventDefault();
                        if ((draft.trim() || attachment) && !sending) event.currentTarget.form?.requestSubmit();
                      }}
                    />
                    <DirectMessageEmojiPicker
                      disabled={sending || !canCompose || Boolean(unconfirmedDraft)}
                      onEmojiSelect={(emoji) => {
                        const input = composerRef.current;
                        const start = input?.selectionStart ?? draft.length;
                        const end = input?.selectionEnd ?? start;
                        setDraft((current) => {
                          const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
                          drafts.current.set(routeSelection, next);
                          return next;
                        });
                        requestAnimationFrame(() => {
                          input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length);
                        });
                      }}
                    />
                    <div className={styles.composerActions}>
                      {!draft.trim() && !attachment && !sending ? <button
                        type="button"
                        className={styles.voiceButton}
                        aria-label="Talk to One"
                        onClick={openOneVoiceChat}
                      >
                        <Mic className="h-4 w-4" aria-hidden="true" />
                      </button> : <button
                        type="submit"
                        className={styles.sendButton}
                        disabled={sending || !canCompose || (!draft.trim() && !attachment)}
                        aria-label={unconfirmedDraft ? "Retry" : "Send message"}
                      >
                        {sending ? (
                          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <Send className="h-5 w-5" aria-hidden="true" />
                        )}
                      </button>}
                    </div>
                    <span className="sr-only" aria-live="polite">
                      {draft.length}/{DIRECT_MESSAGE_MAX_LENGTH}
                    </span>
                    {composerError ? (
                      <p className={styles.composerError} role="status">
                        {composerError}
                      </p>
                    ) : null}
                  </form>
                  </AgentDockPortal> : null}
              <Dialog modal open={Boolean(editingMessage)} onOpenChange={(open) => {
                if (!open) { editDraftGeneration.current += 1; setEditingMessage(null); setEditingContent(""); }
              }}>
                <DialogContent className={styles.editDialog} srDescription="Update the text of your message.">
                  <DialogHeader><DialogTitle>Edit message</DialogTitle></DialogHeader>
                  <label className="sr-only" htmlFor="message-edit-text">Edit message</label>
                  <div className={styles.expandedMessageEditor}>
                  <textarea id="message-edit-text" ref={editingInputRef}
                    value={editingContent} maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                    className={styles.messageEditInput}
                    onChange={(event) => { editDraftGeneration.current += 1; setEditingContent(event.target.value); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !window.matchMedia("(pointer: coarse)").matches) {
                        event.preventDefault();
                        saveEdit();
                      }
                    }} />
                  <div className={styles.messageEditActions}>
                    <Button onClick={() => { editDraftGeneration.current += 1; setEditingMessage(null); setEditingContent(""); }}>Cancel</Button>
                    <Button variant="blue-gradient" disabled={!editingContent.trim()} onClick={saveEdit}>Save</Button>
                  </div>
                  </div>
                </DialogContent>
              </Dialog>
              <AlertDialog
                open={Boolean(deleteRequest)}
                onOpenChange={(open) => {
                  if (!open) setDeleteRequest(null);
                }}
              >
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {deleteRequest?.scope === "everyone"
                        ? "Delete for everyone?"
                        : "Delete this message?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {deleteRequest?.scope === "everyone"
                        ? "This removes the message for both people in this conversation."
                        : "This removes the message from your view of this conversation."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>No, keep it</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={confirmDelete}>
                      Yes, delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
        </main>
        {lane === "circles" ? <CircleMessagesPane theme={isDark ? "dark" : "light"} onThreadOpenChange={setCircleThreadOpen}
          laneSwitcher={<div className={styles.circleLaneSwitcher}>{laneSwitcher}{themeToggle}</div>} /> : null}
      </section>
      <Dialog open={newChatOpen} onOpenChange={setNewChatOpen}>
        <DialogContent className={styles.newChatDialog} srDescription="Choose a connection to message.">
          <DialogHeader><DialogTitle>New chat</DialogTitle></DialogHeader>
          <input type="search" aria-label="Search connections" placeholder="Search connections"
            className={styles.newChatSearch} value={newChatQuery} onChange={(event) => {
              setNewChatQuery(event.target.value); setNewChatPage(1); setNewChatPeople([]); setNewChatHasMore(false);
            }} />
          <div className={styles.newChatResults}>
            {newChatLoading && !newChatPeople.length ? <p role="status">Loading connections…</p> : null}
            {newChatError ? <p role="alert">Connections are unavailable. Try your search again.</p> : null}
            {!newChatLoading && !newChatError && !newChatPeople.length ? <p>No connections found.</p> : null}
            {newChatPeople.map((person) => <button type="button" key={person.userId} className={styles.newChatPerson}
              aria-label={`Message ${person.displayName || "connection"}`}
              disabled={!person.publicPersonRef} onClick={() => {
                if (!person.publicPersonRef) return;
                setNewChatOpen(false);
                void navigateDirectMessage(router, { personRef: person.publicPersonRef });
              }}>
              <ConnectionPersonAvatar label={person.displayName || "Connection"} photoUrl={person.photoUrl} size="list" />
              <span>{person.displayName || "Connection"}</span>
            </button>)}
            {newChatHasMore ? <button type="button" className={styles.newChatMore} disabled={newChatLoading}
              onClick={() => setNewChatPage((page) => page + 1)}>Load more</button> : null}
          </div>
        </DialogContent>
      </Dialog>
    </AppPageShell>
  );
}

export { parseSseFrames };
