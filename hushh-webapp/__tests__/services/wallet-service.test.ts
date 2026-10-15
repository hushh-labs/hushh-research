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

const networkApi = vi.hoisted(() => ({ fetch: vi.fn(), user: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: networkApi.fetch } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: networkApi.user, getIdTokenWithRetry: networkApi.token } }));

import { WalletService } from "@/lib/services/wallet-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { luhnValid } from "@/lib/wallet/card-validation";
import { approveWalletCatalogArtwork } from "@/lib/wallet/card-artwork";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { encodeCardPng } from "@/lib/wallet/card-scan-raster";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";

beforeEach(() => {
  publishValidatedAuthSessionOwner("user_1");
  networkApi.user.mockReturnValue({ uid: "user_1" });
  networkApi.token.mockResolvedValue("identity");
});

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
  it("uses native binary transport and verifies approved final artwork bytes", async () => {
    vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("crypto", webcrypto);
    const blob = await encodeCardPng({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) });
    const bytes = await blob.arrayBuffer(), digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    const variant = { assetId: "synthetic", issuerId: "issuer", productId: "product", variantId: "blue", label: "Synthetic", image: `/api/one/wallet/card-access/artwork/assets/${digest}`, digest, allowOverlay: true };
    networkApi.fetch.mockImplementation(async url => url.endsWith("/validate") ? new Response(JSON.stringify({ selections: [{ assetId: "synthetic", approved: true, allowOverlay: false }] })) : new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    try {
      const approved = await WalletService.selectCardArtwork(CONTEXT, variant, "test-1");
      expect(approved).toMatchObject({ source: "catalog", digest, allowOverlay: false });
      const [, options] = networkApi.fetch.mock.calls.find(([url]) => url.includes("/assets/"))!;
      expect(options.responseType).toBe("arraybuffer");
      networkApi.fetch.mockImplementation(async url => url.endsWith("/validate") ? new Response(JSON.stringify({ selections: [{ assetId: "synthetic", approved: true, allowOverlay: false }] })) : new Response("bad bytes", { headers: { "Content-Type": "image/png" } }));
      await expect(WalletService.selectCardArtwork(CONTEXT, variant, "test-1")).rejects.toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
  it("retains one fallback identity when an uncertain save is retried after registration recovers", async () => {
    const draftId = "123E4567-E89B-12D3-A456-426614174088", reserveCardId = vi.fn().mockResolvedValueOnce(null).mockResolvedValue("card_registered_later");
    const card = { draftId, pan: "4111111111111111", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2030 };
    mockStoreWalletDomain.mockRejectedValueOnce(new Error("Synthetic uncertain receipt")).mockResolvedValue({ success: true });
    await expect(WalletService.addCard({ ...CONTEXT, card, surface: "web", source: "one_wallet_add", reserveCardId })).rejects.toThrow("uncertain");
    const saved = await WalletService.addCard({ ...CONTEXT, card, surface: "web", source: "one_wallet_add", reserveCardId });
    expect(saved.cardId).toBe(`card_${draftId.toLowerCase()}`); expect(reserveCardId).toHaveBeenCalledOnce();
    const ids = mockStoreWalletDomain.mock.calls.map(([call]) => Object.keys(call.applyMutation({}).summary));
    expect(ids).toEqual([[saved.cardId], [saved.cardId]]);
    await expect(WalletService.addCard({ ...CONTEXT, card: { ...card, draftId: "-".repeat(36) }, surface: "web", source: "one_wallet_add" })).rejects.toThrow("Invalid card draft");
  });
  it("saves valid details with neutral artwork when catalog approval is revoked while reviewing", async () => {
    const artwork = approveWalletCatalogArtwork({ source: "catalog", version: 1, assetId: "synthetic", issuerId: "issuer", productId: "product", variantId: "blue", catalogVersion: "test-1", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: false, evidence: "owner_selected" }, CONTEXT.userId, snapshotVaultSessionEpoch());
    networkApi.fetch.mockImplementation(async (url) => url.endsWith("/artwork/validate") ? new Response(JSON.stringify({ selections: [{ assetId: "synthetic", approved: false, allowOverlay: false }] })) : new Response(JSON.stringify({ network: "visa", source: "prefix", candidates: [] })));
    const saved = await WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2030, artwork }, surface: "web", source: "one_wallet_add" });
    expect(saved.artwork).toEqual({ source: "neutral", version: 1 });
    const result = mockStoreWalletDomain.mock.calls[0]![0].applyMutation({}); expect(result.artwork[saved.cardId]).toEqual(saved.artwork);
    await expect(WalletService.updateCardArtwork({ ...CONTEXT, cardId: saved.cardId, artwork })).rejects.toThrow("approval changed");
  });
  it("prepares an existing owner's card unchanged and refuses stale or missing cards", async () => {
    let current = true;
    const isCurrent = () => current;
    await WalletService.prepareCardSharing({ ...CONTEXT, cardId: CARD_ID, isCurrent });
    const params = mockStoreWalletDomain.mock.calls[0][0];
    expect(params.mayPublish).toBe(isCurrent);
    expect(params.applyMutation(DOMAIN_DATA)).toBe(DOMAIN_DATA);
    expect(() => params.applyMutation({ summary: {}, secrets: {} })).toThrow("Card unavailable");
    current = false;
    expect(params.mayPublish()).toBe(false);
    expect(() => params.applyMutation(DOMAIN_DATA)).toThrow("Card unavailable");
  });
  beforeEach(() => {
    mockLoadDomainData.mockResolvedValue(DOMAIN_DATA);
    mockStoreWalletDomain.mockResolvedValue({ success: true });
    networkApi.fetch.mockImplementation(async (_url, options) => {
      const input = options?.body ? JSON.parse(options.body) : {};
      return new Response(JSON.stringify({ network: input.selectedNetwork || "visa", source: input.selectedNetwork ? "owner_selected" : "prefix", candidates: [] }), { status: 200 });
    });
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
    expect(JSON.stringify(summaries)).not.toContain("A Person");
  });

  it("keeps acknowledged recipients only in encrypted secrets and preserves other cards", async () => {
    const receipt = { messageId: "message", conversationId: "conversation", recipientPersonRef: "person", recipientName: "Recipient", sentAt: "2026-10-10T10:00:00Z" };
    const mayPublish = () => true;
    await WalletService.recordCardShareReceipt({ ...CONTEXT, cardId: CARD_ID, receipt, mayPublish });
    const params = mockStoreWalletDomain.mock.calls[0][0];
    expect(params.scopePath).toBe("secrets"); expect(params.mayPublish).toBe(mayPublish);
    const base = { ...DOMAIN_DATA, secrets: { ...DOMAIN_DATA.secrets, other: { pan: "4242424242424242" } } };
    const next = params.applyMutation(base);
    expect(next.summary).toEqual(base.summary); expect(next.secrets.other).toEqual(base.secrets.other);
    expect(next.secrets[CARD_ID].share_receipts).toEqual([receipt]);
    expect(params.applyMutation(next).secrets[CARD_ID].share_receipts).toEqual([receipt]);
    mockLoadDomainData.mockResolvedValue(next);
    expect(await WalletService.listCardShareReceipts({ ...CONTEXT, cardId: CARD_ID })).toEqual([receipt]);
    expect(await WalletService.listCardShareReceipts({ ...CONTEXT, cardId: "other" })).toEqual([]);
    expect(JSON.stringify(await WalletService.listCardSummaries(CONTEXT))).not.toContain(receipt.recipientName);
    expect(JSON.stringify(await WalletService.getCard({ ...CONTEXT, cardId: CARD_ID }))).not.toContain(receipt.recipientName);
  });

  it("projects the owner's cardholder name without projecting payment credentials", async () => {
    const [card] = await WalletService.listCardPresentations(CONTEXT);
    expect(card.cardholderName).toBe("A Person");
    expect(card.summary.cardId).toBe(CARD_ID);
    expect(mockLoadDomainData).toHaveBeenCalledTimes(1);
    expect(card).not.toHaveProperty("secrets");
    expect(JSON.stringify(card)).not.toContain("4111111111111111");
    expect(card.summary).not.toHaveProperty("cardholderName");
  });

  it("does not turn a failed read into an empty wallet", async () => {
    mockLoadDomainData.mockResolvedValueOnce(null);
    await expect(WalletService.listCardSummaries(CONTEXT)).resolves.toEqual([]);
    const failure = new Error("Synthetic encrypted wallet unavailable");
    mockLoadDomainData.mockRejectedValue(failure);
    await expect(WalletService.listCardSummaries(CONTEXT)).rejects.toBe(failure);
    await expect(WalletService.listCardPresentations(CONTEXT)).rejects.toBe(failure);
  });

  it("getCard returns both halves for the reveal surface", async () => {
    const full = await WalletService.getCard({ ...CONTEXT, cardId: CARD_ID });
    expect(full?.secrets.pan).toBe("4111111111111111");
    expect(full?.secrets).not.toHaveProperty("pin");
    expect(full?.secrets).not.toHaveProperty("cvv");
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
    networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ network: "amex", source: "prefix", candidates: [] })));
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
    });
    expect(mutated.summary[saved.cardId]).not.toHaveProperty("pan");
    expect(mutated.summary[saved.cardId]).not.toHaveProperty("cardholder_name");
    expect(saved.cardholderName).toBe("A Person");
    expect(JSON.stringify(mutated.summary)).not.toContain("378282246310005");
  });

  it("saves an explicit provider with optional fields empty and preserves other cards", async () => {
    const saved = await WalletService.addCard({
      ...CONTEXT,
      surface: "web",
      source: "test",
      card: {
        cardholderName: "A Person",
        // This JCB test BIN overlaps the broad RuPay detector window.
        pan: "3566 0020 2036 0505",
        brand: "jcb",
        cvv: "123",
        expiryMonth: 5,
        expiryYear: 2031,
      },
    });
    const call = mockStoreWalletDomain.mock.calls[0][0];
    const original = structuredClone(DOMAIN_DATA);
    const mutated = call.applyMutation(original);
    expect(saved.summary).toMatchObject({ brand: "jcb", issuingRegion: "", nickname: "" });
    expect(mutated.secrets[saved.cardId]).not.toHaveProperty("pin");
    expect(mutated.secrets[saved.cardId]).not.toHaveProperty("cvv");
    expect(mutated.summary[CARD_ID]).toEqual(DOMAIN_DATA.summary[CARD_ID]);
    expect(mutated.secrets[CARD_ID]).toEqual(DOMAIN_DATA.secrets[CARD_ID]);
    expect(original).toEqual(DOMAIN_DATA);
  });

  it.each(["cardholderName"] as const)("requires %s before saving", async (field) => {
    await expect(WalletService.addCard({
      ...CONTEXT,
      surface: "web",
      source: "test",
      card: {
        cardholderName: "A Person", pan: "4111111111111111", cvv: "123",
        expiryMonth: 5, expiryYear: 2031, [field]: "",
      },
    })).rejects.toThrow("CARD_VALIDATION_FAILED");
    expect(mockStoreWalletDomain).not.toHaveBeenCalled();
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

describe("backend network integration", () => {
it("preserves newly supported backend networks in options, resolution, storage and existing records", async () => {
 networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ networks: ["visa", "future_network", "other"] })));
 expect(await WalletService.supportedCardNetworks(CONTEXT)).toEqual(["visa", "future_network", "other"]);
 networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ network: "future_network", source: "owner_selected", candidates: [] })));
 const saved = await WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", brand: "future_network", cardholderName: "Test Owner", cvv: "123", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "test" });
 expect(saved.summary.brand).toBe("future_network");
 mockLoadDomainData.mockResolvedValueOnce(mockStoreWalletDomain.mock.calls[0][0].applyMutation({}));
 expect((await WalletService.listCardSummaries(CONTEXT))[0].brand).toBe("future_network");
});
it("rejects malformed backend catalogue entries instead of silently hiding options", async () => {
 networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ networks: ["visa", "invalid/network"] })));
 await expect(WalletService.supportedCardNetworks(CONTEXT)).rejects.toThrow("Network identification unavailable");
});
 beforeEach(() => { vi.clearAllMocks(); networkApi.fetch.mockReset(); mockStoreWalletDomain.mockResolvedValue({ success: true }); mockLoadDomainData.mockResolvedValue(DOMAIN_DATA); });
it("requests only issuer metadata and never card credentials", async () => {
 networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ network: "visa", source: "prefix", candidates: [] })));
 await WalletService.resolveCardNetwork(CONTEXT, { iinPrefix: "411111", panLength: 16, pan: "4111111111111111", cvv: "123", pin: "1234" } as never);
 const [url, options] = networkApi.fetch.mock.calls[0];
 expect(url).toBe("/api/one/wallet/card-access/networks/resolve");
 expect(JSON.parse(options.body)).toEqual({ iinPrefix: "411111", panLength: 16 });
 expect(options.headers["X-Hushh-Consent"]).toBe(CONTEXT.vaultOwnerToken);
 expect(options.cache).toBe("no-store");
});
it("uses a neutral brand when backend identification fails", async () => {
 networkApi.fetch.mockResolvedValueOnce(new Response("private diagnostic", { status: 503 }));
 const saved = await WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", cardholderName: "Test Owner", cvv: "123", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "test" });
 expect(saved.summary.brand).toBe("other");
 expect(JSON.stringify(mockStoreWalletDomain.mock.calls[0][0].applyMutation({}))).not.toContain("iinPrefix");
});
it("normalizes existing stored casing without modifying a saved record", async () => {
 mockLoadDomainData.mockResolvedValueOnce({ ...DOMAIN_DATA, summary: { [CARD_ID]: { ...DOMAIN_DATA.summary[CARD_ID], brand: " Visa " } } });
 expect((await WalletService.listCardSummaries(CONTEXT))[0].brand).toBe("visa");
 expect(mockStoreWalletDomain).not.toHaveBeenCalled();
});

describe.each([false, true])("invalid network length (owner-selected: %s)", (ownerSelected) => {
it.each([
  ["41111111111114", "visa"],
  ["3711111111111117", "amex"],
  ["555555555555558", "mastercard"],
])("rejects a checksum-valid %s with an invalid backend-resolved network length", async (pan, network) => {
  expect(luhnValid(pan)).toBe(true);
  networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ network, source: "prefix", candidates: [] })));
  await expect(WalletService.addCard({ ...CONTEXT, card: { pan, brand: ownerSelected ? network : undefined, cardholderName: "Test Owner", cvv: "123", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "test" })).rejects.toThrow("pan_length_invalid_for_brand");
  expect(mockStoreWalletDomain).not.toHaveBeenCalled();
});
});

it.each(["owner", "vault", "validated owner"])("refuses a delayed lookup after the %s session changes", async (change) => {
  let finish!: (response: Response) => void;
  networkApi.fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
  const saving = WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", cardholderName: "Test Owner", cvv: "123", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "test" });
  const rejected = expect(saving).rejects.toThrow("Wallet changed.");
  await vi.waitFor(() => expect(networkApi.fetch).toHaveBeenCalledOnce());
  if (change === "owner") networkApi.user.mockReturnValue({ uid: "another_owner" });
  else if (change === "vault") advanceVaultSessionEpoch();
  else publishValidatedAuthSessionOwner(null);
  finish(new Response(JSON.stringify({ network: "visa", source: "prefix", candidates: [] })));
  await rejected;
  expect(mockStoreWalletDomain).not.toHaveBeenCalled();
});

it("fences the eventual vault publication and binds native identity to the owner", async () => {
  networkApi.user.mockReturnValue(null);
  networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ network: "Visa", source: "prefix", candidates: [] })));
  const saved = await WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", cardholderName: "Test Owner", cvv: "123", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "test" });
  expect(networkApi.token).toHaveBeenCalledWith({ expectedUserId: CONTEXT.userId });
  expect(saved.summary.brand).toBe("visa");
  const params = mockStoreWalletDomain.mock.calls[0][0];
  expect(networkApi.fetch.mock.calls[0][1].isEffectCurrent()).toBe(true);
  expect(params.mayPublish()).toBe(true);
  advanceVaultSessionEpoch();
  expect(networkApi.fetch.mock.calls[0][1].isEffectCurrent()).toBe(false);
  expect(params.mayPublish()).toBe(false);
  expect(() => params.applyMutation({})).toThrow("Wallet changed.");
});

});
