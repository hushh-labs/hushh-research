"use client";

import { CacheService, CACHE_KEYS } from "./cache-service";
import { WalletService, type WalletCardPresentation, type WalletArtworkRejection } from "@/lib/services/wallet-service";
import { AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { currentPkmSourceEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";

type Context = { userId: string; vaultKey: string; vaultOwnerToken: string };
type Scope = { ownerId: string; authGeneration: number; epoch: number; source: string; revision: number };
export type WalletPresentationSnapshot = Scope & { rows: WalletCardPresentation[]; artworkExpiresAt: number; pendingArtworkIds?: string[] };
type Load = { scope: Scope; promise: Promise<WalletPresentationSnapshot>; listeners: Set<(refs: readonly WalletArtworkRejection[]) => void>; rejected: WalletArtworkRejection[] };
const inflight = new Map<string, Load>();
let revision = 0, subscribed = false;
const PREFIX = "wallet_presentations_";
const cache = () => CacheService.getInstance();
const same = (a: Scope, b: Scope | null) => Boolean(b && a.ownerId === b.ownerId && a.authGeneration === b.authGeneration && a.epoch === b.epoch && a.source === b.source && a.revision === b.revision);
function scope(userId: string): Scope | null {
  const owner = snapshotValidatedAuthSessionOwner();
  return owner?.userId === userId ? { ownerId: userId, authGeneration: owner.generation, epoch: snapshotVaultSessionEpoch(), source: currentPkmSourceEpoch(userId, ["wallet"]), revision } : null;
}
function subscribe() {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  const clear = () => { revision++; inflight.clear(); cache().invalidatePattern(PREFIX); };
  subscribeVaultSessionEpoch(clear);
  window.addEventListener(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, clear);
  subscribeToPkmDomainChanges(detail => { if (detail.domain === "wallet") { revision++; inflight.delete(detail.userId); cache().invalidate(CACHE_KEYS.WALLET_PRESENTATIONS(detail.userId)); } });
  cache().subscribe(event => {
    if (event.type === "clear" || event.type === "invalidate_user") { revision++; inflight.clear(); }
  });
}

/** Browser memory only. No vault credentials, full PAN, CVV or domain records. */
export class WalletPresentationResource {
  static peek(userId: string): WalletPresentationSnapshot | null {
    subscribe();
    const saved = cache().peek<WalletPresentationSnapshot>(CACHE_KEYS.WALLET_PRESENTATIONS(userId))?.data;
    if (!saved || !same(saved, scope(userId))) return null;
    if (saved.artworkExpiresAt > Date.now()) return saved;
    // Timers may be throttled in a background tab. Never revive expired pixels.
    return { ...saved, pendingArtworkIds: saved.rows.filter(row => row.artwork?.source === "catalog").map(row => row.summary.cardId), rows: saved.rows.map(row => row.artwork?.source === "catalog" ? { ...row, artwork: { source: "neutral", version: 1 } } : row) };
  }

  static load(context: Context, options?: { force?: boolean; onArtworkRejected?: (refs: readonly WalletArtworkRejection[]) => void }): Promise<WalletPresentationSnapshot> {
    subscribe();
    const initial = scope(context.userId);
    if (!initial) return Promise.reject(new Error("Wallet changed."));
    const saved = this.peek(context.userId);
    if (!options?.force && saved && saved.artworkExpiresAt > Date.now()) return Promise.resolve().then(() => {
      if (!same(initial, scope(context.userId))) throw new Error("Wallet changed.");
      return saved;
    });
    const pending = inflight.get(context.userId);
    if (pending && same(pending.scope, initial)) {
      if (options?.onArtworkRejected) { pending.listeners.add(options.onArtworkRejected); if (pending.rejected.length) options.onArtworkRejected(pending.rejected); }
      return pending.promise;
    }
    const listeners = new Set<(refs: readonly WalletArtworkRejection[]) => void>();
    if (options?.onArtworkRejected) listeners.add(options.onArtworkRejected);
    const rejected: WalletArtworkRejection[] = [];
    const artworkExpiresAt = Date.now() + 60_000;
    const current = () => same(initial, scope(context.userId));
    const promise = WalletService.listCardPresentations(context, { recoverArtwork: true, failOnArtworkUnavailable: Boolean(saved), onArtworkRejected: refs => {
      if (!current()) return;
      rejected.push(...refs);
      const previous = this.peek(context.userId);
      if (previous) cache().set(CACHE_KEYS.WALLET_PRESENTATIONS(context.userId), { ...previous, rows: previous.rows.map(row => row.artwork?.source === "catalog" && refs.some(ref => ref.cardId === row.summary.cardId) ? { ...row, artwork: { source: "neutral", version: 1 } } : row) }, 60_000);
      listeners.forEach(listener => listener(refs));
    } }).then(rows => {
      if (!current()) throw new Error("Wallet changed.");
      const projected = rows.map(row => {
        const { cardId, nickname, brand, last4, expiryMonth, expiryYear, issuingRegion, createdAt } = row.summary;
        return { summary: { cardId, nickname, brand, last4, expiryMonth, expiryYear, issuingRegion, createdAt }, cardholderName: row.cardholderName, artwork: row.artwork };
      });
      const snapshot: WalletPresentationSnapshot = { ...initial, rows: projected, artworkExpiresAt };
      cache().set(CACHE_KEYS.WALLET_PRESENTATIONS(context.userId), snapshot, 60_000);
      const currentSnapshot = this.peek(context.userId);
      if (!currentSnapshot) throw new Error("Wallet changed.");
      return currentSnapshot;
    }).finally(() => { if (inflight.get(context.userId)?.promise === promise) inflight.delete(context.userId); });
    inflight.set(context.userId, { scope: initial, promise, listeners, rejected });
    return promise;
  }
}
