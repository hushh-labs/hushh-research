/**
 * Payment Cards service - the single boundary for the reserved `payment_cards`
 * PKM domain. All storage rides PersonalKnowledgeModelService (client-side
 * AES-256-GCM under the vault key; the server holds ciphertext only), so this
 * module performs no fetch of its own.
 *
 * Domain data shape (inside the encrypted blob):
 *   { summary: { [cardId]: PaymentCardSummaryRecord },
 *     secrets: { [cardId]: PaymentCardSecretsRecord } }
 *
 * Distinct from the Wallet Profile (`wallet-card-service.ts`), which is a
 * public identity pass and never holds payment credentials.
 */

import {
  validateCardForRegion,
  type CardBrand,
  type CardValidationResult,
} from "@/lib/cards/card-validation";
import { isPaymentCardsBuildEnabled } from "@/lib/cards/payment-cards-availability";
import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export const PAYMENT_CARDS_DOMAIN = "payment_cards";

export interface PaymentCardSummary {
  cardId: string;
  nickname: string;
  brand: CardBrand;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  issuingRegion: string;
  createdAt: string;
}

export interface PaymentCardSecrets {
  pan: string;
  cvv: string;
  pin: string;
  cardholderName: string;
}

export interface PaymentCardInput {
  nickname: string;
  pan: string;
  cvv?: string;
  pin?: string;
  cardholderName: string;
  expiryMonth: number;
  expiryYear: number;
  issuingRegion: string;
}

interface VaultContextParams {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSummary(cardId: string, value: unknown): PaymentCardSummary | null {
  if (!isRecord(value)) return null;
  return {
    cardId,
    nickname: String(value.nickname ?? ""),
    brand: String(value.brand ?? "other") as CardBrand,
    last4: String(value.last4 ?? ""),
    expiryMonth: Number(value.expiry_month ?? 0),
    expiryYear: Number(value.expiry_year ?? 0),
    issuingRegion: String(value.issuing_region ?? ""),
    createdAt: String(value.created_at ?? ""),
  };
}

export class PaymentCardsService {
  static isEnabled(): boolean {
    return isPaymentCardsBuildEnabled();
  }

  static validateCard(input: PaymentCardInput): CardValidationResult {
    return validateCardForRegion({
      pan: input.pan,
      cvv: input.cvv,
      pin: input.pin,
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
      domain: PAYMENT_CARDS_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => null);
    return isRecord(data) ? data : null;
  }

  static async listCardSummaries(
    params: VaultContextParams,
  ): Promise<PaymentCardSummary[]> {
    const data = await this.loadDomain(params);
    const branch = isRecord(data?.summary) ? data.summary : {};
    return Object.entries(branch)
      .map(([cardId, value]) => toSummary(cardId, value))
      .filter((entry): entry is PaymentCardSummary => entry !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /** Decrypts one card fully. Call only from a reveal surface; never hand the result to a model. */
  static async getCard(
    params: VaultContextParams & { cardId: string },
  ): Promise<{ summary: PaymentCardSummary; secrets: PaymentCardSecrets } | null> {
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
      card: PaymentCardInput;
      surface: PkmUserConfirmation["surface"];
      source: string;
    },
  ): Promise<{ cardId: string; summary: PaymentCardSummary }> {
    if (!this.isEnabled()) {
      throw new Error("Payment cards are not enabled in this environment.");
    }
    const validation = this.validateCard(params.card);
    if (!validation.valid) {
      throw new Error(`CARD_VALIDATION_FAILED:${validation.errors.join(",")}`);
    }
    const cardId = `card_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const summaryRecord = {
      nickname: params.card.nickname.trim(),
      brand: validation.brand ?? "other",
      last4: validation.last4,
      expiry_month: params.card.expiryMonth,
      expiry_year: params.card.expiryYear,
      issuing_region: params.card.issuingRegion.trim().toUpperCase(),
      created_at: createdAt,
    };
    const secretsRecord = {
      pan: params.card.pan.replace(/[\s-]/g, ""),
      cvv: params.card.cvv ?? "",
      pin: params.card.pin ?? "",
      cardholder_name: params.card.cardholderName.trim(),
    };
    await PersonalKnowledgeModelService.storePaymentCardsDomain({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      scopePath: "summary",
      explanation: "The owner confirmed saving a payment card to their vault.",
      confirmation: {
        confirmedByUser: true,
        surface: params.surface,
        source: params.source,
      },
      applyMutation: (base) => {
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
    return { cardId, summary: toSummary(cardId, summaryRecord)! };
  }

  static async updateCardNickname(
    params: VaultContextParams & {
      cardId: string;
      nickname: string;
      surface: PkmUserConfirmation["surface"];
      source: string;
    },
  ): Promise<void> {
    await PersonalKnowledgeModelService.storePaymentCardsDomain({
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

  static async deleteCard(
    params: VaultContextParams & {
      cardId: string;
      surface: PkmUserConfirmation["surface"];
      source: string;
    },
  ): Promise<void> {
    await PersonalKnowledgeModelService.storePaymentCardsDomain({
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

  /** Metadata-only line rendering for chat resultSummary payloads. */
  static describeSummaries(summaries: PaymentCardSummary[]): string {
    if (summaries.length === 0) return "No cards are stored yet.";
    return summaries
      .map(
        (card) =>
          `${card.nickname || card.brand} · ${card.brand} ····${card.last4} · ` +
          `${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear} · ${card.issuingRegion}`,
      )
      .join("\n");
  }
}
