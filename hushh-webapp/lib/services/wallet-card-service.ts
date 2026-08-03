/**
 * Wallet Profile service — the single network boundary for the Wallet Card
 * feature (contract: docs/superpowers/specs/2026-08-03-wallet-card-contract.md).
 *
 * Everything the owner screens, the pass hand-off and the public `/c/[token]`
 * page need goes through here. `app/**` and `components/**` never call
 * `fetch()` themselves — `scripts/architecture/verify-service-layer-boundary.mjs`
 * enforces that — so this module owns:
 *
 * - the two URL shapes (public share URL on the app origin, `.pkpass` URL on the
 *   backend origin, because iOS follows that link out of the WebView),
 * - the closed `card_payload` allowlist the owner sees before the server
 *   re-validates it,
 * - the typed public states, so a revoked card, an expired link and an unknown
 *   token can never be collapsed into one vague failure,
 * - the device-local copy of the share link, because the plaintext token comes
 *   back from the backend exactly once (contract §5).
 *
 * Privacy rules that are binding here: the plaintext share token is never
 * logged, no `card_payload` value is ever logged, and the public resolve carries
 * no authorization header — the token *is* the credential.
 */

import { isIOS, isNative } from "@/lib/capacitor/platform";
import { resolveRuntimeFrontendUrl } from "@/lib/runtime/settings";
import { ApiError, apiErrorCode, apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";

/* ------------------------------------------------------------------ routes */

/** Backend route prefix (contract §1). */
export const WALLET_CARD_API_PREFIX = "/api/one/wallet-card";

/** Public web page prefix — what the QR encodes (contract §1). */
export const WALLET_CARD_PUBLIC_PATH_PREFIX = "/c";

/** Server code for "the pass cannot be signed in this deployment". */
export const WALLET_PASS_SIGNING_UNAVAILABLE_CODE = "WALLET_PASS_SIGNING_UNAVAILABLE";

/**
 * Copy owned by the service layer. The revoked and expired lines are verbatim
 * from contract §9 and are asserted by the test suite — change the contract
 * before changing them here.
 */
export const WALLET_CARD_SERVICE_COPY = {
  revoked: "This profile is no longer shared.",
  expired: "This profile link has expired.",
  notFound: "This profile is not available.",
  unavailable: "This profile could not be loaded right now.",
  signingUnavailable:
    "We couldn't create your Wallet pass right now. Please try again in a moment.",
  unsupported: "Apple Wallet is available on iPhone and iPad.",
} as const;

/* ------------------------------------------------------------------- types */

/** Mirrors the server-side `preferred_contact` closed set (contract §3). */
export type WalletCardPreferredContact = "email" | "phone" | "linkedin" | "website";

export type WalletCardStatus = "active" | "paused" | "revoked";

/**
 * The owner-selected fields, in the server's snake_case shape. Every key here
 * is on the closed allowlist; anything else is rejected, never dropped.
 */
export type WalletCardPayload = {
  full_name?: string | null;
  headline?: string | null;
  organisation?: string | null;
  location_label?: string | null;
  summary?: string | null;
  skills?: string[] | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  github?: string | null;
  portfolio?: string | null;
  preferred_contact?: WalletCardPreferredContact | null;
};

/** What callers may hand to validation — unknown keys are the point of it. */
export type WalletCardPayloadInput = WalletCardPayload | Record<string, unknown>;

/** The owner's card row, as the owner screens consume it. */
export interface WalletCardRecord {
  passSerial: string | null;
  status: WalletCardStatus;
  shareTokenVersion: number;
  cardPayload: WalletCardPayload;
  displayName: string | null;
  headline: string | null;
  avatarUrl: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
  lastScannedAt: string | null;
  scanCount: number;
}

/**
 * The device-local copy of the share link. The backend cannot return the
 * plaintext token again, so this is what keeps the QR renderable.
 */
export interface WalletCardShareLink {
  shareUrl: string;
  shareToken: string;
  /** Token version this link belongs to; a newer card invalidates it. */
  version: number | null;
}

export interface WalletCardState {
  enabled: boolean;
  exists: boolean;
  card: WalletCardRecord | null;
  shareUrl: string | null;
}

export interface WalletCardMutationResult {
  card: WalletCardRecord;
  /** Present only on create and rotate (contract §5). */
  shareToken: string | null;
  shareUrl: string | null;
  passUrl: string | null;
}

/** The visitor projection, in the same snake_case shape the contract defines. */
export interface WalletCardPublicProfile {
  full_name: string | null;
  headline: string | null;
  organisation: string | null;
  location_label: string | null;
  summary: string | null;
  skills: string[];
  email: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  github: string | null;
  portfolio: string | null;
  preferred_contact: WalletCardPreferredContact | null;
  avatar_url: string | null;
  updated_at: string | null;
}

/**
 * Terminal states a visitor can land in. `not_found` is deliberately identical
 * for an unknown token and a paused card (contract §6) — the page must not be
 * able to tell them apart.
 */
export type WalletCardPublicFailureState =
  | "revoked"
  | "expired"
  | "not_found"
  | "unavailable";

export type WalletCardPublicResult =
  | { state: "available"; card: WalletCardPublicProfile }
  | { state: WalletCardPublicFailureState; message: string };

/** Why a `.pkpass` could not be produced. */
export type WalletPassFailure =
  | { state: "signing_unavailable"; message: string; code: string }
  | { state: "revoked"; message: string }
  | { state: "expired"; message: string }
  | { state: "not_found"; message: string }
  | { state: "unavailable"; message: string };

export type WalletPassAvailability =
  | { state: "available"; url: string }
  | WalletPassFailure;

export type WalletPassAddResult =
  | { state: "opened"; url: string }
  | { state: "unsupported"; message: string; shareUrl: string }
  | WalletPassFailure;

export type WalletPassCapability = "capacitor_ios" | "ios_web" | "unsupported";

export interface WalletCardPayloadIssue {
  field: string;
  message: string;
}

export type WalletCardPayloadValidation =
  | { ok: true; value: WalletCardPayload }
  | { ok: false; errors: WalletCardPayloadIssue[] };

/** Thrown instead of sending a payload the server would reject. */
export class WalletCardPayloadError extends Error {
  constructor(public readonly errors: readonly WalletCardPayloadIssue[]) {
    super("Some of this information cannot be shared from a Wallet Profile.");
    this.name = "WalletCardPayloadError";
  }
}

interface WalletCardOwnerRequest {
  vaultOwnerToken: string;
  userId: string;
}

/* --------------------------------------------------------------- allowlist */

/** Per-field caps, exactly as contract §3 states them. */
const TEXT_FIELD_LIMITS = {
  full_name: 80,
  headline: 120,
  organisation: 80,
  location_label: 80,
  summary: 400,
  email: 254,
  phone: 32,
  website: 300,
  linkedin: 300,
  github: 300,
  portfolio: 300,
  preferred_contact: 16,
} as const;

type WalletCardTextField = keyof typeof TEXT_FIELD_LIMITS;

const URL_FIELDS: readonly WalletCardTextField[] = [
  "website",
  "linkedin",
  "github",
  "portfolio",
];

const PREFERRED_CONTACTS: readonly WalletCardPreferredContact[] = [
  "email",
  "phone",
  "linkedin",
  "website",
];

const MAX_SKILLS = 12;
const MAX_SKILL_LENGTH = 40;
const MAX_URL_LENGTH = 2048;
const MAX_TIMESTAMP_LENGTH = 64;

// Same shapes the backend applies, so the owner is told before saving rather
// than after: exactly one `@`, at least one dot label, no whitespace.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const PHONE_SHAPE = /^\+?[0-9][0-9\s().\-]{5,31}$/;

// `secrets.token_urlsafe(32)` yields 43 URL-safe characters. Bounding the shape
// locally keeps traversal-shaped and obviously-junk tokens off a rate-limited
// public endpoint, and guarantees a token can never widen a path.
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/* ----------------------------------------------------------------- reading */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readString(
  source: UnknownRecord,
  keys: readonly string[],
  maxLength: number,
): string | null {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return trimmed.slice(0, maxLength);
  }
  return null;
}

function readNumber(
  source: UnknownRecord,
  keys: readonly string[],
  fallback: number,
): number {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

/**
 * Read the honest status word out of a body, tolerating FastAPI's
 * `{"detail": {...}}` envelope as well as a bare `{"status": "..."}`.
 */
function readStatusWord(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const direct = record.status;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toLowerCase();
  }
  return readStatusWord(record.detail) ?? readStatusWord(record.error);
}

function readMessageWord(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const direct = record.message;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return readMessageWord(record.detail) ?? readMessageWord(record.error);
}

function readCodeWord(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const direct = record.code;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return readCodeWord(record.detail) ?? readCodeWord(record.error);
}

/* ------------------------------------------------------------ URL builders */

function trimOrigin(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.replace(/\/+$/, "");
}

function appOrigin(): string {
  try {
    return trimOrigin(resolveRuntimeFrontendUrl());
  } catch {
    return "";
  }
}

function backendOrigin(): string {
  try {
    return trimOrigin(ApiService.getDirectBackendUrl());
  } catch {
    return "";
  }
}

/**
 * The URL the QR encodes. Falls back to a relative path when no app origin is
 * configured, which is what the native shell resolves against its own host.
 */
export function walletCardShareUrl(shareToken: string): string {
  const token = encodeURIComponent(String(shareToken ?? ""));
  return `${appOrigin()}${WALLET_CARD_PUBLIC_PATH_PREFIX}/${token}`;
}

/**
 * The `.pkpass` download URL.
 *
 * Built against the backend origin rather than the Next proxy: iOS hands this
 * URL to Safari, which imports the pass natively, and the proxy would return
 * JSON rather than the signed bundle.
 */
export function walletCardPassUrl(shareToken: string): string {
  const token = encodeURIComponent(String(shareToken ?? ""));
  return `${backendOrigin()}${WALLET_CARD_API_PREFIX}/pass/${token}.pkpass`;
}

/** Reject a wrong-shape token before it is sent, stored or trusted. */
export function isWalletShareTokenShape(value: string | null | undefined): boolean {
  return typeof value === "string" && SHARE_TOKEN_SHAPE.test(value);
}

/* ------------------------------------------------------- platform capability */

/**
 * Where an Apple Wallet pass can actually be installed.
 *
 * The native Android shell and desktop web get `unsupported` and are offered the
 * share link instead. iPadOS asks for the desktop site, so a Macintosh user
 * agent with a touch screen still counts as iOS on the web.
 */
export function walletPassCapability(): WalletPassCapability {
  if (isNative()) {
    return isIOS() ? "capacitor_ios" : "unsupported";
  }
  if (typeof navigator === "undefined") return "unsupported";
  const userAgent = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios_web";
  if (/Macintosh/i.test(userAgent) && (navigator.maxTouchPoints ?? 0) > 1) {
    return "ios_web";
  }
  return "unsupported";
}

export function canAddToAppleWallet(): boolean {
  return walletPassCapability() !== "unsupported";
}

/* ------------------------------------------------------------- URL safety */

/**
 * The one URL rule for the whole feature: absolute `https://` only, with no
 * embedded credentials. `javascript:`, `data:`, `http:` and `user@host` display
 * spoofs all resolve to false.
 */
export function isAllowedWalletCardUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return Boolean(parsed.hostname);
}

function safeLink(value: string | null): string | null {
  return isAllowedWalletCardUrl(value) ? value : null;
}

function safeEmail(value: string | null): string | null {
  if (!value) return null;
  return EMAIL_SHAPE.test(value) ? value : null;
}

function safePhone(value: string | null): string | null {
  if (!value) return null;
  return PHONE_SHAPE.test(value) ? value : null;
}

/* --------------------------------------------------------- payload validation */

function isTextField(key: string): key is WalletCardTextField {
  return Object.prototype.hasOwnProperty.call(TEXT_FIELD_LIMITS, key);
}

function validateSkills(raw: unknown, errors: WalletCardPayloadIssue[]): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field: "skills", message: "Skills must be a list of short entries." });
    return [];
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      errors.push({ field: "skills", message: "Each skill must be text." });
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_SKILL_LENGTH) {
      errors.push({
        field: "skills",
        message: `Each skill must be ${MAX_SKILL_LENGTH} characters or fewer.`,
      });
      continue;
    }
    cleaned.push(trimmed);
  }
  if (cleaned.length > MAX_SKILLS) {
    errors.push({ field: "skills", message: `Keep it to ${MAX_SKILLS} skills.` });
  }
  return cleaned;
}

/**
 * Client-side mirror of the server's closed allowlist.
 *
 * A key outside the allowlist is an error, not a silent drop, so an owner
 * screen can never quietly send something the server would refuse. Values are
 * trimmed; an empty value is treated as absent rather than stored as a blank.
 * No value is ever logged.
 */
export function validateWalletCardPayload(
  input: WalletCardPayloadInput,
): WalletCardPayloadValidation {
  const errors: WalletCardPayloadIssue[] = [];
  const value: WalletCardPayload = {};
  const source = asRecord(input) ?? {};

  for (const [key, raw] of Object.entries(source)) {
    if (key === "skills") {
      const skills = validateSkills(raw, errors);
      if (skills.length > 0) value.skills = skills;
      continue;
    }

    if (!isTextField(key)) {
      errors.push({
        field: "card_payload",
        message: `"${key}" is not a field a Wallet Profile can share.`,
      });
      continue;
    }

    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") {
      errors.push({ field: key, message: "Enter this as text." });
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) continue;

    const limit = TEXT_FIELD_LIMITS[key];
    if (trimmed.length > limit) {
      errors.push({
        field: key,
        message: `Keep this to ${limit} characters or fewer.`,
      });
      continue;
    }

    if (key === "preferred_contact") {
      const candidate = trimmed.toLowerCase();
      const match = PREFERRED_CONTACTS.find((option) => option === candidate);
      if (!match) {
        errors.push({
          field: key,
          message: "Choose email, phone, LinkedIn or a link.",
        });
        continue;
      }
      value.preferred_contact = match;
      continue;
    }

    if (key === "email" && !EMAIL_SHAPE.test(trimmed)) {
      errors.push({ field: key, message: "Enter a valid email address." });
      continue;
    }
    if (key === "phone" && !PHONE_SHAPE.test(trimmed)) {
      errors.push({ field: key, message: "Enter a valid phone number." });
      continue;
    }
    if (URL_FIELDS.includes(key) && !isAllowedWalletCardUrl(trimmed)) {
      errors.push({ field: key, message: "Use a full https:// link." });
      continue;
    }

    value[key] = trimmed;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/* -------------------------------------------------------------- projections */

function readPreferredContact(
  source: UnknownRecord,
): WalletCardPreferredContact | null {
  const raw = readString(
    source,
    ["preferredContact", "preferred_contact"],
    TEXT_FIELD_LIMITS.preferred_contact,
  );
  if (!raw) return null;
  const candidate = raw.toLowerCase();
  return PREFERRED_CONTACTS.find((option) => option === candidate) ?? null;
}

function readSkills(source: UnknownRecord): string[] {
  const raw = source.skills;
  if (!Array.isArray(raw)) return [];
  const skills: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, MAX_SKILL_LENGTH);
    if (!trimmed) continue;
    skills.push(trimmed);
    if (skills.length >= MAX_SKILLS) break;
  }
  return skills;
}

/**
 * Re-apply the allowlist to whatever the wire actually carried.
 *
 * The server already validates, so this is defence in depth: a hostile or
 * malformed projection must not be able to hand the page a `javascript:` or
 * `data:` link, and an over-long value must not be able to reach the DOM.
 */
function toPublicProfile(raw: unknown): WalletCardPublicProfile | null {
  const source = asRecord(raw);
  if (!source) return null;
  return {
    full_name: readString(
      source,
      ["fullName", "full_name", "displayName", "display_name"],
      TEXT_FIELD_LIMITS.full_name,
    ),
    headline: readString(source, ["headline"], TEXT_FIELD_LIMITS.headline),
    organisation: readString(
      source,
      ["organisation", "organization"],
      TEXT_FIELD_LIMITS.organisation,
    ),
    location_label: readString(
      source,
      ["locationLabel", "location_label"],
      TEXT_FIELD_LIMITS.location_label,
    ),
    summary: readString(source, ["summary"], TEXT_FIELD_LIMITS.summary),
    skills: readSkills(source),
    email: safeEmail(readString(source, ["email"], TEXT_FIELD_LIMITS.email)),
    phone: safePhone(readString(source, ["phone"], TEXT_FIELD_LIMITS.phone)),
    website: safeLink(readString(source, ["website"], TEXT_FIELD_LIMITS.website)),
    linkedin: safeLink(readString(source, ["linkedin"], TEXT_FIELD_LIMITS.linkedin)),
    github: safeLink(readString(source, ["github"], TEXT_FIELD_LIMITS.github)),
    portfolio: safeLink(readString(source, ["portfolio"], TEXT_FIELD_LIMITS.portfolio)),
    preferred_contact: readPreferredContact(source),
    avatar_url: safeLink(
      readString(source, ["avatarUrl", "avatar_url", "photoUrl", "photo_url"], MAX_URL_LENGTH),
    ),
    updated_at: readString(
      source,
      ["updatedOn", "updated_on", "updatedAt", "updated_at"],
      MAX_TIMESTAMP_LENGTH,
    ),
  };
}

/** The owner's own stored fields, kept editable rather than re-sanitised away. */
function toStoredPayload(raw: unknown): WalletCardPayload {
  const payload: WalletCardPayload = {};
  const source = asRecord(raw);
  if (!source) return payload;

  const textKeys: readonly [WalletCardTextField, readonly string[]][] = [
    ["full_name", ["full_name", "fullName"]],
    ["headline", ["headline"]],
    ["organisation", ["organisation", "organization"]],
    ["location_label", ["location_label", "locationLabel"]],
    ["summary", ["summary"]],
    ["email", ["email"]],
    ["phone", ["phone"]],
    ["website", ["website"]],
    ["linkedin", ["linkedin"]],
    ["github", ["github"]],
    ["portfolio", ["portfolio"]],
  ];

  for (const [field, keys] of textKeys) {
    if (field === "preferred_contact") continue;
    const text = readString(source, keys, TEXT_FIELD_LIMITS[field]);
    if (text) payload[field] = text;
  }

  const skills = readSkills(source);
  if (skills.length > 0) payload.skills = skills;

  const preferred = readPreferredContact(source);
  if (preferred) payload.preferred_contact = preferred;

  return payload;
}

function readStatus(source: UnknownRecord): WalletCardStatus {
  const raw = readString(source, ["status"], 16)?.toLowerCase() ?? "";
  if (raw === "paused" || raw === "revoked") return raw;
  return "active";
}

function toCardRecord(raw: unknown): WalletCardRecord | null {
  const source = asRecord(raw);
  if (!source) return null;
  return {
    passSerial: readString(source, ["passSerial", "pass_serial"], 128),
    status: readStatus(source),
    shareTokenVersion: readNumber(
      source,
      ["shareTokenVersion", "share_token_version"],
      1,
    ),
    cardPayload: toStoredPayload(source.cardPayload ?? source.card_payload),
    displayName: readString(
      source,
      ["displayName", "display_name"],
      TEXT_FIELD_LIMITS.full_name,
    ),
    headline: readString(source, ["headline"], TEXT_FIELD_LIMITS.headline),
    avatarUrl: readString(source, ["avatarUrl", "avatar_url"], MAX_URL_LENGTH),
    expiresAt: readString(source, ["expiresAt", "expires_at"], MAX_TIMESTAMP_LENGTH),
    createdAt: readString(source, ["createdAt", "created_at"], MAX_TIMESTAMP_LENGTH),
    updatedAt: readString(source, ["updatedAt", "updated_at"], MAX_TIMESTAMP_LENGTH),
    revokedAt: readString(source, ["revokedAt", "revoked_at"], MAX_TIMESTAMP_LENGTH),
    lastScannedAt: readString(
      source,
      ["lastScannedAt", "last_scanned_at"],
      MAX_TIMESTAMP_LENGTH,
    ),
    scanCount: readNumber(source, ["scanCount", "scan_count"], 0),
  };
}

/* ------------------------------------------------------------ typed states */

function revokedResult(): WalletCardPublicResult {
  return { state: "revoked", message: WALLET_CARD_SERVICE_COPY.revoked };
}

function expiredResult(): WalletCardPublicResult {
  return { state: "expired", message: WALLET_CARD_SERVICE_COPY.expired };
}

function notFoundResult(): WalletCardPublicResult {
  return { state: "not_found", message: WALLET_CARD_SERVICE_COPY.notFound };
}

function unavailableResult(): WalletCardPublicResult {
  return { state: "unavailable", message: WALLET_CARD_SERVICE_COPY.unavailable };
}

/** Map a 200 body — public resolve and owner preview share one projection. */
function projectPublicResult(response: unknown): WalletCardPublicResult {
  const record = asRecord(response);
  const state = readStatusWord(record) ?? "not_found";
  if (state === "revoked") return revokedResult();
  if (state === "expired") return expiredResult();
  if (state === "unavailable") return unavailableResult();
  // Paused and unknown both arrive as the identical generic state (contract §6).
  if (state !== "active") return notFoundResult();

  const card = toPublicProfile(record?.card ?? record?.profile);
  return card ? { state: "available", card } : notFoundResult();
}

/** Map a failed request onto the same terminal states, never onto an exception. */
function publicFailureResult(error: unknown): WalletCardPublicResult {
  if (!(error instanceof ApiError)) return unavailableResult();
  const declared =
    readStatusWord(error.payload) ?? apiErrorCode(error)?.toLowerCase() ?? null;
  if (error.status === 410) {
    return declared === "expired" ? expiredResult() : revokedResult();
  }
  if (declared === "expired") return expiredResult();
  if (declared === "revoked") return revokedResult();
  if (error.status === 404 || error.status === 400 || error.status === 422) {
    return notFoundResult();
  }
  return unavailableResult();
}

function unreadableResponse(): ApiError {
  return new ApiError("Wallet Profile response could not be read.", 502);
}

function isFeatureDisabled(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    apiErrorCode(error) === "ONE_WALLET_CARD_DISABLED"
  );
}

/* ------------------------------------------------------------ local storage */

const SHARE_LINK_STORAGE_PREFIX = "hushh.one.wallet-card.share-link";

function shareLinkKey(userId: string): string {
  return `${SHARE_LINK_STORAGE_PREFIX}:${userId}`;
}

function localStore(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readTokenVersion(card: WalletCardRecord | null | undefined): number | null {
  const raw = card?.shareTokenVersion;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/* ---------------------------------------------------------------- requests */

function ownerHeaders(vaultOwnerToken: string): Record<string, string> {
  return { Authorization: `Bearer ${vaultOwnerToken}` };
}

function ownerJsonHeaders(vaultOwnerToken: string): Record<string, string> {
  return { ...ownerHeaders(vaultOwnerToken), "Content-Type": "application/json" };
}

function ownerQuery(userId: string): string {
  return `?user_id=${encodeURIComponent(userId)}`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- service */

export class WalletCardService {
  /* ------------------------------------------------------------ owner side */

  /**
   * The owner's current card. A deployment without the feature flag reports
   * `enabled: false` rather than throwing, so the screen can explain itself.
   */
  static async getCard(params: WalletCardOwnerRequest): Promise<WalletCardState> {
    try {
      const response = await apiJson<unknown>(
        `${WALLET_CARD_API_PREFIX}${ownerQuery(params.userId)}`,
        { headers: ownerHeaders(params.vaultOwnerToken) },
      );
      const card = toCardRecord(asRecord(response)?.card);
      if (!card) {
        return { enabled: true, exists: false, card: null, shareUrl: null };
      }
      return {
        enabled: true,
        exists: true,
        card,
        shareUrl:
          WalletCardService.readShareLink(params.userId, card)?.shareUrl ?? null,
      };
    } catch (error) {
      if (isFeatureDisabled(error)) {
        return { enabled: false, exists: false, card: null, shareUrl: null };
      }
      throw error;
    }
  }

  /**
   * Create or update the shared fields.
   *
   * The payload is validated against the closed allowlist first: an invalid
   * draft never reaches the network. The plaintext token comes back only on
   * first creation, so it is persisted here before the response is discarded.
   */
  static async saveCard(params: {
    vaultOwnerToken: string;
    userId: string;
    payload: WalletCardPayloadInput;
    expiresAt?: string | null;
  }): Promise<WalletCardMutationResult> {
    const validation = validateWalletCardPayload(params.payload);
    if (!validation.ok) {
      throw new WalletCardPayloadError(validation.errors);
    }
    const response = await apiJson<unknown>(WALLET_CARD_API_PREFIX, {
      method: "POST",
      headers: ownerJsonHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        userId: params.userId,
        cardPayload: validation.value,
        ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
      }),
    });
    return WalletCardService.adoptMutation(params.userId, response);
  }

  /** Mint a new token. The old QR stops working immediately. */
  static async rotateShareToken(
    params: WalletCardOwnerRequest,
  ): Promise<WalletCardMutationResult> {
    const response = await apiJson<unknown>(`${WALLET_CARD_API_PREFIX}/rotate`, {
      method: "POST",
      headers: ownerJsonHeaders(params.vaultOwnerToken),
      body: JSON.stringify({ userId: params.userId }),
    });
    return WalletCardService.adoptMutation(params.userId, response);
  }

  /** A paused card reads as non-existent to a visitor. */
  static async pauseCard(
    params: WalletCardOwnerRequest,
  ): Promise<WalletCardRecord> {
    return WalletCardService.ownerAction(params, "/pause");
  }

  static async resumeCard(
    params: WalletCardOwnerRequest,
  ): Promise<WalletCardRecord> {
    return WalletCardService.ownerAction(params, "/resume");
  }

  /** Stop sharing for good. The device-local link is dropped with it. */
  static async revokeCard(
    params: WalletCardOwnerRequest,
  ): Promise<WalletCardRecord> {
    const response = await apiJson<unknown>(
      `${WALLET_CARD_API_PREFIX}${ownerQuery(params.userId)}`,
      { method: "DELETE", headers: ownerHeaders(params.vaultOwnerToken) },
    );
    WalletCardService.forgetShareLink(params.userId);
    const card = toCardRecord(asRecord(response)?.card);
    if (!card) throw unreadableResponse();
    return card;
  }

  /**
   * Preview-as-visitor. The backend runs the same projection builder the public
   * route uses, so this cannot drift from what a stranger actually receives.
   */
  static async previewAsVisitor(
    params: WalletCardOwnerRequest,
  ): Promise<WalletCardPublicResult> {
    try {
      const response = await apiJson<unknown>(
        `${WALLET_CARD_API_PREFIX}/preview${ownerQuery(params.userId)}`,
        { headers: ownerHeaders(params.vaultOwnerToken) },
      );
      return projectPublicResult(response);
    } catch (error) {
      return publicFailureResult(error);
    }
  }

  /* ----------------------------------------------------------- public side */

  /**
   * Resolve a scanned share token for a stranger.
   *
   * Deliberately unauthenticated — the token is the credential, so no
   * authorization header is attached. Terminal states are returned, never
   * thrown, so the page can render an honest message for each one.
   */
  static async resolvePublicCard(
    shareToken: string,
  ): Promise<WalletCardPublicResult> {
    if (!isWalletShareTokenShape(shareToken)) return notFoundResult();
    try {
      const response = await apiJson<unknown>(
        `${WALLET_CARD_API_PREFIX}/public/${encodeURIComponent(shareToken)}`,
        { method: "GET", cache: "no-store" },
      );
      return projectPublicResult(response);
    } catch (error) {
      return publicFailureResult(error);
    }
  }

  /**
   * Ask whether the signed `.pkpass` can actually be produced before handing
   * the URL to the OS, so a missing certificate surfaces as product copy rather
   * than a raw error page in Safari.
   */
  static async checkPassAvailability(
    shareToken: string,
  ): Promise<WalletPassAvailability> {
    if (!isWalletShareTokenShape(shareToken)) {
      return { state: "not_found", message: WALLET_CARD_SERVICE_COPY.notFound };
    }

    let response: Response;
    try {
      response = await ApiService.apiFetch(
        `${WALLET_CARD_API_PREFIX}/pass/${encodeURIComponent(shareToken)}.pkpass`,
        { method: "GET", cache: "no-store" },
      );
    } catch {
      return { state: "unavailable", message: WALLET_CARD_SERVICE_COPY.unavailable };
    }

    if (response.ok) {
      return { state: "available", url: walletCardPassUrl(shareToken) };
    }

    const body = await readJsonBody(response);
    const declared = readStatusWord(body);

    if (response.status === 410) {
      return declared === "expired"
        ? { state: "expired", message: WALLET_CARD_SERVICE_COPY.expired }
        : { state: "revoked", message: WALLET_CARD_SERVICE_COPY.revoked };
    }
    if (response.status === 404) {
      return { state: "not_found", message: WALLET_CARD_SERVICE_COPY.notFound };
    }
    if (response.status === 503) {
      return {
        state: "signing_unavailable",
        message: readMessageWord(body) ?? WALLET_CARD_SERVICE_COPY.signingUnavailable,
        code: readCodeWord(body) ?? WALLET_PASS_SIGNING_UNAVAILABLE_CODE,
      };
    }
    return { state: "unavailable", message: WALLET_CARD_SERVICE_COPY.unavailable };
  }

  /**
   * Add the pass to Apple Wallet.
   *
   * The URL is handed to the OS through `openExternalUrl()` because WKWebView
   * cannot import a `.pkpass`; it is never loaded in the WebView. Off-iOS there
   * is nothing to install, so the share link is offered instead — without
   * spending a request.
   */
  static async addToAppleWallet(
    shareToken: string,
    options: { verifyFirst?: boolean } = {},
  ): Promise<WalletPassAddResult> {
    if (walletPassCapability() === "unsupported") {
      return {
        state: "unsupported",
        message: WALLET_CARD_SERVICE_COPY.unsupported,
        shareUrl: walletCardShareUrl(shareToken),
      };
    }

    if (options.verifyFirst !== false) {
      const availability = await WalletCardService.checkPassAvailability(shareToken);
      if (availability.state !== "available") return availability;
    }

    const url = walletCardPassUrl(shareToken);
    openExternalUrl(url);
    return { state: "opened", url };
  }

  /* --------------------------------------------------- device-local link */

  /**
   * Persist the share link on this device.
   *
   * The backend hashes the token and cannot return it again (contract §5), so
   * without this copy the QR could never be rendered after the create or rotate
   * response is gone. Nothing here is logged.
   */
  static rememberShareLink(
    userId: string,
    input: {
      card?: WalletCardRecord | null;
      shareToken: string;
      shareUrl: string;
    },
  ): void {
    if (!userId) return;
    const shareToken = String(input.shareToken ?? "").trim();
    const shareUrl = String(input.shareUrl ?? "").trim();
    if (!isWalletShareTokenShape(shareToken) || !shareUrl) return;

    const storage = localStore();
    if (!storage) return;
    try {
      storage.setItem(
        shareLinkKey(userId),
        JSON.stringify({
          shareUrl,
          shareToken,
          version: readTokenVersion(input.card),
        }),
      );
    } catch {
      // A full or unavailable store only costs the QR on this device.
    }
  }

  /**
   * Read this device's share link.
   *
   * Passing the current card drops the link when its token version no longer
   * matches — that is how a rotation performed on another device stops this one
   * from showing a dead QR. The stored copy is left in place rather than
   * deleted, because the caller may be checking a stale card.
   */
  static readShareLink(
    userId: string,
    card?: WalletCardRecord | null,
  ): WalletCardShareLink | null {
    if (!userId) return null;
    const storage = localStore();
    if (!storage) return null;

    let parsed: unknown;
    try {
      const raw = storage.getItem(shareLinkKey(userId));
      if (!raw) return null;
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const record = asRecord(parsed);
    if (!record) return null;

    const shareUrl = typeof record.shareUrl === "string" ? record.shareUrl.trim() : "";
    const shareToken =
      typeof record.shareToken === "string" ? record.shareToken.trim() : "";
    if (!shareUrl || !isWalletShareTokenShape(shareToken)) return null;

    const version =
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : null;

    if (card && card.status === "revoked") return null;
    const cardVersion = readTokenVersion(card);
    if (cardVersion !== null && version !== null && cardVersion !== version) {
      return null;
    }

    return { shareUrl, shareToken, version };
  }

  static forgetShareLink(userId: string): void {
    if (!userId) return;
    const storage = localStore();
    if (!storage) return;
    try {
      storage.removeItem(shareLinkKey(userId));
    } catch {
      // Nothing to do: the link is device-local and advisory.
    }
  }

  /* ------------------------------------------------------------- internals */

  private static async ownerAction(
    params: WalletCardOwnerRequest,
    suffix: string,
  ): Promise<WalletCardRecord> {
    const response = await apiJson<unknown>(`${WALLET_CARD_API_PREFIX}${suffix}`, {
      method: "POST",
      headers: ownerJsonHeaders(params.vaultOwnerToken),
      body: JSON.stringify({ userId: params.userId }),
    });
    const card = toCardRecord(asRecord(response)?.card);
    if (!card) throw unreadableResponse();
    return card;
  }

  /** Adopt a create/rotate response and keep the once-only token on-device. */
  private static adoptMutation(
    userId: string,
    response: unknown,
  ): WalletCardMutationResult {
    const record = asRecord(response);
    const card = toCardRecord(record?.card);
    if (!card) throw unreadableResponse();

    const rawToken = record
      ? readString(record, ["shareToken", "share_token"], 128)
      : null;
    const shareToken = isWalletShareTokenShape(rawToken) ? rawToken : null;

    const shareUrl = shareToken
      ? ((record ? readString(record, ["shareUrl", "share_url"], MAX_URL_LENGTH) : null) ??
        walletCardShareUrl(shareToken))
      : null;
    const passUrl = shareToken ? walletCardPassUrl(shareToken) : null;

    if (shareToken && shareUrl) {
      WalletCardService.rememberShareLink(userId, { card, shareToken, shareUrl });
    }

    return { card, shareToken, shareUrl, passUrl };
  }
}
