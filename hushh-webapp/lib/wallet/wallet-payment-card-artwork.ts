/** Compatibility descriptor for the neutral fallback. Original card artwork is
 * selected explicitly and persisted in the encrypted wallet.artwork branch. */
export const PAYMENT_CARD_ARTWORK = [{ id: "neutral", name: "Neutral card" }] as const;
export type PaymentCardArtwork = (typeof PAYMENT_CARD_ARTWORK)[number];
/** Legacy callers may still supply an ID; it never determines the design. */
export function paymentCardArtwork(_cardId: string): PaymentCardArtwork { return PAYMENT_CARD_ARTWORK[0]; }
