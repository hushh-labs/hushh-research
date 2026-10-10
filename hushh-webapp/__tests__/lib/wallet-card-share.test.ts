// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/capacitor", () => ({ HushhKeychain: { get: vi.fn(), set: vi.fn() } }));
vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => false }));
import { ensureLocationRecipientKey } from "@/lib/one-location/encryption";
import { openWalletCardShare, parseWalletCardShare, sealWalletCardShare, walletMessagePreview } from "@/lib/wallet/wallet-card-share";

describe("encrypted single-card messages", () => {
  it("opens only for the exact participants and authenticated binding, never includes security codes or plaintext", async () => {
    const sender = { userId: "wallet-alice", ...await ensureLocationRecipientKey("wallet-alice") };
    const recipient = { userId: "wallet-bob", ...await ensureLocationRecipientKey("wallet-bob") };
    const card = { pan: "4111111111111111", cardholderName: "A Person", brand: "visa" as const, expiryMonth: 4, expiryYear: 2030, issuingRegion: "US", cvv: "123", pin: "1234" };
    const content = await sealWalletCardShare({ cardId: "card_example", card, sender, recipient });
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).not.toContain(card.pan);
    expect(content).not.toContain(card.cardholderName);
    expect(walletMessagePreview(content)).toBe("Shared payment card");
    const received = await openWalletCardShare({ content, userId: recipient.userId, peerUserId: sender.userId, senderIsViewer: false });
    expect(received).toEqual({ pan: card.pan, cardholderName: card.cardholderName, brand: "visa", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" });
    expect(await openWalletCardShare({ content, userId: sender.userId, peerUserId: recipient.userId, senderIsViewer: true })).toEqual(received);
    await expect(openWalletCardShare({ content, userId: recipient.userId, peerUserId: "another-sender", senderIsViewer: false })).rejects.toThrow();
    await expect(openWalletCardShare({ content, userId: recipient.userId, peerUserId: sender.userId, senderIsViewer: true })).rejects.toThrow();
    await ensureLocationRecipientKey("wallet-eve");
    await expect(openWalletCardShare({ content, userId: "wallet-eve", peerUserId: sender.userId, senderIsViewer: false })).rejects.toThrow();
    const envelope = parseWalletCardShare(content);
    const tampered = content.replace(envelope.shareId, crypto.randomUUID());
    await expect(openWalletCardShare({ content: tampered, userId: recipient.userId, peerUserId: sender.userId, senderIsViewer: false })).rejects.toThrow();
    envelope.payload.ciphertext = (envelope.payload.ciphertext[0] === "A" ? "B" : "A") + envelope.payload.ciphertext.slice(1);
    await expect(openWalletCardShare({ content: "hushh-wallet-card:v1:" + JSON.stringify(envelope), userId: recipient.userId, peerUserId: sender.userId, senderIsViewer: false })).rejects.toThrow();
    const longest = await sealWalletCardShare({ cardId: "card_123e4567-e89b-12d3-a456-426614174000", card: { ...card, pan: "1234567890123456789", cardholderName: "名".repeat(100) }, sender, recipient });
    expect(longest.length).toBeLessThanOrEqual(2000);
  });
  it("rejects malformed and oversized envelopes before decryption", () => {
    for (const content of ["hushh-wallet-card:v1:{}", "hushh-wallet-card:v1:null", "hushh-wallet-card:v1:" + "x".repeat(4001)]) expect(() => parseWalletCardShare(content)).toThrow();
  });
});
