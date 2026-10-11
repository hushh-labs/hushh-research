import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import { sealWalletCardShare } from "@/lib/wallet/wallet-card-share";
import { createEncryptedCardFile } from "@/lib/wallet/wallet-card-file";
import { DirectMessagesService } from "./direct-messages-service";
import { WalletService, type WalletCardShareReceipt } from "./wallet-service";

export type CardShareContext = { userId: string; vaultKey: string; vaultOwnerToken: string; getIdToken: () => Promise<string>; isCurrent: () => boolean };
function requireCurrent(context: CardShareContext) { if (!context.isCurrent()) throw new Error("Wallet changed. Try again."); }

export async function prepareSavedCardFile(context: CardShareContext, cardId: string, password: string, openAt?: string): Promise<File> {
  requireCurrent(context);
  const saved = await WalletService.getCard({ ...context, cardId });
  requireCurrent(context);
  if (!saved) throw new Error("Card no longer available.");
  const file = await createEncryptedCardFile({ pan: saved.secrets.pan, cardholderName: saved.secrets.cardholderName,
    brand: saved.summary.brand, expiryMonth: saved.summary.expiryMonth, expiryYear: saved.summary.expiryYear,
    issuingRegion: saved.summary.issuingRegion }, password, openAt);
  requireCurrent(context);
  return file;
}

export async function findCardShareRecipients(context: CardShareContext, query = "") {
  const result = await OneLocationService.listRecipientsPage({ vaultOwnerToken: context.vaultOwnerToken, query, limit: 50 });
  requireCurrent(context);
  return result;
}
export async function shareSavedCard(context: CardShareContext, cardId: string, selected: OneLocationRecipient): Promise<{ receipt: WalletCardShareReceipt; receiptSaved: boolean }> {
  requireCurrent(context);
  if (!selected.publicPersonRef || selected.userId === context.userId || !selected.keyId || !selected.publicKeyJwk) throw new Error("This person needs to unlock Hushh before receiving a card.");
  const idToken = await context.getIdToken();
  requireCurrent(context);
  const peer = await DirectMessagesService.getConversationWithPerson({ idToken, personRef: selected.publicPersonRef });
  requireCurrent(context);
  if (!peer.canSend || peer.peerPersonRef !== selected.publicPersonRef) throw new Error("Connect with this person before sharing a card.");
  // Re-resolve the key after exact recipient confirmation; never send to a stale picker key.
  let recipient: OneLocationRecipient | undefined;
  for (let page = 1; ; page += 1) {
    const result = await OneLocationService.listRecipientsPage({ vaultOwnerToken: context.vaultOwnerToken, page, limit: 50 });
    requireCurrent(context);
    recipient = result.items.find(item => item.publicPersonRef === selected.publicPersonRef && item.userId === selected.userId);
    if (recipient || !result.hasMore) break;
    if (result.page !== page || !result.items.length) throw new Error("Recipients could not be verified.");
  }
  if (!recipient?.keyId || !recipient.publicKeyJwk || recipient.keyId !== selected.keyId) throw new Error("Secure access changed. Choose the person again.");
  const sender = await bootstrapCurrentUserLocationRecipientKey({ ...context, strictRecovery: true });
  requireCurrent(context);
  if (sender.userId !== context.userId || !sender.keyId || !sender.publicKeyJwk) throw new Error("Secure sharing unavailable.");
  const saved = await WalletService.getCard({ ...context, cardId });
  requireCurrent(context);
  if (!saved) throw new Error("Card no longer available.");
  const content = await sealWalletCardShare({ cardId,
    card: { pan: saved.secrets.pan, cardholderName: saved.secrets.cardholderName, brand: saved.summary.brand,
      expiryMonth: saved.summary.expiryMonth, expiryYear: saved.summary.expiryYear, issuingRegion: saved.summary.issuingRegion },
    sender: { userId: context.userId, keyId: sender.keyId, publicKeyJwk: sender.publicKeyJwk },
    recipient: { userId: recipient.userId, keyId: recipient.keyId, publicKeyJwk: recipient.publicKeyJwk },
  });
  requireCurrent(context);
  let result: Awaited<ReturnType<typeof DirectMessagesService.sendMessage>>;
  try { result = await DirectMessagesService.sendMessage({ idToken, recipientPersonRef: selected.publicPersonRef, content }); }
  catch { throw new Error("Delivery could not be confirmed. Check Chat before trying again."); }
  const receipt = { messageId: result.message.id, conversationId: result.conversation.id,
    recipientPersonRef: selected.publicPersonRef, recipientName: peer.peerDisplayName || selected.displayName,
    sentAt: result.message.createdAt };
  if (result.message.content !== content || !result.message.senderIsViewer || result.conversation.peerPersonRef !== selected.publicPersonRef) throw new Error("Card delivery could not be verified.");
  // A late acknowledgement must not mutate a different owner or another card.
  if (!context.isCurrent()) return { receipt, receiptSaved: false };
  try { await WalletService.recordCardShareReceipt({ ...context, cardId, receipt, mayPublish: context.isCurrent }); return { receipt, receiptSaved: true }; }
  catch { return { receipt, receiptSaved: false }; }
}
