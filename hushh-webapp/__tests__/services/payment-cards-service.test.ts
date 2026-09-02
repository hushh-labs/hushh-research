import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadDomainData, mockStorePaymentCardsDomain } = vi.hoisted(() => ({
  mockLoadDomainData: vi.fn(),
  mockStorePaymentCardsDomain: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainData: mockLoadDomainData,
    storePaymentCardsDomain: mockStorePaymentCardsDomain,
  },
}));

import { PaymentCardsService } from "@/lib/services/payment-cards-service";

const CONTEXT = {
  userId: "user_1",
  vaultKey: "vault_key",
  vaultOwnerToken: "vault_owner_token",
};

const CARD_ID = "card_123e4567-e89b-12d3-a456-426614174000";

const DOMAIN_DATA = {
  summary: {
    [CARD_ID]: {
      nickname: "Everyday Visa",
      brand: "visa",
      last4: "1111",
      expiry_month: 4,
      expiry_year: 2030,
      issuing_region: "US",
      created_at: "2026-09-01T00:00:00.000Z",
    },
  },
  secrets: {
    [CARD_ID]: {
      pan: "4111111111111111",
      cvv: "123",
      pin: "1234",
      cardholder_name: "A Person",
    },
  },
};

describe("PaymentCardsService", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ONE_PAYMENT_CARDS_ENABLED", "true");
    mockLoadDomainData.mockResolvedValue(DOMAIN_DATA);
    mockStorePaymentCardsDomain.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("lists metadata only", async () => {
    const summaries = await PaymentCardsService.listCardSummaries(CONTEXT);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      cardId: CARD_ID,
      brand: "visa",
      last4: "1111",
      issuingRegion: "US",
    });
    expect(JSON.stringify(summaries)).not.toContain("4111111111111111");
  });

  it("getCard returns both halves for the reveal surface", async () => {
    const full = await PaymentCardsService.getCard({ ...CONTEXT, cardId: CARD_ID });
    expect(full?.secrets.pan).toBe("4111111111111111");
    expect(full?.secrets.pin).toBe("1234");
  });

  it("refuses addCard when the feature flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_ONE_PAYMENT_CARDS_ENABLED", "false");
    await expect(
      PaymentCardsService.addCard({
        ...CONTEXT,
        surface: "web",
        source: "test",
        card: {
          nickname: "n",
          cardholderName: "A",
          pan: "4111111111111111",
          expiryMonth: 4,
          expiryYear: 2030,
          issuingRegion: "US",
        },
      }),
    ).rejects.toThrow("not enabled");
  });

  it("refuses an invalid card before any storage call", async () => {
    await expect(
      PaymentCardsService.addCard({
        ...CONTEXT,
        surface: "web",
        source: "test",
        card: {
          nickname: "n",
          cardholderName: "A",
          pan: "4111111111111112",
          expiryMonth: 4,
          expiryYear: 2030,
          issuingRegion: "US",
        },
      }),
    ).rejects.toThrow("CARD_VALIDATION_FAILED");
    expect(mockStorePaymentCardsDomain).not.toHaveBeenCalled();
  });

  it("addCard nests secrets under the secrets branch with a card_ segment id", async () => {
    const saved = await PaymentCardsService.addCard({
      ...CONTEXT,
      surface: "chat",
      source: "agent_chat_cards_add",
      card: {
        nickname: "Travel Amex",
        cardholderName: "A Person",
        pan: "3782 822463 10005",
        cvv: "1234",
        pin: "4321",
        expiryMonth: 5,
        expiryYear: 2031,
        issuingRegion: "in",
      },
    });
    expect(saved.cardId).toMatch(/^card_[0-9a-f-]{36}$/);
    expect(saved.summary.brand).toBe("amex");
    expect(saved.summary.last4).toBe("0005");
    expect(saved.summary.issuingRegion).toBe("IN");

    const call = mockStorePaymentCardsDomain.mock.calls[0][0];
    expect(call.scopePath).toBe("summary");
    expect(call.confirmation).toMatchObject({ confirmedByUser: true, surface: "chat" });
    const mutated = call.applyMutation({});
    expect(mutated.secrets[saved.cardId]).toMatchObject({
      pan: "378282246310005",
      cvv: "1234",
      pin: "4321",
    });
    expect(mutated.summary[saved.cardId]).not.toHaveProperty("pan");
    expect(JSON.stringify(mutated.summary)).not.toContain("378282246310005");
  });

  it("deleteCard removes both branches", async () => {
    await PaymentCardsService.deleteCard({
      ...CONTEXT,
      cardId: CARD_ID,
      surface: "web",
      source: "test",
    });
    const call = mockStorePaymentCardsDomain.mock.calls[0][0];
    const mutated = call.applyMutation(structuredClone(DOMAIN_DATA));
    expect(mutated.summary).not.toHaveProperty(CARD_ID);
    expect(mutated.secrets).not.toHaveProperty(CARD_ID);
  });

  it("describeSummaries exposes last4 only", async () => {
    const summaries = await PaymentCardsService.listCardSummaries(CONTEXT);
    const text = PaymentCardsService.describeSummaries(summaries);
    expect(text).toContain("····1111");
    expect(text).not.toContain("4111111111111111");
  });
});
