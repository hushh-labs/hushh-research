"use client";

/**
 * Keeps the owner's living `memory.md` current, inside the lifecycle the repo
 * already has for derived PKM views.
 *
 * `memory.md` is deliberately NOT persisted as a new PKM domain. The vault/PKM
 * governance is explicit that manifests are the authority and derived views
 * must not become "new authoritative owner information"; a stored memory
 * document would be a third authority that could silently disagree with the
 * domains it came from. So it is rendered on demand from the authoritative
 * encrypted domains and cached for the session only.
 *
 * Freshness reuses the shipped vocabulary rather than inventing one:
 *
 *   current          built from the domains at their current revisions
 *   refresh_pending  a domain changed since the last build
 *   refresh_failed   the last build could not read one or more domains
 *   stale            no build this session yet
 *
 * A locked vault reports `stale`, never an empty document: a lock must not
 * collapse real memory into a false "nothing here"
 * (vault-pkm-browser-data-boundary, PKM Truth 4).
 */

import { CacheService, CACHE_TTL } from "@/lib/services/cache-service";
import { buildMemoryDocument, type MemoryAccountIdentity, type MemoryDocument } from "@/lib/pkm/memory-document";
import { buildPkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";

export type MemoryRefreshStatus =
  | "current"
  | "refresh_pending"
  | "refresh_failed"
  | "stale";

export interface MemoryView {
  document: MemoryDocument | null;
  status: MemoryRefreshStatus;
  builtAt: string | null;
}

const CACHE_KEY = (userId: string) => `pkm_memory_document_${userId}`;

/** Domains marked dirty since their last build, per user. */
const dirtyByUser = new Map<string, Set<string>>();

/**
 * Start marking this user's memory document dirty when any PKM domain changes.
 * Returns the unsubscribe handle. Idempotent per caller.
 */
export function watchMemoryFreshness(userId: string): () => void {
  return subscribeToPkmDomainChanges((detail) => {
    if (!detail?.domain) return;
    const dirty = dirtyByUser.get(userId) ?? new Set<string>();
    dirty.add(detail.domain);
    dirtyByUser.set(userId, dirty);
  });
}

/** The cached document and an honest status, without building anything. */
export function peekMemoryView(userId: string): MemoryView {
  const snapshot = CacheService.getInstance().peek<{
    document: MemoryDocument;
    builtAt: string;
  }>(CACHE_KEY(userId));
  const cached = snapshot?.data;
  if (!cached) return { document: null, status: "stale", builtAt: null };
  const dirty = dirtyByUser.get(userId);
  const status: MemoryRefreshStatus = !cached.document.complete
    ? "refresh_failed"
    : dirty && dirty.size > 0
      ? "refresh_pending"
      : "current";
  return { document: cached.document, status, builtAt: cached.builtAt };
}

export interface RefreshMemoryParams {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  /** Every domain to include. The caller owns discovery; this reads what it is given. */
  domains: readonly string[];
  account?: MemoryAccountIdentity | null;
  /** Rebuild even when the cache is current. */
  force?: boolean;
}

/**
 * Rebuild the document from the owner's decrypted domains.
 *
 * Requires an unlocked vault: without a key nothing can be read, and this
 * returns `stale` rather than an empty document.
 */
export async function refreshMemoryDocument(
  params: RefreshMemoryParams,
): Promise<MemoryView> {
  if (!params.vaultKey || !params.vaultOwnerToken) {
    return { document: null, status: "stale", builtAt: null };
  }
  const existing = peekMemoryView(params.userId);
  if (!params.force && existing.status === "current") return existing;

  const sources: { domain: string; contentRevision: number | null; unavailableReason?: string }[] =
    [];
  const fullBlob: Record<string, unknown> = {};

  for (const domain of params.domains) {
    try {
      const snapshot = await PkmDomainResourceService.getStaleFirst({
        userId: params.userId,
        domain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      if (!snapshot?.data) {
        sources.push({ domain, contentRevision: null, unavailableReason: "no data" });
        continue;
      }
      fullBlob[domain] = snapshot.data;
      sources.push({ domain, contentRevision: snapshot.key.contentRevision });
    } catch {
      sources.push({ domain, contentRevision: null, unavailableReason: "could not be read" });
    }
  }

  const builtAt = new Date().toISOString();
  const document = buildMemoryDocument({
    snapshot: buildPkmMemorySnapshot({ metadata: null, fullBlob }),
    sources,
    audience: "self",
    builtAt,
    account: params.account ?? null,
  });

  CacheService.getInstance().set(CACHE_KEY(params.userId), { document, builtAt }, CACHE_TTL.SESSION);
  // Only clear the domains this build actually covered; a domain that changed
  // mid-build stays dirty so the next read still reports refresh_pending.
  const dirty = dirtyByUser.get(params.userId);
  if (dirty) for (const domain of params.domains) dirty.delete(domain);

  return {
    document,
    status: document.complete ? "current" : "refresh_failed",
    builtAt,
  };
}

/** Drop the cached document. Called on vault lock and on sign-out. */
export function clearMemoryDocument(userId: string): void {
  CacheService.getInstance().invalidate(CACHE_KEY(userId));
  dirtyByUser.delete(userId);
}
