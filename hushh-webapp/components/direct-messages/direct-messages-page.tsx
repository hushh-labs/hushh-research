"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import {
  OneChatBubble,
  OneChatTimeSeparator,
} from "@/components/agent/chat-message-styles";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import {
  ArrowLeft,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
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

function formatConversationTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
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
  return `${day}, ${time}`;
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
  const [inbox, setInbox] = useState<DirectMessageConversation[]>([]);
  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
  const [thread, setThread] = useState<ThreadState>(EMPTY_THREAD);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadGeneration = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const activeConversationId = thread.conversation?.id ?? null;
  const hasRouteSelection = Boolean(requestedPersonRef || requestedConversationId);

  const loadInbox = useCallback(async () => {
    if (!user) return;
    setLoadingInbox(true);
    try {
      const idToken = await user.getIdToken();
      const result = await DirectMessagesService.listConversations({ idToken });
      setInbox(result.items);
      setInboxUnreadCount(result.unreadCount);
      setInboxError(null);
    } catch (error) {
      setInboxError(
        error instanceof Error ? error.message : "Your conversations could not be loaded.",
      );
    } finally {
      setLoadingInbox(false);
    }
  }, [user]);

  const loadThread = useCallback(
    async (options?: { preserveMessages?: boolean }) => {
      if (!user) return;
      const generation = ++loadGeneration.current;
      if (!options?.preserveMessages) setLoadingThread(true);
      setThreadError(null);
      try {
        const idToken = await user.getIdToken();
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
            : message || "This conversation could not be loaded.",
        );
      } finally {
        if (generation === loadGeneration.current) setLoadingThread(false);
      }
    },
    [requestedConversationId, requestedPersonRef, user],
  );

  useEffect(() => {
    if (!user) {
      setInbox([]);
      setInboxUnreadCount(0);
      setThread(EMPTY_THREAD);
      setMessages([]);
      return;
    }
    void loadInbox();
  }, [loadInbox, user]);

  useEffect(() => {
    if (!user) return;
    void loadThread();
  }, [loadThread, user]);

  const refresh = useCallback(() => {
    void loadInbox();
    if (hasRouteSelection) void loadThread({ preserveMessages: true });
  }, [hasRouteSelection, loadInbox, loadThread]);

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

  const openConversation = (conversation: DirectMessageConversation) => {
    router.push(
      buildDirectMessageRoute({ conversationId: conversation.id }),
      { scroll: false },
    );
  };

  const backToInbox = () => {
    router.push(ROUTES.ONE_MESSAGES, { scroll: false });
  };

  const sendDraft = async (event?: FormEvent<HTMLFormElement>, retry?: string) => {
    event?.preventDefault();
    if (!user || sending || !thread.canSend) return;
    const content = retry ?? draft;
    const recipientPersonRef = thread.peerPersonRef || requestedPersonRef;
    if (!recipientPersonRef) {
      setSendError("This recipient is no longer available for messaging.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const idToken = await user.getIdToken();
      const result = await DirectMessagesService.sendMessage({
        idToken,
        content,
        recipientPersonRef,
      });
      setDraft("");
      setFailedDraft(null);
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
      router.replace(
        buildDirectMessageRoute({ conversationId: result.conversation.id }),
        { scroll: false },
      );
      void loadInbox();
    } catch (error) {
      setFailedDraft(content);
      setSendError(
        error instanceof Error ? error.message : "Message could not be sent. Try again.",
      );
      // A 403/409 is authoritative: redraw the thread as read-only instead of
      // leaving a stale connected composer visible.
      void loadThread({ preserveMessages: true });
    } finally {
      setSending(false);
    }
  };

  const loadOlderMessages = async () => {
    const conversationId = thread.conversation?.id;
    const before = thread.nextBefore;
    if (!user || !conversationId || !before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const idToken = await user.getIdToken();
      const history = await DirectMessagesService.getConversationMessages({
        idToken,
        conversationId,
        before,
        limit: 60,
      });
      setMessages((current) => mergeMessages(history.items, current));
      setThread(
        threadFromConversation(history.conversation, {
          canSend: history.canSend,
          disconnectedNotice: history.disconnectedNotice,
          nextBefore: history.nextBefore,
        }),
      );
    } catch (error) {
      setThreadError(
        error instanceof Error ? error.message : "Older messages could not be loaded.",
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  const visibleInbox = useMemo(
    () =>
      [...inbox].sort((left, right) => {
        const leftTime = Date.parse(left.lastMessageAt || left.createdAt || "");
        const rightTime = Date.parse(right.lastMessageAt || right.createdAt || "");
        return rightTime - leftTime;
      }),
    [inbox],
  );

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

  return (
    <AppPageShell
      width={hasRouteSelection ? "expanded" : "agent"}
      fitContent={!hasRouteSelection}
    >
      <section
        className={styles.page}
        data-one-chat-surface
        data-chat-open={hasRouteSelection ? "true" : undefined}
        data-native-route="native-route-direct-messages"
      >
        <aside className={styles.inbox} aria-label="Conversations">
          <div className={styles.inboxHeader}>
            <div>
              <h1>Messages</h1>
              <p>
                {inboxUnreadCount > 0
                  ? `${inboxUnreadCount} unread ${inboxUnreadCount === 1 ? "message" : "messages"}`
                  : "Your connections"}
              </p>
            </div>
            <Button
              type="button"
              variant="none"
              effect="fade"
              aria-label="Refresh conversations"
              className={styles.refreshButton}
              disabled={loadingInbox}
              onClick={() => refresh()}
            >
              {loadingInbox ? (
                <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
              ) : (
                <RefreshCw className="h-5 w-5" />
              )}
            </Button>
          </div>

          {inboxError ? (
            <div className={styles.errorState} role="alert">
              <p>{inboxError}</p>
              <Button type="button" variant="none" effect="fade" onClick={() => void loadInbox()}>
                Try again
              </Button>
            </div>
          ) : null}

          {loadingInbox && visibleInbox.length === 0 ? (
            <p className={styles.loading}>Loading conversations…</p>
          ) : visibleInbox.length ? (
            <ul className={styles.conversationList}>
              {visibleInbox.map((conversation) => {
                const active = activeConversationId === conversation.id;
                const preview = conversation.latestMessage?.content || "No messages yet";
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={styles.conversationRow}
                      data-active={active ? "true" : undefined}
                      onClick={() => openConversation(conversation)}
                    >
                      <ConnectionPersonAvatar
                        label={conversation.peerDisplayName || "Connection"}
                        photoUrl={conversation.peerPhotoUrl}
                        size="list"
                        className={styles.conversationAvatar}
                      />
                      <span className={styles.conversationCopy}>
                        <span className={styles.conversationName}>
                          {conversation.peerDisplayName || "Connection"}
                        </span>
                        <span className={styles.conversationPreview}>{preview}</span>
                      </span>
                      <span className={styles.conversationMeta}>
                        <time dateTime={conversation.lastMessageAt || conversation.createdAt || undefined}>
                          {formatConversationTime(conversation.lastMessageAt || conversation.createdAt)}
                        </time>
                        {conversation.unreadCount > 0 ? (
                          <span className={styles.unreadCount} aria-label={`${conversation.unreadCount} unread`}>
                            {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className={styles.emptyInbox}>
              <MessageCircle className="h-7 w-7" aria-hidden="true" />
              <h2>No conversations yet</h2>
              <p>Open a connected person’s profile to start a message.</p>
            </div>
          )}
        </aside>

        <main className={styles.thread} aria-live="polite">
          {hasRouteSelection ? (
            <>
              <header className={styles.threadHeader}>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  className={styles.backButton}
                  aria-label="Back to messages"
                  onClick={backToInbox}
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                </Button>
                <ConnectionPersonAvatar
                  label={selectedLabel}
                  photoUrl={thread.peerPhotoUrl}
                  size="list"
                  className={styles.threadAvatar}
                />
                <div className={styles.threadTitle}>
                  <h2>{selectedLabel}</h2>
                  <p>{thread.canSend ? "Connected on One" : "Conversation"}</p>
                </div>
              </header>

              {threadError && !thread.disconnectedNotice ? (
                <div className={styles.threadError} role="alert">
                  <p>{threadError}</p>
                  <Button type="button" variant="none" effect="fade" onClick={() => void loadThread()}>
                    Try again
                  </Button>
                </div>
              ) : null}

              <div
                className={cn(
                  styles.messageList,
                  "mx-auto w-full max-w-3xl px-4 pt-5 sm:px-6 lg:px-8",
                )}
                ref={messageListRef}
                data-testid="direct-message-list"
                aria-label={`${selectedLabel} message feed`}
              >
                {loadingThread && messages.length === 0 ? (
                  <p className={styles.loading}>Loading messages…</p>
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
                {messages.map((message, index) => (
                  <div key={message.id} className={styles.messageFeedItem}>
                    {isNewMessageDay(message, messages[index - 1]) ? (
                      <OneChatTimeSeparator
                        accessibleLabel={formatMessageFeedMarker(message.createdAt)}
                        dateTime={message.createdAt}
                        label={formatMessageFeedMarker(message.createdAt)}
                      />
                    ) : null}
                    <article
                      className={cn(
                        "motion-step-enter flex w-full items-start gap-2",
                        message.senderIsViewer ? "justify-end" : "justify-start",
                      )}
                      data-message-role={message.senderIsViewer ? "user" : "peer"}
                      data-message-sent-at={message.createdAt}
                    >
                      <div
                        className={cn(
                          "min-w-0 max-w-[90%] sm:max-w-[min(82%,48rem)]",
                          message.senderIsViewer && "sm:max-w-[min(76%,42rem)]",
                        )}
                      >
                        <OneChatBubble tone={message.senderIsViewer ? "user" : "assistant"}>
                          <p className="whitespace-pre-wrap break-words">{message.content}</p>
                        </OneChatBubble>
                      </div>
                    </article>
                  </div>
                ))}
              </div>

              {!thread.canSend ? (
                messages.length > 0 ? (
                  <div className={styles.readOnlyNotice} role="status">
                    {thread.disconnectedNotice || "You are no longer connected."}
                  </div>
                ) : null
              ) : (
                <form
                  className={cn(
                    styles.composer,
                    "agent-chat-composer-surface flex min-h-[3.75rem] items-center gap-2 overflow-hidden rounded-[var(--app-input-radius)] px-2.5 pl-3.5",
                  )}
                  onSubmit={(event) => void sendDraft(event)}
                >
                  <label className="sr-only" htmlFor="direct-message-draft">
                    Message {selectedLabel}
                  </label>
                  <textarea
                    id="direct-message-draft"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={`Message ${selectedLabel}`}
                    maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                    disabled={sending}
                    rows={1}
                    className="h-auto max-h-40 min-h-0 min-w-0 flex-1 resize-none overscroll-contain overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-0 bg-transparent px-0 py-3 text-[15px] leading-snug text-foreground caret-[color:var(--app-accent)] outline-none shadow-none focus-visible:border-transparent focus-visible:ring-0 placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60 sm:max-h-44 sm:text-sm break-words [overflow-wrap:anywhere] [word-break:break-word]"
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
                  <span className="sr-only" aria-live="polite">
                    {draft.length}/{DIRECT_MESSAGE_MAX_LENGTH}
                  </span>
                </form>
              )}
              {sendError ? (
                <div className={styles.sendError} role="alert">
                  <span>{sendError}</span>
                  {failedDraft ? (
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      disabled={sending}
                      onClick={() => void sendDraft(undefined, failedDraft)}
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.selectThread}>
              <MessageCircle className="h-8 w-8" aria-hidden="true" />
              <h2>Choose a conversation</h2>
              <p>Select a connection to read messages or start a new one.</p>
            </div>
          )}
        </main>
      </section>
    </AppPageShell>
  );
}

export { parseSseFrames };
