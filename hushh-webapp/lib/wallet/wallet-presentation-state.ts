import type { WalletCardSummary } from "@/lib/services/wallet-service";
import type { WalletPresentationSnapshot } from "@/lib/services/wallet-presentation-resource";
import type { WalletCardArtwork } from "./card-artwork";

/** Owner-only display projection. Never pass this to agent/chat summary callers. */
export interface WalletCardPresentation {
  summary: WalletCardSummary;
  cardholderName: string;
  artwork?: WalletCardArtwork;
}
export interface WalletArtworkRejection { cardId: string; assetId: string; digest: string }

export function presentationState(snapshot: WalletPresentationSnapshot) {
  return {
    ownerId: snapshot.ownerId, epoch: snapshot.epoch,
    cards: snapshot.rows.map(row => row.summary),
    cardholderNames: Object.fromEntries(snapshot.rows.map(row => [row.summary.cardId, row.cardholderName])),
    artworks: Object.fromEntries(snapshot.rows.map(row => [row.summary.cardId, row.artwork])),
    pendingArtworkIds: new Set(snapshot.pendingArtworkIds ?? []), artworkExpiresAt: snapshot.artworkExpiresAt,
  };
}

export type WalletPresentationState = ReturnType<typeof presentationState>;

/** Merge only a confirmed save; never extend older artwork approvals. */
export function mergeSavedCard(
  previous: WalletPresentationState | null,
  ownerId: string,
  epoch: number,
  saved: { cardId: string; summary: WalletCardSummary; cardholderName: string; artwork?: WalletCardArtwork },
): WalletPresentationState {
  const owned = previous?.ownerId === ownerId ? previous : null;
  const now = Date.now(), expired = !owned || owned.artworkExpiresAt <= now;
  const pendingArtworkIds = new Set(owned?.pendingArtworkIds);
  const artworks = { ...owned?.artworks };
  if (expired) for (const [id, artwork] of Object.entries(artworks)) {
    if (artwork?.source === "catalog") { artworks[id] = { source: "neutral", version: 1 }; pendingArtworkIds.add(id); }
  }
  pendingArtworkIds.delete(saved.cardId);
  if (saved.summary.brand !== "other" && (!saved.artwork || saved.artwork.source === "neutral")) pendingArtworkIds.add(saved.cardId);
  return {
    ownerId: ownerId,
    epoch,
    cards: [...(owned?.cards ?? []).filter((item) => item.cardId !== saved.cardId), saved.summary],
    cardholderNames: { ...owned?.cardholderNames, [saved.cardId]: saved.cardholderName },
    artworks: { ...artworks, [saved.cardId]: saved.artwork },
    pendingArtworkIds,
    // A fresh save may start a lease after clearing expired
    // old images; it must never extend those old approvals.
    artworkExpiresAt: expired ? now + 60_000 : owned.artworkExpiresAt,
  };
}

/** Revoke the captured display or the matching persisted artwork reference. */
export function rejectPresentationArtwork(
  previous: WalletPresentationState,
  captured: WalletPresentationState,
  references: readonly WalletArtworkRejection[],
): WalletPresentationState {
  const artworks = { ...previous.artworks }, pendingArtworkIds = new Set(previous.pendingArtworkIds);
  for (const reference of references) {
    const current = artworks[reference.cardId];
    // A read-only cleaned revision still depends on the persisted
    // source approval. Its displayed digest differs from that source.
    const capturedDisplay = current === captured.artworks[reference.cardId];
    const sameReference = current?.source === "catalog" && current.assetId === reference.assetId && current.digest === reference.digest;
    if (current?.source !== "catalog" || (!capturedDisplay && !sameReference)) continue;
    artworks[reference.cardId] = { source: "neutral", version: 1 }; pendingArtworkIds.delete(reference.cardId);
  }
  return { ...previous, artworks, pendingArtworkIds };
}
