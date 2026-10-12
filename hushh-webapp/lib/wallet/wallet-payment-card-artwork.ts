/**
 * The owner's supplied payment-card finishes. Their order is a persistence
 * contract: an immutable card id always resolves to the same finish, without
 * fetching artwork or saving a second copy of the card's state.
 */
export const PAYMENT_CARD_ARTWORK = [
  { id: "a", name: "Porcelain" },
  { id: "b", name: "Midnight Titanium" },
  { id: "c", name: "Cobalt Circuit" },
  { id: "d", name: "Evergreen Ledger" },
  { id: "e", name: "Burgundy Seal" },
  { id: "f", name: "Sandstone Map" },
  { id: "g", name: "Graphite Mono" },
  { id: "h", name: "Aurora Frost" },
  { id: "i", name: "Carbon Weave" },
  { id: "j", name: "Terracotta Arc" },
  { id: "k", name: "Ocean Current" },
  { id: "l", name: "Plum Velvet" },
  { id: "m", name: "Silver Mesh" },
  { id: "n", name: "Ink Blueprint" },
  { id: "o", name: "Jade Halo" },
  { id: "p", name: "Rose Alloy" },
  { id: "q", name: "Coral Vault" },
  { id: "r", name: "Arctic Line" },
  { id: "s", name: "Amethyst Cut" },
  { id: "t", name: "Steel Blue" },
] as const;

export type PaymentCardArtwork = (typeof PAYMENT_CARD_ARTWORK)[number];

/** Stable FNV-1a selection; edits, sorting and hydration cannot change it. */
export function paymentCardArtwork(cardId: string): PaymentCardArtwork {
  let hash = 0x811c9dc5;
  for (let index = 0; index < cardId.length; index += 1) {
    hash ^= cardId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PAYMENT_CARD_ARTWORK[hash % PAYMENT_CARD_ARTWORK.length]!;
}
