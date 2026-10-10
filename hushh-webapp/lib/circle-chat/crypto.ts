import { openRecipientPayload, sealRecipientPayload, type RecipientPayloadEnvelope } from "@/lib/one-location/encryption";
import type { OneLocationMyRecipientKey } from "@/lib/one-location/types";
import { unzipSync } from "fflate";
export type ChatKeyRecovery = { vaultKey: string; remoteBackup: OneLocationMyRecipientKey };

export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_TEXT = 4000;
export type ChatMemberKey = { userId: string; name: string; keyId: string | null; publicKeyJwk: JsonWebKey | null };
export type ChatAttachment = { kind: "photo" | "video" | "document"; type: string; name: string };
export type ChatContent = {
  text: string;
  /** Legacy image messages remain readable after the attachment expansion. */
  image?: { type: string; name: string } | null;
  attachment?: ChatAttachment | null;
};
export type SealedChatMessage = {
  clientMessageId: string; rosterVersion: string; ciphertext: string; iv: string;
  imageCiphertext: string | null; imageIv: string | null;
  recipients: { userId: string; envelope: RecipientPayloadEnvelope }[];
  notificationPreviews?: Record<string, string>;
};
export type ChatMessage = {
  id: string; sequence: number; clientMessageId: string; senderUserId: string;
  senderName: string; createdAt: string; ciphertext: string; iv: string;
  hasImage: boolean; envelope: RecipientPayloadEnvelope;
  senderPhotoUrl?: string | null;
  receipt?: { recipientCount: number | null; readCount: number };
  reactions?: { emoji: string; count: number; reactedByViewer: boolean }[];
};

function encode(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
export function chatContext(circleId: string, clientMessageId: string, senderUserId: string, kind: string): string {
  return JSON.stringify(["hussh-circle-chat-v1", circleId, clientMessageId, senderUserId, kind]);
}

/** Only passive raster images; never render SVG/HTML or trust a filename extension. */
export function validateChatImageBytes(bytes: Uint8Array, type: string): void {
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (bytes.length > MAX_CHAT_IMAGE_BYTES || bytes.length < 12
      || !(type === "image/png" && png || type === "image/jpeg" && jpeg || type === "image/webp" && webp)) {
    throw new Error("Choose a JPEG, PNG, or WebP image up to 5 MB.");
  }
}

export function validateChatAttachmentBytes(bytes: Uint8Array, type: string): ChatAttachment["kind"] {
  if (bytes.length === 0 || bytes.length > MAX_CHAT_IMAGE_BYTES) {
    throw new Error("Choose a photo, video, or document up to 5 MB.");
  }
  if (["image/png", "image/jpeg", "image/webp"].includes(type)) {
    validateChatImageBytes(bytes, type);
    return "photo";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (type === "video/mp4" && bytes.length >= 12 && head.slice(4, 8) === "ftyp") return "video";
  if (type === "video/webm" && bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video";
  if (type === "application/pdf" && head.startsWith("%PDF-")) return "document";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      const names = new Set<string>();
      unzipSync(bytes, { filter: (entry) => { names.add(entry.name); return false; } });
      if (names.has("[Content_Types].xml") && names.has("word/document.xml")) return "document";
    } catch { /* invalid archive */ }
  }
  if (type === "text/plain" && !bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0)) return "document";
  throw new Error("Choose a JPEG, PNG, WebP, MP4, WebM, PDF, DOCX, or text file up to 5 MB.");
}

export async function sealChatMessage(params: {
  circleId: string; userId: string; rosterVersion: string; members: ChatMemberKey[];
  text: string; file?: File | null;
}): Promise<SealedChatMessage> {
  const text = params.text.trim();
  if ((!text && !params.file) || text.length > MAX_CHAT_TEXT) throw new Error("Write a message up to 4,000 characters or choose a file.");
  const missing = params.members.filter((member) => !member.keyId || !member.publicKeyJwk);
  if (missing.length) throw new Error(`${missing[0]!.name} needs to open the app to enable secure chat.`);
  if (!params.members.some((member) => member.userId === params.userId)) throw new Error("You are no longer a member of this circle.");
  const id = crypto.randomUUID();
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const context = (kind: string) => chatContext(params.circleId, id, params.userId, kind);
    const seal = async (bytes: Uint8Array<ArrayBuffer>, kind: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
        additionalData: new TextEncoder().encode(context(kind)) }, key, bytes);
      return { ciphertext: encode(new Uint8Array(cipher)), iv: encode(iv) };
    };
    let image: { ciphertext: string; iv: string } | null = null;
    let attachment: ChatAttachment | null = null;
    if (params.file) {
      if (params.file.size > MAX_CHAT_IMAGE_BYTES) throw new Error("Choose a file up to 5 MB.");
      const bytes = new Uint8Array(await params.file.arrayBuffer());
      attachment = {
        kind: validateChatAttachmentBytes(bytes, params.file.type),
        type: params.file.type,
        name: params.file.name.slice(0, 160),
      };
      image = await seal(bytes, "image");
    }
    const content: ChatContent = { text, attachment };
    const sealed = await seal(new TextEncoder().encode(JSON.stringify(content)), "content");
    const recipients = await Promise.all(params.members.map(async (member) => ({
      userId: member.userId,
      envelope: await sealRecipientPayload({ bytes: rawKey, context: context(`key:${member.userId}`),
        recipientKeyId: member.keyId!, recipientPublicKeyJwk: member.publicKeyJwk! }),
    })));
    return { clientMessageId: id, rosterVersion: params.rosterVersion, ...sealed,
      imageCiphertext: image?.ciphertext ?? null, imageIv: image?.iv ?? null, recipients };
  } finally { rawKey.fill(0); }
}

async function messageKey(circle: string, user: string, message: ChatMessage, recovery?: ChatKeyRecovery): Promise<CryptoKey> {
  const raw = await openRecipientPayload({ userId: user, envelope: message.envelope,
    context: chatContext(circle, message.clientMessageId, message.senderUserId, `key:${user}`), recovery });
  try { return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]); }
  finally { new Uint8Array(raw).fill(0); }
}

export async function openChatContent(circle: string, user: string, message: ChatMessage, recovery?: ChatKeyRecovery): Promise<ChatContent> {
  const key = await messageKey(circle, user, message, recovery);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(message.iv),
    additionalData: new TextEncoder().encode(chatContext(circle, message.clientMessageId, message.senderUserId, "content")) },
    key, decode(message.ciphertext));
  const content = JSON.parse(new TextDecoder().decode(bytes)) as ChatContent;
  const attachment = content.attachment ?? content.image;
  if (typeof content.text !== "string" || content.text.length > MAX_CHAT_TEXT
      || Boolean(attachment) !== message.hasImage || Boolean(content.attachment && content.image)
      || attachment && (typeof attachment.name !== "string" || attachment.name.length > 160
        || typeof attachment.type !== "string"
        || !["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"].includes(attachment.type))) {
    throw new Error("This message has an unsupported format.");
  }
  return content;
}

export async function openChatImage(circle: string, user: string, message: ChatMessage,
  image: { ciphertext: string; iv: string }, type: string, recovery?: ChatKeyRecovery): Promise<Blob> {
  if (image.ciphertext.length > 6990530) throw new Error("Image is too large.");
  const key = await messageKey(circle, user, message, recovery);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(image.iv),
    additionalData: new TextEncoder().encode(chatContext(circle, message.clientMessageId, message.senderUserId, "image")) },
    key, decode(image.ciphertext));
  validateChatAttachmentBytes(new Uint8Array(bytes), type);
  return new Blob([bytes], { type });
}
