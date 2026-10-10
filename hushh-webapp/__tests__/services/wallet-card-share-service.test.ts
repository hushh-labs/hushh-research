import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ directory: vi.fn(), bootstrap: vi.fn(), peer: vi.fn(), send: vi.fn(), getCard: vi.fn(), record: vi.fn(), seal: vi.fn(), file: vi.fn() }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { listRecipientsPage: mocks.directory } }));
vi.mock("@/lib/one-location/key-bootstrap", () => ({ bootstrapCurrentUserLocationRecipientKey: mocks.bootstrap }));
vi.mock("@/lib/services/direct-messages-service", () => ({ DirectMessagesService: { getConversationWithPerson: mocks.peer, sendMessage: mocks.send } }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { getCard: mocks.getCard, recordCardShareReceipt: mocks.record } }));
vi.mock("@/lib/wallet/wallet-card-share", () => ({ sealWalletCardShare: mocks.seal }));
vi.mock("@/lib/wallet/wallet-card-file", () => ({ createEncryptedCardFile: mocks.file }));
import { prepareSavedCardFile, shareSavedCard, type CardShareContext } from "@/lib/services/wallet-card-share-service";
import type { OneLocationRecipient } from "@/lib/one-location/types";
const recipient = { userId: "bob", publicPersonRef: "person-bob", displayName: "Bob", keyId: "bob-key", publicKeyJwk: { kty: "EC" } } as OneLocationRecipient;
const ack = { conversation: { id: "chat", peerPersonRef: "person-bob" }, message: { id: "msg", content: "encrypted-envelope", senderIsViewer: true, createdAt: "2026-10-10T10:00:00Z" } };
let current = true;
const context: CardShareContext = { userId: "alice", vaultKey: "vault-key", vaultOwnerToken: "owner-token", isCurrent: () => current, getIdToken: async () => "id-token" };

describe("owner-confirmed encrypted card delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks(); current = true;
    mocks.directory.mockResolvedValue({ items: [recipient], page: 1, hasMore: false });
    mocks.bootstrap.mockResolvedValue({ userId: "alice", keyId: "alice-key", publicKeyJwk: { kty: "EC" } });
    mocks.peer.mockResolvedValue({ canSend: true, peerPersonRef: "person-bob", peerDisplayName: "Bob" });
    mocks.getCard.mockResolvedValue({ summary: { brand: "visa", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" }, secrets: { pan: "4111111111111111", cardholderName: "Alice", cvv: "123", pin: "1234" } });
    mocks.seal.mockResolvedValue("encrypted-envelope"); mocks.send.mockResolvedValue(ack); mocks.record.mockResolvedValue(undefined);
  });
  it("sends only the selected card projection to the confirmed peer and records its acknowledgement", async () => {
    const result = await shareSavedCard(context, "selected-card", recipient);
    expect(mocks.getCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice", cardId: "selected-card" }));
    expect(mocks.seal).toHaveBeenCalledWith(expect.objectContaining({ cardId: "selected-card", recipient: expect.objectContaining({ userId: "bob", keyId: "bob-key" }) }));
    const projection = mocks.seal.mock.calls[0][0].card;
    expect(projection).not.toHaveProperty("cvv"); expect(projection).not.toHaveProperty("pin");
    expect(mocks.send).toHaveBeenCalledWith({ idToken: "id-token", recipientPersonRef: "person-bob", content: "encrypted-envelope" });
    expect(result.receiptSaved).toBe(true);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ cardId: "selected-card", receipt: expect.objectContaining({ messageId: "msg", recipientPersonRef: "person-bob" }), mayPublish: context.isCurrent }));
    expect(JSON.stringify(mocks.record.mock.calls[0][0].receipt)).not.toContain("4111111111111111");
  });
  it("prepares only the selected projection without a directory, upload or recipient receipt", async () => {
    const file = new File(["encrypted"], "encrypted-card.json"); mocks.file.mockResolvedValue(file);
    expect(await prepareSavedCardFile(context, "selected-card", "long-password", "https://example.test/wallet/open")).toBe(file);
    expect(mocks.file.mock.calls[0][0]).toEqual({ pan: "4111111111111111", cardholderName: "Alice", brand: "visa", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" });
    expect(mocks.directory).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each(["read", "encryption"])("discards a file after scope changes during %s", async boundary => {
    mocks.file.mockResolvedValue(new File(["encrypted"], "encrypted-card.json"));
    if (boundary === "read") mocks.getCard.mockImplementation(async () => { current = false; return {}; });
    else mocks.file.mockImplementation(async () => { current = false; return new File(["encrypted"], "encrypted-card.json"); });
    await expect(prepareSavedCardFile(context, "selected-card", "long-password")).rejects.toThrow("changed");
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
    if (boundary === "read") expect(mocks.file).not.toHaveBeenCalled();
  });
  it.each(["connection", "key", "sender", "scope"])("refuses to send when the %s boundary changes", async boundary => {
    if (boundary === "connection") mocks.peer.mockResolvedValue({ canSend: false, peerPersonRef: "person-bob" });
    if (boundary === "key") mocks.directory.mockResolvedValue({ items: [{ ...recipient, keyId: "rotated" }], hasMore: false });
    if (boundary === "sender") mocks.bootstrap.mockResolvedValue({ userId: "another-owner", keyId: "key", publicKeyJwk: {} });
    if (boundary === "scope") mocks.seal.mockImplementation(async () => { current = false; return "encrypted-envelope"; });
    await expect(shareSavedCard(context, "selected-card", recipient)).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("does not record an unverified acknowledgement or promise a retry after uncertain delivery", async () => {
    mocks.send.mockResolvedValueOnce({ ...ack, conversation: { ...ack.conversation, peerPersonRef: "wrong-peer" } });
    await expect(shareSavedCard(context, "selected-card", recipient)).rejects.toThrow("verified");
    expect(mocks.record).not.toHaveBeenCalled();
    mocks.send.mockRejectedValueOnce(new Error("Network timeout"));
    await expect(shareSavedCard(context, "selected-card", recipient)).rejects.toThrow("Check Chat before trying again");
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("does not write a late receipt after a lock or account change", async () => {
    mocks.send.mockImplementation(async () => { current = false; return ack; });
    expect((await shareSavedCard(context, "selected-card", recipient)).receiptSaved).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("reports acknowledged delivery separately from a failed receipt save", async () => {
    mocks.record.mockRejectedValue(new Error("PKM unavailable"));
    expect((await shareSavedCard(context, "selected-card", recipient)).receiptSaved).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
