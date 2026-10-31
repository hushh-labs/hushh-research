// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEncryptedCardFile, openEncryptedCardFile, parseEncryptedCardFile, readEncryptedCardFile, ENCRYPTED_CARD_MAX_BYTES } from "@/lib/wallet/wallet-card-file";

const card = { pan: "4111111111111111", cardholderName: "Synthetic Owner", brand: "visa" as const, expiryMonth: 4, expiryYear: 2030, issuingRegion: "US", cvv: "123", pin: "1234", userId: "private-owner", cardId: "private-card" };
const password = "synthetic-long-password";
describe("portable encrypted card files", () => {
  it("round trips without an account and excludes security codes, identifiers and plaintext metadata", async () => {
    const file = await createEncryptedCardFile(card, password, "https://example.test/wallet/open");
    expect(file.name).toBe("encrypted-card.json");
    const text = await file.text();
    for (const value of [card.pan, card.cardholderName, card.userId, card.cardId, password, '"cvv"', '"pin"']) expect(text).not.toContain(value);
    const envelope = await readEncryptedCardFile(file);
    expect(envelope).not.toHaveProperty("openAt");
    expect(await openEncryptedCardFile(envelope, password)).toEqual({ pan: card.pan, cardholderName: card.cardholderName, brand: card.brand, expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, issuingRegion: card.issuingRegion });
    const second = await readEncryptedCardFile(await createEncryptedCardFile(card, password));
    expect(second.kdf.salt).not.toBe(envelope.kdf.salt);
    expect(second.payload.iv).not.toBe(envelope.payload.iv);
    await expect(openEncryptedCardFile(envelope, "incorrect-password")).rejects.toThrow();
    const altered = structuredClone(envelope);
    altered.payload.ciphertext = (altered.payload.ciphertext[0] === "A" ? "B" : "A") + altered.payload.ciphertext.slice(1);
    await expect(openEncryptedCardFile(altered, password)).rejects.toThrow();
    await expect(openEncryptedCardFile({ ...envelope, kdf: { ...envelope.kdf, salt: second.kdf.salt } }, password)).rejects.toThrow();
  });
  it("rejects hostile format and KDF settings before deriving and oversized files before reading", async () => {
    const envelope = await readEncryptedCardFile(await createEncryptedCardFile(card, password));
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    for (const changes of [{ version: 2 }, { format: "other" }, { kdf: { ...envelope.kdf, iterations: 1_000_000_000 } }, { kdf: { ...envelope.kdf, algorithm: "other" } }]) {
      expect(() => parseEncryptedCardFile(JSON.stringify({ ...envelope, ...changes }))).toThrow();
      await expect(openEncryptedCardFile({ ...envelope, ...changes } as typeof envelope, password)).rejects.toThrow();
    }
    expect(derive).not.toHaveBeenCalled(); derive.mockRestore();
    const text = vi.fn();
    await expect(readEncryptedCardFile({ size: ENCRYPTED_CARD_MAX_BYTES + 1, text } as unknown as File)).rejects.toThrow();
    expect(text).not.toHaveBeenCalled();
    await expect(createEncryptedCardFile(card, "short")).rejects.toThrow("12");
  });
});
