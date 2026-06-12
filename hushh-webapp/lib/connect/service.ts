/**
 * lib/connect/service.ts
 *
 * Connect discovery service — aggregates data from existing APIs.
 * All fetch calls go through existing service-layer classes.
 * Components must NOT import this directly; use the hook instead.
 */

import {
  RiaService,
  type MarketplaceRia,
  type MarketplaceInvestor,
  type MarketplaceContactMatch,
  type MarketplaceInvestorActionRecord,
  type RiaClientAccess,
  isIAMSchemaNotReadyError,
} from "@/lib/services/ria-service";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import { buildMarketplaceContactLookups } from "@/lib/marketplace/contact-matching";
import type { ConnectRawPayload } from "./types";

const WEB_CONTACT_MATCH_FIXTURE_KEY = "hushh:dev:marketplace-contact-matches";

export type ConnectServiceLoadOptions = {
  idToken: string;
  userId: string;
  persona: "investor" | "ria";
  query?: string;
  limit?: number;
  signal?: AbortSignal;
};

export type ConnectContactLoadResult = {
  matches: MarketplaceContactMatch[];
  totalContacts: number;
  sourcePlatform: string;
  error?: string;
};

function isLocalFixtureAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && typeof window !== "undefined";
}

function readLocalContactMatchFixture(): MarketplaceContactMatch[] {
  if (!isLocalFixtureAllowed()) return [];
  const raw = window.localStorage.getItem(WEB_CONTACT_MATCH_FIXTURE_KEY);
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${WEB_CONTACT_MATCH_FIXTURE_KEY} must be a JSON array.`);
  }

  return parsed
    .map((item): MarketplaceContactMatch | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const kind = record.kind === "ria" ? "ria" : record.kind === "investor" ? "investor" : null;
      const userId = String(record.user_id || "").trim();
      const displayName = String(record.display_name || "").trim();
      if (!kind || !userId || !displayName) return null;

      const profile =
        record.profile && typeof record.profile === "object"
          ? (record.profile as MarketplaceRia | MarketplaceInvestor)
          : ({
              id: kind === "ria" ? userId : `hushh_user:${userId}`,
              user_id: userId,
              display_name: displayName,
              headline: typeof record.headline === "string" ? record.headline : null,
              visibility_posture: "default_available",
              exposure_enabled: true,
              ...(kind === "ria"
                ? { verification_status: "active" }
                : { source_type: "hushh_user", connectable: true }),
            } as MarketplaceRia | MarketplaceInvestor);

      return {
        user_id: userId,
        kind,
        display_name: displayName,
        headline: typeof record.headline === "string" ? record.headline : null,
        phone_last4: typeof record.phone_last4 === "string" ? record.phone_last4 : null,
        profile,
      };
    })
    .filter((match): match is MarketplaceContactMatch => Boolean(match));
}

export function hasLocalContactMatchFixture(): boolean {
  try {
    return readLocalContactMatchFixture().length > 0;
  } catch {
    return false;
  }
}

/**
 * Load all discovery sources for the Connect tab.
 * Returns raw payloads — normalization is done in candidates.ts.
 */
export async function loadConnectPayload(
  options: ConnectServiceLoadOptions,
): Promise<ConnectRawPayload> {
  const { idToken, userId, persona, query = "", limit = 32 } = options;

  const iamUnavailableFlags: boolean[] = [];

  // ─── RIA search ───────────────────────────────────────────────────────────
  const riasPromise = RiaService.searchRias({
    query,
    limit,
    verification_status: "active",
  }).catch((err) => {
    if (isIAMSchemaNotReadyError(err)) iamUnavailableFlags.push(true);
    return [] as MarketplaceRia[];
  });

  // ─── Investor search ──────────────────────────────────────────────────────
  const investorsPromise = (async (): Promise<MarketplaceInvestor[]> => {
    try {
      if (persona === "ria") {
        const deck = await RiaService.searchInvestorDeck(idToken, {
          query,
          limit,
          persona: "ria",
          deck: "qualified",
        });
        return deck.items;
      }
      return await RiaService.searchInvestors({
        query,
        limit,
        persona: "ria",
        deck: "qualified",
      });
    } catch (err) {
      if (isIAMSchemaNotReadyError(err)) iamUnavailableFlags.push(true);
      return [];
    }
  })();

  // ─── Consent center connections (active/pending/previous) ─────────────────
  const connectionsPromise = Promise.allSettled([
    ConsentCenterService.listEntries({
      idToken,
      userId,
      actor: persona,
      mode: "connections",
      surface: "active",
      top: 50,
    }),
    ConsentCenterService.listEntries({
      idToken,
      userId,
      actor: persona,
      mode: "connections",
      surface: "pending",
      top: 50,
    }),
    ConsentCenterService.listEntries({
      idToken,
      userId,
      actor: persona,
      mode: "connections",
      surface: "previous",
      top: 50,
    }),
  ]);

  // ─── RIA clients (relationship map) ──────────────────────────────────────
  const riaRelationshipsPromise = RiaService.listClients(idToken, {
    userId,
  }).catch(() => ({ items: [] as RiaClientAccess[], total: 0, page: 1, limit: 50, has_more: false }));

  // ─── Investor actions ─────────────────────────────────────────────────────
  const investorActionsPromise = persona === "ria"
    ? RiaService.listInvestorActions(idToken, { limit: 100 }).catch(() => [] as MarketplaceInvestorActionRecord[])
    : Promise.resolve([] as MarketplaceInvestorActionRecord[]);

  // ─── Await all ────────────────────────────────────────────────────────────
  const [rias, investors, connectionResults, riaClientsResult, investorActions] =
    await Promise.all([
      riasPromise,
      investorsPromise,
      connectionsPromise,
      riaRelationshipsPromise,
      investorActionsPromise,
    ]);

  const [activeResult, pendingResult, previousResult] = connectionResults;

  const activeConnections: ConsentCenterEntry[] =
    activeResult.status === "fulfilled" ? activeResult.value.items : [];
  const pendingConnections: ConsentCenterEntry[] =
    pendingResult.status === "fulfilled" ? pendingResult.value.items : [];
  const previousConnections: ConsentCenterEntry[] =
    previousResult.status === "fulfilled" ? previousResult.value.items : [];

  const iamUnavailable = iamUnavailableFlags.length > 0;

  return {
    rias,
    investors,
    contactMatches: [], // Populated separately via matchContacts()
    activeConnections,
    pendingConnections,
    previousConnections,
    riaRelationships: riaClientsResult.items,
    investorActions,
    iamUnavailable,
  };
}

/**
 * Perform contact matching — reads device contacts (hashed) and sends to backend.
 * Returns matched profiles.
 */
export async function loadContactMatches(
  idToken: string,
  options?: { limit?: number },
): Promise<ConnectContactLoadResult> {
  let totalContacts = 0;
  let sourcePlatform = "web";

  try {
    const { lookups, totalContacts: total, sourcePlatform: platform } =
      await buildMarketplaceContactLookups({ limit: options?.limit ?? 500 });

    totalContacts = total;
    sourcePlatform = platform;

    if (lookups.length === 0) {
      return {
        matches: [],
        totalContacts,
        sourcePlatform,
      };
    }

    const contactLookups = lookups.map((l) => ({ hash: l.hash, last4: l.last4 }));
    const matches = await RiaService.matchMarketplaceContacts(idToken, {
      phone_lookups: contactLookups,
      limit: 50,
    });
    const fixtureMatches = matches.length === 0 ? readLocalContactMatchFixture() : [];
    if (fixtureMatches.length > 0) {
      return { matches: fixtureMatches, totalContacts, sourcePlatform };
    }
    return { matches, totalContacts, sourcePlatform };
  } catch (err) {
    const fixtureMatches = readLocalContactMatchFixture();
    if (fixtureMatches.length > 0) {
      return {
        matches: fixtureMatches,
        totalContacts,
        sourcePlatform,
      };
    }
    const message = err instanceof Error ? err.message : "Contact matching failed.";
    return {
      matches: [],
      totalContacts,
      sourcePlatform,
      error: message,
    };
  }
}
