// Inert boundaries for the Wallet layout fixture. Synthetic test cards only
// (network test numbers such as 4242 4242 4242 4242); nothing here is a real
// card, and nothing leaves the page. The scenario is read from
// `window.__walletScenario`, set by the spec before the fixture script runs.
import React from "react";
import { detectBrand } from "../../lib/wallet/card-validation";

type FixtureCard = {
  cardId: string;
  nickname: string;
  brand: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  issuingRegion: string;
  createdAt: string;
  pan: string;
  cvv: string;
  pin: string;
  cardholderName: string;
};

type Scenario = {
  cards?: number;
  locked?: boolean;
  delayMs?: number;
  error?: boolean;
  artworkGallery?: boolean;
};

const SYNTHETIC: FixtureCard[] = [
  { cardId: "card_a", nickname: "Everyday", brand: "visa", last4: "4242", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US", createdAt: "2026-09-01T00:00:01.000Z", pan: "4242424242424242", cvv: "123", pin: "1234", cardholderName: "Alex Rivera" },
  { cardId: "card_b", nickname: "Travel", brand: "amex", last4: "0005", expiryMonth: 11, expiryYear: 2029, issuingRegion: "US", createdAt: "2026-09-01T00:00:02.000Z", pan: "378282246310005", cvv: "1234", pin: "", cardholderName: "Alex Rivera" },
  { cardId: "card_c", nickname: "Groceries", brand: "mastercard", last4: "4444", expiryMonth: 8, expiryYear: 2028, issuingRegion: "GB", createdAt: "2026-09-01T00:00:03.000Z", pan: "5555555555554444", cvv: "321", pin: "", cardholderName: "Alex Rivera" },
  { cardId: "card_d", nickname: "", brand: "discover", last4: "1117", expiryMonth: 1, expiryYear: 2031, issuingRegion: "US", createdAt: "2026-09-01T00:00:04.000Z", pan: "6011111111111117", cvv: "456", pin: "", cardholderName: "Alex Rivera" },
];

declare global {
  interface Window {
    __walletScenario?: Scenario;
    __walletEvents?: string[];
    __walletRemount?: () => void;
  }
}

function scenario(): Scenario {
  return window.__walletScenario ?? {};
}

function record(event: string) {
  (window.__walletEvents ??= []).push(event);
}

let store: FixtureCard[] | null = null;
function cards(): FixtureCard[] {
  if (!store) {
    const count = scenario().cards ?? 3;
    store = Array.from({ length: count }, (_, index) => {
      const base = SYNTHETIC[index % SYNTHETIC.length]!;
      if (index < SYNTHETIC.length) return { ...base };
      return { ...base, cardId: `${base.cardId}_${index}`, nickname: `Card ${index + 1}` };
    });
  }
  return store;
}

const wait = () => new Promise((resolve) => window.setTimeout(resolve, scenario().delayMs ?? 0));

function summaryOf(card: FixtureCard) {
  const { pan: _pan, cvv: _cvv, pin: _pin, cardholderName: _name, ...summary } = card;
  return summary;
}

export class WalletService {
  static isEnabled() {
    return true;
  }
  static async listCardSummaries() {
    await wait();
    if (scenario().error) throw new Error("Your cards could not be loaded.");
    return cards().map(summaryOf);
  }
  static async listCardPresentations() {
    await wait();
    if (scenario().error) throw new Error("Your cards could not be loaded.");
    return cards().map((card) => ({ summary: summaryOf(card), cardholderName: card.cardholderName }));
  }
  static async getCard({ cardId }: { cardId: string }) {
    record(`reveal:${cardId}`);
    const card = cards().find((entry) => entry.cardId === cardId);
    if (!card) return null;
    return {
      summary: summaryOf(card),
      secrets: { pan: card.pan, cvv: card.cvv, pin: card.pin, cardholderName: card.cardholderName },
    };
  }
  static async deleteCard({ cardId }: { cardId: string }) {
    record(`delete:${cardId}`);
    store = cards().filter((card) => card.cardId !== cardId);
  }
  static async addCard({ card }: { card: {
    nickname: string; brand?: string; pan: string; cardholderName: string;
    cvv: string; pin?: string; expiryMonth: number; expiryYear: number; issuingRegion?: string;
  } }) {
    await wait();
    record("add");
    const saved: FixtureCard = {
      ...card,
      cardId: `card_saved_${cards().length + 1}`,
      brand: card.brand || detectBrand(card.pan) || "other",
      last4: card.pan.slice(-4),
      issuingRegion: card.issuingRegion || "",
      pin: card.pin || "",
      createdAt: "2026-10-09T00:00:00.000Z",
    };
    cards().push(saved);
    return { cardId: saved.cardId, summary: summaryOf(saved), cardholderName: saved.cardholderName };
  }
  static matchesQuery(card: { nickname: string; brand: string; last4: string; issuingRegion: string }, query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [card.nickname, card.brand, card.last4, card.issuingRegion].some((value) =>
      String(value || "").toLowerCase().includes(q),
    );
  }
}

// Secrets vault: the fixture never stages a Secrets card offer, so nothing is
// decrypted or filed. Inert, like the Wallet service, so the layout bundle
// never pulls in the PKM, cache and API stack behind the real service.
export class SecretsVaultService {
  static async revealSecret(): Promise<string | null> {
    record("secret-reveal");
    return null;
  }
  static async markFiled(): Promise<boolean> {
    record("secret-filed");
    return false;
  }
}

// next/navigation: search and page live in memory for the fixture.
const params = new URLSearchParams();
const router = {
  replace: (href: string) => {
    const query = href.split("?")[1] ?? "";
    for (const key of [...params.keys()]) params.delete(key);
    new URLSearchParams(query).forEach((value, key) => params.set(key, value));
  },
  push: () => undefined,
  prefetch: () => undefined,
};
export const useRouter = () => router;
export const usePathname = () => "/one/wallet";
export const useSearchParams = () => params;

// Auth and vault.
const user = { uid: "fixture-owner", displayName: "Alex Rivera", metadata: { creationTime: "2026-01-01T00:00:00Z" }, getIdToken: async () => "fixture-token" };
export const useEffectiveAvatarUrl = () => null;
export const useReferralStream = () => ({ connected: true });
export const useAuth = () => ({ user, loading: false });
export const useVault = () => ({
  vaultKey: scenario().locked ? null : "fixture-vault-key",
  isVaultUnlocked: !scenario().locked,
  vaultOwnerToken: scenario().locked ? null : "fixture-owner-token",
  getVaultOwnerToken: () => (scenario().locked ? null : "fixture-owner-token"),
});

// Unlock dialog: a visible stand-in that records the request.
export function VaultUnlockDialog({ open, title }: { open: boolean; title?: string }) {
  if (open) record("unlock-dialog");
  return open ? <div data-testid="fixture-vault-unlock" role="dialog" aria-label={title} /> : null;
}

export const trackEvent = () => undefined;
// The wallet fixture aliases the observability boundary so layout tests never
// initialize analytics adapters. Keep the API-service surface complete while
// recording no external events.
export const toDurationBucket = (durationMs: number) => {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 300) return "100ms_300ms";
  if (durationMs < 1000) return "300ms_1s";
  if (durationMs < 3000) return "1s_3s";
  if (durationMs < 10000) return "3s_10s";
  return "gte_10s";
};
export const trackApiRequestCompleted = () => undefined;
export const NativeTestBeacon = () => null;

// The production Wallet Card service imports ApiService through the shared
// client. Keep that transport inert in this fixture so a layout test never
// initializes Firebase or performs a network request just to load an empty
// card state.
export const ApiService = {
  getDirectBackendUrl: () => "",
  apiFetch: async (requestPath: string) => {
    // Production profile/referral views keep their rendering; only network
    // responses are synthetic. No live profile, visitor, or payment is touched.
    const payload = requestPath.startsWith("/api/one/referrals/summary") ? {
      slug: "fixture-referral", link: "https://example.test/r/fixture-referral",
      link_open_count: 7, last_opened_at: "2026-09-01T10:00:00Z",
      qualified_count: 2, in_progress_count: 1, under_review_count: 0,
      required_active_minutes: 15, new_users_only: true, referrals: [],
    } : requestPath.startsWith("/api/one/wallet-card") ? {
      card: {
        pass_serial: "fixture-wallet-0001", status: "active", share_token_version: 1,
        card_payload: { full_name: "Alex Rivera", username: "alex.rivera" },
        display_name: "Alex Rivera", created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-09-01T10:00:00Z", scan_count: 3,
        last_scanned_at: "2026-09-01T09:00:00Z",
      },
      share_token: "fixture-wallet-share-token-000001", share_url: "https://example.test/c/fixture-wallet-share-token-000001",
    } : {};
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    });
  },
};

export class ConsentCenterService {
  static async listEntries({ surface, page }: { surface: string; page: number }) {
    return { user_id: "fixture-owner", page, has_more: false, items: [{
      kind: surface === "pending" ? "incoming_request" : "active_grant", status: surface === "pending" ? "pending" : "active", action: "request", counterpart_type: "person",
      id: `fixture-${surface}`, request_id: `fixture-${surface}`,
      scope: surface === "pending" ? "attr.wallet.secrets.*" : "attr.wallet.summary.*",
      counterpart_label: surface === "pending" ? "Sample requester" : "Sample recipient",
      expires_at: "2030-01-01T00:00:00Z",
    }] };
  }
}

export const useConsentActions = () => ({ handleApprove: async () => record("approve"), handleDeny: async () => record("deny"), handleRevoke: async () => record("revoke") });
