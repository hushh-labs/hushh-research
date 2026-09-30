/**
 * How a stored card is drawn: its masked and revealed number, its face tone,
 * and where it sits in the Wallet stack. Pure, so the masking rule and the
 * stack geometry are testable without a browser.
 *
 * The masked number is built from `last4` alone. It never receives the full
 * number, so a masked face cannot leak a digit it was never given.
 */

import type { CardBrand } from "@/lib/wallet/card-validation";

/** ISO/IEC 7810 ID-1: 85.60 x 53.98 mm. */
export const CARD_ASPECT_RATIO = 85.6 / 53.98;

/**
 * ISO/IEC 7810 corner radius (3.18 mm) as a share of the card's width. The
 * card is a physical object, so its corner follows the card standard rather
 * than the UI radius stops, and it scales with the card.
 */
export const CARD_CORNER_RADIUS_RATIO = 3.18 / 85.6;

/** How much of each card shows above the next one in the stack. */
export const WALLET_STACK_PEEK_PX = 60;

const MASK = "•";

/** Digit groups a network prints on the card, by total length. */
function groupPattern(brand: CardBrand | string | null | undefined, length: number): number[] {
  const key = String(brand || "").toLowerCase();
  if (key === "amex") return [4, 6, 5];
  if (key === "diners" && length === 14) return [4, 6, 4];
  if (length === 16) return [4, 4, 4, 4];
  const groups: number[] = [];
  for (let remaining = length; remaining > 0; remaining -= 4) {
    groups.push(Math.min(4, remaining));
  }
  return groups;
}

function nominalLength(brand: CardBrand | string | null | undefined): number {
  const key = String(brand || "").toLowerCase();
  if (key === "amex") return 15;
  if (key === "diners") return 14;
  return 16;
}

/**
 * The masked number as printed groups, e.g. `["••••", "••••", "••••", "4242"]`
 * or `["••••", "••••••", "•0005"]` for American Express. Only the last four
 * digits are ever visible; anything that is not four digits is masked too.
 */
export function maskedCardNumberGroups(
  brand: CardBrand | string | null | undefined,
  last4: string,
): string[] {
  const visible = /^\d{4}$/.test(last4) ? last4 : MASK.repeat(4);
  const length = nominalLength(brand);
  const digits = MASK.repeat(length - 4) + visible;
  const groups: string[] = [];
  let cursor = 0;
  for (const size of groupPattern(brand, length)) {
    groups.push(digits.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

/** A revealed number grouped the way the network prints it. */
export function formatCardNumber(
  brand: CardBrand | string | null | undefined,
  pan: string,
): string {
  const digits = pan.replace(/\D/g, "");
  const groups: string[] = [];
  let cursor = 0;
  for (const size of groupPattern(brand, digits.length)) {
    groups.push(digits.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups.join(" ");
}

export function formatCardExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
}

/**
 * Face tones. Hussh's own, deliberately not the networks' trade dress: two
 * Visa cards should still be told apart at a glance. Every tone is dark
 * enough that white text and the 72% caption stay above 4.5:1 in either
 * theme, which e2e/wallet-workspace.layout.spec.ts measures.
 */
export const CARD_FACE_TONES = [
  { id: "graphite", background: "#1f2023" },
  { id: "midnight", background: "#19233a" },
  { id: "evergreen", background: "#15302a" },
  { id: "oxblood", background: "#3a1b21" },
  { id: "slate", background: "#27303b" },
  { id: "plum", background: "#2a2038" },
] as const;

export type CardFaceTone = (typeof CARD_FACE_TONES)[number];

/** A stable tone per card id (FNV-1a), so a card keeps its colour. */
export function cardFaceTone(cardId: string): CardFaceTone {
  let hash = 0x811c9dc5;
  for (let index = 0; index < cardId.length; index += 1) {
    hash ^= cardId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CARD_FACE_TONES[hash % CARD_FACE_TONES.length]!;
}

export interface StackCardPlacement {
  /** Vertical travel from the top of the stack, in px. */
  y: number;
  /** Hidden cards stay mounted so the return path mirrors the way out. */
  hidden: boolean;
  zIndex: number;
}

/**
 * Where each card sits. At rest every card shows a `WALLET_STACK_PEEK_PX`
 * strip above the next. With one card focused, the others gather behind it
 * at the top and fade, so nothing travels through the details below.
 */
export function stackCardPlacement(
  index: number,
  count: number,
  focusedIndex: number | null,
): StackCardPlacement {
  if (focusedIndex === null || focusedIndex < 0) {
    return { y: index * WALLET_STACK_PEEK_PX, hidden: false, zIndex: index + 1 };
  }
  if (index === focusedIndex) {
    return { y: 0, hidden: false, zIndex: count + 1 };
  }
  return { y: 0, hidden: true, zIndex: index + 1 };
}

/** Extra height below the first card that the resting stack needs. */
export function stackTrailingHeight(count: number, focused: boolean): number {
  if (focused || count <= 1) return 0;
  return (count - 1) * WALLET_STACK_PEEK_PX;
}
