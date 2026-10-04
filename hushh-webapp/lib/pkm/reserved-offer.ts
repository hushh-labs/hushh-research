/**
 * Offers to commit a chat fact on the app screen that owns it.
 *
 * When a memory agent aims a fact at an app-owned branch ("my home is ..."
 * aimed at `location.saved_places`), the server keeps it in that branch's
 * `agent_memory` sibling and returns a `reserved_offer` naming the owning
 * screen (contracts/pkm/reserved-branches.v1.json). The chat shows the offer
 * ("Add as Home in Location"); tapping it opens that screen, where the owner
 * commits with the feature's own writer. Chat never writes the reserved branch.
 *
 * The prefill travels IN MEMORY only, never in the URL, a query string, web
 * storage or a log. It follows the validation discipline of
 * `lib/agent/drive-oauth-chat-recovery.ts` (owner-bound, expiring, one-shot,
 * correlation by opaque id) but stays in this JavaScript realm: the hand-off is
 * same-session client navigation, so nothing needs to survive a reload, and a
 * reload simply opens the screen without a prefill.
 */

export type AgentPkmReservedOffer = {
  domain: string;
  branch: string;
  /** The agent's short noun for the fact ("Home", "Amex Gold"). */
  subject?: string;
  owner_feature: string;
  agent_memory_sibling: string;
  offer_action: { route_pattern: string; action_id: string; label: string };
  registry_version: number;
};

export type ReservedOfferPrefill =
  | { kind: "location_saved_place"; category: "home" | "work" | "other"; label: string }
  | { kind: "wallet_card"; nickname: string };

/** One offer as the chat shows it. Labels and routes only. */
export type ReservedOfferItem = {
  id: string;
  ownerFeature: string;
  label: string;
  routePattern: string;
  actionId: string;
  prefill: ReservedOfferPrefill | null;
};

/** The owning app's name, as the Memory screen's "Open in <app>" says it. */
export const RESERVED_OWNER_APP_NAMES: Readonly<Record<string, string>> = {
  finance: "Finance",
  ria: "RIA",
  location: "Location",
  // Identity details are committed on Mail's KYC tab (/one/gmail?workspace=kyc).
  kyc: "Mail",
  settings: "Preferences",
  wallet: "Wallet",
  gmail_receipts: "Receipts",
  runtime_credentials: "Settings",
  secrets: "Secrets",
};

export function reservedOwnerAppName(ownerFeature: string | null | undefined): string {
  const key = String(ownerFeature ?? "").trim().toLowerCase();
  return RESERVED_OWNER_APP_NAMES[key] ?? "the app";
}

const SAFE_ROUTE = /^\/[A-Za-z0-9/_-]{1,120}(?:\?[A-Za-z0-9=&_-]{1,80})?$/;
const SUBJECT_MAX = 48;

function cleanSubject(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX);
}

/**
 * What the owning screen is handed, derived from the agent's own subject.
 * Location reads an exact "Home" or "Work" as that category and anything else
 * as an "Other" place with the subject as its name; Wallet takes the subject
 * as the card's nickname. Nothing else is prefilled anywhere: other areas open
 * their screen without a prefill. Never a card number or a stored value.
 */
export function buildReservedOfferPrefill(offer: AgentPkmReservedOffer): ReservedOfferPrefill | null {
  const subject = cleanSubject(offer.subject);
  if (!subject) return null;
  if (offer.domain === "location" && offer.branch === "saved_places") {
    const lowered = subject.toLowerCase();
    const category = lowered === "home" ? "home" : lowered === "work" ? "work" : "other";
    return { kind: "location_saved_place", category, label: category === "other" ? subject : "" };
  }
  if (offer.domain === "wallet") return { kind: "wallet_card", nickname: subject };
  return null;
}

/** A server offer, validated, as the chat shows it; null when malformed. */
export function toReservedOfferItem(id: string, offer: AgentPkmReservedOffer | null | undefined): ReservedOfferItem | null {
  const action = offer?.offer_action;
  if (!offer || !action || !SAFE_ROUTE.test(String(action.route_pattern ?? ""))) return null;
  const label = String(action.label ?? "").replace(/\s+/g, " ").trim().slice(0, 96);
  if (!label) return null;
  return {
    id,
    ownerFeature: String(offer.owner_feature ?? ""),
    label,
    routePattern: action.route_pattern,
    actionId: String(action.action_id ?? ""),
    prefill: buildReservedOfferPrefill(offer),
  };
}

/* ---------- in-memory hand-off ---------- */

export const RESERVED_OFFER_PREFILL_TTL_MS = 15 * 60 * 1_000;

type Staged = { ownerUserId: string; ownerFeature: string; prefill: ReservedOfferPrefill; expiresAt: number };

// One slot per owning feature: a newer tap replaces an older one.
const staged = new Map<string, Staged>();

function slotKey(ownerUserId: string, ownerFeature: string): string {
  return `${ownerUserId}\u0000${ownerFeature}`;
}

/** Hold a prefill for the owning screen. Memory only; dropped on reload. */
export function stageReservedOfferPrefill(input: {
  ownerUserId: string;
  ownerFeature: string;
  prefill: ReservedOfferPrefill;
  now?: number;
}): void {
  if (!input.ownerUserId || !input.ownerFeature) return;
  staged.set(slotKey(input.ownerUserId, input.ownerFeature), {
    ownerUserId: input.ownerUserId,
    ownerFeature: input.ownerFeature,
    prefill: input.prefill,
    expiresAt: (input.now ?? Date.now()) + RESERVED_OFFER_PREFILL_TTL_MS,
  });
}

/** Whether the owning screen has a prefill waiting, without consuming it. */
export function hasReservedOfferPrefill(input: { ownerUserId: string; ownerFeature: string; now?: number }): boolean {
  const entry = staged.get(slotKey(input.ownerUserId, input.ownerFeature));
  return Boolean(entry && entry.expiresAt > (input.now ?? Date.now()));
}

/** Take the prefill once. Another owner, another feature or an expired one gets null. */
export function takeReservedOfferPrefill<K extends ReservedOfferPrefill["kind"]>(input: {
  ownerUserId: string;
  ownerFeature: string;
  kind: K;
  now?: number;
}): Extract<ReservedOfferPrefill, { kind: K }> | null {
  const key = slotKey(input.ownerUserId, input.ownerFeature);
  const entry = staged.get(key);
  if (!entry) return null;
  staged.delete(key);
  if (entry.ownerUserId !== input.ownerUserId || entry.expiresAt <= (input.now ?? Date.now())) return null;
  return entry.prefill.kind === input.kind
    ? (entry.prefill as Extract<ReservedOfferPrefill, { kind: K }>)
    : null;
}

/** Forget every staged prefill (sign-out, account switch). */
export function clearReservedOfferPrefills(): void {
  staged.clear();
}
