/**
 * What the Profile and Referral artwork prints, and the messages that carry it
 * into the card iframe. Pure, so the joining-year rule and the QR geometry are
 * testable without a browser.
 *
 * Nothing here invents a value. A missing or unparseable input yields `null`,
 * which the artwork renders as an empty field, never as a placeholder year.
 */

import { encodeQrCode } from "@/components/wallet-card/qr-code";
import type { WalletCardPayload } from "@/lib/services/wallet-card-service";

export type WalletIdentityCard = "profile" | "referral";

/** Cards whose artwork shows the owner's own details. */
export const WALLET_IDENTITY_CARDS: readonly WalletIdentityCard[] = ["profile", "referral"];

export const WALLET_ARTWORK_IDENTITY_MESSAGE = "agent-one-card:identity";
export const WALLET_ARTWORK_READY_MESSAGE = "agent-one-card:ready";
export const WALLET_ARTWORK_ACTION_MESSAGE = "agent-one-card:action";
/** The only action the artwork may ask for: open the Wallet Profile page. */
export const WALLET_ARTWORK_OPEN_PROFILE_ACTION = "open-wallet-profile";

/** How many years after the joining year the card is valid through. */
export const WALLET_CARD_VALIDITY_YEARS = 2;

export interface WalletCardDates {
  /** `YYYY`, the calendar year the account was created. */
  memberSince: string;
  /** `MM/YY`, always December of the joining year plus two. */
  validThru: string;
}

function parseCreationTime(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === "number" || typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Derive both date fields from the Firebase account-creation timestamp
 * (`user.metadata.creationTime`).
 *
 * The joining year is read in UTC so the same account shows the same year on
 * every device, whatever its time zone. Valid-through is an end-of-year rule,
 * not a rolling 24 months: 2026 -> 12/28, 2027 -> 12/29.
 */
export function deriveWalletCardDates(creationTime: unknown): WalletCardDates | null {
  const created = parseCreationTime(creationTime);
  if (!created) return null;
  const year = created.getUTCFullYear();
  if (year < 1970 || year > 9999 - WALLET_CARD_VALIDITY_YEARS) return null;
  const validYear = year + WALLET_CARD_VALIDITY_YEARS;
  return {
    memberSince: String(year),
    validThru: `12/${String(validYear % 100).padStart(2, "0")}`,
  };
}

export interface WalletArtworkQr {
  /** Modules per side, excluding the quiet zone (the artwork supplies that). */
  size: number;
  /** One SVG path in module units; adjacent runs share a path so no seams show. */
  d: string;
}

/** Encode `value` as a real QR symbol, or `null` when there is nothing to encode. */
export function buildWalletArtworkQr(value: string | null | undefined): WalletArtworkQr | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const { size, modules } = encodeQrCode(text);
    let d = "";
    for (let y = 0; y < size; y += 1) {
      let start = -1;
      for (let x = 0; x <= size; x += 1) {
        const dark = x < size && (modules[y * size + x] ?? 0) === 1;
        if (dark && start < 0) {
          start = x;
        } else if (!dark && start >= 0) {
          d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
          start = -1;
        }
      }
    }
    return { size, d };
  } catch {
    return null;
  }
}

/** The owner's details for one card, exactly as the artwork should draw them. */
export interface WalletArtworkIdentityMessage {
  type: typeof WALLET_ARTWORK_IDENTITY_MESSAGE;
  card: WalletIdentityCard;
  name: string | null;
  memberSince: string | null;
  validThru: string | null;
  qr: WalletArtworkQr | null;
  /** Shades the QR area with a prompt that opens the Wallet Profile page. */
  gate: Exclude<WalletProfileStatus, "unknown" | "ready"> | null;
}

/**
 * Where the owner stands with their Wallet Profile, as the server reports it.
 *
 * - `unknown`: not asked yet, still loading, the request failed, the vault is
 *   locked, or the feature is off. Never treated as "not created".
 * - `setup`: the server says there is no active profile.
 * - `link-missing`: the profile exists but this device does not hold its
 *   once-only share link (set up on another device, or storage was cleared).
 * - `ready`: the profile exists and this device holds its share link.
 */
export type WalletProfileStatus = "unknown" | "setup" | "link-missing" | "ready";

export function resolveWalletProfileStatus(state: {
  enabled: boolean;
  exists: boolean;
  card: { status: string } | null;
  shareUrl: string | null;
}): WalletProfileStatus {
  if (!state.enabled) return "unknown";
  if (!state.exists || !state.card || state.card.status === "revoked") return "setup";
  return state.shareUrl?.trim() ? "ready" : "link-missing";
}

export interface WalletCardIdentity {
  /** The signed-in owner these details belong to; `null` when signed out. */
  ownerId: string | null;
  name: string | null;
  memberSince: string | null;
  validThru: string | null;
  /** Profile -> Apple Wallet share link, `null` until the owner has one on this device. */
  profileUrl: string | null;
  profileStatus: WalletProfileStatus;
  /** The saved Wallet Profile fields, for the View details panel; `null` until one exists. */
  cardPayload: WalletCardPayload | null;
  /** The owner's Invite friends link, `null` until the server returns it. */
  referralUrl: string | null;
}

export const EMPTY_WALLET_CARD_IDENTITY: WalletCardIdentity = {
  ownerId: null,
  name: null,
  memberSince: null,
  validThru: null,
  profileUrl: null,
  profileStatus: "unknown",
  cardPayload: null,
  referralUrl: null,
};

export function buildWalletArtworkMessage(
  card: WalletIdentityCard,
  identity: WalletCardIdentity | null | undefined,
): WalletArtworkIdentityMessage {
  const source = identity ?? EMPTY_WALLET_CARD_IDENTITY;
  return {
    type: WALLET_ARTWORK_IDENTITY_MESSAGE,
    card,
    name: source.name,
    memberSince: source.memberSince,
    validThru: source.validThru,
    qr: buildWalletArtworkQr(card === "profile" ? source.profileUrl : source.referralUrl),
    // Only the black card has a gate, and only on the server's word that the
    // profile is missing or its link is not on this device; never while loading.
    gate:
      card === "profile" && source.ownerId && (source.profileStatus === "setup" || source.profileStatus === "link-missing")
        ? source.profileStatus
        : null,
  };
}
