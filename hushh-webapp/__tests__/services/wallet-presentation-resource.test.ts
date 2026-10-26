import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletService } from "@/lib/services/wallet-service";
import { WalletPresentationResource } from "@/lib/services/wallet-presentation-resource";
import { CacheService } from "@/lib/services/cache-service";
import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { approveWalletCatalogArtwork } from "@/lib/wallet/card-artwork";

const CONTEXT = { userId: "user_1", vaultKey: "vault_key", vaultOwnerToken: "vault_owner_token" };
const CARD_ID = "card_123e4567-e89b-12d3-a456-426614174000";
beforeEach(() => publishValidatedAuthSessionOwner(CONTEXT.userId));

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
  it("publishes masked cards before artwork settles and fences progress after session changes", async () => {
    let publish!: NonNullable<Parameters<typeof WalletService.listCardPresentations>[1]>["onCardsLoaded"];
    let finish!: (rows: ReturnType<typeof row>[]) => void;
    vi.spyOn(WalletService, "listCardPresentations").mockImplementationOnce((_context, options) => {
      publish = options!.onCardsLoaded;
      return new Promise(resolve => { finish = resolve; });
    });
    const progress = vi.fn();
    const pending = WalletPresentationResource.load(CONTEXT, { onCardsLoaded: progress });
    const masked = { ...row(), artwork: undefined, pan: "4111111111111111", vaultKey: CONTEXT.vaultKey };
    publish!([masked]);
    expect(progress).toHaveBeenCalledOnce();
    expect(progress.mock.calls[0]![0].rows[0].summary.last4).toBe("1111");
    expect(JSON.stringify(progress.mock.calls[0])).not.toContain(masked.pan);
    expect(JSON.stringify(progress.mock.calls[0])).not.toContain(CONTEXT.vaultKey);
    expect(WalletPresentationResource.peek(CONTEXT.userId)).toBeNull();
    advanceVaultSessionEpoch();
    publish!([masked]);
    expect(progress).toHaveBeenCalledOnce();
    finish([row()]);
    await expect(pending).rejects.toThrow("Wallet changed");
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
