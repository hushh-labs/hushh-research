"use client";

import { formatMessageTime, formatMessageFeedMarker, formatConversationTime } from "@/lib/direct-messages/message-timestamps";
import { replaceMessageHistory } from "@/lib/direct-messages/message-history";
import { writeLastMessagesSelection, type LastMessagesSelection } from "@/lib/direct-messages/last-selection";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AgentDockPortal, useAgentDockFrame } from "@/components/agent/agent-dock";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { navigateDirectMessage, resolveDirectMessageHref } from "@/lib/direct-messages/navigate-direct-message";
import { OneChatBubble } from "@/components/agent/chat-message-styles";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ConnectionsService, type ConnectionSummaryEntry } from "@/lib/services/connections-service";
import { DirectMessageEmojiPicker } from "@/components/direct-messages/direct-message-emoji-picker";
import { useLongPress } from "@/lib/morphy-ux/hooks/use-long-press";
import { DirectMessageVoiceRecorder } from "./direct-message-voice-recorder";
import { DirectMessageVoicePlayer } from "./direct-message-voice-player";
import { DirectMessageInboxRow } from "./direct-message-inbox-row";
import { shareFile } from "@/lib/share/share-file";
import { isShareCancellationError } from "@/lib/share/share-link";
import { CircleMessagesPane } from "@/components/connect/circles/circle-messages-pane";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  Smile,
  MoonIcon,
  SunIcon,
  Plus,
  Image as ImageIcon,
  FileText,
  Info,
  Download,
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
  buildPersonProfileRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { requestAgentConversationAfterRoute } from "@/lib/agent/agent-voice-settings";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";

import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { chatReadIsBlocked, subscribeChatLayerChanges } from "@/lib/interaction/chat-read-visibility";
import { useChatAlertVisibility } from "@/lib/notifications/chat-alert-visibility";
import { useVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

import styles from "./direct-messages-page.module.css";
import { WalletSharedCardMessage } from "@/components/wallet/wallet-shared-card-message";
import { WalletCardAccessMessage } from "@/components/wallet/wallet-card-access-message";
import { cardAccessReference } from "@/lib/services/wallet-card-access-service";
import { isWalletCardShare, walletMessagePreview } from "@/lib/wallet/wallet-card-share";
import { cardRequestReference, walletCardRequestHref } from "@/lib/wallet/card-request";

type ThreadState = {
  conversation: DirectMessageConversation | null;
  peerPersonRef: string | null;
  peerDisplayName: string | null;
  peerPhotoUrl: string | null;
  canSend: boolean;
  disconnectedNotice: string | null;
  nextBefore: string | null;
};

type MessageMenuOpening = {
  generation: number;
  sequence: number;
  conversationId: string;
  messageId: string;
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

function PeerProfileLink({ href, label, className, children }: {
  href: string | null;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  if (!href) return <>{children}</>;
  return <Link href={href} prefetch={false} aria-label={`View ${label}'s profile`}
    className={cn(styles.peerProfileLink, className)}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.stopPropagation()}>
    {children}
  </Link>;
}


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

function MessageAttachment({ message, getIdToken, onPhotoLoad, isCurrentVisit }: {
  message: DirectMessage;
  getIdToken: () => Promise<string>;
  onPhotoLoad: () => void;
  isCurrentVisit: () => boolean;
}) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const active = useRef(true);
  const originalAccess = useRef({ isCurrentVisit, getIdToken });
  const isCurrent = useCallback(() => active.current && originalAccess.current.isCurrentVisit(), []);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);
  const attachment = message.attachment;
  const photoRef = useRef<HTMLDivElement>(null);
  const [photoVisible, setPhotoVisible] = useState(false);
  useEffect(() => {
    const node = photoRef.current;
    if (attachment?.kind !== "photo" || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!isCurrent() || !entry?.isIntersecting) return;
      setPhotoVisible(true);
      observer.disconnect();
    }, { rootMargin: "80px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [attachment?.kind, message.conversationId, message.id, isCurrent]);
  useEffect(() => {
    if (!isCurrent() || attachment?.kind !== "photo" || !photoVisible) return;
    let current = true;
    const effectIsCurrent = () => current && isCurrent();
    let url: string | null = null;
    setOpening(true);
    void (async () => {
      if (!effectIsCurrent()) return;
      const idToken = await originalAccess.current.getIdToken();
      if (!effectIsCurrent()) return;
      const blob = await DirectMessagesService.getAttachment({ idToken,
        conversationId: message.conversationId, messageId: message.id,
        isEffectCurrent: effectIsCurrent });
      if (!effectIsCurrent()) return;
      url = URL.createObjectURL(blob);
      setMediaUrl(url);
    })().catch(() => {
      // Keep the Open control available for an explicit retry.
    }).finally(() => { if (effectIsCurrent()) setOpening(false); });
    return () => { current = false; if (url) URL.revokeObjectURL(url); };
  }, [attachment?.kind, message.conversationId, message.id, photoVisible, isCurrent]);
  if (!attachment) return null;
  const typeLabel = ({ "application/pdf": "PDF", "text/plain": "Text file",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
    "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP",
    "video/mp4": "MP4 file", "video/webm": "WebM file" } as Record<string, string>)[attachment.mimeType] || "File";
  const loadAttachment = async () => {
    if (!isCurrent()) throw new DOMException("Attachment request expired.", "AbortError");
    const idToken = await originalAccess.current.getIdToken();
    if (!isCurrent()) throw new DOMException("Attachment request expired.", "AbortError");
    const blob = await DirectMessagesService.getAttachment({ idToken, conversationId: message.conversationId, messageId: message.id, isEffectCurrent: isCurrent });
    if (!isCurrent()) throw new DOMException("Attachment request expired.", "AbortError");
    return blob;
  };
  if (attachment.kind === "audio") return <DirectMessageVoicePlayer durationMs={attachment.durationMs ?? 0} loadAudio={loadAttachment} />;
  const open = async () => {
    if (!isCurrent() || opening) return;
    setOpening(true);
    try {
      const blob = await loadAttachment();
      if (!isCurrent()) return;
      if (attachment.kind !== "photo") {
        await shareFile({ file: new File([blob], attachment.name, { type: attachment.mimeType }), title: attachment.name, isEffectCurrent: isCurrent });
      } else {
        if (mediaUrl) URL.revokeObjectURL(mediaUrl);
        setMediaUrl(URL.createObjectURL(blob));
      }
    } catch (error) {
      if (isCurrent() && !isShareCancellationError(error)) morphyToast.error("This attachment is unavailable. Try again.");
    } finally { if (isCurrent()) setOpening(false); }
  };
  return <div className={styles.messageAttachment} ref={photoRef}>
    {mediaUrl && attachment.kind === "photo" ? (
      // Encrypted attachments use short-lived blob URLs, which Next's image optimizer cannot serve.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={mediaUrl} alt={attachment.name} onLoad={() => { if (isCurrent()) onPhotoLoad(); }} />
    ) : null}
    <div className={styles.fileMessageCard}>
      <FileText className="h-6 w-6" aria-hidden="true" />
      <div><strong title={attachment.name}>{attachment.name}</strong>
        <span>{attachment.size < 1024 * 1024 ? `${(attachment.size / 1024).toFixed(1)} KB` : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`} · {typeLabel}</span></div>
      <button type="button" disabled={opening} aria-busy={opening} aria-label={`${attachment.kind === "photo" ? "Open" : "Download"} ${attachment.name}`} onClick={() => void open()}>
        <Download className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  </div>;
}

function conversationLabel(conversation: DirectMessageConversation): string {
  return conversation.peerDisplayName || "Connection";
}

function conversationPreview(conversation: DirectMessageConversation): string {
  const latest = conversation.latestMessage;
  if (!latest) return "Start a conversation";
  if (latest.deletedForEveryoneAt) return "Message deleted";
  const prefix = latest.senderIsViewer ? "You: " : "";
  const preview = `${prefix}${walletMessagePreview(latest.content) || (latest.attachment ? latest.attachment.kind[0]!.toUpperCase() + latest.attachment.kind.slice(1) : "")}`.replace(/\s+/g, " ").trim();
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

export function DirectMessagesPage({ selection, resolvingSelection = false, restoredSelection = null }: { selection?: { kind: "conversation" | "person"; ref: string } | null; resolvingSelection?: boolean; restoredSelection?: LastMessagesSelection | null } = {}) {
  const { user, loading: authLoading } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const router = useRouter();
  const requestedPersonRef = selection?.kind === "person" ? selection.ref : "";
  const requestedConversationId = selection?.kind === "conversation" ? selection.ref : "";
  const restoredLane = restoredSelection?.lane;
  const [storedThread, setThread] = useState<ThreadState>(EMPTY_THREAD);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [settledReadScopes, setSettledReadScopes] = useState<readonly string[]>([]);
  const [storedInbox, setInbox] = useState<{
    ownerId: string;
    items: DirectMessageConversation[];
  } | null>(null);
  const [inboxSearch, setInboxSearch] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatQuery, setNewChatQuery] = useState("");
  const [newChatPage, setNewChatPage] = useState(1);
  const [newChatPeople, setNewChatPeople] = useState<ConnectionSummaryEntry[]>([]);
  const [newChatHasMore, setNewChatHasMore] = useState(false);
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [newChatError, setNewChatError] = useState(false);
  const [lane, setLane] = useState<"people" | "circles">(restoredSelection?.lane ?? "people");
  const [circleThreadOpen, setCircleThreadOpen] = useState(false);
  const [circleCount, setCircleCount] = useState(0);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [unconfirmedDraft, setUnconfirmedDraft] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [contactInfoOpen, setContactInfoOpen] = useState(false);
  const [chatDeleteRequest, setChatDeleteRequest] = useState<{ ownerId: string; conversation: DirectMessageConversation } | null>(null);
  const [, setChatDeleteRevision] = useState(0);
  const pendingChatDeletes = useRef(new Set<string>());
  const chatDeleteToasts = useRef(new Set<string | number>());
  const chatDeleteLifetime = useRef(true);
  const chatDeleteSession = useRef({ ownerId: user?.uid, epoch: 0 });
  if (chatDeleteSession.current.ownerId !== user?.uid) {
    chatDeleteSession.current = { ownerId: user?.uid, epoch: chatDeleteSession.current.epoch + 1 };
  }
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const jumping = useRef(false);
  const acknowledged = useRef(new Set<string>());
  const [deliveryRevision, setDeliveryRevision] = useState(0);
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
  const loadedReadScopes = useRef<readonly string[]>([]);
  const operationGeneration = useRef(0);
  const messageMenuSequence = useRef(0);
  const messageMenuOpening = useRef<MessageMenuOpening | null>(null);
  const replyFocus = useRef<MessageMenuOpening | null>(null);
  const reactionFocus = useRef<MessageMenuOpening | null>(null);
  const editFocus = useRef<{ opening: MessageMenuOpening; message: DirectMessage } | null>(null);
  const inboxLoadGeneration = useRef(0);
  const successfulInboxOwner = useRef<string | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const invalidateThreadRead = useCallback(() => { ++loadGeneration.current; }, []);
  const invalidateInboxRead = useCallback(() => { ++inboxLoadGeneration.current; }, []);
  const invalidateOperations = useCallback(() => {
    ++operationGeneration.current;
    messageMenuOpening.current = null;
    replyFocus.current = null;
    reactionFocus.current = null;
    editFocus.current = null;
  }, []);
  const pageRef = useRef<HTMLElement | null>(null);
  const dockFrame = useAgentDockFrame();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const editingInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editDraftGeneration = useRef(0);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const messageSearchRef = useRef(messageSearchQuery); messageSearchRef.current = messageSearchQuery;

  const hasRouteSelection = Boolean(resolvingSelection || requestedPersonRef || requestedConversationId);
  const selectedRouteKey = requestedPersonRef
    ? `person:${requestedPersonRef}`
    : requestedConversationId ? `conversation:${requestedConversationId}` : null;
  const readScope = user && selectedRouteKey
    ? JSON.stringify([user.uid, selectedRouteKey]) : null;
  const isCurrentRead = readScope !== null && settledReadScopes.includes(readScope);
  // Reuse the owner-bound read admission for main's loading/status UI. A
  // second route-only completion key could re-admit another owner's thread.
  const pendingSelection = resolvingSelection || loadingThread || (selectedRouteKey !== null && !isCurrentRead);
  const isCurrentInbox = Boolean(user && storedInbox?.ownerId === user.uid);
  const inboxItems = useMemo(() => isCurrentInbox ? storedInbox!.items : [], [isCurrentInbox, storedInbox]);
  // React can render the new owner/selection before effect cleanup runs. Keep
  // the old transcript and send authority concealed during that interval.
  const thread = isCurrentRead ? storedThread : EMPTY_THREAD;
  const currentThread = useRef(thread); currentThread.current = thread;
  const activeConversationId = thread.conversation?.id ?? null;
  const settleReadScope = useCallback((scope: string | null) => {
    const scopes = scope ? [scope] : [];
    loadedReadScopes.current = scopes;
    setSettledReadScopes(scopes);
  }, []);

  useLayoutEffect(() => {
    invalidateOperations();
    setSending(false);
    setLoadingOlder(false);
    setOpenMessageMenu(null);
    setActiveMessageActions(null);
    setReplyingTo(null);
    setEditingMessage(null);
    setEditingContent("");
    setDeleteRequest(null);
    setComposerError(null);
    setMessageActionError(null);
    return invalidateOperations;
  }, [invalidateOperations, readScope]);

  useLayoutEffect(() => {
    invalidateInboxRead();
    successfulInboxOwner.current = null;
    setInboxSearch("");
    setInboxError(null);
    setLoadingInbox(Boolean(user?.uid));
    return invalidateInboxRead;
  }, [invalidateInboxRead, user?.uid]);
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

  const routeSelection = JSON.stringify([user?.uid ?? null, requestedPersonRef ? "person" : "conversation", requestedPersonRef || requestedConversationId]);
  const draftScope = routeSelection;
  useEffect(() => {
    if (requestedPersonRef || requestedConversationId) setLane("people");
    else if (restoredLane) setLane(restoredLane);
  }, [requestedPersonRef, requestedConversationId, restoredLane]);
  const selectionRef = useRef(routeSelection);
  const readAdmission = useRef({ ownerId: user?.uid, scope: readScope, admitted: isCurrentRead, resolvingSelection, lane });
  readAdmission.current = { ownerId: user?.uid, scope: readScope, admitted: isCurrentRead, resolvingSelection, lane };
  const ownerRef = useRef(user?.uid);
  const cleanedOwnerRef = useRef(user?.uid);
  ownerRef.current = user?.uid;
  selectionRef.current = routeSelection;
  const selectionGeneration = operationGeneration;
  const replyDrafts = useRef(new Map<string, DirectMessage | null>());
  const drafts = useRef(new Map<string, string>());
  const attachmentDrafts = useRef(new Map<string, File>());
  const sendAttempts = useRef(new Map<string, { id: string; content: string; replyId?: string; attachment?: File; unconfirmed?: boolean }>());
  const sendingSelections = useRef(new Map<string, object>());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const visibleBottom = useRef(false);
  const atBottomRef = useRef(true);
  const prependPosition = useRef<{ top: number; height: number } | null>(null);
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const reading = useRef(false);
  const readThrough = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [readRevision, setReadRevision] = useState(0);
  const blockingLayer = Boolean(useVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions || contactInfoOpen);
  const messageLongPress = useLongPress(lane !== "people" || !hasRouteSelection || !isCurrentRead || pendingSelection || blockingLayer);
  const cancelMessageLongPress = messageLongPress.cancel;
  const foreground = () => document.visibilityState === "visible" && appInteractionCoordinator.getLifecycleSnapshot().state === "active";
  const bottomIsUncovered = useCallback(() => {
    const marker = bottomRef.current?.getBoundingClientRect();
    const transcript = messageListRef.current?.getBoundingClientRect();
    if (!marker || !transcript || transcript.width <= 0 || transcript.height <= 0 || marker.width <= 0) return false;
    const dock = dockFrame?.getBoundingClientRect();
    const visibleEnd = dock && dock.height > 0 ? Math.min(transcript.bottom, dock.top) : transcript.bottom;
    return marker.top >= transcript.top && marker.bottom <= visibleEnd + 1;
  }, [dockFrame]);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page || !dockFrame) return;
    const publish = () => {
      page.style.setProperty("--direct-message-dock-height", `${Math.ceil(dockFrame.getBoundingClientRect().height)}px`);
      page.style.setProperty("--direct-message-page-top", `${Math.max(0, Math.ceil(page.getBoundingClientRect().top))}px`);
      setReadRevision((value) => value + 1);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(dockFrame);
    window.addEventListener("resize", publish);
    return () => { observer.disconnect(); window.removeEventListener("resize", publish); };
  }, [dockFrame]);

  const invalidateSelection = useCallback(() => {
    invalidateOperations();
    invalidateThreadRead();
  }, [invalidateOperations, invalidateThreadRead]);

  // Read the current render only when selection changes; later history
  // settlement must not reset the selected conversation or its draft.
  const selectionRead = useRef({ requestedConversationId, readScope, conversationId: storedThread.conversation?.id });
  selectionRead.current = { requestedConversationId, readScope, conversationId: storedThread.conversation?.id };
  useEffect(() => {
    chatDeleteLifetime.current = true;
    const handles = chatDeleteToasts.current;
    return () => {
      chatDeleteLifetime.current = false;
      handles.forEach(id => toast.dismiss(id));
      handles.clear();
    };
  }, [user?.uid]);

  const removeDeletedChat = useCallback((conversationId: string, peerPersonRef?: string | null) => {
    const ownerId = user?.uid;
    if (!ownerId || readAdmission.current.ownerId !== ownerId) return;
    invalidateInboxRead();
    setInbox(current => current?.ownerId === ownerId
      ? { ...current, items: current.items.filter(item => item.id !== conversationId) } : current);
    CacheSyncService.onFeedHistoryMutated(ownerId);
    dispatchFeedStateChanged("action");
    const peer = peerPersonRef ?? inboxItems.find(item => item.id === conversationId)?.peerPersonRef;
    const selections = [`conversation:${conversationId}`, ...(peer ? [`person:${peer}`] : [])];
    for (const selection of selections) {
      const scope = JSON.stringify([ownerId, selection]);
      drafts.current.delete(scope); replyDrafts.current.delete(scope);
      attachmentDrafts.current.delete(scope); sendAttempts.current.delete(scope);
    }
    if (readAdmission.current.lane === "people" && (currentThread.current.conversation?.id === conversationId || selections.includes(selectionRef.current))) {
      invalidateSelection();
      loadedReadScopes.current = [];
      setSettledReadScopes([]);
      setThread(EMPTY_THREAD); setMessages([]); setDraft(""); setAttachment(null); setReplyingTo(null);
      setUnconfirmedDraft(null); setComposerError(null); setContactInfoOpen(false);
      replaceMessageHistory(null);
      writeLastMessagesSelection(ownerId, { lane: "people", token: null });
      router.replace(ROUTES.ONE_MESSAGES, { scroll: false });
    }
  }, [inboxItems, invalidateInboxRead, invalidateSelection, router, user?.uid]);

  useLayoutEffect(() => {
    if (cleanedOwnerRef.current !== user?.uid) {
      cleanedOwnerRef.current = user?.uid;
      // Replicas belong to an account, not merely a matching route.
      drafts.current.clear(); replyDrafts.current.clear();
      attachmentDrafts.current.clear(); sendAttempts.current.clear();
      sendingSelections.current.clear(); reactionPending.current.clear();
      setChatDeleteRequest(null);
    }
    cancelMessageLongPress();
    ownerRef.current = user?.uid; invalidateSelection();
    selectionRef.current = routeSelection;
    acknowledged.current.clear(); setContactInfoOpen(false); setJumpTarget(null); setRecordingVoice(false); jumping.current = false;
    readThrough.current = null; reading.current = false; visibleBottom.current = false;
    atBottomRef.current = true; prependPosition.current = null; setAtBottom(true);
    const previousAttempt = sendAttempts.current.get(draftScope);
    setUnconfirmedDraft(previousAttempt?.unconfirmed ? previousAttempt.content : null);
    setDraft(drafts.current.get(draftScope) ?? ""); setAttachment(attachmentDrafts.current.get(draftScope) ?? null); setSending(sendingSelections.current.has(draftScope));
    setReplyingTo(replyDrafts.current.get(draftScope) ?? null); setEditingMessage(null); setEditingContent(""); setDeleteRequest(null); setChatDeleteRequest(null);
    setMessageActionError(null); setComposerError(null); setOpenMessageMenu(null); setOpenReactionPicker(null); setActiveMessageActions(null);
    setLoadingOlder(false);
    // An accepted send admits only this owner's exact destination before
    // encrypted navigation. Preserve it until the destination history settles.
    const observed = selectionRead.current;
    const acceptedHandoff = Boolean(observed.requestedConversationId && observed.readScope
      && loadedReadScopes.current.includes(observed.readScope)
      && observed.conversationId === observed.requestedConversationId);
    if (!acceptedHandoff) { setMessages([]); setThread(EMPTY_THREAD); }
    return invalidateSelection;
  }, [invalidateSelection, routeSelection, draftScope, user?.uid, resolvingSelection, settleReadScope, cancelMessageLongPress]);

  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [draft, thread.canSend]);

  useEffect(() => {
    return () => {
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

  useChatAlertVisibility(lane === "people" && isCurrentRead && hasRouteSelection && activeConversationId && !pendingSelection && !blockingLayer && !messageSearchOpen
    ? `direct-chat:${activeConversationId}` : null, messageListRef);
  const canCompose = hasRouteSelection && !pendingSelection && isCurrentRead && thread.canSend;
  useEffect(() => messageLongPress.cancel, [requestedPersonRef, requestedConversationId, lane, messageLongPress.cancel]);

  const loadInbox = useCallback(
    async (options?: { preserveItems?: boolean }) => {
      if (!user) return;
      const generation = ++inboxLoadGeneration.current;
      const preserveSnapshot = Boolean(options?.preserveItems && successfulInboxOwner.current === user.uid);
      if (!preserveSnapshot) setLoadingInbox(true);
      if (!options?.preserveItems) setInboxError(null);
      try {
        const idToken = await user.getIdToken();
        if (generation !== inboxLoadGeneration.current) return;
        const inbox = await DirectMessagesService.listConversations({ idToken });
        if (generation !== inboxLoadGeneration.current) return;
        successfulInboxOwner.current = user.uid;
        setInbox({ ownerId: user.uid, items: inbox.items });
        setInboxError(null);
      } catch {
        if (generation !== inboxLoadGeneration.current) return;
        if (!preserveSnapshot) {
          successfulInboxOwner.current = null;
          setInbox({ ownerId: user.uid, items: [] });
          setInboxError("Conversations could not be loaded. Check your connection and try again.");
        }
      } finally {
        if (generation === inboxLoadGeneration.current) setLoadingInbox(false);
      }
    },
    [user],
  );

  const loadThread = useCallback(
    async (options?: { preserveMessages?: boolean }) => {
      if (!user || resolvingSelection) return;
      const generation = ++loadGeneration.current;
      const requestKey = requestedPersonRef
        ? `person:${requestedPersonRef}`
        : requestedConversationId
          ? `conversation:${requestedConversationId}`
          : null;
      const requestScope = requestKey ? JSON.stringify([user.uid, requestKey]) : null;

      // A route change must never leave the previous connection's messages
      // visible beneath a new header while the next history request is in flight.
      // Background refreshes of the same route keep the readable transcript.
      if (!requestScope || !loadedReadScopes.current.includes(requestScope)) {
        loadedReadScopes.current = requestScope ? [requestScope] : [];
        setSettledReadScopes([]);
        setMessages([]);
        setThread(EMPTY_THREAD);
      }
      if (!options?.preserveMessages) {
        setLoadingThread(true);
        setSettledReadScopes((current) => requestScope && current.includes(requestScope) ? current : []);
        setThreadError(null);
      }
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
            settleReadScope(requestScope);
            setThreadError(null);
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
          settleReadScope(requestScope);
          setThreadError(null);
          return;
        }

        if (!requestedConversationId) {
          loadedReadScopes.current = [];
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
        settleReadScope(requestScope);
        setThreadError(null);
      } catch (error) {
        if (generation !== loadGeneration.current) return;
        // A short-lived refresh failure must not replace an already readable
        // conversation with a large error panel. The next focus, SSE update,
        // or explicit refresh will retry while the cached thread stays usable.
        if (options?.preserveMessages) {
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
        settleReadScope(requestScope);
      } finally {
        if (generation === loadGeneration.current) {
          setLoadingThread(false);
        }
      }
    },
    [requestedConversationId, requestedPersonRef, resolvingSelection, settleReadScope, user],
  );

  useEffect(() => {
    if (!user) {
      loadedReadScopes.current = [];
      setSettledReadScopes([]);
      setInbox(null);
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
    return invalidateThreadRead;
  }, [invalidateThreadRead, loadThread, user]);

  const refresh = useCallback(() => {
    void loadInbox({ preserveItems: true });
    if (hasRouteSelection) void loadThread({ preserveMessages: true });
  }, [hasRouteSelection, loadInbox, loadThread]);

  useEffect(() => {
    if (!user?.uid) return;
    return subscribeToDirectMessagesUpdated((detail) => {
      if (detail.userId !== user.uid) return;
      if (detail.source === "delete" && detail.conversationId) removeDeletedChat(detail.conversationId);
      if (foreground()) refresh();
    });
  }, [refresh, removeDeletedChat, user?.uid]);

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
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
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
        if (cancelled || !response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          if (cancelled) return;
          throw new Error(`Message updates unavailable (${response.status})`);
        }
        reconnectAttempt = 0;
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let remainder = "";
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          remainder += decoder.decode(value, { stream: true });
          const splitAt = Math.max(
            remainder.lastIndexOf("\n\n"),
            remainder.lastIndexOf("\r\n\r\n"),
          );
          if (splitAt < 0) continue;
          const complete = remainder.slice(0, splitAt + 2);
          remainder = remainder.slice(splitAt + 2);
          for (const frame of parseSseFrames(complete)) {
            if (frame.event !== "direct_message" && frame.event !== "resync") continue;
            const conversationId = String(frame.data.conversationId || "").trim() || null;
            const messageId = String(frame.data.messageId || "").trim() || null;
            dispatchDirectMessagesUpdated({
              userId: user.uid,
              conversationId,
              messageId,
              source: frame.data.action === "conversation_deleted" ? "delete" : "sse",
            });
          }
        }
      } catch {
        // Push, focus refresh and the short reconnect below keep the inbox live
        // when a proxy or network briefly interrupts the stream.
      } finally {
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          reader = null;
        }
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
      // The transport stops forwarding this signal after headers arrive.
      void reader?.cancel().catch(() => undefined);
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
      if (!isCurrentRead || messageSearchQuery.trim() || !user || !activeConversationId || !last || loadingThread || reading.current || readThrough.current === last.id
        || !foreground() || !document.hasFocus() || !atBottomRef.current || !visibleBottom.current || !bottomIsUncovered() || !node || chatReadIsBlocked(node) || node.scrollHeight - node.scrollTop - node.clientHeight > 8) return;
      const generation = selectionGeneration.current;
      reading.current = true;
      try {
        const idToken = await user.getIdToken();
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection) || messageSearchRef.current.trim() || !foreground() || !document.hasFocus()
            || !atBottomRef.current || !visibleBottom.current || !bottomIsUncovered() || !messageListRef.current
            || chatReadIsBlocked(messageListRef.current)
            || messageListRef.current.scrollHeight - messageListRef.current.scrollTop - messageListRef.current.clientHeight > 8) return;
        await DirectMessagesService.markConversationRead({ idToken, ownerUserId: user.uid, conversationId: activeConversationId, throughMessageId: last.id, throughCreatedAt: last.createdAt });
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        readThrough.current = last.id;
        setInbox((current) => current?.ownerId === user.uid ? { ...current, items: current.items.map((conversation) => conversation.id === activeConversationId && messagesRef.current.at(-1)?.id === last.id ? { ...conversation, unreadCount: 0 } : conversation) } : current);
        setThread((current) => current.conversation?.id === activeConversationId && messagesRef.current.at(-1)?.id === last.id
          ? { ...current, conversation: { ...current.conversation, unreadCount: 0 } } : current);
        dispatchDirectMessagesUpdated({ userId: user.uid, conversationId: activeConversationId, messageId: null, source: "read" });
      } catch { /* Retain unread state so the next foreground/read event can retry. */ }
      finally {
        if ((generation === selectionGeneration.current && ownerRef.current === user?.uid && selectionRef.current === routeSelection)) {
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
  }, [isCurrentRead, routeSelection, activeConversationId, loadingThread, messages, readRevision, thread.conversation?.unreadCount, user, blockingLayer, messageSearchQuery, bottomIsUncovered, selectionGeneration]);

  useEffect(() => {
    if (!user) return;
    // An inbox preview contains the received body too. A push hint alone never
    // reaches this effect and never establishes delivery.
    const received = [...inboxItems.flatMap(item => item.latestMessage ? [item.latestMessage] : []),
      ...(!loadingThread && activeConversationId ? messages : [])];
    const batches = new Map<string, Set<string>>();
    for (const message of received) {
      if (message.senderIsViewer || message.deliveredAt || message.readAt || message.deletedForEveryoneAt || acknowledged.current.has(message.id)) continue;
      const batch = batches.get(message.conversationId) ?? new Set<string>();
      if (batch.size < 100) batch.add(message.id);
      batches.set(message.conversationId, batch);
    }
    if (!batches.size) return;
    const generation = selectionGeneration.current;
    let cancelled = false;
    const current = () => !cancelled && generation === selectionGeneration.current && ownerRef.current === user.uid;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (!current()) return;
        for (const [conversationId, batch] of batches) {
          if (!current()) return;
          const messageIds = [...batch];
          await DirectMessagesService.acknowledgeDelivery({ idToken, conversationId, messageIds, isEffectCurrent: current });
          if (!current()) return;
          messageIds.forEach(id => acknowledged.current.add(id));
        }
        setDeliveryRevision(value => value + 1);
      } catch { /* A later history refresh retries; never invent a delivered state. */ }
    })();
    return () => { cancelled = true; };
  }, [activeConversationId, loadingThread, messages, inboxItems, user, deliveryRevision, selectionGeneration]);

  const selectedLabel =
    thread.peerDisplayName || thread.conversation?.peerDisplayName || "Conversation";
  const peerProfileHref = thread.peerPersonRef
    ? buildPersonProfileRoute(thread.peerPersonRef, { from: ROUTES.ONE_MESSAGES })
    : null;
  const admittedMessages = isCurrentRead ? messages : [];
  const normalizedMessageSearch = messageSearchQuery.trim().toLocaleLowerCase();
  const visibleMessages = pendingSelection ? [] : normalizedMessageSearch
    ? admittedMessages.filter((message) =>
        [walletMessagePreview(message.content), message.replyTo ? walletMessagePreview(message.replyTo.content) : null]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedMessageSearch),
      )
    : admittedMessages;
  const messageSearchSummary = normalizedMessageSearch
    ? `${visibleMessages.length} ${visibleMessages.length === 1 ? "match" : "matches"}`
    : "";
  const nativeTest = {
    routeId: "/one/messages",
    marker: "native-route-direct-messages",
    authState: authLoading ? "pending" : user ? "authenticated" : "anonymous",
    dataState: authLoading ? "loading" : !user ? "unavailable-valid"
      : !hasRouteSelection ? !isCurrentInbox ? "loading" : inboxError ? "error" : loadingInbox ? "loading" : inboxItems.length ? "loaded" : "empty-valid"
      : !isCurrentRead || loadingThread ? "loading"
      : threadError ? "error" : admittedMessages.length ? "loaded" : "empty-valid",
    errorCode: !hasRouteSelection && isCurrentInbox && inboxError ? "direct_messages_read"
      : isCurrentRead && threadError ? "direct_messages_read" : null,
  } as const;
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
    writeLastMessagesSelection(user?.uid, { lane: "people", token: null });
    router.replace(ROUTES.ONE_MESSAGES, { scroll: false });
  };

  const chooseLane = (nextLane: "people" | "circles") => {
    if (nextLane === lane) return;
    if (nextLane === "circles") replaceMessageHistory(null);
    writeLastMessagesSelection(user?.uid, nextLane === "people"
      ? { lane: "people", token: null }
      : { lane: "circles", circleId: null });
    setLane(nextLane);
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
      "image/jpeg", "image/png", "image/webp", "audio/wav",
      "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain",
    ];
    if (!allowed.includes(file.type) || file.size > 5 * 1024 * 1024) {
      morphyToast.error("Choose a photo, voice recording, PDF, Word, or text file up to 5 MB.");
      return;
    }
    attachmentDrafts.current.set(draftScope, file);
    setAttachment(file);
    setComposerError(null);
  };

  const sendDraft = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!user || sending || !canCompose) return;
    const content = unconfirmedDraft ?? draft;
    if ((!content.trim() && !attachment) || sendingSelections.current.has(draftScope)) return;
    const generation = selectionGeneration.current;
    const isCurrent = () => (generation === selectionGeneration.current && ownerRef.current === user?.uid && selectionRef.current === routeSelection);
    const reply = replyingTo;
    const replyId = unconfirmedDraft ? sendAttempts.current.get(draftScope)?.replyId : reply?.id;
    let attempt = sendAttempts.current.get(draftScope);
    if (!attempt || attempt.content !== content || attempt.replyId !== replyId || (attempt.attachment ?? null) !== attachment) {
      attempt = { id: crypto.randomUUID(), content, replyId, attachment: attachment ?? undefined }; sendAttempts.current.set(draftScope, attempt);
    }
    const recipientPersonRef = thread.peerPersonRef || requestedPersonRef;
    if (!recipientPersonRef) {
      morphyToast.error("This recipient is no longer available for messaging.");
      return;
    }
    setComposerError(null);
    setSending(true);
    const sendLease = {};
    sendingSelections.current.set(draftScope, sendLease);
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
      drafts.current.delete(draftScope); attachmentDrafts.current.delete(draftScope); sendAttempts.current.delete(draftScope);
      atBottomRef.current = true; setAtBottom(true);
      replyDrafts.current.delete(draftScope);
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
      setInbox((current) => {
        const items = current?.ownerId === user.uid ? current.items : [];
        const withoutConversation = items.filter(
          (conversation) => conversation.id !== result.conversation.id,
        );
        return { ownerId: user.uid, items: [result.conversation, ...withoutConversation] };
      });
      dispatchDirectMessagesUpdated({
        userId: user.uid,
        conversationId: result.conversation.id,
        messageId: result.message.id,
        source: "send",
      });
      // Keep only this owner's accepted source and destination visible while
      // the encrypted route resolves; unrelated selections stay fenced.
      const href = await resolveDirectMessageHref({ conversationId: result.conversation.id }).catch(() => null);
      if (!href || !isCurrent()) return;
      const destinationScope = JSON.stringify([user.uid, `conversation:${result.conversation.id}`]);
      const handoffScopes = readScope ? [readScope, destinationScope] : [destinationScope];
      ++loadGeneration.current;
      loadedReadScopes.current = handoffScopes;
      setSettledReadScopes(handoffScopes);
      router.replace(href, { scroll: false });
    } catch (error) {
      const definiteRefusal = error instanceof DirectMessagesServiceRequestError && [400, 401, 403, 404, 409, 413, 422, 429].includes(error.status);
      if (!isCurrent()) return;
      if (definiteRefusal && sendAttempts.current.get(draftScope) === attempt) sendAttempts.current.delete(draftScope);
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
    const isCurrentOperation = () => (generation === selectionGeneration.current && ownerRef.current === user?.uid && selectionRef.current === routeSelection) && ownerRef.current === user?.uid && selectionRef.current === routeSelection;
    setLoadingOlder(true);
    try {
      const idToken = await user.getIdToken();
      if (!isCurrentOperation()) return;
      const history = await DirectMessagesService.getConversationMessages({
        idToken,
        conversationId,
        before,
        limit: 60,
      });
      if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
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
      if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
      morphyToast.error("Older messages could not be loaded. Try again.");
    } finally {
      if ((generation === selectionGeneration.current && ownerRef.current === user?.uid && selectionRef.current === routeSelection)) setLoadingOlder(false);
    }
  };

  const replaceMessage = (updated: DirectMessage) => {
    setMessages((current) =>
      current.map((message) => (message.id === updated.id && message.conversationId === updated.conversationId ? updated : message)),
    );
  };

  const jumpToOriginal = async (messageId: string) => {
    if (jumping.current || !user || !activeConversationId) return;
    jumping.current = true;
    atBottomRef.current = false; setAtBottom(false);
    const generation = selectionGeneration.current;
    setMessageSearchOpen(false); setMessageSearchQuery("");
    try {
      let items = messagesRef.current;
      let before = thread.nextBefore;
      const visited = new Set<string>();
      const idToken = await user.getIdToken();
      if (generation !== selectionGeneration.current) return;
      while (!items.some(item => item.id === messageId) && before && !visited.has(before)) {
        visited.add(before);
        const history = await DirectMessagesService.getConversationMessages({ idToken, conversationId: activeConversationId, before, limit: 60 });
        if (generation !== selectionGeneration.current) return;
        items = mergeMessages(mergeMessages(history.items, items), messagesRef.current); before = history.nextBefore;
        setMessages(current => mergeMessages(history.items, current));
        setThread(current => ({ ...current, nextBefore: before }));
      }
      if (items.some(item => item.id === messageId)) setJumpTarget(messageId);
      else morphyToast.info("The original message is no longer available.");
    } catch {
      if (generation === selectionGeneration.current) morphyToast.error("The original message could not be loaded. Try again.");
    } finally { if (generation === selectionGeneration.current) jumping.current = false; }
  };

  useLayoutEffect(() => {
    const list = messageListRef.current;
    const target = jumpTarget && list?.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(jumpTarget)}"]`);
    if (!list || !target) return;
    const top = list.scrollTop + target.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - target.offsetHeight) / 2;
    atBottomRef.current = false;
    list.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target.tabIndex = -1; target.focus({ preventScroll: true });
    setJumpTarget(null);
  }, [jumpTarget, messages, messageSearchQuery]);

  const startReply = (message: DirectMessage) => {
    const opening = messageMenuOpening.current;
    if (!opening || opening.generation !== operationGeneration.current ||
        opening.messageId !== message.id || opening.conversationId !== message.conversationId) return;
    replyFocus.current = opening;
    setOpenMessageMenu(null);
    setActiveMessageActions(null);
    setComposerError(null);
    replyDrafts.current.set(draftScope, message);
    setReplyingTo(message);
  };

  const startEditing = (message: DirectMessage) => {
    const opening = messageMenuOpening.current;
    if (!opening || opening.generation !== operationGeneration.current ||
        opening.messageId !== message.id || opening.conversationId !== message.conversationId) return;
    editFocus.current = { opening, message };
    setOpenMessageMenu(null);
    setActiveMessageActions(null);
  };

  const openMessageActions = (message: DirectMessage) => {
    if (!isCurrentRead || message.conversationId !== activeConversationId || pendingSelection || blockingLayer) return;
    replyFocus.current = null;
    reactionFocus.current = null;
    editFocus.current = null;
    messageMenuOpening.current = {
      generation: operationGeneration.current,
      sequence: ++messageMenuSequence.current,
      conversationId: message.conversationId,
      messageId: message.id,
    };
    setActiveMessageActions(message.id);
    setOpenReactionPicker(null);
    setOpenMessageMenu(message.id);
  };

  const saveEdit = () => {
    if (!user || !isCurrentRead || !editingMessage || editingMessage.conversationId !== activeConversationId || !editingContent.trim()) return;
    const message = editingMessage;
    const content = editingContent;
    const draftGeneration = editDraftGeneration.current;
    const generation = selectionGeneration.current;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        const updated = await DirectMessagesService.editMessage({
          idToken,
          conversationId: message.conversationId,
          messageId: message.id,
          content,
        });
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        loadGeneration.current += 1;
        replaceMessage(updated);
        if (draftGeneration !== editDraftGeneration.current) return;
        setMessageActionError(null);
        setEditingMessage(null);
        setEditingContent("");
      } catch {
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection) || draftGeneration !== editDraftGeneration.current) return;
        setMessageActionError({
          messageId: message.id,
          message: "Couldn’t update this message. Try again.",
        });
        morphyToast.error("Couldn’t update this message. Try again.");
      }
    })();
  };

  const saveReaction = (message: DirectMessage, emoji: string) => {
    if (!user || !isCurrentRead || message.conversationId !== activeConversationId) return;
    const reactionKey = `${message.id}:${emoji}`;
    if (reactionPending.current.has(reactionKey)) return;
    reactionPending.current.add(reactionKey);
    const removing = Boolean(message.reactions?.find((reaction) => reaction.emoji === emoji)?.reactedByViewer);
    const generation = operationGeneration.current;
    setMessages((current) => current.map((item) => item.id === message.id ? toggleReaction(item, emoji) : item));
    setOpenReactionPicker(null);
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        const updated = await DirectMessagesService[removing ? "removeReaction" : "reactToMessage"]({
          idToken,
          conversationId: message.conversationId,
          messageId: message.id,
          emoji,
        });
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        loadGeneration.current += 1;
        replaceMessage(updated);
        setMessageActionError(null);
      } catch {
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
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
    if (!user || !isCurrentRead || !deleteRequest || deleteRequest.message.conversationId !== activeConversationId) return;
    const { message, scope } = deleteRequest;
    const generation = selectionGeneration.current;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        const result = await DirectMessagesService.deleteMessage({
          idToken,
          conversationId: message.conversationId,
          messageId: message.id,
          scope,
        });
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        loadGeneration.current += 1;
        if (result.message) replaceMessage(result.message);
        else setMessages((current) => current.filter((item) => item.id !== message.id || item.conversationId !== message.conversationId));
        setMessageActionError(null);
        setDeleteRequest(null);
        setActiveMessageActions(null);
      } catch {
        if ((generation !== selectionGeneration.current || ownerRef.current !== user?.uid || selectionRef.current !== routeSelection)) return;
        setDeleteRequest(null);
        setMessageActionError({
          messageId: message.id,
          message: "Couldn’t delete this message. Try again.",
        });
      }
    })();
  };

  const confirmDeleteChat = () => {
    const request = chatDeleteRequest;
    if (!user || !request || request.ownerId !== user.uid) return;
    const session = chatDeleteSession.current;
    const key = `${user.uid}:${session.epoch}:${request.conversation.id}`;
    if (pendingChatDeletes.current.has(key)) return;
    pendingChatDeletes.current.add(key);
    setChatDeleteRevision(value => value + 1);
    const current = () => chatDeleteLifetime.current && chatDeleteSession.current === session && readAdmission.current.ownerId === request.ownerId;
    const operation = (async () => {
      const idToken = await user.getIdToken();
      if (!current()) return;
      await DirectMessagesService.deleteConversation({ idToken, conversationId: request.conversation.id });
      if (!current()) return;
      removeDeletedChat(request.conversation.id, request.conversation.peerPersonRef);
      setChatDeleteRequest(value => value === request ? null : value);
      dispatchDirectMessagesUpdated({ userId: user.uid, conversationId: request.conversation.id, messageId: null, source: "delete" });
    })();
    const handle = morphyToast.promise(operation, { isCurrent: current, loading: "Deleting chat…", success: "Chat deleted", error: "Couldn’t delete this chat. Try again." });
    const toastId = typeof handle === "string" || typeof handle === "number" ? handle : null;
    if (toastId !== null) chatDeleteToasts.current.add(toastId);
    void operation.catch(() => {}).finally(() => {
      pendingChatDeletes.current.delete(key);
      if (toastId !== null) chatDeleteToasts.current.delete(toastId);
      if (current()) setChatDeleteRevision(value => value + 1);
    });
  };

  const deletingChat = Boolean(chatDeleteRequest && pendingChatDeletes.current.has(
    `${user?.uid}:${chatDeleteSession.current.epoch}:${chatDeleteRequest.conversation.id}`,
  ));

  if (!user && !authLoading) {
    return (
      <AppPageShell width="agent" fitContent nativeTest={nativeTest}>
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
    <div className={styles.laneSwitcher} role="tablist" aria-label="Message lanes">
      <button type="button" role="tab" aria-selected={lane === "people"}
        onClick={() => chooseLane("people")}>People <span className={styles.laneCount}>{inboxItems.length}</span></button>
      <button type="button" role="tab" aria-selected={lane === "circles"}
        onClick={() => chooseLane("circles")}>Circles <span className={styles.laneCount}>{circleCount}</span></button>
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
    <AppPageShell width="expanded" fitContent={false} nativeTest={nativeTest} className={styles.shell}>
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
              <h1>Messages</h1>
            </div>
            <div className={styles.inboxHeaderActions}>
              {themeToggle}
              <button type="button" className={styles.refreshButton} aria-label="Compose message" onClick={() => {
                setNewChatQuery(""); setNewChatPage(1); setNewChatPeople([]); setNewChatHasMore(false); setNewChatOpen(true);
              }}><Pencil className="h-5 w-5" aria-hidden="true" /></button>
              <button type="button" className={styles.refreshButton} aria-label="New chat" onClick={() => {
                setNewChatQuery(""); setNewChatPage(1); setNewChatPeople([]); setNewChatHasMore(false); setNewChatOpen(true);
              }}><Plus className="h-5 w-5" aria-hidden="true" /></button>
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
                placeholder="Search messages or people"
                aria-label="Search conversations"
              />
            </label>
          </div>
          {laneSwitcher}
          <nav className={styles.conversationList} aria-label="Conversation list">
            {loadingInbox && !inboxError && inboxItems.length === 0 ? (
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
                <DirectMessageInboxRow
                  key={conversation.id}
                  label={conversationLabel(conversation)}
                  active={active}
                  disabled={pendingChatDeletes.current.has(`${user?.uid}:${chatDeleteSession.current.epoch}:${conversation.id}`)}
                  onOpen={() => openConversation(conversation)}
                  onDelete={() => {
                    if (!user) return;
                    const scopes = [`conversation:${conversation.id}`, ...(conversation.peerPersonRef ? [`person:${conversation.peerPersonRef}`] : [])];
                    if (scopes.some(selection => sendingSelections.current.has(JSON.stringify([user.uid, selection])))) {
                      morphyToast.info("Wait for this message to finish sending."); return;
                    }
                    setChatDeleteRequest({ ownerId: user.uid, conversation });
                  }}
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
                </DirectMessageInboxRow>
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
                    <PeerProfileLink href={peerProfileHref} label={selectedLabel}>
                    <ConnectionPersonAvatar
                      label={selectedLabel}
                      photoUrl={thread.peerPhotoUrl}
                      size="list"
                      className={styles.threadAvatar}
                    />
                    </PeerProfileLink>
                    <div className={styles.threadTitle}>
                      <h2 title={selectedLabel}>{selectedLabel}</h2>
                      <p className={styles.threadStatus}>{pendingSelection ? "Connecting…" : thread.canSend ? "Connected" : "Messaging unavailable"}</p>
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
                    ) : null}
                    <button
                      type="button"
                      className={styles.headerAction}
                      aria-label="Start voice call"
                      title="Calls are not available yet"
                      disabled
                    >
                      <PhoneCall className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button type="button" className={styles.headerAction} aria-label="Contact info" onClick={() => setContactInfoOpen(true)}>
                      <Info className="h-5 w-5" aria-hidden="true" />
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
                {pendingSelection ? (
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
                {!pendingSelection && messages.length === 0 && thread.disconnectedNotice ? (
                  <div className={styles.emptyThread} role="status">
                    <MessageCircle className="h-7 w-7" aria-hidden="true" />
                    <p>{thread.disconnectedNotice}</p>
                  </div>
                ) : null}
                {!pendingSelection && messages.length === 0 && !threadError && !thread.disconnectedNotice ? (
                  <div className={styles.emptyThread}>
                    <MessageCircle className="h-7 w-7" aria-hidden="true" />
                    <p>Start the conversation with {selectedLabel}.</p>
                  </div>
                ) : null}
                {visibleMessages.map((message, index) => {
                  const presentationEpoch = operationGeneration.current;
                  const opening = messageMenuOpening.current?.messageId === message.id &&
                    messageMenuOpening.current.conversationId === message.conversationId
                      ? messageMenuOpening.current : null;
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
                        onPointerDown={(event) => messageLongPress.start(event, () => openMessageActions(message))}
                        onPointerMove={messageLongPress.move}
                        onPointerUp={messageLongPress.cancel}
                        onPointerCancel={messageLongPress.cancel}
                        onPointerLeave={(event) => {
                          messageLongPress.cancel();
                          if (event.pointerType === "mouse" && !openMessageMenu &&
                            !event.currentTarget.contains(document.activeElement)) {
                            setActiveMessageActions((current) =>
                              current === message.id ? null : current,
                            );
                          }
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          messageLongPress.cancel();
                          if (!pendingSelection && !blockingLayer) openMessageActions(message);
                        }}
                      >
                        {!message.senderIsViewer ? (
                          <PeerProfileLink href={peerProfileHref} label={selectedLabel} className={styles.messageProfileLink}>
                          <ConnectionPersonAvatar
                            label={selectedLabel}
                            photoUrl={thread.peerPhotoUrl}
                            size="list"
                            className={styles.messagePeerAvatar}
                          />
                          </PeerProfileLink>
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
                                      <button type="button" className={styles.replyPreview} aria-label={`Go to original message from ${message.replyTo.senderIsViewer ? "you" : selectedLabel}`}
                                        onClick={() => void jumpToOriginal(message.replyTo!.id)}>
                                        <span>{message.replyTo.senderIsViewer ? "You" : selectedLabel}</span>
                                        <p>{walletMessagePreview(message.replyTo.content)}</p>
                                      </button>
                                    ) : null}
                                    {cardRequestReference(message.content) ? <Link className="underline underline-offset-4" href={walletCardRequestHref(cardRequestReference(message.content)!)}>View card request</Link> : cardAccessReference(message.content) ? <WalletCardAccessMessage key={`${message.id}:${activeConversationId}`} grantId={cardAccessReference(message.content)!} senderIsViewer={message.senderIsViewer} /> : isWalletCardShare(message.content) ? <WalletSharedCardMessage key={`${message.id}:${activeConversationId}`} content={message.content} peerPersonRef={thread.peerPersonRef} senderIsViewer={message.senderIsViewer} /> : message.content ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : null}
                                    <MessageAttachment key={`${presentationEpoch}:${message.id}`} message={message} isCurrentVisit={() => operationGeneration.current === presentationEpoch && readAdmission.current.admitted && readAdmission.current.ownerId === user?.uid} getIdToken={() => {
                                      if (!user) throw new Error("Sign in to open this attachment.");
                                      return user.getIdToken();
                                    }} onPhotoLoad={() => {
                                      const node = messageListRef.current;
                                      if (node && atBottomRef.current) node.scrollTop = node.scrollHeight;
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
                                        aria-label={message.readAt ? "Read" : message.deliveredAt ? "Delivered" : "Sent"}
                                        title={message.readAt ? "Read" : message.deliveredAt ? "Delivered" : "Sent"}
                                      >
                                        {message.readAt || message.deliveredAt ? (
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
                                  <DirectMessageEmojiPicker
                                    label="React to message"
                                    triggerIcon={<Smile className="h-5 w-5" />}
                                    triggerClassName={styles.messageActionButton}
                                    open={openReactionPicker === message.id}
                                    onOpenChange={(open) => {
                                      if (open) setOpenMessageMenu(null);
                                      setOpenReactionPicker(open ? message.id : null);
                                    }}
                                    onEmojiSelect={(emoji) => saveReaction(message, emoji)}
                                  />
                                ) : null}
                                <DropdownMenu
                                  modal={false}
                                  open={openMessageMenu === message.id}
                                  onOpenChange={(open) => {
                                    if (open) {
                                      openMessageActions(message);
                                    } else setOpenMessageMenu(null);
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
                                    key={opening?.sequence ?? 0}
                                    side="top"
                                    align={message.senderIsViewer ? "end" : "start"}
                                    collisionPadding={12}
                                    className={styles.messageMenu}
                                    onCloseAutoFocus={(event) => {
                                      // Settle the menu before handing focus to another surface.
                                      if (!opening || opening.generation !== operationGeneration.current ||
                                          opening !== messageMenuOpening.current) {
                                        event.preventDefault();
                                        return;
                                      }
                                      if (reactionFocus.current === opening) {
                                        reactionFocus.current = null;
                                        event.preventDefault();
                                        setOpenReactionPicker(message.id);
                                        return;
                                      }
                                      if (editFocus.current?.opening === opening) {
                                        const { message: editMessage } = editFocus.current;
                                        editFocus.current = null;
                                        event.preventDefault();
                                        editDraftGeneration.current += 1;
                                        setMessageActionError(null);
                                        setEditingMessage(editMessage);
                                        setEditingContent(editMessage.content);
                                        return;
                                      }
                                      if (replyFocus.current !== opening) return;
                                      replyFocus.current = null;
                                      event.preventDefault();
                                      composerRef.current?.focus();
                                    }}
                                  >
                                    {!message.deletedForEveryoneAt ? (
                                      <DropdownMenuItem onSelect={() => {
                                        reactionFocus.current = opening;
                                        setOpenMessageMenu(null);
                                      }}>
                                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                        React
                                      </DropdownMenuItem>
                                    ) : null}
                                    {!message.deletedForEveryoneAt ? (
                                      <DropdownMenuItem onSelect={() => startReply(message)}>
                                        <Quote className="h-3.5 w-3.5" aria-hidden="true" />
                                        Reply
                                      </DropdownMenuItem>
                                    ) : null}
                                    {message.senderIsViewer && !message.deletedForEveryoneAt && !isWalletCardShare(message.content) ? (
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
                          <span>{walletMessagePreview(replyingTo.content)}</span>
                        </div>
                        <button
                          type="button"
                          aria-label="Cancel reply"
                          disabled={sending || Boolean(unconfirmedDraft)}
                          onClick={() => { replyDrafts.current.delete(draftScope); setReplyingTo(null); }}
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                    {attachment ? <div className={styles.attachmentPreview} role="status">
                      <span title={attachment.name}>{attachment.name} · {(attachment.size / 1024 / 1024).toFixed(1)} MB</span>
                      <button type="button" aria-label="Remove attachment" onClick={() => {
                        attachmentDrafts.current.delete(draftScope); setAttachment(null);
                      }}><X className="h-4 w-4" aria-hidden="true" /></button>
                    </div> : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className={styles.attachButton} aria-label="Add attachment"
                          disabled={sending || recordingVoice || !canCompose || Boolean(unconfirmedDraft)}>
                          <Plus className="h-5 w-5" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top" className={styles.attachmentMenu}>
                        <DropdownMenuItem onSelect={() => photoInputRef.current?.click()}>
                          <ImageIcon className="h-4 w-4" aria-hidden="true" /> Photo
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
                        drafts.current.set(draftScope, event.target.value);
                        setDraft(event.target.value);
                      }}
                      placeholder={hasRouteSelection ? `Message ${selectedLabel}...` : "Message"}
                      maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                      disabled={!canCompose || recordingVoice}
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
                      key={draftScope}
                      triggerIcon={<Smile className="h-5 w-5" />}
                      restoreTriggerFocusOnSelect={false}
                      disabled={sending || recordingVoice || !canCompose || Boolean(unconfirmedDraft)}
                      onEmojiSelect={(emoji) => {
                        const input = composerRef.current;
                        const start = input?.selectionStart ?? draft.length;
                        const end = input?.selectionEnd ?? start;
                        setDraft((current) => {
                          const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
                          drafts.current.set(draftScope, next);
                          return next;
                        });
                        requestAnimationFrame(() => {
                          input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length);
                        });
                      }}
                    />
                    <div className={styles.composerActions}>
                      {!draft.trim() && !attachment && !sending ? hasRouteSelection ? <DirectMessageVoiceRecorder
                        key={`${user?.uid}:${routeSelection}`} disabled={!canCompose || Boolean(unconfirmedDraft)} onRecorded={chooseAttachment} onRecordingChange={setRecordingVoice}
                      /> : <button type="button" className={styles.voiceButton} aria-label="Talk to One" onClick={() => {
                        requestAgentConversationAfterRoute(ROUTES.HOME); router.push(ROUTES.HOME);
                      }}><Mic className="h-5 w-5" aria-hidden="true" /></button> : <button
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
              <Dialog open={contactInfoOpen} onOpenChange={setContactInfoOpen}>
                <DialogContent className={styles.contactInfoDialog}>
                  <DialogHeader><DialogTitle>Contact info</DialogTitle></DialogHeader>
                  <PeerProfileLink href={peerProfileHref} label={selectedLabel} className={styles.contactProfileLink}>
                  <ConnectionPersonAvatar label={selectedLabel} photoUrl={thread.peerPhotoUrl} size="list" className={styles.contactInfoAvatar} />
                  </PeerProfileLink>
                  <h3>{selectedLabel}</h3>
                  <DialogDescription>{thread.canSend ? "Connected" : thread.disconnectedNotice || "Messaging unavailable"}</DialogDescription>
                  <Button variant="none" effect="fade" onClick={() => { setContactInfoOpen(false); setMessageSearchOpen(true); }}>
                    <Search className="h-5 w-5" aria-hidden="true" /> Search messages
                  </Button>
                </DialogContent>
              </Dialog>
              <Dialog modal open={Boolean(editingMessage)} onOpenChange={(open) => {
                if (!open) { editDraftGeneration.current += 1; setEditingMessage(null); setEditingContent(""); }
              }}>
                <DialogContent className={styles.editDialog} srDescription="Update the text of your message."
                  onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    const input = editingInputRef.current;
                    if (!input) return;
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                  }}>
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
        <CircleMessagesPane active={lane === "circles"} theme={isDark ? "dark" : "light"}
          onThreadOpenChange={setCircleThreadOpen} onCircleCountChange={setCircleCount}
          initialCircleId={restoredSelection?.lane === "circles" ? restoredSelection.circleId : null}
          laneSwitcher={laneSwitcher} headerActions={themeToggle} />
      </section>
      <AlertDialog open={Boolean(chatDeleteRequest && chatDeleteRequest.ownerId === user?.uid)}
        onOpenChange={open => { if (!open && !deletingChat) setChatDeleteRequest(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat with {chatDeleteRequest ? conversationLabel(chatDeleteRequest.conversation) : "this person"}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the entire chat history for you. The other person keeps their copy, and your connection stays. New messages can start the chat again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingChat)}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={Boolean(deletingChat)} onClick={event => { event.preventDefault(); confirmDeleteChat(); }}>
              {deletingChat ? "Deleting…" : "Delete chat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog modal open={newChatOpen} onOpenChange={setNewChatOpen}>
        <DialogContent aria-modal="true" className={styles.newChatDialog} srDescription="Choose a connection to message.">
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
