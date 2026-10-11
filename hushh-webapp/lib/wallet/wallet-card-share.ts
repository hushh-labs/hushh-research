import { openRecipientPayload, sealRecipientPayload, type RecipientPayloadEnvelope } from "@/lib/one-location/encryption";
import type { OneLocationMyRecipientKey } from "@/lib/one-location/types";
import { decryptExport, encryptForExport, generateExportKey } from "@/lib/vault/export-encrypt";
import { DIRECT_MESSAGE_MAX_LENGTH } from "@/lib/services/direct-messages-service";
import { projectSharedPaymentCard, type SharedPaymentCard } from "./shared-payment-card";
export { projectSharedPaymentCard, type SharedPaymentCard } from "./shared-payment-card";

const PREFIX = "hushh-wallet-card:v1:";
export type WalletCardShareEnvelope = {
  shareId: string; cardId: string;
  payload: { ciphertext: string; iv: string; tag: string };
  senderKey: RecipientPayloadEnvelope; recipientKey: RecipientPayloadEnvelope;
};
type Member = { userId: string; keyId: string; publicKeyJwk: JsonWebKey };
function context(envelope: Pick<WalletCardShareEnvelope, "shareId" | "cardId">, sender: string, recipient: string) {
  return JSON.stringify([PREFIX, envelope.shareId, envelope.cardId, sender, recipient]);
}
function keyValid(key: RecipientPayloadEnvelope) {
  return key && key.algorithm === "ECDH-P256-AES256-GCM" && typeof key.recipientKeyId === "string" &&
    key.recipientKeyId.length > 0 && key.recipientKeyId.length <= 160 &&
    /^[\w-]{16}$/.test(key.iv) && /^[\w-]{64}$/.test(key.ciphertext) &&
    key.senderEphemeralPublicKeyJwk?.kty === "EC" && key.senderEphemeralPublicKeyJwk.crv === "P-256" &&
    typeof key.senderEphemeralPublicKeyJwk.x === "string" && typeof key.senderEphemeralPublicKeyJwk.y === "string" &&
    !key.senderEphemeralPublicKeyJwk.d;
}
export function isWalletCardShare(content: string): boolean { return content.startsWith(PREFIX); }
export function walletMessagePreview(content: string): string {
  return isWalletCardShare(content) || /^\[wallet-access:[a-f0-9-]{36}\]$/i.test(content) ? "Shared payment card" : content;
}
export function parseWalletCardShare(content: string): WalletCardShareEnvelope {
  if (!isWalletCardShare(content) || content.length > DIRECT_MESSAGE_MAX_LENGTH) throw new Error("Card unavailable.");
  let value: WalletCardShareEnvelope;
  try { value = JSON.parse(content.slice(PREFIX.length)); } catch { throw new Error("Card unavailable."); }
  if (!value || !/^[\da-f-]{36}$/i.test(value.shareId) || !/^card_[\w-]{1,64}$/.test(value.cardId) ||
      !value.payload || !/^[A-Za-z\d+/]+=*$/.test(value.payload.ciphertext) || value.payload.ciphertext.length > 900 ||
      !/^[A-Za-z\d+/]{16}$/.test(value.payload.iv) || !/^[A-Za-z\d+/]{22}==$/.test(value.payload.tag) ||
      !keyValid(value.senderKey) || !keyValid(value.recipientKey)) throw new Error("Card unavailable.");
  return value;
}
export async function sealWalletCardShare(params: { cardId: string; card: SharedPaymentCard; sender: Member; recipient: Member }): Promise<string> {
  if (params.sender.userId === params.recipient.userId) throw new Error("Choose another person.");
  const binding = { shareId: crypto.randomUUID(), cardId: params.cardId };
  const aad = context(binding, params.sender.userId, params.recipient.userId);
  const exportKey = await generateExportKey();
  const bytes = Uint8Array.from(exportKey.match(/../g)!, byte => parseInt(byte, 16));
  try {
    const [payload, senderKey, recipientKey] = await Promise.all([
      encryptForExport(JSON.stringify(projectSharedPaymentCard(params.card)), exportKey, { additionalData: aad }),
      sealRecipientPayload({ bytes, context: `${aad}:sender`, recipientKeyId: params.sender.keyId, recipientPublicKeyJwk: params.sender.publicKeyJwk }),
      sealRecipientPayload({ bytes, context: `${aad}:recipient`, recipientKeyId: params.recipient.keyId, recipientPublicKeyJwk: params.recipient.publicKeyJwk }),
    ]);
    const content = PREFIX + JSON.stringify({ ...binding, payload, senderKey, recipientKey });
    parseWalletCardShare(content);
    return content;
  } finally { bytes.fill(0); }
}
export async function openWalletCardShare(params: {
  content: string; userId: string; peerUserId: string; senderIsViewer: boolean;
  recovery?: { vaultKey: string; remoteBackup: OneLocationMyRecipientKey };
}): Promise<SharedPaymentCard> {
  const envelope = parseWalletCardShare(params.content);
  if (!params.userId || !params.peerUserId || params.userId === params.peerUserId) throw new Error("Card unavailable.");
  const aad = context(envelope, params.senderIsViewer ? params.userId : params.peerUserId, params.senderIsViewer ? params.peerUserId : params.userId);
  const bytes = new Uint8Array(await openRecipientPayload({ userId: params.userId,
    context: `${aad}:${params.senderIsViewer ? "sender" : "recipient"}`,
    envelope: params.senderIsViewer ? envelope.senderKey : envelope.recipientKey, recovery: params.recovery }));
  try {
    if (bytes.length !== 32) throw new Error("Card unavailable.");
    const key = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return projectSharedPaymentCard(JSON.parse(await decryptExport(envelope.payload.ciphertext, envelope.payload.iv, envelope.payload.tag, key, { additionalData: aad })));
  } finally { bytes.fill(0); }
}
