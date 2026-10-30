import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

/** Owner-only encrypted branch. Never include artwork in sharing/agent projections. */
export type WalletCardArtwork =
  | { source: "neutral"; version: 1 }
  | { source: "catalog"; version: 1; assetId: string; catalogVersion: string; issuerId: string; productId: string; variantId: string; image: string; digest: string; allowOverlay: boolean; evidence: "owner_selected" | "provider_exact" | "network_assigned"; providerId?: string; artworkVersion?: string }
  | { source: "photo"; version: 1; image: string; digest: string; sanitizerVersion: 1 };
export interface WalletArtworkVariant {
  assetId: string; issuerId: string; productId: string; variantId: string;
  label: string; image: string; digest: string; allowOverlay: boolean;
  issuerName?: string; productName?: string; variantName?: string; country?: string;
  providerId?: string; artworkVersion?: string; width?: number; height?: number;
  /** Reviewed same-design revisions for private unused-image allocation only. */
  replaces?: readonly { assetId: string; digest: string }[];
}
export type WalletArtworkReference = Pick<Extract<WalletCardArtwork, { source: "catalog" }>, "assetId" | "issuerId" | "productId" | "variantId" | "digest" | "catalogVersion">;
export interface WalletArtworkResolution {
  catalogVersion: string;
  match: "exact" | "ambiguous" | "issuer_only" | "unknown";
  provider: "configured" | "unconfigured" | "unavailable";
  issuerId: string | null;
  identification?: "network" | "issuer" | "product_family" | "product" | "variant";
  variants: WalletArtworkVariant[];
  metadata?: { issuerName?: string; country?: string; productFamily?: string; cardType?: "credit" | "debit" | "prepaid"; tier?: string };
}
const inspected = new WeakMap<Blob, { userId: string; epoch: number; owner: NonNullable<ReturnType<typeof snapshotValidatedAuthSessionOwner>> }>();
/** Only the owned scan supervisor registers its inspected worker result. */
export function registerInspectedWalletPhoto(blob: Blob, userId: string, epoch: number): void {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner || owner.userId !== userId || !isVaultSessionEpochCurrent(epoch)) throw new Error("Wallet changed.");
  inspected.set(blob, { userId, epoch, owner });
}
const approvals = new WeakMap<WalletCardArtwork, { userId: string; epoch: number; owner: NonNullable<ReturnType<typeof snapshotValidatedAuthSessionOwner>> }>();
export const MAX_CARD_ARTWORK_BYTES = 512 * 1024;
export const MAX_WALLET_ARTWORK_CHARACTERS = 2_000_000;

/** Explicit approval is bound to the exact final raster bytes and owner epoch. */
export async function approveWalletPhoto(blob: Blob, userId: string): Promise<WalletCardArtwork> {
  const inspection = inspected.get(blob);
  if (!inspection || inspection.userId !== userId || !isVaultSessionEpochCurrent(inspection.epoch) || !isValidatedAuthSessionOwnerCurrent(inspection.owner)) throw new Error("Inspect the photo before approval.");
  const epoch = inspection.epoch;
  if (blob.type !== "image/png" || blob.size > MAX_CARD_ARTWORK_BYTES) throw new Error("Choose neutral artwork; this image is too large.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  if (!isVaultSessionEpochCurrent(epoch) || !isValidatedAuthSessionOwnerCurrent(inspection.owner)) throw new Error("Wallet changed.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const artwork: WalletCardArtwork = Object.freeze({ source: "photo", version: 1, sanitizerVersion: 1, image: `data:image/png;base64,${btoa(binary)}`, digest });
  approvals.set(artwork, { userId, epoch, owner: inspection.owner }); return artwork;
}

export function assertWalletArtworkApproval(artwork: WalletCardArtwork, userId: string): void {
  if (artwork.source === "neutral") return;
  const approval = approvals.get(artwork);
  if (!approval || approval.userId !== userId || !isVaultSessionEpochCurrent(approval.epoch) || !isValidatedAuthSessionOwnerCurrent(approval.owner)) throw new Error("Review and approve the photo again.");
}

export function approveWalletCatalogArtwork(artwork: Extract<WalletCardArtwork, { source: "catalog" }>, userId: string, epoch: number): WalletCardArtwork {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner || owner.userId !== userId || !isVaultSessionEpochCurrent(epoch)) throw new Error("Wallet changed.");
  const approved = Object.freeze(artwork); approvals.set(approved, { userId, epoch, owner }); return approved;
}

/** Read allowlist: never spread untrusted encrypted records into presentation. */
export function readWalletArtwork(value: unknown): WalletCardArtwork | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return undefined;
  if (row.source === "neutral") return { source: "neutral", version: 1 };
  if (row.source === "photo" && row.sanitizerVersion === 1 && typeof row.image === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(row.image) && row.image.length <= MAX_CARD_ARTWORK_BYTES * 1.4 && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)) return { source: "photo", version: 1, sanitizerVersion: 1, image: row.image, digest: row.digest };
  if (row.source === "catalog" && ["assetId", "catalogVersion", "issuerId", "productId", "variantId"].every(key => typeof row[key] === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(row[key] as string)) && typeof row.image === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(row.image) && row.image.length <= MAX_CARD_ARTWORK_BYTES * 1.4 && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest) && typeof row.allowOverlay === "boolean") return { source: "catalog", version: 1, assetId: row.assetId as string, catalogVersion: row.catalogVersion as string, issuerId: row.issuerId as string, productId: row.productId as string, variantId: row.variantId as string, image: row.image, digest: row.digest, allowOverlay: row.allowOverlay, evidence: row.evidence === "provider_exact" ? "provider_exact" : row.evidence === "network_assigned" ? "network_assigned" : "owner_selected", ...(typeof row.providerId === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(row.providerId) ? { providerId: row.providerId } : {}), ...(typeof row.artworkVersion === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(row.artworkVersion) ? { artworkVersion: row.artworkVersion } : {}) };
  return undefined;
}
