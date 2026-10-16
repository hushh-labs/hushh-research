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
import { WalletPresentationResource } from "@/lib/services/wallet-presentation-resource";
import { CacheService } from "@/lib/services/cache-service";
import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { AUTH_SESSION_VERIFICATION_REQUIRED_EVENT } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { luhnValid } from "@/lib/wallet/card-validation";
import { MAX_WALLET_ARTWORK_CHARACTERS, approveWalletCatalogArtwork } from "@/lib/wallet/card-artwork";
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

describe("Wallet presentation preloading", () => {
  beforeEach(() => CacheService.getInstance().clear());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const row = () => ({ summary: { cardId: CARD_ID, nickname: "Synthetic card", brand: "visa", last4: "1111", expiryMonth: 12, expiryYear: 2030, issuingRegion: "US", createdAt: "synthetic" }, cardholderName: "SYNTHETIC OWNER", artwork: approveWalletCatalogArtwork({ source: "catalog", version: 1, assetId: "synthetic", issuerId: "issuer", productId: "product", variantId: "blue", catalogVersion: "test", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: true, evidence: "network_assigned" }, CONTEXT.userId, snapshotVaultSessionEpoch()) });
  it("shares preload with entry and caches only the owner display projection", async () => {
    const data = { ...row(), pan: "4111111111111111", manual_cvv: "private-code", vaultKey: CONTEXT.vaultKey };
    const read = vi.spyOn(WalletService, "listCardPresentations").mockResolvedValue([data]);
    const a = WalletPresentationResource.load(CONTEXT), b = WalletPresentationResource.load(CONTEXT);
    expect(a).toBe(b);
    const snapshot = await a;
    expect(WalletPresentationResource.peek(CONTEXT.userId)).toBe(snapshot);
    await WalletPresentationResource.load(CONTEXT);
    expect(read).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(snapshot);
    for (const value of [data.pan, data.manual_cvv, CONTEXT.vaultKey, CONTEXT.vaultOwnerToken]) expect(serialized).not.toContain(value);
  });
  it("preserves the original approval deadline across cached entry and hides expired images synchronously", async () => {
    vi.useFakeTimers();
    vi.spyOn(WalletService, "listCardPresentations").mockResolvedValue([row()]);
    const first = await WalletPresentationResource.load(CONTEXT);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await WalletPresentationResource.load(CONTEXT)).artworkExpiresAt).toBe(first.artworkExpiresAt);
    await vi.advanceTimersByTimeAsync(40_001);
    expect(WalletPresentationResource.peek(CONTEXT.userId)?.rows[0].artwork?.source).toBe("neutral");
  });
  it.each(["wallet mutation", "epoch", "owner", "verification"])("fences late preload after %s", async boundary => {
    let finish!: (rows: ReturnType<typeof row>[]) => void;
    vi.spyOn(WalletService, "listCardPresentations").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = WalletPresentationResource.load(CONTEXT);
    const data = row();
    if (boundary === "wallet mutation") bumpPkmInvalidationEpoch(CONTEXT.userId, "wallet");
    if (boundary === "epoch") advanceVaultSessionEpoch();
    if (boundary === "owner") publishValidatedAuthSessionOwner("another-owner");
    if (boundary === "verification") window.dispatchEvent(new Event(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT));
    finish([data]);
    await expect(pending).rejects.toThrow("Wallet changed");
    expect(WalletPresentationResource.peek(CONTEXT.userId)).toBeNull();
  });
  it("keeps the original warm lease after unavailable validation and replays denials to late joiners", async () => {
    const read = vi.spyOn(WalletService, "listCardPresentations").mockResolvedValueOnce([row()]);
    const saved = await WalletPresentationResource.load(CONTEXT);
    read.mockRejectedValueOnce(new Error("Artwork unavailable"));
    await expect(WalletPresentationResource.load(CONTEXT, { force: true })).rejects.toThrow("Artwork unavailable");
    expect(WalletPresentationResource.peek(CONTEXT.userId)).toBe(saved);
    let finish!: (rows: ReturnType<typeof row>[]) => void;
    read.mockImplementationOnce((_context, options) => {
      expect(options?.failOnArtworkUnavailable).toBe(true);
      options?.onArtworkRejected?.([{ cardId: CARD_ID, assetId: "synthetic", digest: "a".repeat(64) }]);
      return new Promise(resolve => { finish = resolve; });
    });
    const first = WalletPresentationResource.load(CONTEXT, { force: true });
    const denied = vi.fn();
    const joined = WalletPresentationResource.load(CONTEXT, { force: true, onArtworkRejected: denied });
    expect(joined).toBe(first); expect(denied).toHaveBeenCalledOnce();
    finish([]); await joined;
  });
  it("removes a known denied image from the warm snapshot before a stalled refresh finishes", async () => {
    const read = vi.spyOn(WalletService, "listCardPresentations").mockResolvedValueOnce([row()]);
    await WalletPresentationResource.load(CONTEXT);
    let finish!: (rows: ReturnType<typeof row>[]) => void;
    read.mockImplementationOnce((_context, options) => {
      options?.onArtworkRejected?.([{ cardId: CARD_ID, assetId: "synthetic", digest: "a".repeat(64) }]);
      return new Promise(resolve => { finish = resolve; });
    });
    const denied = vi.fn();
    const refresh = WalletPresentationResource.load(CONTEXT, { force: true, onArtworkRejected: denied });
    expect(denied).toHaveBeenCalledOnce();
    expect(WalletPresentationResource.peek(CONTEXT.userId)?.rows[0].artwork?.source).toBe("neutral");
    finish([]);
    await refresh;
  });
});

describe("WalletService", () => {
  it("never allocates a different design by number when the explicit product is ambiguous", async () => {
    const blue = { assetId: "blue", issuerId: "bank", productId: "product", variantId: "blue", label: "Blue", digest: "a".repeat(64), image: "/unused", allowOverlay: false };
    const gold = { ...blue, assetId: "gold", variantId: "gold", digest: "b".repeat(64) };
    mockLoadDomainData.mockClear(); networkApi.fetch.mockClear();
    for (const pan of ["4111111111111111", "4242424242424242"]) {
      expect(await WalletService.suggestBankArtwork({ ...CONTEXT, pan, variants: [blue, gold] })).toBeNull();
      expect(await WalletService.suggestBankArtwork({ ...CONTEXT, pan, variants: [blue] })).toEqual(blue);
    }
    expect(mockLoadDomainData).not.toHaveBeenCalled(); expect(networkApi.fetch).not.toHaveBeenCalled();
  });

  it("constructs a credential-free bank request and refuses a partially malformed bank catalog", async () => {
    const bank = { bankKey: "a".repeat(32), issuerId: "bank", name: "Owned bank", country: "US", designCount: 2 };
    const response = { catalogVersion: "test", selectionBasis: "owner_selected_bank", requiresConfirmation: true, bankKey: null, banks: [bank], variants: [], nextOffset: null };
    networkApi.fetch.mockResolvedValue(new Response(JSON.stringify(response)));
    const input = { network: "visa" as const, pan: "4242424242424242", vaultKey: "not-for-wire" };
    expect((await WalletService.bankArtwork(CONTEXT, input)).banks).toEqual([bank]);
    const [, options] = networkApi.fetch.mock.calls.at(-1)!; expect(JSON.parse(options.body)).toEqual({ network: "visa" });
    networkApi.fetch.mockResolvedValue(new Response(JSON.stringify({ ...response, banks: [bank, { ...bank, country: "invalid" }] })));
    await expect(WalletService.bankArtwork(CONTEXT, input)).rejects.toThrow("Bank designs unavailable");
  });
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
  it("bounds artwork requests and sends only the permitted prefix metadata", async () => {
    vi.useFakeTimers();
    networkApi.fetch.mockImplementation(() => new Promise(() => {}));
    try {
      const result = WalletService.resolveCardArtwork(CONTEXT, { iinPrefix: "42424200", panLength: 16, pan: "4242424242424242", cvv: "123", pin: "1234", cardholderName: "Private" } as Parameters<typeof WalletService.resolveCardArtwork>[1]);
      const rejected = expect(result).rejects.toThrow("Artwork unavailable");
      await vi.advanceTimersByTimeAsync(8001); await rejected;
      const [, options] = networkApi.fetch.mock.calls[0]!;
      expect(JSON.parse(options.body)).toEqual({ iinPrefix: "42424200", panLength: 16 });
      expect(options.signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each([true, false])("adopts current overlay permission %s without rewriting saved records", async currentOverlay => {
    const artwork = approveWalletCatalogArtwork({ source: "catalog", version: 1, assetId: "synthetic", issuerId: "issuer", productId: "product", variantId: "blue", catalogVersion: "previous-version", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: !currentOverlay, evidence: "owner_selected" }, CONTEXT.userId, snapshotVaultSessionEpoch());
    const original = { ...DOMAIN_DATA, artwork: { [CARD_ID]: artwork }, sharing: { preserved: true } };
    mockLoadDomainData.mockResolvedValue(original);
    networkApi.fetch.mockResolvedValue(new Response(JSON.stringify({ selections: [{ assetId: "synthetic", approved: true, allowOverlay: currentOverlay }] })));
    expect((await WalletService.listCardPresentations(CONTEXT))[0]!.artwork).toMatchObject({ source: "catalog", catalogVersion: "previous-version", allowOverlay: currentOverlay });
    expect(JSON.parse(networkApi.fetch.mock.calls[0]![1].body).purpose).toBe("saved");
    expect(original.artwork[CARD_ID].allowOverlay).toBe(!currentOverlay);
    expect(mockStoreWalletDomain).not.toHaveBeenCalled();
    await WalletService.updateCardArtwork({ ...CONTEXT, cardId: CARD_ID, artwork: { source: "neutral", version: 1 } });
    const changed = mockStoreWalletDomain.mock.calls[0]![0].applyMutation(original);
    expect(changed.summary).toBe(original.summary); expect(changed.secrets).toBe(original.secrets); expect(changed.sharing).toBe(original.sharing);
    expect(changed.artwork).toEqual({ [CARD_ID]: { source: "neutral", version: 1 } });
  });
  it.each(["current", "overlay-withdrawn", "source-withdrawn", "target-withdrawn", "mapping-changed", "owner-changed"])("loads a reviewed cleaned revision only while both approvals remain current: %s", async state => {
    vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("crypto", webcrypto);
    try {
      const blob = await encodeCardPng({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) });
      const bytes = await blob.arrayBuffer(), digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
      const original = { ...DOMAIN_DATA, artwork: { [CARD_ID]: { source: "catalog", version: 1, assetId: "previous", issuerId: "issuer", productId: "product", variantId: "blue", digest: "a".repeat(64), catalogVersion: "old", image: "data:image/png;base64,c3ludGhldGlj", evidence: "network_assigned", allowOverlay: false } } };
      const before = JSON.stringify(original);
      const variant = { assetId: "cleaned", issuerId: "issuer", productId: "product", variantId: "blue", label: "Cleaned", digest, image: `/api/one/wallet/card-access/artwork/assets/${digest}`, allowOverlay: true };
      let downloaded = false;
      mockLoadDomainData.mockResolvedValue(original);
      networkApi.fetch.mockImplementation(async (url, options) => {
        if (!url.endsWith("/validate")) {
          downloaded = true;
          if (state === "owner-changed") advanceVaultSessionEpoch();
          return new Response(bytes, { headers: { "Content-Type": "image/png" } });
        }
        const input = JSON.parse(options.body), source = input.selections[0].assetId === "previous";
        const approved = !(downloaded && ((source && state === "source-withdrawn") || (!source && state === "target-withdrawn")));
        const allowOverlay = approved && !(downloaded && state === "overlay-withdrawn");
        return new Response(JSON.stringify({ selections: [{ assetId: source ? "previous" : "cleaned", approved, allowOverlay,
          ...(source && approved ? { replacement: { catalogVersion: "current", variant: { ...variant, allowOverlay, ...(downloaded && state === "mapping-changed" ? { assetId: "different-cleaned" } : {}) } } } : {}) }] }));
      });
      const pending = WalletService.listCardPresentations(CONTEXT);
      if (state === "owner-changed") await expect(pending).rejects.toThrow("Wallet changed");
      else {
        const card = (await pending)[0]!;
        expect(card.artwork).toMatchObject(["current", "overlay-withdrawn"].includes(state) ? { source: "catalog", assetId: "cleaned", digest, allowOverlay: state === "current" } : { source: "neutral" });
        if (state === "current") await expect(WalletService.updateCardArtwork({ ...CONTEXT, cardId: CARD_ID, artwork: card.artwork! })).rejects.toThrow();
      }
      expect(JSON.stringify(original)).toBe(before);
      expect(mockStoreWalletDomain).not.toHaveBeenCalled();
      const wire = JSON.stringify(networkApi.fetch.mock.calls.map(([, options]) => options.body));
      for (const secret of [DOMAIN_DATA.secrets[CARD_ID].pan, "A Person", "data:image", CARD_ID]) expect(wire).not.toContain(secret);
    } finally { vi.unstubAllGlobals(); }
  });
  it("retains one fallback identity when an uncertain save is retried after registration recovers", async () => {
    const draftId = "123E4567-E89B-12D3-A456-426614174088", reserveCardId = vi.fn().mockResolvedValueOnce(null).mockResolvedValue("card_registered_later");
    const card = { draftId, pan: "4111111111111111", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2030 };
    mockStoreWalletDomain.mockRejectedValueOnce(new Error("Synthetic uncertain receipt")).mockResolvedValue({ success: true });
    await expect(WalletService.addCard({ ...CONTEXT, card, surface: "web", source: "one_wallet_add", reserveCardId })).rejects.toThrow("uncertain");
    const saved = await WalletService.addCard({ ...CONTEXT, card, surface: "web", source: "one_wallet_add", reserveCardId });
    expect(saved.cardId).toBe(`card_${draftId.toLowerCase()}`); expect(reserveCardId).toHaveBeenCalledOnce();
    const ids = await Promise.all(mockStoreWalletDomain.mock.calls.map(async ([call]) => Object.keys((await call.applyMutation({})).summary)));
    expect(ids).toEqual([[saved.cardId], [saved.cardId]]);
    await expect(WalletService.addCard({ ...CONTEXT, card: { ...card, draftId: "-".repeat(36) }, surface: "web", source: "one_wallet_add" })).rejects.toThrow("Invalid card draft");
  });
  it("saves valid details with neutral artwork when catalog approval is revoked while reviewing", async () => {
    const artwork = approveWalletCatalogArtwork({ source: "catalog", version: 1, assetId: "synthetic", issuerId: "issuer", productId: "product", variantId: "blue", catalogVersion: "test-1", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: false, evidence: "owner_selected" }, CONTEXT.userId, snapshotVaultSessionEpoch());
    networkApi.fetch.mockImplementation(async (url) => url.endsWith("/artwork/validate") ? new Response(JSON.stringify({ selections: [{ assetId: "synthetic", approved: false, allowOverlay: false }] })) : new Response(JSON.stringify({ network: "visa", source: "prefix", candidates: [] })));
    const saved = await WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2030, artwork }, surface: "web", source: "one_wallet_add" });
    expect(saved.artwork).toEqual({ source: "neutral", version: 1 });
    const result = await mockStoreWalletDomain.mock.calls[0]![0].applyMutation({}); expect(result.artwork[saved.cardId]).toEqual(saved.artwork);
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

  it("keeps manual codes out of card readers and exposes them only through the owner action", async () => {
    expect(await WalletService.getCardSecurityCode({ ...CONTEXT, cardId: CARD_ID })).toBeUndefined();
    mockLoadDomainData.mockResolvedValue({ ...DOMAIN_DATA, secrets: { [CARD_ID]: { ...DOMAIN_DATA.secrets[CARD_ID], manual_cvv: "007" } } });
    expect(await WalletService.getCardSecurityCode({ ...CONTEXT, cardId: CARD_ID })).toBe("007");
    expect((await WalletService.getCard({ ...CONTEXT, cardId: CARD_ID }))?.secrets).toEqual({ pan: "4111111111111111", cardholderName: "A Person" });
    expect(JSON.stringify(await WalletService.listCardPresentations(CONTEXT))).not.toContain("007");
    let finish!: (data: typeof DOMAIN_DATA) => void;
    mockLoadDomainData.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const read = WalletService.getCardSecurityCode({ ...CONTEXT, cardId: CARD_ID });
    advanceVaultSessionEpoch();
    finish(DOMAIN_DATA);
    await expect(read).rejects.toThrow("Wallet changed");
  });

  it("writes a manual code with exact owner authority and never sends it for network resolution", async () => {
    const card = { pan: "4111111111111111", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2099, securityCode: "0123" };
    const saved = await WalletService.addCard({ ...CONTEXT, card, surface: "web", source: "one_wallet_add" });
    const call = mockStoreWalletDomain.mock.calls[0][0];
    expect(call.securityCodeChange).toEqual({ cardId: saved.cardId, value: "0123" });
    const domain = await call.applyMutation({});
    expect(domain.secrets[saved.cardId].manual_cvv).toBe("0123");
    expect(JSON.stringify([saved, domain.summary, networkApi.fetch.mock.calls])).not.toContain("0123");
    mockStoreWalletDomain.mockClear();
    await expect(WalletService.addCard({ ...CONTEXT, card, surface: "chat", source: "agent_chat_wallet_add" })).rejects.toThrow("Security code write unavailable");
    expect(mockStoreWalletDomain).not.toHaveBeenCalled();
  });

  it("never carries a previous number's code onto a changed retry number", async () => {
    await WalletService.addCard({ ...CONTEXT, card: { draftId: CARD_ID.slice(5), pan: "4242424242424242", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "one_wallet_add" });
    const call = mockStoreWalletDomain.mock.calls[0][0];
    await expect(call.applyMutation({ ...DOMAIN_DATA, secrets: { [CARD_ID]: { ...DOMAIN_DATA.secrets[CARD_ID], manual_cvv: "007" } } })).rejects.toThrow("cancel and start a new card");
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
    const mutated = await call.applyMutation({});
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
    const mutated = await call.applyMutation(original);
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
    const mutated = await call.applyMutation(structuredClone(DOMAIN_DATA));
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
 mockLoadDomainData.mockResolvedValueOnce(await mockStoreWalletDomain.mock.calls[0][0].applyMutation({}));
 expect((await WalletService.listCardSummaries(CONTEXT))[0].brand).toBe("future_network");
});
it("rejects malformed backend catalogue entries instead of silently hiding options", async () => {
 networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ networks: ["visa", "invalid/network"] })));
 await expect(WalletService.supportedCardNetworks(CONTEXT)).rejects.toThrow("Network identification unavailable");
});
 beforeEach(() => { vi.clearAllMocks(); networkApi.fetch.mockReset(); mockStoreWalletDomain.mockResolvedValue({ success: true }); mockLoadDomainData.mockResolvedValue(DOMAIN_DATA); });
it.each([12, 16])("requests only issuer metadata for a %s-digit number and never card credentials", async panLength => {
 networkApi.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ network: "visa", source: "prefix", candidates: [] })));
 await WalletService.resolveCardNetwork(CONTEXT, { iinPrefix: "411111", panLength, pan: "4111111111111111", cvv: "123", pin: "1234" } as never);
 const [url, options] = networkApi.fetch.mock.calls[0];
 expect(url).toBe("/api/one/wallet/card-access/networks/resolve");
 expect(JSON.parse(options.body)).toEqual({ iinPrefix: "411111", panLength });
 expect(options.headers["X-Hushh-Consent"]).toBe(CONTEXT.vaultOwnerToken);
 expect(options.cache).toBe("no-store");
});
it("uses a neutral brand when backend identification fails", async () => {
 networkApi.fetch.mockResolvedValueOnce(new Response("private diagnostic", { status: 503 }));
 const saved = await WalletService.addCard({ ...CONTEXT, card: { pan: "4111111111111111", cardholderName: "Test Owner", cvv: "123", expiryMonth: 12, expiryYear: 2099 }, surface: "web", source: "test" });
 expect(saved.summary.brand).toBe("other");
 expect(JSON.stringify(await mockStoreWalletDomain.mock.calls[0][0].applyMutation({}))).not.toContain("iinPrefix");
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
  await expect(params.applyMutation({})).rejects.toThrow("Wallet changed.");
});

});


describe("explicit bank and card product artwork", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  const card = { draftId: "323e4567-e89b-12d3-a456-426614174000", pan: "4111111111111111", brand: "visa" as const, bankName: "Selected Bank", cardProduct: "Selected Product", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2099, issuingRegion: "US" };
  const params = () => ({ ...CONTEXT, card: { ...card }, surface: "web" as const, source: "one_wallet_add" });

  async function catalog() {
    vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("crypto", webcrypto);
    const designs = await Promise.all([0, 1].map(async index => {
      const bytes = await (await encodeCardPng({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(100 + index) })).arrayBuffer();
      const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      return { bytes, variant: { assetId: `design-${index}`, issuerId: "selected-bank", productId: `product-${index}`, productName: index ? "Different Product" : card.cardProduct, country: "US", variantId: "v1", label: "Catalog design", digest, image: `/api/one/wallet/card-access/artwork/assets/${digest}`, allowOverlay: false } };
    }));
    const bank = { bankKey: "b".repeat(32), issuerId: "selected-bank", name: card.bankName, country: "US", designCount: 2 };
    networkApi.fetch.mockImplementation(async (url, options) => {
      const input = options?.body ? JSON.parse(options.body) : {};
      if (url.endsWith("/artwork/banks")) return new Response(JSON.stringify({ catalogVersion: "products-v1", selectionBasis: "owner_selected_bank", requiresConfirmation: true, banks: [bank], bankKey: input.bankKey ?? null, variants: input.bankKey ? designs.map(row => row.variant) : [], nextOffset: null }));
      if (url.endsWith("/validate")) return new Response(JSON.stringify({ selections: input.selections.map((row: { assetId: string }) => ({ assetId: row.assetId, approved: row.assetId !== "withdrawn", allowOverlay: false })) }));
      if (url.includes("/assets/")) return new Response(designs.find(row => url.endsWith(row.variant.digest))!.bytes, { headers: { "Content-Type": "image/png" } });
      throw new Error("Unexpected identification request");
    });
    return designs;
  }

  it("uses the selected product for different numbers, persists encrypted names and keeps the image on retry/reload", async () => {
    const designs = await catalog();
    let base: Record<string, any> = {};
    mockStoreWalletDomain.mockImplementation(async p => { base = await p.applyMutation(base); return { success: true }; });
    const first = await WalletService.addCard(params());
    const second = await WalletService.addCard({ ...params(), card: { ...card, draftId: "423e4567-e89b-12d3-a456-426614174000", pan: "4242424242424242" } });
    expect(first.artwork).toMatchObject({ source: "catalog", digest: designs[0]!.variant.digest, evidence: "owner_selected" });
    expect(second.artwork).toEqual(first.artwork);
    expect(base.secrets[first.cardId]).toMatchObject({ bank_name: card.bankName, card_product: card.cardProduct });
    expect(base.summary[first.cardId]).not.toHaveProperty("bank_name");
    const transport = networkApi.fetch.getMockImplementation()!;
    networkApi.fetch.mockImplementation(async (url, options) => url.includes("/assets/") ? new Response("Outage", { status: 503 }) : transport(url, options));
    expect((await WalletService.addCard(params())).artwork).toEqual(first.artwork);
    mockLoadDomainData.mockResolvedValue(base);
    expect((await WalletService.listCardPresentations(CONTEXT)).find(row => row.summary.cardId === first.cardId)?.artwork).toEqual(first.artwork);
    const wire = networkApi.fetch.mock.calls.map(([url, options]) => url + (options?.body ?? "")).join(" ");
    for (const secret of [card.pan, card.pan.slice(0, 6), "4242424242424242", card.cardholderName, card.bankName, card.cardProduct, CONTEXT.vaultKey]) expect(wire).not.toContain(secret);
    expect(wire).not.toContain("networks/resolve"); expect(wire).not.toContain('"automatic":true');
    expect((await WalletService.getCard({ ...CONTEXT, cardId: first.cardId }))?.secrets).toEqual({ pan: card.pan, cardholderName: card.cardholderName });
  });

  it.each(["unknown bank", "unknown product", "ambiguous product", "catalog changed", "outage", "corrupt image"])("saves neutral without another product's image for %s", async state => {
    const designs = await catalog(), input = params();
    if (state === "unknown bank") input.card.bankName = "Unlisted Bank";
    if (state === "unknown product") input.card.cardProduct = "Unlisted Product";
    const transport = networkApi.fetch.getMockImplementation()!;
    networkApi.fetch.mockImplementation(async (url, options) => {
      if (state === "outage") return new Response("Outage", { status: 503 });
      if (state === "corrupt image" && url.includes("/assets/")) return new Response(designs[1]!.bytes, { headers: { "Content-Type": "image/png" } });
      const response = await transport(url, options);
      if (url.endsWith("/artwork/banks") && JSON.parse(options.body).bankKey) {
        const data = await response.json();
        if (state === "catalog changed") data.catalogVersion = "changed";
        if (state === "ambiguous product") data.variants[1].productName = card.cardProduct;
        return new Response(JSON.stringify(data));
      }
      return response;
    });
    let saved: any;
    mockStoreWalletDomain.mockImplementation(async p => { saved = await p.applyMutation({}); return { success: true }; });
    const result = await WalletService.addCard(input);
    expect(result.artwork).toEqual({ source: "neutral", version: 1 });
    expect(saved.secrets[result.cardId].bank_name).toBe(input.card.bankName);
    expect(saved.summary[result.cardId].last4).toBe("1111");
  });

  it("never preserves a different country's artwork when retrying the draft", async () => {
    await catalog(); let base: any = {};
    mockStoreWalletDomain.mockImplementation(async p => { base = await p.applyMutation(base); return { success: true }; });
    const first = await WalletService.addCard(params());
    expect(first.artwork?.source).toBe("catalog");
    networkApi.fetch.mockResolvedValue(new Response("Outage", { status: 503 }));
    const retry = await WalletService.addCard({ ...params(), card: { ...card, issuingRegion: "CA" } });
    expect(retry.cardId).toBe(first.cardId); expect(retry.artwork?.source).toBe("neutral");
  });

  it("keeps saving valid details when the optional image exceeds the encrypted artwork budget", async () => {
    await catalog(); const artwork = { existing: "x".repeat(MAX_WALLET_ARTWORK_CHARACTERS - 16) };
    let saved: any;
    mockStoreWalletDomain.mockImplementation(async p => { saved = await p.applyMutation({ artwork }); return { success: true }; });
    const result = await WalletService.addCard(params());
    expect(saved.summary[result.cardId]).toBeTruthy(); expect(result.artwork).toBeUndefined();
    expect(saved.artwork).toEqual(artwork);
  });

  it("recovers only explicit saved products and preserves photos and unknown legacy cards without a write", async () => {
    const designs = await catalog();
    const photo = { source: "photo", version: 1, sanitizerVersion: 1, image: "data:image/png;base64,c3ludGhldGlj", digest: "c".repeat(64) };
    const domain = { summary: { selected: DOMAIN_DATA.summary[CARD_ID], legacy: DOMAIN_DATA.summary[CARD_ID], photo: DOMAIN_DATA.summary[CARD_ID] }, secrets: { selected: { ...DOMAIN_DATA.secrets[CARD_ID], bank_name: card.bankName, card_product: card.cardProduct }, legacy: DOMAIN_DATA.secrets[CARD_ID], photo: DOMAIN_DATA.secrets[CARD_ID] }, artwork: { photo } };
    const before = JSON.stringify(domain); mockLoadDomainData.mockResolvedValue(domain); mockStoreWalletDomain.mockClear();
    const rows = await WalletService.listCardPresentations(CONTEXT, { recoverArtwork: true });
    expect(rows.find(row => row.summary.cardId === "selected")?.artwork).toMatchObject({ digest: designs[0]!.variant.digest });
    expect(rows.find(row => row.summary.cardId === "legacy")?.artwork).toBeUndefined();
    expect(rows.find(row => row.summary.cardId === "photo")?.artwork).toEqual(photo);
    expect(JSON.stringify(domain)).toBe(before); expect(mockStoreWalletDomain).not.toHaveBeenCalled();
  });

  it("rejects late artwork after an owner/vault change", async () => {
    await catalog(); const transport = networkApi.fetch.getMockImplementation()!;
    networkApi.fetch.mockImplementation(async (url, options) => { if (url.includes("/assets/")) advanceVaultSessionEpoch(); return transport(url, options); });
    mockStoreWalletDomain.mockClear();
    await expect(WalletService.addCard(params())).rejects.toThrow("Wallet changed");
    expect(mockStoreWalletDomain).not.toHaveBeenCalled();
  });

  it("does not turn a temporary validation outage into an authoritative denial", async () => {
    const designs = await catalog();
    const saved = { ...designs[0]!.variant, source: "catalog", version: 1, catalogVersion: "old-v1", image: "data:image/png;base64,c3ludGhldGlj", evidence: "owner_selected" };
    mockLoadDomainData.mockResolvedValue({ ...DOMAIN_DATA, artwork: { [CARD_ID]: saved } });
    networkApi.fetch.mockRejectedValue(new Error("offline")); const rejected = vi.fn();
    await expect(WalletService.listCardPresentations(CONTEXT, { failOnArtworkUnavailable: true, onArtworkRejected: rejected })).rejects.toThrow("offline");
    expect(rejected).not.toHaveBeenCalled();
    expect((await WalletService.listCardPresentations(CONTEXT))[0]!.artwork?.source).toBe("neutral");
  });
});
