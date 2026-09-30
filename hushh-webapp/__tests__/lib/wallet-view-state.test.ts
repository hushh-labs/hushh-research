/**
 * The Wallet reveal boundary and masking rule.
 *
 * A card's secrets may enter the screen only for the card the owner chose,
 * and only while the vault is unlocked; a vault that locks takes them off the
 * screen with it. The masked face is built from the last four digits alone.
 * Each rule is paired with the case that must succeed, so a reducer that
 * rejects everything (or accepts everything) cannot pass.
 */
import { describe, expect, it } from "vitest";

import {
  formatCardNumber,
  maskedCardNumberGroups,
} from "@/lib/wallet/wallet-card-presentation";
import {
  INITIAL_WALLET_VIEW,
  walletViewReducer,
  type WalletViewEvent,
  type WalletViewState,
} from "@/lib/wallet/wallet-view-state";

const PAN = "4242424242424242";

const summary = {
  cardId: "card_a",
  nickname: "Everyday",
  brand: "visa" as const,
  last4: "4242",
  expiryMonth: 4,
  expiryYear: 2030,
  issuingRegion: "US",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const secrets = { pan: PAN, cvv: "123", pin: "1234", cardholderName: "Alex Rivera" };

function run(events: WalletViewEvent[], from: WalletViewState = INITIAL_WALLET_VIEW) {
  return events.reduce(walletViewReducer, from);
}

const loadedAndFocused: WalletViewEvent[] = [
  { type: "load_succeeded", cardIds: ["card_a", "card_b"] },
  { type: "focus", cardId: "card_a" },
];

const reveal = (vaultUnlocked: boolean, cardId = "card_a"): WalletViewEvent => ({
  type: "revealed",
  cardId,
  summary: { ...summary, cardId },
  secrets,
  vaultUnlocked,
});

describe("Wallet reveal boundary", () => {
  it("never reveals while the vault is locked, and does once it is unlocked", () => {
    const locked = run([...loadedAndFocused, reveal(false)]);
    expect(locked).toEqual({ kind: "list", focusedCardId: "card_a" });
    expect(JSON.stringify(locked)).not.toContain(PAN);

    // Negative control: the same event with the vault open does reveal.
    const unlocked = run([...loadedAndFocused, reveal(true)]);
    expect(unlocked.kind).toBe("reveal");
    expect(JSON.stringify(unlocked)).toContain(PAN);
  });

  it("reveals only the card the owner focused", () => {
    expect(run([...loadedAndFocused, reveal(true, "card_b")])).toEqual({
      kind: "list",
      focusedCardId: "card_a",
    });
    // Nothing focused: a decrypted result has nowhere to land.
    const unfocused = run([{ type: "load_succeeded", cardIds: ["card_a"] }, reveal(true)]);
    expect(unfocused).toEqual({ kind: "list", focusedCardId: null });
  });

  it("drops revealed values the moment the vault becomes unavailable", () => {
    const revealed = run([...loadedAndFocused, reveal(true)]);
    expect(revealed.kind).toBe("reveal");
    const lockedAgain = walletViewReducer(revealed, { type: "vault_unavailable" });
    expect(lockedAgain).toEqual({ kind: "locked" });
    expect(JSON.stringify(lockedAgain)).not.toContain(PAN);
  });

  it("returns to the masked card on Hide and to the stack on Done", () => {
    const revealed = run([...loadedAndFocused, reveal(true)]);
    expect(walletViewReducer(revealed, { type: "hide" })).toEqual({
      kind: "list",
      focusedCardId: "card_a",
    });
    expect(walletViewReducer(revealed, { type: "unfocus" })).toEqual({
      kind: "list",
      focusedCardId: null,
    });
  });

  it("keeps a quiet refresh from resurrecting a removed card", () => {
    const focused = run(loadedAndFocused);
    expect(walletViewReducer(focused, { type: "load_succeeded", cardIds: ["card_b"] })).toEqual({
      kind: "list",
      focusedCardId: null,
    });
    expect(walletViewReducer(focused, { type: "load_succeeded", cardIds: ["card_a"] })).toBe(focused);
  });
});

describe("masked card number", () => {
  it("shows only the last four digits, grouped the way the network prints them", () => {
    expect(maskedCardNumberGroups("visa", "4242")).toEqual(["••••", "••••", "••••", "4242"]);
    expect(maskedCardNumberGroups("amex", "0005")).toEqual(["••••", "••••••", "•0005"]);
    expect(maskedCardNumberGroups("diners", "0004")).toEqual(["••••", "••••••", "0004"]);
    for (const brand of ["visa", "amex", "diners", "rupay", "other"]) {
      const digits = maskedCardNumberGroups(brand, "4242").join("").replace(/\D/g, "");
      expect(digits).toBe("4242");
    }
  });

  it("masks anything that is not exactly four digits", () => {
    // A malformed summary must never widen what the face shows.
    for (const last4 of ["", "424", "42424", PAN, "abcd"]) {
      expect(maskedCardNumberGroups("visa", last4).join("")).toBe("•".repeat(16));
    }
  });

  it("groups a revealed number by network", () => {
    expect(formatCardNumber("visa", PAN)).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("amex", "378282246310005")).toBe("3782 822463 10005");
    expect(formatCardNumber("diners", "30569309025904")).toBe("3056 930902 5904");
  });
});
