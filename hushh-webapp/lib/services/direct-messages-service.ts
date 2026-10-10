import { ApiService } from "@/lib/services/api-service";
import { validateChatAttachmentBytes, MAX_CHAT_IMAGE_BYTES } from "@/lib/circle-chat/crypto";

export type DirectMessageKind = "text" | "photo" | "video" | "document";
export type DirectMessageAttachment = {
  kind: "photo" | "video" | "document";
  name: string;
  mimeType: string;
  size: number;
};

export type DirectMessageReaction = {
  emoji: string;
  count: number;
  reactedByViewer: boolean;
};

export type DirectMessageReplyPreview = {
  id: string;
  content: string;
  senderIsViewer: boolean;
  deletedForEveryoneAt: string | null;
};

export const DIRECT_MESSAGE_MAX_LENGTH = 4_000;

export type DirectMessage = {
  id: string;
  conversationId: string;
  /** Participant-relative marker. Raw sender ids remain server-side. */
  senderIsViewer: boolean;
  content: string;
  createdAt: string;
  readAt: string | null;
  editedAt?: string | null;
  deletedForEveryoneAt?: string | null;
  replyTo?: DirectMessageReplyPreview | null;
  reactions?: DirectMessageReaction[];
  kind?: DirectMessageKind;
  attachment?: DirectMessageAttachment | null;
};

export type DirectMessageConversation = {
  id: string;
  peerPersonRef: string | null;
  peerDisplayName: string | null;
  peerPhotoUrl: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  latestMessage: DirectMessage | null;
  unreadCount: number;
};

export type DirectMessageInbox = {
  items: DirectMessageConversation[];
  unreadCount: number;
};

export type DirectMessagePeerState = {
  conversation: DirectMessageConversation | null;
  peerPersonRef: string | null;
  peerDisplayName: string | null;
  peerPhotoUrl: string | null;
  canSend: boolean;
  disconnectedNotice: string | null;
};

export type DirectMessageHistory = {
  conversation: DirectMessageConversation;
  items: DirectMessage[];
  canSend: boolean;
  disconnectedNotice: string | null;
  nextBefore: string | null;
};

export type DirectMessageSendResult = {
  conversation: DirectMessageConversation;
  message: DirectMessage;
};

export type DirectMessageReadResult = {
  readCount: number;
  readAt: string | null;
};

export class DirectMessagesServiceRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DirectMessagesServiceRequestError";
    this.status = status;
  }
}

function authHeaders(idToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
  };
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: unknown;
    detail?: unknown;
    message?: unknown;
  };
  if (response.ok) return payload as T;

  // FastAPI's HTTPException route shape is `{ detail: { code, message } }`.
  // Keep that server-authoritative explanation intact (notably the accepted-
  // connection gate) instead of flattening every refusal into a generic 403.
  const detailMessage =
    payload.detail && typeof payload.detail === "object"
      ? (payload.detail as { message?: unknown }).message
      : payload.detail;
  const candidates = [payload.error, detailMessage, payload.message];
  const message = candidates.find(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );
  throw new DirectMessagesServiceRequestError(
    response.status,
    message?.trim() || `Message request failed (${response.status})`,
  );
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNonNegativeInt(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function parseReactions(value: unknown): DirectMessageReaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const emoji = asTrimmedString(source.emoji);
    const count = asNonNegativeInt(source.count);
    if (!emoji || !count) return [];
    return [{ emoji, count, reactedByViewer: source.reactedByViewer === true }];
  });
}

function parseReplyPreview(value: unknown): DirectMessageReplyPreview | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = asTrimmedString(source.id);
  const content = typeof source.content === "string" ? source.content : null;
  if (!id || content === null) return null;
  return {
    id,
    content,
    senderIsViewer: source.senderIsViewer === true,
    deletedForEveryoneAt: asTrimmedString(source.deletedForEveryoneAt),
  };
}

function parseAttachment(value: unknown): DirectMessageAttachment | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const name = asTrimmedString(source.name);
  const mimeType = asTrimmedString(source.mimeType);
  const kind = source.kind;
  const size = Number(source.size);
  if (!name || !mimeType || !["photo", "video", "document"].includes(String(kind))
      || !Number.isSafeInteger(size) || size < 1 || size > MAX_CHAT_IMAGE_BYTES) return null;
  return { name, mimeType, kind: kind as DirectMessageAttachment["kind"], size };
}

function parseMessage(value: unknown): DirectMessage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = asTrimmedString(source.id);
  const conversationId = asTrimmedString(source.conversationId);
  const content = typeof source.content === "string" ? source.content : null;
  const createdAt = asTrimmedString(source.createdAt);
  if (!id || !conversationId || content === null || !createdAt) {
    return null;
  }
  return {
    id,
    conversationId,
    senderIsViewer: source.senderIsViewer === true,
    content,
    createdAt,
    readAt: asTrimmedString(source.readAt),
    editedAt: asTrimmedString(source.editedAt),
    deletedForEveryoneAt: asTrimmedString(source.deletedForEveryoneAt),
    replyTo: parseReplyPreview(source.replyTo),
    reactions: parseReactions(source.reactions),
    kind: source.kind === "text" ? "text" : undefined,
    attachment: parseAttachment(source.attachment),
  };
}

function parseConversation(value: unknown): DirectMessageConversation | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = asTrimmedString(source.id);
  if (!id) return null;
  return {
    id,
    peerPersonRef: asTrimmedString(source.peerPersonRef),
    peerDisplayName: asTrimmedString(source.peerDisplayName),
    peerPhotoUrl: asTrimmedString(source.peerPhotoUrl),
    createdAt: asTrimmedString(source.createdAt),
    lastMessageAt: asTrimmedString(source.lastMessageAt),
    latestMessage: parseMessage(source.latestMessage),
    unreadCount: asNonNegativeInt(source.unreadCount),
  };
}

function parseConversations(value: unknown): DirectMessageConversation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = parseConversation(entry);
    return parsed ? [parsed] : [];
  });
}

function parseMessages(value: unknown): DirectMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = parseMessage(entry);
    return parsed ? [parsed] : [];
  });
}

/** Normalizes input before a network call so blank/oversize sends never leave the device. */
export function normalizeDirectMessageContent(value: string, allowEmpty = false): string {
  const content = String(value ?? "").trim();
  if (!content && !allowEmpty) throw new Error("Write a message before sending.");
  if (content.length > DIRECT_MESSAGE_MAX_LENGTH) {
    throw new Error(
      `Messages can be up to ${DIRECT_MESSAGE_MAX_LENGTH.toLocaleString()} characters.`,
    );
  }
  return content;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * All peer-messaging requests stay behind the service boundary. The backend
 * is the authority for connection/participant checks; the client never treats
 * a route query or a cached relationship as permission to send.
 */
export class DirectMessagesService {
  static async routeSelection(input: { idToken: string; token?: string; conversationId?: string; personRef?: string }): Promise<{ token: string; kind: "conversation" | "person"; ref: string }> {
    const { idToken, ...selection } = input;
    const response = await ApiService.apiFetch("/api/one/messages/route-token", {
      method: "POST", cache: "no-store", headers: authHeaders(idToken), body: JSON.stringify(selection),
    });
    return jsonOrThrow(response);
  }

  static async routeHref(input: { idToken: string; conversationId?: string; personRef?: string }): Promise<string> {
    const selection = await this.routeSelection(input);
    return `/one/messages?token=${encodeURIComponent(selection.token)}`;
  }

  static async listConversations(input: {
    idToken: string;
  }): Promise<DirectMessageInbox> {
    const response = await ApiService.apiFetch("/api/one/messages/conversations", {
      method: "GET",
      cache: "no-store",
      headers: authHeaders(input.idToken),
    });
    const payload = await jsonOrThrow<{ items?: unknown; unreadCount?: unknown }>(
      response,
    );
    return {
      items: parseConversations(payload.items),
      unreadCount: asNonNegativeInt(payload.unreadCount),
    };
  }

  /** Resolve a public person reference server-side; never place a peer UID in a URL. */
  static async getConversationWithPerson(input: {
    idToken: string;
    personRef: string;
  }): Promise<DirectMessagePeerState> {
    const personRef = String(input.personRef || "").trim();
    if (!personRef) throw new Error("A person reference is required.");
    const response = await ApiService.apiFetch(
      `/api/one/messages/with/person/${encodeURIComponent(personRef)}`,
      {
        method: "GET",
        cache: "no-store",
        headers: authHeaders(input.idToken),
      },
    );
    const payload = await jsonOrThrow<{
      conversation?: unknown;
      peerPersonRef?: unknown;
      peerDisplayName?: unknown;
      peerPhotoUrl?: unknown;
      canSend?: unknown;
      disconnectedNotice?: unknown;
    }>(response);
    return {
      conversation: parseConversation(payload.conversation),
      peerPersonRef: asTrimmedString(payload.peerPersonRef) ?? personRef,
      peerDisplayName: asTrimmedString(payload.peerDisplayName),
      peerPhotoUrl: asTrimmedString(payload.peerPhotoUrl),
      canSend: payload.canSend === true,
      disconnectedNotice: asTrimmedString(payload.disconnectedNotice),
    };
  }

  static async getConversationMessages(input: {
    idToken: string;
    conversationId: string;
    before?: string | null;
    limit?: number;
  }): Promise<DirectMessageHistory> {
    const conversationId = String(input.conversationId || "").trim();
    if (!conversationId) throw new Error("A conversation is required.");
    const params = new URLSearchParams();
    if (input.before?.trim()) params.set("before", input.before.trim());
    if (typeof input.limit === "number") params.set("limit", String(input.limit));
    const suffix = params.size ? `?${params.toString()}` : "";
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
      {
        method: "GET",
        cache: "no-store",
        headers: authHeaders(input.idToken),
      },
    );
    const payload = await jsonOrThrow<{
      conversation?: unknown;
      items?: unknown;
      canSend?: unknown;
      disconnectedNotice?: unknown;
      nextBefore?: unknown;
    }>(response);
    const conversation = parseConversation(payload.conversation);
    if (!conversation) throw new Error("The conversation could not be loaded.");
    return {
      conversation,
      items: parseMessages(payload.items),
      canSend: payload.canSend === true,
      disconnectedNotice: asTrimmedString(payload.disconnectedNotice),
      nextBefore: asTrimmedString(payload.nextBefore),
    };
  }

  static async sendMessage(input: {
    idToken: string;
    content: string;
    recipientPersonRef: string;
    replyToMessageId?: string | null;
    clientMessageId?: string;
    attachment?: File;
  }): Promise<DirectMessageSendResult> {
    const recipientPersonRef = String(input.recipientPersonRef || "").trim();
    if (!recipientPersonRef) throw new Error("Choose one connected recipient before sending.");
    let attachment: { name: string; mimeType: string; data: string } | undefined;
    if (input.attachment) {
      if (!input.attachment.size || input.attachment.size > MAX_CHAT_IMAGE_BYTES) {
        throw new Error("Choose a file up to 5 MB.");
      }
      const bytes = new Uint8Array(await input.attachment.arrayBuffer());
      validateChatAttachmentBytes(bytes, input.attachment.type);
      attachment = { name: input.attachment.name, mimeType: input.attachment.type, data: encodeBase64Url(bytes) };
    }
    const response = await ApiService.apiFetch("/api/one/messages", {
      method: "POST",
      headers: authHeaders(input.idToken),
      body: JSON.stringify({
        content: normalizeDirectMessageContent(input.content, Boolean(attachment)),
        recipientPersonRef,
        ...(attachment ? { attachment } : {}),
        ...(input.replyToMessageId?.trim()
          ? { replyToMessageId: input.replyToMessageId.trim() }
          : {}),
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      }),
    });
    const payload = await jsonOrThrow<{ conversation?: unknown; message?: unknown }>(
      response,
    );
    const conversation = parseConversation(payload.conversation);
    const message = parseMessage(payload.message);
    if (!conversation || !message || message.conversationId !== conversation.id) {
      throw new Error("The sent message could not be verified.");
    }
    return { conversation, message };
  }

  static async getAttachment(input: {
    idToken: string;
    conversationId: string;
    messageId: string;
  }): Promise<Blob> {
    const conversationId = String(input.conversationId || "").trim();
    const messageId = String(input.messageId || "").trim();
    if (!conversationId || !messageId) throw new Error("This attachment is no longer available.");
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachment`,
      { method: "GET", cache: "no-store", headers: authHeaders(input.idToken) },
    );
    if (!response.ok) await jsonOrThrow(response);
    return response.blob();
  }

  static async editMessage(input: {
    idToken: string;
    conversationId: string;
    messageId: string;
    content: string;
  }): Promise<DirectMessage> {
    const conversationId = String(input.conversationId || "").trim();
    const messageId = String(input.messageId || "").trim();
    if (!conversationId || !messageId) throw new Error("This message is no longer available.");
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: authHeaders(input.idToken),
        body: JSON.stringify({ content: normalizeDirectMessageContent(input.content) }),
      },
    );
    const payload = await jsonOrThrow<{ message?: unknown }>(response);
    const message = parseMessage(payload.message);
    if (!message || message.id !== messageId || message.conversationId !== conversationId) {
      throw new Error("The edited message could not be verified.");
    }
    return message;
  }

  static async deleteMessage(input: {
    idToken: string;
    conversationId: string;
    messageId: string;
    scope: "me" | "everyone";
  }): Promise<{ scope: "me" | "everyone"; message: DirectMessage | null }> {
    const conversationId = String(input.conversationId || "").trim();
    const messageId = String(input.messageId || "").trim();
    if (!conversationId || !messageId) throw new Error("This message is no longer available.");
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}?scope=${input.scope}`,
      { method: "DELETE", headers: authHeaders(input.idToken) },
    );
    const payload = await jsonOrThrow<{ scope?: unknown; message?: unknown }>(response);
    const scope = payload.scope === "everyone" ? "everyone" : payload.scope === "me" ? "me" : null;
    if (!scope) throw new Error("The deleted message could not be verified.");
    const message = payload.message == null ? null : parseMessage(payload.message);
    if (scope === "everyone" && (!message || message.id !== messageId)) {
      throw new Error("The deleted message could not be verified.");
    }
    return { scope, message };
  }

  static async reactToMessage(input: {
    idToken: string;
    conversationId: string;
    messageId: string;
    emoji: string;
  }): Promise<DirectMessage> {
    const conversationId = String(input.conversationId || "").trim();
    const messageId = String(input.messageId || "").trim();
    const emoji = String(input.emoji || "").trim();
    if (!conversationId || !messageId || !emoji) throw new Error("This message is no longer available.");
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reaction`,
      {
        method: "PUT",
        headers: authHeaders(input.idToken),
        body: JSON.stringify({ emoji }),
      },
    );
    const payload = await jsonOrThrow<{ message?: unknown }>(response);
    const message = parseMessage(payload.message);
    if (!message || message.id !== messageId || message.conversationId !== conversationId) {
      throw new Error("The reaction could not be verified.");
    }
    return message;
  }

  static async removeReaction(input: {
    idToken: string;
    conversationId: string;
    messageId: string;
    emoji: string;
  }): Promise<DirectMessage> {
    const conversationId = String(input.conversationId || "").trim();
    const messageId = String(input.messageId || "").trim();
    const emoji = String(input.emoji || "").trim();
    if (!conversationId || !messageId || !emoji) throw new Error("This message is no longer available.");
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reaction`,
      { method: "DELETE", headers: authHeaders(input.idToken), body: JSON.stringify({ emoji }) },
    );
    const payload = await jsonOrThrow<{ message?: unknown }>(response);
    const message = parseMessage(payload.message);
    if (!message || message.id !== messageId || message.conversationId !== conversationId) {
      throw new Error("The reaction could not be verified.");
    }
    return message;
  }

  static async markConversationRead(input: {
    idToken: string;
    ownerUserId: string;
    conversationId: string;
    throughMessageId?: string;
    throughCreatedAt?: string;
  }): Promise<DirectMessageReadResult> {
    const conversationId = String(input.conversationId || "").trim();
    if (!conversationId) throw new Error("A conversation is required.");
    const { activeNotificationKeyId } = await import("@/lib/notifications/preview-keys");
    const keyId = activeNotificationKeyId(input.ownerUserId);
    const response = await ApiService.apiFetch(
      `/api/one/messages/conversations/${encodeURIComponent(conversationId)}/read${input.throughMessageId ? `?throughMessageId=${encodeURIComponent(input.throughMessageId)}` : ""}`,
      {
        method: "POST",
        headers: authHeaders(input.idToken),
      },
    );
    const payload = await jsonOrThrow<{ readCount?: unknown; readAt?: unknown; readThroughCreatedAt?: unknown; readThroughMessageId?: string; chatBadgeCount?: number; chatBadgeVersion?: number }>(
      response,
    );
    if (keyId) {
      const { ChatSystemNotifications } = await import("@/lib/notifications/chat-system-notifications");
      const cutoff = payload.readThroughCreatedAt ?? input.throughCreatedAt;
      const before = cutoff ? Date.parse(String(cutoff)) : NaN;
      const messageId = payload.readThroughMessageId ?? input.throughMessageId;
      // FCM timestamps have millisecond precision. A later unread message can
      // share the boundary's millisecond; clear the exact boundary event and
      // only strictly earlier milliseconds in the system tray.
      if (Number.isFinite(before)) await ChatSystemNotifications.clearRead({ threadId: conversationId, keyId,
        before: before - 1, badgeCount: payload.chatBadgeCount, badgeVersion: payload.chatBadgeVersion,
        ...(messageId ? { messageId: `direct-message:${messageId}` } : {}) });
    }
    return {
      readCount: asNonNegativeInt(payload.readCount),
      readAt: asTrimmedString(payload.readAt),
    };
  }

  /** Authenticated SSE stream; consumers re-fetch durable rows after every metadata event. */
  static openEvents(input: { idToken: string; signal?: AbortSignal }): Promise<Response> {
    return ApiService.apiFetchStream("/api/one/messages/events", {
      method: "GET",
      cache: "no-store",
      headers: authHeaders(input.idToken),
      signal: input.signal,
    });
  }
}
