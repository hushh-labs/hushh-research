import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadDomainData, mockStoreWalletDomain } = vi.hoisted(() => ({
  mockLoadDomainData: vi.fn(),
  mockStoreWalletDomain: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainData: mockLoadDomainData,
    storeWalletDomain: mockStoreWalletDomain,
  },
}));

import { WalletService } from "@/lib/services/wallet-service";

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

describe("WalletService", () => {
  beforeEach(() => {
    mockLoadDomainData.mockResolvedValue(DOMAIN_DATA);
    mockStoreWalletDomain.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("lists metadata only", async () => {
    const summaries = await WalletService.listCardSummaries(CONTEXT);
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
    const full = await WalletService.getCard({ ...CONTEXT, cardId: CARD_ID });
    expect(full?.secrets.pan).toBe("4111111111111111");
    expect(full?.secrets.pin).toBe("1234");
  });

  it("refuses an invalid card before any storage call", async () => {
    await expect(
      WalletService.addCard({
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
    expect(mockStoreWalletDomain).not.toHaveBeenCalled();
  });

  it("addCard nests secrets under the secrets branch with a card_ segment id", async () => {
    const saved = await WalletService.addCard({
      ...CONTEXT,
      surface: "chat",
      source: "agent_chat_wallet_add",
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

    const call = mockStoreWalletDomain.mock.calls[0][0];
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
    await WalletService.deleteCard({
      ...CONTEXT,
      cardId: CARD_ID,
      surface: "web",
      source: "test",
    });
    const call = mockStoreWalletDomain.mock.calls[0][0];
    const mutated = call.applyMutation(structuredClone(DOMAIN_DATA));
    expect(mutated.summary).not.toHaveProperty(CARD_ID);
    expect(mutated.secrets).not.toHaveProperty(CARD_ID);
  });

  it("describeSummaries exposes last4 only", async () => {
    const summaries = await WalletService.listCardSummaries(CONTEXT);
    const text = WalletService.describeSummaries(summaries);
    expect(text).toContain("····1111");
    expect(text).not.toContain("4111111111111111");
  });

  it("describeSummaries stays bounded for a large vault", async () => {
    const [one] = await WalletService.listCardSummaries(CONTEXT);
    const many = Array.from({ length: 53 }, (_, i) => ({ ...one, cardId: `card_${i}`, nickname: `Card ${i}` }));
    const text = WalletService.describeSummaries(many);
    expect(text.split("\n")).toHaveLength(11);
    expect(text).toContain("and 43 more");
  });

  it("matchesQuery searches nickname, brand, last4, and region", async () => {
    const [card] = await WalletService.listCardSummaries(CONTEXT);
    expect(WalletService.matchesQuery(card, "everyday")).toBe(true);
    expect(WalletService.matchesQuery(card, "VISA")).toBe(true);
    expect(WalletService.matchesQuery(card, "1111")).toBe(true);
    expect(WalletService.matchesQuery(card, "us")).toBe(true);
    expect(WalletService.matchesQuery(card, "amex")).toBe(false);
    expect(WalletService.matchesQuery(card, "")).toBe(true);
  });
});
