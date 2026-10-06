"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { AgentDockPortal } from "@/components/agent/agent-dock";
import { OneChatBubble } from "@/components/agent/chat-message-styles";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { DirectMessageEmojiPicker } from "@/components/direct-messages/direct-message-emoji-picker";
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
import {
  ArrowLeft,
  CheckCheck,
  Loader2,
  MessageCircle,
  Mic,
  MoreVertical,
  Pencil,
  Phone,
  Quote,
  Send,
  Trash2,
} from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import {
  dispatchDirectMessagesUpdated,
  subscribeToDirectMessagesUpdated,
} from "@/lib/direct-messages/direct-message-events";
import {
  DIRECT_MESSAGE_MAX_LENGTH,
  DirectMessagesService,
  type DirectMessage,
  type DirectMessageConversation,
} from "@/lib/services/direct-messages-service";
import {
  buildDirectMessageRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { requestAgentConversationAfterRoute } from "@/lib/agent/agent-voice-settings";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";

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
  const sameDay = date.toDateString() === now.toDateString();
  const day = sameDay
    ? "Today"
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} ${time}`;
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

function sortMessages(items: DirectMessage[]): DirectMessage[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
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

export function DirectMessagesPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedPersonRef = String(searchParams?.get("person") || "").trim();
  const requestedConversationId = String(
    searchParams?.get("conversation") || "",
  ).trim();
  const [storedThread, setThread] = useState<ThreadState>(EMPTY_THREAD);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [settledReadScopes, setSettledReadScopes] = useState<readonly string[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [openMessageMenu, setOpenMessageMenu] = useState<string | null>(null);
  const [activeMessageActions, setActiveMessageActions] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<DirectMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<DirectMessage | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [deleteRequest, setDeleteRequest] = useState<{
    message: DirectMessage;
    scope: "me" | "everyone";
  } | null>(null);
  const loadGeneration = useRef(0);
  const loadedReadScopes = useRef<readonly string[]>([]);
  const operationGeneration = useRef(0);
  const actionToastIds = useRef(new Set<number>());
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const invalidateThreadRead = useCallback(() => { ++loadGeneration.current; }, []);
  const invalidateOperations = useCallback(() => {
    ++operationGeneration.current;
    for (const id of actionToastIds.current) morphyToast.dismiss(id);
    actionToastIds.current.clear();
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const hasRouteSelection = Boolean(requestedPersonRef || requestedConversationId);
  const selectedRouteKey = requestedPersonRef
    ? `person:${requestedPersonRef}`
    : requestedConversationId ? `conversation:${requestedConversationId}` : null;
  const readScope = user && selectedRouteKey
    ? JSON.stringify([user.uid, selectedRouteKey]) : null;
  const isCurrentRead = readScope !== null && settledReadScopes.includes(readScope);
  // React can render the new owner/selection before effect cleanup runs. Keep
  // the old transcript and send authority concealed during that interval.
  const thread = isCurrentRead ? storedThread : EMPTY_THREAD;
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
    return invalidateOperations;
  }, [invalidateOperations, readScope]);

  useEffect(() => { setDraft(""); }, [user?.uid]);

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
          const history = await DirectMessagesService.getConversationMessages({
            idToken,
            conversationId: peer.conversation.id,
            limit: 60,
          });
          if (generation !== loadGeneration.current) return;
          setThread(
            threadFromConversation(history.conversation, {
              peerPersonRef: peer.peerPersonRef ?? history.conversation.peerPersonRef,
              peerDisplayName:
                peer.peerDisplayName ?? history.conversation.peerDisplayName,
              peerPhotoUrl: peer.peerPhotoUrl ?? history.conversation.peerPhotoUrl,
              canSend: history.canSend,
              disconnectedNotice: history.disconnectedNotice,
              nextBefore: history.nextBefore,
            }),
          );
          setMessages(sortMessages(history.items));
          settleReadScope(requestScope);
          setThreadError(null);
          if (history.conversation.unreadCount > 0) {
            void DirectMessagesService.markConversationRead({
              idToken,
              conversationId: history.conversation.id,
            }).then(() => {
              dispatchDirectMessagesUpdated({
                userId: user.uid,
                conversationId: history.conversation.id,
                messageId: null,
                source: "read",
              });
            });
          }
          return;
        }

        if (!requestedConversationId) {
          loadedReadScopes.current = [];
          setThread(EMPTY_THREAD);
          setMessages([]);
          return;
        }
        const history = await DirectMessagesService.getConversationMessages({
          idToken,
          conversationId: requestedConversationId,
          limit: 60,
        });
        if (generation !== loadGeneration.current) return;
        setThread(
          threadFromConversation(history.conversation, {
            canSend: history.canSend,
            disconnectedNotice: history.disconnectedNotice,
            nextBefore: history.nextBefore,
          }),
        );
        setMessages(sortMessages(history.items));
        settleReadScope(requestScope);
        setThreadError(null);
        if (history.conversation.unreadCount > 0) {
          void DirectMessagesService.markConversationRead({
            idToken,
            conversationId: history.conversation.id,
          }).then(() => {
            dispatchDirectMessagesUpdated({
              userId: user.uid,
              conversationId: history.conversation.id,
              messageId: null,
              source: "read",
            });
          });
        }
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
        if (generation === loadGeneration.current) setLoadingThread(false);
      }
    },
    [requestedConversationId, requestedPersonRef, settleReadScope, user],
  );

  useEffect(() => {
    if (!user) {
      loadedReadScopes.current = [];
      setSettledReadScopes([]);
      setThread(EMPTY_THREAD);
      setMessages([]);
      return;
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void loadThread();
    return invalidateThreadRead;
  }, [invalidateThreadRead, loadThread, user]);

  const refresh = useCallback(() => {
    if (hasRouteSelection) void loadThread({ preserveMessages: true });
  }, [hasRouteSelection, loadThread]);

  useEffect(() => {
    if (!user?.uid) return;
    return subscribeToDirectMessagesUpdated((detail) => {
      if (detail.userId !== user.uid) return;
      refresh();
    });
  }, [refresh, user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const interval = window.setInterval(refreshVisible, 30_000);
    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.clearInterval(interval);
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

  useEffect(() => {
    const node = messageListRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [activeConversationId, messages.length]);

  const selectedLabel =
    thread.peerDisplayName || thread.conversation?.peerDisplayName || "Conversation";
  const visibleMessages = isCurrentRead ? messages : [];
  const nativeTest = {
    routeId: "/one/messages",
    marker: "native-route-direct-messages",
    authState: authLoading ? "pending" : user ? "authenticated" : "anonymous",
    dataState: authLoading ? "loading" : !user ? "unavailable-valid"
      : !isCurrentRead || loadingThread ? "loading"
      : threadError ? "error" : visibleMessages.length ? "loaded" : "empty-valid",
    errorCode: isCurrentRead && threadError ? "direct_messages_read" : null,
  } as const;

  const backToConnections = () => {
    router.replace(ROUTES.CONNECT, { scroll: false });
  };

  const sendDraft = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!user || sending || !thread.canSend) return;
    const generation = operationGeneration.current;
    const isCurrentOperation = () => generation === operationGeneration.current;
    const content = draft;
    const recipientPersonRef = thread.peerPersonRef || requestedPersonRef;
    if (!recipientPersonRef) {
      morphyToast.error("This recipient is no longer available for messaging.");
      return;
    }
    setSending(true);
    try {
      const idToken = await user.getIdToken();
      if (!isCurrentOperation()) return;
      const result = await DirectMessagesService.sendMessage({
        idToken,
        content,
        recipientPersonRef,
        replyToMessageId: replyingTo?.id,
      });
      if (!isCurrentOperation()) return;
      setDraft("");
      setReplyingTo(null);
      setMessages((current) => mergeMessages(current, [result.message]));
      setThread((current) =>
        threadFromConversation(result.conversation, {
          peerPersonRef: current.peerPersonRef ?? result.conversation.peerPersonRef,
          peerDisplayName:
            current.peerDisplayName ?? result.conversation.peerDisplayName,
          peerPhotoUrl: current.peerPhotoUrl ?? result.conversation.peerPhotoUrl,
          canSend: true,
        }),
      );
      dispatchDirectMessagesUpdated({
        userId: user.uid,
        conversationId: result.conversation.id,
        messageId: result.message.id,
        source: "send",
      });
      // The route becomes conversation-addressed after the first send. Keep
      // the optimistically rendered, server-returned record visible while the
      // matching history refresh resolves.
      // Admit only this owner's exact source and destination during the
      // navigation handoff. An unrelated route or a new owner cannot inherit
      // either the retained transcript or its send authority.
      const destinationScope = JSON.stringify([user.uid, `conversation:${result.conversation.id}`]);
      const handoffScopes = readScope ? [readScope, destinationScope] : [destinationScope];
      ++loadGeneration.current;
      loadedReadScopes.current = handoffScopes;
      setSettledReadScopes(handoffScopes);
      router.replace(
        buildDirectMessageRoute({ conversationId: result.conversation.id }),
        { scroll: false },
      );
    } catch {
      if (!isCurrentOperation()) return;
      setDraft(content);
      morphyToast.error("Message could not be sent. Check your connection and try again.");
      // A 403/409 is authoritative: redraw the thread as read-only instead of
      // leaving a stale connected composer visible.
      void loadThread({ preserveMessages: true });
    } finally {
      if (isCurrentOperation()) setSending(false);
    }
  };

  const loadOlderMessages = async () => {
    const conversationId = thread.conversation?.id;
    const before = thread.nextBefore;
    if (!user || !conversationId || !before || loadingOlder) return;
    const generation = operationGeneration.current;
    const isCurrentOperation = () => generation === operationGeneration.current;
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
      if (!isCurrentOperation()) return;
      setMessages((current) => mergeMessages(history.items, current));
      setThread(
        threadFromConversation(history.conversation, {
          canSend: history.canSend,
          disconnectedNotice: history.disconnectedNotice,
          nextBefore: history.nextBefore,
        }),
      );
    } catch {
      if (!isCurrentOperation()) return;
      morphyToast.error("Older messages could not be loaded. Try again.");
    } finally {
      if (isCurrentOperation()) setLoadingOlder(false);
    }
  };

  const replaceMessage = (updated: DirectMessage) => {
    setMessages((current) =>
      current.map((message) => (message.id === updated.id && message.conversationId === updated.conversationId ? updated : message)),
    );
  };

  const showActionToast = <T,>(operation: Promise<T>, generation: number, labels: { loading: string; success: string; error: string }) => {
    let id: number;
    const handle = morphyToast.promise(operation, {
      ...labels,
      isCurrent: () => generation === operationGeneration.current,
      finally: () => { actionToastIds.current.delete(id); },
    });
    // Sonner's generated numeric handle is boxed with an unwrap method.
    id = Number(handle);
    if (Number.isFinite(id)) actionToastIds.current.add(id);
  };

  const startReply = (message: DirectMessage) => {
    setOpenMessageMenu(null);
    setActiveMessageActions(message.id);
    setReplyingTo(message);
    const generation = operationGeneration.current;
    requestAnimationFrame(() => {
      if (generation === operationGeneration.current) composerRef.current?.focus();
    });
  };

  const startEditing = (message: DirectMessage) => {
    setOpenMessageMenu(null);
    setActiveMessageActions(message.id);
    setEditingMessage(message);
    setEditingContent(message.content);
  };

  const saveEdit = () => {
    if (!user || !isCurrentRead || !editingMessage || editingMessage.conversationId !== activeConversationId || !editingContent.trim()) return;
    const message = editingMessage;
    const generation = operationGeneration.current;
    const isCurrentOperation = () => generation === operationGeneration.current;
    const operation = (async () => {
      const idToken = await user.getIdToken();
      if (!isCurrentOperation()) throw new Error("Message action retired");
      return DirectMessagesService.editMessage({
        idToken,
        conversationId: message.conversationId,
        messageId: message.id,
        content: editingContent,
      });
    })();
    void operation.then((updated) => {
      if (!isCurrentOperation()) return;
      replaceMessage(updated);
      setEditingMessage(null);
      setEditingContent("");
    }).catch(() => undefined);
    showActionToast(operation, generation, {
      loading: "Saving message…",
      success: "Message edited",
      error: "Message could not be edited. Try again.",
    });
  };

  const saveReaction = (message: DirectMessage, emoji: string) => {
    if (!user || !isCurrentRead || message.conversationId !== activeConversationId) return;
    const generation = operationGeneration.current;
    const isCurrentOperation = () => generation === operationGeneration.current;
    const operation = (async () => {
      const idToken = await user.getIdToken();
      if (!isCurrentOperation()) throw new Error("Message action retired");
      return DirectMessagesService.reactToMessage({
        idToken,
        conversationId: message.conversationId,
        messageId: message.id,
        emoji,
      });
    })();
    void operation.then((updated) => {
      if (isCurrentOperation()) replaceMessage(updated);
    }).catch(() => undefined);
    showActionToast(operation, generation, {
      loading: "Adding reaction…",
      success: "Reaction added",
      error: "Reaction could not be saved. Try again.",
    });
  };

  const confirmDelete = () => {
    if (!user || !isCurrentRead || !deleteRequest || deleteRequest.message.conversationId !== activeConversationId) return;
    const { message, scope } = deleteRequest;
    const generation = operationGeneration.current;
    const isCurrentOperation = () => generation === operationGeneration.current;
    const operation = (async () => {
      const idToken = await user.getIdToken();
      if (!isCurrentOperation()) throw new Error("Message action retired");
      return DirectMessagesService.deleteMessage({
        idToken,
        conversationId: message.conversationId,
        messageId: message.id,
        scope,
      });
    })();
    void operation.then((result) => {
      if (!isCurrentOperation()) return;
      if (result.message) replaceMessage(result.message);
      else setMessages((current) => current.filter((item) => item.id !== message.id || item.conversationId !== message.conversationId));
      setDeleteRequest(null);
      setActiveMessageActions(null);
    }).catch(() => undefined);
    showActionToast(operation, generation, {
      loading: "Deleting message…",
      success: deleteRequest.scope === "everyone"
        ? "Message deleted for everyone"
        : "Message deleted for you",
      error: "Message could not be deleted. Try again.",
    });
  };

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

  return (
    <AppPageShell width="agent" fitContent={false} nativeTest={nativeTest}>
      <section
        className={styles.page}
        data-one-chat-surface
        data-chat-open="true"
        data-direct-message-composer-docked={
          hasRouteSelection && thread.canSend ? "true" : undefined
        }
        data-native-route="native-route-direct-messages"
      >
        <main className={styles.thread} aria-live="polite">
              <header className={styles.threadHeader}>
                <div className={styles.threadHeaderContent}>
                  <button
                    type="button"
                    className={styles.backButton}
                    aria-label="Back to connections"
                    onClick={backToConnections}
                  >
                    <ArrowLeft className="h-6 w-6" aria-hidden="true" />
                  </button>
                  <div className={styles.threadIdentity}>
                    <span className={styles.threadAvatarPresence}>
                      <ConnectionPersonAvatar
                        label={selectedLabel}
                        photoUrl={thread.peerPhotoUrl}
                        size="list"
                        className={styles.threadAvatar}
                      />
                      {thread.canSend ? (
                        <span
                          className={styles.connectionStatus}
                          aria-label="Connected"
                        />
                      ) : null}
                    </span>
                    <div className={styles.threadTitle}>
                      <h2 title={selectedLabel}>{selectedLabel}</h2>
                      <p>{thread.canSend ? "Connected on One" : "Conversation"}</p>
                    </div>
                  </div>
                  <div className={styles.threadHeaderActions}>
                    <button
                      type="button"
                      className={styles.headerAction}
                      aria-label="Audio calls are not available in Messages yet"
                      onClick={() =>
                        morphyToast.info("Calls are not available in Messages yet.")
                      }
                    >
                      <Phone className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </header>

              <div
                className={styles.messageList}
                ref={messageListRef}
                data-testid="direct-message-list"
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
                {!loadingThread && messages.length === 0 && thread.disconnectedNotice ? (
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
                  const nextMessage = visibleMessages[index + 1];
                  const showPeerAvatar =
                    !message.senderIsViewer &&
                    (!nextMessage ||
                      nextMessage.senderIsViewer ||
                      isNewMessageDay(nextMessage, message));

                  return (
                    <div key={message.id} className={styles.messageFeedItem}>
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
                        data-message-role={message.senderIsViewer ? "user" : "peer"}
                        data-message-sent-at={message.createdAt}
                        data-actions-visible={
                          activeMessageActions === message.id ? "true" : undefined
                        }
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("button, textarea")) return;
                          setActiveMessageActions(message.id);
                        }}
                      >
                        <div
                          className={cn(
                            styles.messageCluster,
                            "group relative flex min-w-0 items-end gap-1",
                            message.senderIsViewer && "flex-row-reverse",
                          )}
                        >
                          {showPeerAvatar ? (
                            <ConnectionPersonAvatar
                              label={selectedLabel}
                              photoUrl={thread.peerPhotoUrl}
                              size="list"
                              className={styles.messageAvatar}
                            />
                          ) : !message.senderIsViewer ? (
                            <span className={styles.messageAvatarSpacer} aria-hidden="true" />
                          ) : null}
                          <div className={styles.messageContent}>
                            <div className={styles.messageBubbleWrap}>
                              <OneChatBubble
                                tone={message.senderIsViewer ? "user" : "assistant"}
                                className={cn(
                                  styles.messageBubble,
                                  !message.senderIsViewer && styles.peerMessageBubble,
                                )}
                              >
                                {editingMessage?.id === message.id ? (
                                  <div className={styles.messageEditForm}>
                                    <label className="sr-only" htmlFor={`edit-message-${message.id}`}>
                                      Edit message
                                    </label>
                                    <textarea
                                      id={`edit-message-${message.id}`}
                                      value={editingContent}
                                      maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                                      className={styles.messageEditInput}
                                      onChange={(event) => setEditingContent(event.target.value)}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.shiftKey) {
                                          event.preventDefault();
                                          saveEdit();
                                        }
                                      }}
                                      autoFocus
                                    />
                                    <div className={styles.messageEditActions}>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingMessage(null);
                                          setEditingContent("");
                                        }}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        disabled={!editingContent.trim()}
                                        onClick={saveEdit}
                                      >
                                        Save
                                      </button>
                                    </div>
                                  </div>
                                ) : message.deletedForEveryoneAt ? (
                                  <p className={styles.deletedMessage}>This message was deleted.</p>
                                ) : (
                                  <>
                                    {message.replyTo ? (
                                      <div className={styles.replyPreview}>
                                        <span>{message.replyTo.senderIsViewer ? "You" : selectedLabel}</span>
                                        <p>{message.replyTo.content}</p>
                                      </div>
                                    ) : null}
                                    <p className="whitespace-pre-wrap break-words">
                                      {message.content}
                                    </p>
                                    {message.editedAt ? <span className={styles.editedLabel}>Edited</span> : null}
                                  </>
                                )}
                              </OneChatBubble>
                              <div className={styles.messageActions}>
                                {!message.deletedForEveryoneAt ? (
                                  <DirectMessageEmojiPicker
                                    label="Choose a reaction"
                                    triggerClassName={styles.messageActionButton}
                                    compact
                                    onEmojiSelect={(emoji) => saveReaction(message, emoji)}
                                  />
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
                                      <MoreVertical className="h-4 w-4" aria-hidden="true" />
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
                            <time
                              className={cn(
                                styles.messageMeta,
                                message.senderIsViewer && styles.messageMetaOwn,
                              )}
                              dateTime={message.readAt || message.createdAt}
                            >
                              {message.senderIsViewer && message.readAt
                                ? `Read ${formatMessageTime(message.readAt)}`
                                : formatMessageTime(message.createdAt)}
                              {message.senderIsViewer && message.readAt ? (
                                <CheckCheck
                                  className="h-3 w-3"
                                  aria-label="Read"
                                />
                              ) : null}
                            </time>
                          </div>
                        </div>
                      </article>
                    </div>
                  );
                })}
              </div>

              {!thread.canSend && messages.length > 0 ? (
                <div className={styles.readOnlyNotice} role="status">
                  {thread.disconnectedNotice || "You are no longer connected."}
                </div>
              ) : null}
              <AgentDockPortal
                enabled={hasRouteSelection}
                visible={thread.canSend}
                suppressed={!thread.canSend}
              >
                {thread.canSend ? (
                  <form
                    className={styles.composer}
                    onSubmit={(event) => void sendDraft(event)}
                  >
                    {replyingTo ? (
                      <div className={styles.composerReplyPreview}>
                        <div>
                          <strong>Replying to {replyingTo.senderIsViewer ? "yourself" : selectedLabel}</strong>
                          <span>{replyingTo.content}</span>
                        </div>
                        <button
                          type="button"
                          aria-label="Cancel reply"
                          onClick={() => setReplyingTo(null)}
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                    <label className="sr-only" htmlFor="direct-message-draft">
                      Message {selectedLabel}
                    </label>
                    <textarea
                      id="direct-message-draft"
                      ref={composerRef}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={`Message ${selectedLabel}`}
                      maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                      disabled={sending}
                      rows={1}
                      className={styles.composerInput}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.shiftKey ||
                          event.nativeEvent.isComposing
                        ) {
                          return;
                        }
                        event.preventDefault();
                        if (draft.trim() && !sending) event.currentTarget.form?.requestSubmit();
                      }}
                    />
                    <DirectMessageEmojiPicker
                      disabled={sending}
                      onEmojiSelect={(emoji) =>
                        setDraft((current) => `${current}${emoji}`)
                      }
                    />
                    <div className={styles.composerActions}>
                      <button
                        type="button"
                        className={styles.voiceButton}
                        aria-label="Talk to One"
                        onClick={openOneVoiceChat}
                      >
                        <Mic className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="submit"
                        className={styles.sendButton}
                        disabled={sending || !draft.trim()}
                        aria-label="Send message"
                      >
                        {sending ? (
                          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <Send className="h-5 w-5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    <span className="sr-only" aria-live="polite">
                      {draft.length}/{DIRECT_MESSAGE_MAX_LENGTH}
                    </span>
                  </form>
                ) : null}
              </AgentDockPortal>
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
                    <AlertDialogCancel>Keep message</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={confirmDelete}>
                      Delete message
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
        </main>
      </section>
    </AppPageShell>
  );
}

export { parseSseFrames };
