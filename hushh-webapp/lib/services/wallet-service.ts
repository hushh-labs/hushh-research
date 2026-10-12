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
  CARD_BRANDS,
  normalizePan,
  validateCardForRegion,
  type CardBrand,
  type CardValidationResult,
} from "@/lib/wallet/card-validation";
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
  cvv: string;
  pin: string;
  cardholderName: string;
}

export interface WalletCardInput {
  nickname?: string;
  brand?: CardBrand;
  pan: string;
  cvv?: string;
  pin?: string;
  cardholderName: string;
  expiryMonth: number;
  expiryYear: number;
  issuingRegion?: string;
}

class WalletNetworkSessionChangedError extends Error {}

export interface WalletNetworkContext { userId: string; vaultOwnerToken: string }
export interface WalletNetworkInput { iinPrefix: string; panLength: number; selectedNetwork?: CardBrand }
export interface WalletNetworkResult {
  network: CardBrand;
  source: "prefix" | "owner_selected" | "ambiguous" | "unknown";
  candidates: CardBrand[];
}

function normalizedNetwork(value: unknown): CardBrand {
  const key = String(value ?? "").trim().toLowerCase() as CardBrand;
  return CARD_BRANDS.includes(key) ? key : "other";
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
}

interface VaultContextParams {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export class WalletService {
  static isEnabled(): boolean {
    return true;
  }

  private static async networkRequest(context: WalletNetworkContext, suffix: string, signal?: AbortSignal, input?: WalletNetworkInput): Promise<unknown> {
    const assertCurrent = networkSessionGuard(context, signal);
    assertCurrent();
    const token = await AuthService.getIdTokenWithRetry({ expectedUserId: context.userId });
    assertCurrent();
    if (!token) throw new Error("Network identification unavailable.");
    const response = await ApiService.apiFetch(`/api/one/wallet/card-access/networks${suffix}`, {
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
    return data.networks.filter((value): value is CardBrand => typeof value === "string" && CARD_BRANDS.includes(value as CardBrand));
  }

  static async resolveCardNetwork(context: WalletNetworkContext, input: WalletNetworkInput, signal?: AbortSignal): Promise<WalletNetworkResult> {
    // Construct the wire object explicitly; never serialize a card or vault key.
    if (!/^[0-9]{6}$/.test(input.iinPrefix) || !Number.isInteger(input.panLength) || input.panLength < 13 || input.panLength > 19) throw new Error("Network identification unavailable.");
    const payload = { iinPrefix: input.iinPrefix, panLength: input.panLength, ...(input.selectedNetwork ? { selectedNetwork: input.selectedNetwork } : {}) };
    const data = await this.networkRequest(context, "/resolve", signal, payload);
    if (!isRecord(data)) throw new Error("Network identification unavailable.");
    const source = data.source;
    if (!["prefix", "owner_selected", "ambiguous", "unknown"].includes(String(source))) throw new Error("Network identification unavailable.");
    return { network: normalizedNetwork(data.network), source: source as WalletNetworkResult["source"], candidates: Array.isArray(data.candidates) ? data.candidates.map(normalizedNetwork).filter(value => value !== "other") : [] };
  }

  static validateCard(input: WalletCardInput): CardValidationResult {
    return validateCardForRegion({
      pan: input.pan,
      brand: input.brand,
      cvv: input.cvv,
      pin: input.pin,
      cardholderName: input.cardholderName,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      issuingRegion: input.issuingRegion,
    });
  }

  private static async loadDomain(
    params: VaultContextParams,
  ): Promise<Record<string, unknown> | null> {
    const data = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      domain: WALLET_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    });
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
  ): Promise<WalletCardPresentation[]> {
    const data = await this.loadDomain(params);
    const secrets = isRecord(data?.secrets) ? data.secrets : {};
    return summariesFromDomain(data).map((summary) => {
      const cardSecrets = secrets[summary.cardId];
      return {
        summary,
        cardholderName: isRecord(cardSecrets) ? String(cardSecrets.cardholder_name ?? "") : "",
      };
    });
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
        cvv: String(rawSecrets.cvv ?? ""),
        pin: String(rawSecrets.pin ?? ""),
        cardholderName: String(rawSecrets.cardholder_name ?? ""),
      },
    };
  }

  static async addCard(
    params: VaultContextParams & {
      card: WalletCardInput;
      surface: PkmUserConfirmation["surface"];
      source: string;
      reserveCardId?: () => Promise<string | null>;
    },
  ): Promise<{ cardId: string; summary: WalletCardSummary; cardholderName: string }> {
    if (!this.isEnabled()) {
      throw new Error("Payment cards are not enabled in this environment.");
    }
    const assertCurrent = networkSessionGuard(params);
    assertCurrent();
    const preliminary = this.validateCard(params.card);
    if (!preliminary.valid) throw new Error(`CARD_VALIDATION_FAILED:${preliminary.errors.join(",")}`);
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
    const cardId = await params.reserveCardId?.() || `card_${crypto.randomUUID()}`;
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
      cvv: params.card.cvv ?? "",
      pin: params.card.pin ?? "",
      cardholder_name: params.card.cardholderName.trim(),
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
      applyMutation: (base) => {
        assertCurrent();
        const next = isRecord(base) ? { ...base } : {};
        const summary = isRecord(next.summary) ? { ...next.summary } : {};
        const secrets = isRecord(next.secrets) ? { ...next.secrets } : {};
        summary[cardId] = summaryRecord;
        secrets[cardId] = secretsRecord;
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
