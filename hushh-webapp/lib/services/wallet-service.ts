/**
 * Wallet service - the single boundary for the reserved `wallet`
 * PKM domain. All storage rides PersonalKnowledgeModelService (client-side
 * AES-256-GCM under the vault key; the server holds ciphertext only), so this
 * credential storage never bypasses that service. Network metadata alone uses
 * the owner-authorized Wallet backend.
 *
 * Domain data shape (inside the encrypted blob):
 *   { summary: { [cardId]: WalletCardSummaryRecord },
 *     secrets: { [cardId]: WalletCardSecretsRecord } }
 *
 * Distinct from the Wallet Profile (`wallet-card-service.ts`), which is a
 * public identity pass and never holds payment credentials.
 */

import {
  isCardNetworkId,
  normalizePan,
  validateCardForRegion,
  type CardBrand,
  type CardValidationResult,
} from "@/lib/wallet/card-validation";
import { approveWalletCatalogArtwork, assertWalletArtworkApproval, readWalletArtwork, MAX_WALLET_ARTWORK_CHARACTERS, type WalletCardArtwork, type WalletArtworkResolution, type WalletArtworkVariant, type WalletArtworkReference } from "@/lib/wallet/card-artwork";
import { validateCardImage } from "@/lib/wallet/card-scan-image";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";
import { readWalletSecurityCode } from "@/lib/wallet/card-security-code";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export const WALLET_DOMAIN = "wallet";

export interface WalletCardSummary {
  cardId: string;
  nickname: string;
  brand: CardBrand;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  issuingRegion: string;
  createdAt: string;
}

export interface WalletCardSecrets {
  pan: string;
  cardholderName: string;
}

export interface WalletCardInput {
  nickname?: string;
  brand?: CardBrand;
  pan: string;
  /** Stable logical save identity, retained across uncertain responses. */
  draftId?: string;
  artwork?: WalletCardArtwork;
  cardholderName: string;
  /** Owner Wallet manual entry only; never part of getCard or sharing. */
  securityCode?: string;
  expiryMonth: number;
  expiryYear: number;
  issuingRegion?: string;
}

class WalletNetworkSessionChangedError extends Error {}

const exactArtworkProofs = new WeakMap<WalletArtworkVariant, { userId: string; token: string; epoch: number; catalogVersion: string }>();

/** One bounded operation on web and native; late completions lose authority. */
async function artworkDeadline<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Artwork unavailable.")); }, 8000);
  });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); controller.abort(); }
}

export interface WalletNetworkContext { userId: string; vaultOwnerToken: string }
export interface WalletBankChoice { bankKey: string; issuerId: string; name: string; country: string; designCount: number }
export interface WalletBankDesignRequest { network: CardBrand; country?: string; bankKey?: string; offset?: number; automatic?: boolean }
export interface WalletBankDesigns { catalogVersion: string; banks: WalletBankChoice[]; variants: WalletArtworkVariant[]; nextOffset: number | null }
export interface WalletNetworkInput { iinPrefix: string; panLength: number; selectedNetwork?: CardBrand }
export interface WalletNetworkResult {
  network: CardBrand;
  source: "prefix" | "owner_selected" | "ambiguous" | "unknown";
  candidates: CardBrand[];
}

function normalizedNetwork(value: unknown): CardBrand {
  const key = String(value ?? "").trim().toLowerCase() as CardBrand;
  return isCardNetworkId(key) ? key : "other";
}

function networkSessionGuard(context: WalletNetworkContext, signal?: AbortSignal): () => void {
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  return () => {
    const user = AuthService.getCurrentUser();
    if (!owner || owner.userId !== context.userId || !isValidatedAuthSessionOwnerCurrent(owner) ||
        !isVaultSessionEpochCurrent(epoch) || (user && user.uid !== context.userId)) {
      throw new WalletNetworkSessionChangedError("Wallet changed.");
    }
    if (signal?.aborted) throw new DOMException("Network request cancelled.", "AbortError");
  };
}

/** An acknowledged sent-copy receipt, not a revocable Wallet access grant. */
export interface WalletCardShareReceipt {
  messageId: string; conversationId: string; recipientPersonRef: string;
  recipientName: string; sentAt: string;
}

/** Owner-only display projection. Never pass this to agent/chat summary callers. */
export interface WalletCardPresentation {
  summary: WalletCardSummary;
  cardholderName: string;
  artwork?: WalletCardArtwork;
}
export interface WalletArtworkRejection { cardId: string; assetId: string; digest: string }

interface VaultContextParams {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ArtworkDisplayApproval {
  approved: boolean;
  allowOverlay: boolean;
  replacement?: { catalogVersion: string; variant: WalletArtworkVariant };
}

function toSummary(cardId: string, value: unknown): WalletCardSummary | null {
  if (!isRecord(value)) return null;
  return {
    cardId,
    nickname: String(value.nickname ?? ""),
    brand: normalizedNetwork(value.brand),
    last4: String(value.last4 ?? ""),
    expiryMonth: Number(value.expiry_month ?? 0),
    expiryYear: Number(value.expiry_year ?? 0),
    issuingRegion: String(value.issuing_region ?? ""),
    createdAt: String(value.created_at ?? ""),
  };
}

function summariesFromDomain(data: Record<string, unknown> | null): WalletCardSummary[] {
  const branch = isRecord(data?.summary) ? data.summary : {};
  return Object.entries(branch)
    .map(([cardId, value]) => toSummary(cardId, value))
    .filter((entry): entry is WalletCardSummary => entry !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.cardId.localeCompare(b.cardId));
}

/** Allocation uses the current decrypted snapshot, including after a CAS conflict. */
function chooseUnusedWalletArtwork(data: Record<string, unknown> | null, inputPan: string, candidates: readonly WalletArtworkVariant[], reserved?: ReadonlyMap<string, number>): WalletArtworkVariant | null {
  const sorted = [...candidates].sort((a, b) => a.assetId.localeCompare(b.assetId));
  const seen = new Set<string>();
  const unique = sorted.filter(row => { if (seen.has(row.digest)) return false; seen.add(row.digest); return true; });
  if (!unique.length) return null;
  const counts = new Map(unique.map(row => [row.digest, reserved?.get(row.digest) ?? 0]));
  const artwork = isRecord(data?.artwork) ? data.artwork : {}, secrets = isRecord(data?.secrets) ? data.secrets : {};
  const pan = normalizePan(inputPan);
  for (const [cardId, record] of Object.entries(artwork)) {
    const chosen = readWalletArtwork(record);
    if (chosen?.source !== "catalog") continue;
    const candidate = sorted.find(row => row.issuerId === chosen.issuerId && row.productId === chosen.productId && row.variantId === chosen.variantId && ((row.assetId === chosen.assetId && row.digest === chosen.digest) || row.replaces?.some(old => old.assetId === chosen.assetId && old.digest === chosen.digest)));
    const secret = secrets[cardId];
    if (candidate && pan.length >= 13 && isRecord(secret) && normalizePan(String(secret.pan ?? "")) === pan) return candidate;
    // Retired aliases still occupy these pixels in the owner's collection.
    const occupied = candidate?.digest ?? chosen.digest;
    if (counts.has(occupied)) counts.set(occupied, counts.get(occupied)! + 1);
  }
  return unique.reduce((least, row) => counts.get(row.digest)! < counts.get(least.digest)! ? row : least);
}

export class WalletService {
  private static saveIdentities = new Map<string, Promise<string>>();
  private static identityEpoch = -1;
  static isEnabled(): boolean {
    return true;
  }

  private static async networkRequest(context: WalletNetworkContext, suffix: string, signal?: AbortSignal, input?: WalletNetworkInput | WalletBankDesignRequest, path = "/networks"): Promise<unknown> {
    const assertCurrent = networkSessionGuard(context, signal);
    assertCurrent();
    const token = await AuthService.getIdTokenWithRetry({ expectedUserId: context.userId });
    assertCurrent();
    if (!token) throw new Error("Network identification unavailable.");
    const response = await ApiService.apiFetch(`/api/one/wallet/card-access${path}${suffix}`, {
      method: input ? "POST" : "GET", cache: "no-store", signal,
      isEffectCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
      headers: { Authorization: `Bearer ${token}`, "X-Hushh-Consent": context.vaultOwnerToken, "Content-Type": "application/json" },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    assertCurrent();
    if (!response.ok) throw new Error("Network identification unavailable.");
    const data = await response.json();
    assertCurrent();
    return data;
  }

  static async supportedCardNetworks(context: WalletNetworkContext, signal?: AbortSignal): Promise<CardBrand[]> {
    const data = await this.networkRequest(context, "", signal);
    if (!isRecord(data) || !Array.isArray(data.networks)) throw new Error("Network identification unavailable.");
    if (!data.networks.length || !data.networks.every(isCardNetworkId)) throw new Error("Network identification unavailable.");
    return [...new Set(data.networks)];
  }

  static async resolveCardNetwork(context: WalletNetworkContext, input: WalletNetworkInput, signal?: AbortSignal): Promise<WalletNetworkResult> {
    // Construct the wire object explicitly; never serialize a card or vault key.
    if (!/^[0-9]{6}$/.test(input.iinPrefix) || !Number.isInteger(input.panLength) || input.panLength < 12 || input.panLength > 19) throw new Error("Network identification unavailable.");
    const payload = { iinPrefix: input.iinPrefix, panLength: input.panLength, ...(input.selectedNetwork ? { selectedNetwork: input.selectedNetwork } : {}) };
    const data = await this.networkRequest(context, "/resolve", signal, payload);
    if (!isRecord(data) || typeof data.network !== "string" || !isCardNetworkId(data.network.trim().toLowerCase())) throw new Error("Network identification unavailable.");
    const source = data.source;
    if (!["prefix", "owner_selected", "ambiguous", "unknown"].includes(String(source))) throw new Error("Network identification unavailable.");
    return { network: normalizedNetwork(data.network), source: source as WalletNetworkResult["source"], candidates: Array.isArray(data.candidates) ? data.candidates.map(normalizedNetwork).filter(value => value !== "other") : [] };
  }

  static validateCard(input: WalletCardInput): CardValidationResult {
    return validateCardForRegion({
      pan: input.pan,
      brand: input.brand,
      cardholderName: input.cardholderName,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      issuingRegion: input.issuingRegion,
      securityCode: input.securityCode,
    });
  }

  /** Cosmetic bank choices disclose no card number, prefix or saved-card IDs. */
  static async bankArtwork(context: WalletNetworkContext, input: WalletBankDesignRequest, signal?: AbortSignal): Promise<WalletBankDesigns> {
    if ((input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 10000)) || !isCardNetworkId(input.network) || (input.country && !/^[A-Z]{2}$/.test(input.country)) || (input.bankKey && !/^[a-f0-9]{32}$/.test(input.bankKey))) throw new Error("Bank designs unavailable.");
    const payload = { network: input.network, ...(input.country ? { country: input.country } : {}), ...(input.bankKey ? { bankKey: input.bankKey } : {}), ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.automatic ? { automatic: true } : {}) };
    const data = await this.networkRequest(context, "/banks", signal, payload, "/artwork");
    const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(v);
    const text = (v: unknown) => typeof v === "string" && Boolean(v.trim()) && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v);
    if (!isRecord(data) || data.selectionBasis !== (input.automatic ? "network_illustration" : "owner_selected_bank") || data.requiresConfirmation !== !input.automatic || (input.automatic && (data.network !== input.network || input.bankKey || (Array.isArray(data.banks) && data.banks.length))) || !id(data.catalogVersion) || data.bankKey !== (input.bankKey ?? null) || !Array.isArray(data.banks) || data.banks.length > 1000 || !Array.isArray(data.variants) || data.variants.length > 24 || !(data.nextOffset === null || (Number.isInteger(data.nextOffset) && Number(data.nextOffset) > (input.offset ?? 0) && Number(data.nextOffset) <= 10000))) throw new Error("Bank designs unavailable.");
    const banks: WalletBankChoice[] = data.banks.map(row => {
      if (!isRecord(row) || (input.country && row.country !== input.country) || typeof row.bankKey !== "string" || !/^[a-f0-9]{32}$/.test(row.bankKey) || !id(row.issuerId) || !text(row.name) || typeof row.country !== "string" || !/^[A-Z]{2}$/.test(row.country) || !Number.isInteger(row.designCount) || Number(row.designCount) < 1 || Number(row.designCount) > 10000) throw new Error("Bank designs unavailable.");
      return { bankKey: row.bankKey, issuerId: String(row.issuerId), name: String(row.name), country: row.country, designCount: Number(row.designCount) };
    });
    if (new Set(banks.map(row => row.bankKey)).size !== banks.length) throw new Error("Bank designs unavailable.");
    const bank = banks.find(row => row.bankKey === input.bankKey);
    const variants: WalletArtworkVariant[] = data.variants.map(row => {
      if (!isRecord(row) || (!input.automatic && (!bank || row.issuerId !== bank.issuerId)) || ![row.assetId, row.issuerId, row.productId, row.variantId].every(id) || !text(row.label) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest) || row.image !== `/api/one/wallet/card-access/artwork/assets/${row.digest}` || typeof row.allowOverlay !== "boolean") throw new Error("Bank designs unavailable.");
      if (row.replaces !== undefined && (!Array.isArray(row.replaces) || row.replaces.length > 24 || !row.replaces.every(old => isRecord(old) && id(old.assetId) && old.assetId !== row.assetId && typeof old.digest === "string" && /^[a-f0-9]{64}$/.test(old.digest) && old.digest !== row.digest))) throw new Error("Bank designs unavailable.");
      return { assetId: String(row.assetId), issuerId: String(row.issuerId), productId: String(row.productId), variantId: String(row.variantId), label: String(row.label), digest: row.digest, image: String(row.image), allowOverlay: row.allowOverlay, issuerName: bank?.name ?? (text(row.issuerName) ? String(row.issuerName) : String(row.issuerId)), productName: text(row.productName) ? String(row.productName) : String(row.label), variantName: text(row.variantName) ? String(row.variantName) : "Bank design", country: bank?.country ?? (typeof row.country === "string" && /^[A-Z]{2}$/.test(row.country) ? row.country : undefined), ...(Array.isArray(row.replaces) ? { replaces: row.replaces as { assetId: string; digest: string }[] } : {}) };
    });
    if (new Set(variants.map(row => row.assetId)).size !== variants.length) throw new Error("Bank designs unavailable.");
    return { catalogVersion: String(data.catalogVersion), banks, variants, nextOffset: data.nextOffset as number | null };
  }

  /** Local-only allocation from the encrypted domain. Never identify by last4. */
  static async suggestBankArtwork(params: VaultContextParams & { pan: string; variants: readonly WalletArtworkVariant[]; signal?: AbortSignal }): Promise<WalletArtworkVariant | null> {
    const assertCurrent = networkSessionGuard(params, params.signal); assertCurrent();
    const candidates = [...params.variants].sort((a, b) => a.assetId.localeCompare(b.assetId));
    if (!candidates.length || new Set(candidates.map(row => row.issuerId)).size !== 1) return null;
    const data = await this.loadDomain(params); assertCurrent();
    return chooseUnusedWalletArtwork(data, params.pan, candidates);
  }

  /** Approved network illustrations only; no bank inference or card identity on wire. */
  static async networkArtwork(context: WalletNetworkContext, network: CardBrand, signal?: AbortSignal): Promise<{ catalogVersion: string; variants: WalletArtworkVariant[] }> {
    if (network === "other") return { catalogVersion: "empty", variants: [] };
    return artworkDeadline(signal, async bounded => {
      const variants: WalletArtworkVariant[] = [];
      let catalogVersion = "", offset: number | null = 0;
      while (offset !== null) {
        const page = await this.bankArtwork(context, { network, automatic: true, offset }, bounded);
        if (catalogVersion && catalogVersion !== page.catalogVersion) throw new Error("Artwork changed.");
        catalogVersion = page.catalogVersion;
        variants.push(...page.variants);
        if (variants.length > 256 || new Set(variants.map(row => row.assetId)).size !== variants.length) throw new Error("Artwork unavailable.");
        offset = page.nextOffset;
      }
      return { catalogVersion, variants };
    });
  }

  static async resolveCardArtwork(context: WalletNetworkContext, input: WalletNetworkInput, signal?: AbortSignal): Promise<WalletArtworkResolution> {
    if (!/^(?:[0-9]{6}|[0-9]{8})$/.test(input.iinPrefix) || !Number.isInteger(input.panLength) || input.panLength < 13 || input.panLength > 19) throw new Error("Artwork unavailable.");
    const payload = { iinPrefix: input.iinPrefix, panLength: input.panLength, ...(input.selectedNetwork ? { selectedNetwork: input.selectedNetwork } : {}) };
    const data = await artworkDeadline(signal, bounded => this.networkRequest(context, "/resolve", bounded, payload, "/artwork"));
    if (!isRecord(data) || !["exact", "ambiguous", "issuer_only", "unknown"].includes(String(data.match)) || !Array.isArray(data.variants) || typeof data.catalogVersion !== "string") throw new Error("Artwork unavailable.");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(data.catalogVersion) || data.variants.length > 30) throw new Error("Artwork unavailable.");
    const variants: WalletArtworkVariant[] = data.variants.map(value => {
      if (!isRecord(value) || !["assetId", "issuerId", "productId", "variantId"].every(key => typeof value[key] === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value[key] as string)) || typeof value.label !== "string" || !value.label.trim() || value.label.length > 100 || /[\u0000-\u001f\u007f]/.test(value.label) || !/^[a-f0-9]{64}$/.test(String(value.digest)) || value.image !== `/api/one/wallet/card-access/artwork/assets/${value.digest}` || typeof value.allowOverlay !== "boolean") throw new Error("Artwork unavailable.");
      const variant: WalletArtworkVariant = { assetId: value.assetId as string, issuerId: value.issuerId as string, productId: value.productId as string, variantId: value.variantId as string, label: value.label, image: value.image as string, digest: value.digest as string, allowOverlay: value.allowOverlay };
      for (const key of ["issuerName", "productName", "variantName"] as const) if (typeof value[key] === "string" && value[key].trim() && value[key].length <= 100 && !/[\u0000-\u001f\u007f]/.test(value[key])) variant[key] = value[key];
      for (const key of ["providerId", "artworkVersion"] as const) if (typeof value[key] === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value[key])) variant[key] = value[key];
      if (typeof value.country === "string" && /^[A-Z]{2}$/.test(value.country)) variant.country = value.country;
      for (const key of ["width", "height"] as const) if (typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 2048) variant[key] = value[key];
      return Object.freeze(variant);
    });
    if (data.match === "exact") {
      if (data.provider !== "configured" || variants.length !== 1) throw new Error("Artwork unavailable.");
      exactArtworkProofs.set(variants[0]!, { userId: context.userId, token: context.vaultOwnerToken, epoch: snapshotVaultSessionEpoch(), catalogVersion: data.catalogVersion });
    }
    const metadata: NonNullable<WalletArtworkResolution["metadata"]> = {};
    if (isRecord(data.metadata)) {
      for (const key of ["issuerName", "productFamily", "tier"] as const) { const value = data.metadata[key]; if (typeof value === "string" && value.trim() && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value)) metadata[key] = value; }
      if (typeof data.metadata.country === "string" && /^[A-Z]{2}$/.test(data.metadata.country)) metadata.country = data.metadata.country;
      if (["credit", "debit", "prepaid"].includes(String(data.metadata.cardType))) metadata.cardType = data.metadata.cardType as "credit" | "debit" | "prepaid";
    }
    return { catalogVersion: data.catalogVersion, match: data.match as WalletArtworkResolution["match"], issuerId: typeof data.issuerId === "string" ? data.issuerId : null, provider: ["configured", "unconfigured", "unavailable"].includes(String(data.provider)) ? data.provider as WalletArtworkResolution["provider"] : "unavailable", variants, metadata };
  }

  static async selectCardArtwork(context: WalletNetworkContext, variant: WalletArtworkVariant, catalogVersion: string, signal?: AbortSignal): Promise<WalletCardArtwork> {
    const epoch = snapshotVaultSessionEpoch();
    const artwork = await artworkDeadline(signal, bounded => this.readCatalogArtwork(context, variant, catalogVersion, bounded));
    const proof = exactArtworkProofs.get(variant);
    const evidence = proof && proof.userId === context.userId && proof.token === context.vaultOwnerToken && proof.epoch === epoch && proof.catalogVersion === catalogVersion ? "provider_exact" : "owner_selected";
    return approveWalletCatalogArtwork({ ...artwork, evidence }, context.userId, epoch);
  }

  /** A thumbnail is validated but is never an owner approval to persist artwork. */
  static async previewCardArtwork(context: WalletNetworkContext, variant: WalletArtworkVariant, catalogVersion: string, signal?: AbortSignal): Promise<string> {
    return (await artworkDeadline(signal, bounded => this.readCatalogArtwork(context, variant, catalogVersion, bounded))).image;
  }

  private static async readCatalogArtwork(context: WalletNetworkContext, variant: WalletArtworkVariant, catalogVersion: string, signal: AbortSignal): Promise<Extract<WalletCardArtwork, { source: "catalog" }>> {
    const assertCurrent = networkSessionGuard(context, signal); assertCurrent();
    if (!/^\/api\/one\/wallet\/card-access\/artwork\/assets\/[a-f0-9]{64}$/.test(variant.image)) throw new Error("Artwork unavailable.");
    const reference: WalletArtworkReference = { assetId: variant.assetId, issuerId: variant.issuerId, productId: variant.productId, variantId: variant.variantId, digest: variant.digest, catalogVersion };
    const approval = await this.validateArtworkReferences(context, [reference], signal);
    if (!approval[0]?.approved) throw new Error("Artwork unavailable.");
    const token = await AuthService.getIdTokenWithRetry({ expectedUserId: context.userId }); assertCurrent();
    if (!token) throw new Error("Artwork unavailable.");
    const response = await ApiService.apiFetch(variant.image, { responseType: "arraybuffer", cache: "no-store", signal, headers: { Authorization: `Bearer ${token}`, "X-Hushh-Consent": context.vaultOwnerToken }, isEffectCurrent: () => { try { assertCurrent(); return true; } catch { return false; } } });
    assertCurrent(); if (!response.ok) throw new Error("Artwork unavailable.");
    const blob = await response.blob(); assertCurrent();
    if (blob.size > 512 * 1024) throw new Error("Artwork unavailable.");
    await validateCardImage(blob); assertCurrent();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    assertCurrent(); if (digest !== variant.digest) throw new Error("Artwork unavailable.");
    let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    // Revalidate metadata after download too; a changed approval cannot ride
    // along on an unchanged image digest.
    const finalApproval = await this.validateArtworkReferences(context, [reference], signal); assertCurrent();
    if (!finalApproval[0]?.approved) throw new Error("Artwork unavailable.");
    return { source: "catalog", version: 1, assetId: variant.assetId, issuerId: variant.issuerId, productId: variant.productId, variantId: variant.variantId, catalogVersion, digest, image: `data:${blob.type};base64,${btoa(binary)}`, allowOverlay: finalApproval[0].allowOverlay, evidence: "owner_selected", ...(variant.providerId ? { providerId: variant.providerId } : {}), ...(variant.artworkVersion ? { artworkVersion: variant.artworkVersion } : {}) };
  }

  /** Display status only: never creates a persistence approval. */
  static async checkCardArtworkDisplay(context: WalletNetworkContext, reference: WalletArtworkReference, signal?: AbortSignal, purpose: "selection" | "saved" = "selection"): Promise<boolean> {
    return Boolean((await artworkDeadline(signal, bounded => this.validateArtworkReferences(context, [reference], bounded, purpose)))[0]?.approved);
  }

  private static async validateArtworkReferences(context: WalletNetworkContext, artworks: WalletArtworkReference[], signal?: AbortSignal, purpose: "selection" | "saved" = "selection"): Promise<ArtworkDisplayApproval[]> {
    const assertCurrent = networkSessionGuard(context, signal); assertCurrent();
    const token = await AuthService.getIdTokenWithRetry({ expectedUserId: context.userId }); assertCurrent();
    if (!token) throw new Error("Artwork unavailable.");
    const selections = artworks.map(row => ({ assetId: row.assetId, issuerId: row.issuerId, productId: row.productId, variantId: row.variantId, catalogVersion: row.catalogVersion, digest: row.digest }));
    const response = await ApiService.apiFetch("/api/one/wallet/card-access/artwork/validate", { method: "POST", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${token}`, "X-Hushh-Consent": context.vaultOwnerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ selections, purpose }), isEffectCurrent: () => { try { assertCurrent(); return true; } catch { return false; } } });
    assertCurrent(); if (!response.ok) throw new Error("Artwork unavailable.");
    const result = await response.json(); assertCurrent();
    if (!Array.isArray(result.selections) || result.selections.length !== selections.length || !result.selections.every((row: unknown, index: number) => isRecord(row) && row.assetId === selections[index]!.assetId && typeof row.approved === "boolean" && typeof row.allowOverlay === "boolean")) throw new Error("Artwork unavailable.");
    return result.selections.map((row: Record<string, unknown>, index: number) => {
      const approval: ArtworkDisplayApproval = { approved: row.approved as boolean, allowOverlay: row.allowOverlay as boolean };
      if (row.replacement === undefined) return approval;
      const replacement = row.replacement, source = artworks[index]!;
      if (!approval.approved || purpose !== "saved" || !isRecord(replacement) || typeof replacement.catalogVersion !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(replacement.catalogVersion) || !isRecord(replacement.variant)) throw new Error("Artwork unavailable.");
      const variant = replacement.variant;
      if (typeof variant.assetId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(variant.assetId) || variant.assetId === source.assetId || variant.issuerId !== source.issuerId || variant.productId !== source.productId || variant.variantId !== source.variantId || typeof variant.digest !== "string" || !/^[a-f0-9]{64}$/.test(variant.digest) || variant.digest === source.digest || variant.image !== `/api/one/wallet/card-access/artwork/assets/${variant.digest}` || typeof variant.allowOverlay !== "boolean" || typeof variant.label !== "string" || !variant.label.trim() || variant.label.length > 100 || /[\u0000-\u001f\u007f]/.test(variant.label) || variant.providerId) throw new Error("Artwork unavailable.");
      approval.replacement = { catalogVersion: replacement.catalogVersion, variant: { assetId: variant.assetId, issuerId: source.issuerId, productId: source.productId, variantId: source.variantId, digest: variant.digest, image: variant.image as string, label: variant.label, allowOverlay: variant.allowOverlay } };
      return approval;
    });
  }

  /** Change design atomically, preserving card identity, details, history and grants. */
  static async updateCardArtwork(params: VaultContextParams & { cardId: string; artwork: WalletCardArtwork; isCurrent?: () => boolean }): Promise<void> {
    const ownerGuard = networkSessionGuard(params);
    const assertCurrent = () => { ownerGuard(); if (params.isCurrent && !params.isCurrent()) throw new Error("Wallet changed."); };
    assertCurrent();
    assertWalletArtworkApproval(params.artwork, params.userId);
    if (params.artwork.source === "catalog") {
      const approval = await artworkDeadline(undefined, signal => this.validateArtworkReferences(params, [params.artwork as Extract<WalletCardArtwork, { source: "catalog" }>], signal));
      assertCurrent();
      if (!approval[0]?.approved || approval[0].allowOverlay !== params.artwork.allowOverlay) throw new Error("Artwork approval changed. Choose your design again.");
    }
    await PersonalKnowledgeModelService.storeWalletDomain({ ...params, scopePath: "summary",
      explanation: "The owner confirmed changing their card design.",
      confirmation: { confirmedByUser: true, surface: "web", source: "one_wallet_artwork_change" },
      mayPublish: () => { try { assertCurrent(); return true; } catch { return false; } },
      applyMutation: base => {
        assertCurrent(); assertWalletArtworkApproval(params.artwork, params.userId);
        if (!isRecord(base.summary) || !isRecord(base.summary[params.cardId])) throw new Error("Card unavailable.");
        const artwork = { ...(isRecord(base.artwork) ? base.artwork : {}), [params.cardId]: params.artwork };
        if (JSON.stringify(artwork).length > MAX_WALLET_ARTWORK_CHARACTERS) throw new Error("Artwork storage is full.");
        return { ...base, artwork };
      },
    }); assertCurrent();
  }

  static async cardArtworkLookupInput(params: VaultContextParams & { cardId: string }): Promise<WalletNetworkInput> {
    const card = await this.getCard(params);
    if (!card) throw new Error("Card unavailable.");
    return { iinPrefix: card.secrets.pan.slice(0, 8), panLength: card.secrets.pan.length };
  }

  private static async loadDomain(
    params: VaultContextParams,
  ): Promise<Record<string, unknown> | null> {
    const assertCurrent = networkSessionGuard(params);
    assertCurrent();
    const data = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      domain: WALLET_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    });
    assertCurrent();
    if (data !== null && !isRecord(data)) {
      throw new Error("Your saved cards could not be read. Please try again.");
    }
    return data;
  }

  static async listCardSummaries(
    params: VaultContextParams,
  ): Promise<WalletCardSummary[]> {
    const data = await this.loadDomain(params);
    return summariesFromDomain(data);
  }

  /** One decrypted read for the unlocked owner UI; credentials never leave this service. */
  static async listCardPresentations(
    params: VaultContextParams,
    options?: { recoverArtwork?: boolean; failOnArtworkUnavailable?: boolean; onArtworkRejected?: (references: readonly WalletArtworkRejection[]) => void },
  ): Promise<WalletCardPresentation[]> {
    const assertCurrent = networkSessionGuard(params); assertCurrent();
    const data = await this.loadDomain(params);
    const secrets = isRecord(data?.secrets) ? data.secrets : {};
    const storedArtwork = isRecord(data?.artwork) ? data.artwork : {};
    const presentations: WalletCardPresentation[] = summariesFromDomain(data).map((summary) => {
      const cardSecrets = secrets[summary.cardId];
      return {
        summary,
        artwork: readWalletArtwork(storedArtwork[summary.cardId]),
        cardholderName: isRecord(cardSecrets) ? String(cardSecrets.cardholder_name ?? "") : "",
      };
    });
    const catalogCards = presentations.filter(row => row.artwork?.source === "catalog");
    // Decide recovery from the saved record, before hiding unapproved copies.
    // A withdrawn catalog design must never become a fresh automatic choice.
    const recoverable = options?.recoverArtwork ? presentations.filter(row => {
      const saved = storedArtwork[row.summary.cardId];
      return row.summary.brand !== "other" && (saved === undefined || (isRecord(saved) && saved.source === "neutral"));
    }) : [];
    const savedReferences = catalogCards.map(row => row.artwork as Extract<WalletCardArtwork, { source: "catalog" }>);
    catalogCards.forEach(row => { row.artwork = { source: "neutral", version: 1 }; });
    if (catalogCards.length || recoverable.length) await artworkDeadline(undefined, async signal => {
      const assertDisplayCurrent = networkSessionGuard(params, signal);
      const downloads = new Set<Promise<void>>();
      const readImage = async (variant: WalletArtworkVariant, version: string) => {
        while (downloads.size >= 4) await Promise.race(downloads);
        assertDisplayCurrent();
        const operation = this.readCatalogArtwork(params, variant, version, signal);
        const settled = operation.then(() => {}, () => {});
        downloads.add(settled);
        try { return await operation; } finally { downloads.delete(settled); }
      };
      const validateSaved = async () => {
        for (let offset = 0; offset < catalogCards.length; offset += 24) {
          const batch = savedReferences.slice(offset, offset + 24);
          const approvals = await this.validateArtworkReferences(params, batch, signal, "saved").catch(error => { if (options?.failOnArtworkUnavailable) throw error; return []; });
          assertDisplayCurrent();
          const rejected = batch.flatMap((artwork, index) => !approvals[index]?.approved ? [{ cardId: catalogCards[offset + index]!.summary.cardId, assetId: artwork.assetId, digest: artwork.digest }] : []);
          if (rejected.length) options?.onArtworkRejected?.(rejected);
          let next = 0;
          const refreshSaved = async () => {
            while (next < batch.length) {
              const index = next++, artwork = batch[index]!, approval = approvals[index];
              if (!approval?.approved) continue;
              const row = catalogCards[offset + index]!;
              if (!approval.replacement) {
                row.artwork = { ...artwork, allowOverlay: approval.allowOverlay };
                continue;
              }
              try {
                const { variant, catalogVersion } = approval.replacement;
                const cleaned = await readImage(variant, catalogVersion);
                // Both ends must still be approved after the binary read. A
                // withdrawn source may never authorize a replacement display.
                const final = (await this.validateArtworkReferences(params, [artwork], signal, "saved"))[0];
                assertDisplayCurrent();
                if (final?.approved && final.replacement?.catalogVersion === catalogVersion && final.replacement.variant.assetId === variant.assetId && final.replacement.variant.digest === variant.digest) {
                  row.artwork = { ...cleaned, allowOverlay: final.replacement.variant.allowOverlay, evidence: artwork.evidence };
                } else options?.onArtworkRejected?.([{ cardId: row.summary.cardId, assetId: artwork.assetId, digest: artwork.digest }]);
              } catch (error) { assertDisplayCurrent(); if (options?.failOnArtworkUnavailable) throw error; }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, batch.length) }, refreshSaved));
        }
      };
      // Read-only display enrichment: no PKM write or persistence approval.
      // Keep allocation local so numbers and saved-card IDs never go on wire.
      const allocation = { ...data, artwork: { ...storedArtwork } };
      const networks = [...new Set(recoverable.map(row => row.summary.brand))];
      let nextNetwork = 0;
      const recoverNetwork = async () => {
        while (nextNetwork < networks.length) {
          const network = networks[nextNetwork++]!;
          try {
            const catalog = await this.networkArtwork(params, network, signal);
            const unavailable = new Set<string>();
            const images = new Map<string, Promise<Extract<WalletCardArtwork, { source: "catalog" }>>>();
            const reserved = new Map<string, number>();
            await Promise.all(recoverable.filter(card => card.summary.brand === network).map(async row => {
              assertDisplayCurrent();
              const secret = secrets[row.summary.cardId];
              const pan = isRecord(secret) ? normalizePan(String(secret.pan ?? "")) : "";
              if (!/^[0-9]{13,19}$/.test(pan)) return;
              while (!signal.aborted) {
                const candidate = chooseUnusedWalletArtwork(allocation, pan, catalog.variants.filter(variant => !unavailable.has(variant.digest)), reserved);
                if (!candidate) break;
                reserved.set(candidate.digest, (reserved.get(candidate.digest) ?? 0) + 1);
                try {
                  let image = images.get(candidate.digest);
                  if (!image) {
                    image = readImage(candidate, catalog.catalogVersion).then(artwork => ({ ...artwork, evidence: "network_assigned" as const }));
                    images.set(candidate.digest, image);
                  }
                  const artwork = await image;
                  assertDisplayCurrent();
                  allocation.artwork[row.summary.cardId] = artwork;
                  row.artwork = artwork;
                  break;
                } catch { assertDisplayCurrent(); unavailable.add(candidate.digest); }
                finally { reserved.set(candidate.digest, (reserved.get(candidate.digest) ?? 1) - 1); }
              }
            }));
          } catch { assertDisplayCurrent(); }
        }
      };
      // At most four concurrent downloads, under one total deadline.
      await Promise.all([validateSaved(), ...Array.from({ length: Math.min(4, networks.length) }, recoverNetwork)]);
      // Decode approved originals before the first card paint. Browser decoding
      // overlaps the remaining hydration instead of starting after a gray face mounts.
      if (typeof Image !== "undefined" && typeof Image.prototype.decode === "function") {
        const images = [...new Set(presentations.flatMap(row => row.artwork?.source === "catalog" ? [row.artwork.image] : []))];
        await Promise.all(images.map(async source => {
          assertDisplayCurrent();
          const image = new Image();
          const cancel = () => { image.src = ""; };
          signal.addEventListener("abort", cancel, { once: true });
          try { image.src = source; await image.decode().catch(() => {}); assertDisplayCurrent(); }
          finally { signal.removeEventListener("abort", cancel); }
        }));
      }
    }).catch(error => { assertCurrent(); if (options?.failOnArtworkUnavailable) throw error; });
    assertCurrent();
    return presentations;
  }

  /** Decrypts one card fully. Call only from a reveal surface; never hand the result to a model. */
  static async getCard(
    params: VaultContextParams & { cardId: string },
  ): Promise<{ summary: WalletCardSummary; secrets: WalletCardSecrets } | null> {
    const data = await this.loadDomain(params);
    const summaryBranch = isRecord(data?.summary) ? data.summary : {};
    const secretsBranch = isRecord(data?.secrets) ? data.secrets : {};
    const summary = toSummary(params.cardId, summaryBranch[params.cardId]);
    const rawSecrets = secretsBranch[params.cardId];
    if (!summary || !isRecord(rawSecrets)) return null;
    return {
      summary,
      secrets: {
        pan: String(rawSecrets.pan ?? ""),
        cardholderName: String(rawSecrets.cardholder_name ?? ""),
      },
    };
  }

  /** Dedicated owner-only action. Shared/chat card readers never receive codes. */
  static async getCardSecurityCode(params: VaultContextParams & { cardId: string }): Promise<string | undefined> {
    const data = await this.loadDomain(params);
    if (!toSummary(params.cardId, isRecord(data?.summary) ? data.summary[params.cardId] : undefined)) return;
    return readWalletSecurityCode(isRecord(data?.secrets) ? data.secrets[params.cardId] : undefined);
  }

  static async addCard(
    params: VaultContextParams & {
      card: WalletCardInput;
      surface: PkmUserConfirmation["surface"];
      source: string;
      reserveCardId?: () => Promise<string | null>;
    },
  ): Promise<{ cardId: string; summary: WalletCardSummary; cardholderName: string; artwork?: WalletCardArtwork }> {
    if (!this.isEnabled()) {
      throw new Error("Payment cards are not enabled in this environment.");
    }
    if (params.card.securityCode && (params.surface !== "web" || params.source !== "one_wallet_add")) throw new Error("Security code write unavailable.");
    const assertCurrent = networkSessionGuard(params);
    assertCurrent();
    const preliminary = this.validateCard(params.card);
    const draftErrors = preliminary.errors.filter(error => error !== "pan_checksum_invalid");
    if (draftErrors.length) throw new Error(`CARD_VALIDATION_FAILED:${draftErrors.join(",")}`);
    let network: CardBrand = "other";
    try {
      network = (await this.resolveCardNetwork(params, { iinPrefix: normalizePan(params.card.pan).slice(0, 6), panLength: normalizePan(params.card.pan).length, selectedNetwork: params.card.brand })).network;
    } catch (error) {
      assertCurrent();
      if (error instanceof WalletNetworkSessionChangedError) throw error;
      // A lookup failure must never substitute a guessed or stale network.
      network = "other";
    }
    assertCurrent();
    const validation = this.validateCard({ ...params.card, brand: network });
    if (!validation.valid) throw new Error(`CARD_VALIDATION_FAILED:${validation.errors.join(",")}`);
    if (params.card.draftId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.card.draftId)) throw new Error("Invalid card draft.");
    const epoch = snapshotVaultSessionEpoch();
    if (this.identityEpoch !== epoch) { this.saveIdentities.clear(); this.identityEpoch = epoch; }
    const draftId = (params.card.draftId || walletOperationId()).toLowerCase();
    const identityKey = `${params.userId}:${draftId}`;
    let identity = this.saveIdentities.get(identityKey);
    if (!identity) {
      if (this.saveIdentities.size >= 64) this.saveIdentities.delete(this.saveIdentities.keys().next().value!);
      identity = (async () => { const reserved = await params.reserveCardId?.(); assertCurrent(); return reserved || `card_${draftId}`; })();
      this.saveIdentities.set(identityKey, identity);
      void identity.catch(() => { if (this.saveIdentities.get(identityKey) === identity) this.saveIdentities.delete(identityKey); });
    }
    const cardId = await identity;
    let artwork = params.card.artwork;
    if (artwork) assertWalletArtworkApproval(artwork, params.userId);
    if (artwork?.source === "catalog") {
      const approval = await artworkDeadline(undefined, signal => this.validateArtworkReferences(params, [artwork as Extract<WalletCardArtwork, { source: "catalog" }>], signal)).catch(() => []);
      assertCurrent();
      if (!approval[0]?.approved || approval[0].allowOverlay !== artwork.allowOverlay) artwork = { source: "neutral", version: 1 };
    }
    assertCurrent();
    let automaticDesigns: Awaited<ReturnType<typeof WalletService.networkArtwork>> | undefined;
    // The Wallet Add writer owns private artwork; chat writers retain their scope.
    const assignAutomatically = !params.card.artwork && params.surface === "web" && params.source === "one_wallet_add";
    if (assignAutomatically && network !== "other") {
      try { automaticDesigns = await this.networkArtwork(params, network); }
      catch { assertCurrent(); }
    }
    assertCurrent();
    const createdAt = new Date().toISOString();
    const summaryRecord = {
      nickname: params.card.nickname?.trim() ?? "",
      brand: validation.brand ?? "other",
      last4: validation.last4,
      expiry_month: params.card.expiryMonth,
      expiry_year: params.card.expiryYear,
      issuing_region: params.card.issuingRegion?.trim().toUpperCase() ?? "",
      created_at: createdAt,
    };
    const secretsRecord = {
      pan: params.card.pan.replace(/[\s-]/g, ""),
      cardholder_name: params.card.cardholderName.trim(),
      ...(params.card.securityCode ? { manual_cvv: params.card.securityCode } : {}),
    };
    await PersonalKnowledgeModelService.storeWalletDomain({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      mayPublish: () => { try { assertCurrent(); return true; } catch { return false; } },
      scopePath: "summary",
      explanation: "The owner confirmed saving a payment card to their vault.",
      confirmation: {
        confirmedByUser: true,
        surface: params.surface,
        source: params.source,
      },
      ...(params.card.securityCode ? { securityCodeChange: { cardId, value: params.card.securityCode } } : {}),
      applyMutation: async (base) => {
        assertCurrent();
        const next = isRecord(base) ? { ...base } : {};
        const summary = isRecord(next.summary) ? { ...next.summary } : {};
        const secrets = isRecord(next.secrets) ? { ...next.secrets } : {};
        const previousSummary = summary[cardId], previousSecret = secrets[cardId];
        if (readWalletSecurityCode(previousSecret) && isRecord(previousSecret) && normalizePan(String(previousSecret.pan ?? "")) !== normalizePan(params.card.pan) && !params.card.securityCode) {
          throw new Error("Enter this card's CVV or cancel and start a new card.");
        }
        // An uncertain acknowledgement may already have committed this draft.
        // Retain its private image without converting saved bytes into a new approval.
        const preserveArtwork = assignAutomatically && isRecord(previousSummary) && previousSummary.brand === network && isRecord(previousSecret) && normalizePan(String(previousSecret.pan ?? "")) === normalizePan(params.card.pan);
        if (preserveArtwork) {
          artwork = readWalletArtwork(isRecord(next.artwork) ? next.artwork[cardId] : undefined);
        } else if (automaticDesigns) {
          artwork = { source: "neutral", version: 1 };
          const candidate = chooseUnusedWalletArtwork(next, params.card.pan, automaticDesigns.variants);
          if (candidate) {
            try {
              const selected = await artworkDeadline(undefined, signal => this.readCatalogArtwork(params, candidate, automaticDesigns!.catalogVersion, signal));
              assertCurrent();
              artwork = approveWalletCatalogArtwork({ ...selected, evidence: "network_assigned" }, params.userId, epoch);
            } catch { assertCurrent(); }
          }
          const collection = isRecord(next.artwork) ? { ...next.artwork } : {};
          collection[cardId] = artwork;
          if (JSON.stringify(collection).length > MAX_WALLET_ARTWORK_CHARACTERS) {
            // Omission renders the same neutral face and needs no extra storage.
            artwork = undefined;
            delete collection[cardId];
            next.artwork = collection;
          }
        }
        assertCurrent();
        const previous = summary[cardId];
        summary[cardId] = { ...summaryRecord, ...(isRecord(previous) && typeof previous.created_at === "string" ? { created_at: previous.created_at } : {}) };
        const previousSecrets = secrets[cardId];
        const previousCode = readWalletSecurityCode(previousSecrets);
        secrets[cardId] = { ...(previousCode ? { manual_cvv: previousCode } : {}), ...secretsRecord, ...(isRecord(previousSecrets) && Array.isArray(previousSecrets.share_receipts) ? { share_receipts: previousSecrets.share_receipts } : {}) };
        if (artwork && !preserveArtwork) {
          assertWalletArtworkApproval(artwork, params.userId);
          const collection = isRecord(next.artwork) ? { ...next.artwork } : {};
          collection[cardId] = artwork;
          if (JSON.stringify(collection).length > MAX_WALLET_ARTWORK_CHARACTERS) throw new Error("Your artwork storage is full. Choose neutral artwork.");
          next.artwork = collection;
        }
        next.summary = summary;
        next.secrets = secrets;
        return next;
      },
    });
    assertCurrent();
    return {
      cardId,
      summary: toSummary(cardId, summaryRecord)!,
      cardholderName: secretsRecord.cardholder_name,
      artwork,
    };
  }

  static async updateCardNickname(
    params: VaultContextParams & {
      cardId: string;
      nickname: string;
      surface: PkmUserConfirmation["surface"];
      source: string;
    },
  ): Promise<void> {
    await PersonalKnowledgeModelService.storeWalletDomain({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      scopePath: "summary",
      explanation: "The owner renamed a stored payment card.",
      confirmation: {
        confirmedByUser: true,
        surface: params.surface,
        source: params.source,
      },
      applyMutation: (base) => {
        const next = isRecord(base) ? { ...base } : {};
        const summary = isRecord(next.summary) ? { ...next.summary } : {};
        const existing = summary[params.cardId];
        if (isRecord(existing)) {
          summary[params.cardId] = { ...existing, nickname: params.nickname.trim() };
        }
        next.summary = summary;
        return next;
      },
    });
  }

  static async listCardShareReceipts(params: VaultContextParams & { cardId: string }): Promise<WalletCardShareReceipt[]> {
    const data = await this.loadDomain(params);
    const secrets = isRecord(data?.secrets) ? data.secrets[params.cardId] : null;
    const receipts = isRecord(secrets) && Array.isArray(secrets.share_receipts) ? secrets.share_receipts : [];
    return receipts.filter((row): row is WalletCardShareReceipt => isRecord(row) &&
      ["messageId", "conversationId", "recipientPersonRef", "recipientName", "sentAt"].every(key => typeof row[key] === "string"));
  }

  static async recordCardShareReceipt(params: VaultContextParams & { cardId: string; receipt: WalletCardShareReceipt; mayPublish?: () => boolean }): Promise<void> {
    await PersonalKnowledgeModelService.storeWalletDomain({ ...params, scopePath: "secrets",
      explanation: "The owner confirmed sending this card; record the acknowledged message receipt.",
      confirmation: { confirmedByUser: true, surface: "web", source: "one_wallet_share_card" },
      applyMutation: base => {
        const next = isRecord(base) ? { ...base } : {};
        const secrets = isRecord(next.secrets) ? { ...next.secrets } : {};
        const saved = secrets[params.cardId];
        if (!isRecord(saved)) throw new Error("Card no longer available.");
        const receipts = Array.isArray(saved.share_receipts) ? saved.share_receipts : [];
        secrets[params.cardId] = { ...saved, share_receipts: [...receipts.filter(row => !isRecord(row) || row.messageId !== params.receipt.messageId), params.receipt] };
        return { ...next, secrets };
      },
    });
  }

  /** Refreshes sharing metadata for an existing owner-entered card without changing its details. */
  static async prepareCardSharing(params: VaultContextParams & { cardId: string; isCurrent: () => boolean }): Promise<void> {
    if (!params.isCurrent()) throw new Error("Wallet changed.");
    await PersonalKnowledgeModelService.storeWalletDomain({
      ...params,
      scopePath: "summary",
      explanation: "The owner requested sharing their saved payment card.",
      confirmation: { confirmedByUser: true, surface: "web", source: "one_wallet_share_card" },
      mayPublish: params.isCurrent,
      applyMutation: (base) => {
        if (!params.isCurrent() || !isRecord(base.summary) || !isRecord(base.summary[params.cardId]) ||
            !isRecord(base.secrets) || !isRecord(base.secrets[params.cardId])) throw new Error("Card unavailable.");
        return base;
      },
    });
  }

  static async deleteCard(
    params: VaultContextParams & {
      cardId: string;
      surface: PkmUserConfirmation["surface"];
      source: string;
    },
  ): Promise<void> {
    await PersonalKnowledgeModelService.storeWalletDomain({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      scopePath: "summary",
      explanation: "The owner removed a stored payment card.",
      confirmation: {
        confirmedByUser: true,
        surface: params.surface,
        source: params.source,
      },
      applyMutation: (base) => {
        const next = isRecord(base) ? { ...base } : {};
        const summary = isRecord(next.summary) ? { ...next.summary } : {};
        const secrets = isRecord(next.secrets) ? { ...next.secrets } : {};
        delete summary[params.cardId];
        delete secrets[params.cardId];
        if (isRecord(next.artwork)) { const artwork = { ...next.artwork }; delete artwork[params.cardId]; next.artwork = artwork; }
        next.summary = summary;
        next.secrets = secrets;
        return next;
      },
    });
  }

  /** Metadata-only line rendering for chat; bounded so a large vault stays readable. */
  static describeSummaries(summaries: WalletCardSummary[], limit = 10): string {
    if (summaries.length === 0) return "No cards are stored yet.";
    const lines = summaries.slice(0, limit).map(
      (card) =>
        `${card.nickname || card.brand} · ${card.brand} ····${card.last4} · ` +
        `${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear} · ${card.issuingRegion}`,
    );
    const remaining = summaries.length - lines.length;
    if (remaining > 0) {
      lines.push(`…and ${remaining} more. Open Wallet to search the full list.`);
    }
    return lines.join("\n");
  }

  /** Case-insensitive match on nickname, brand, last4, or issuing region. */
  static matchesQuery(card: WalletCardSummary, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [card.nickname, card.brand, card.last4, card.issuingRegion]
      .some((value) => String(value || "").toLowerCase().includes(q));
  }
}
