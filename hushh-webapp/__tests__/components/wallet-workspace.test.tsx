import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenWalletSwipeHint: vi.fn().mockResolvedValue(true),
    markWalletSwipeHintSeen: vi.fn().mockResolvedValue(undefined),
    hasSeenWalletIntroduction: vi.fn().mockResolvedValue(false),
    markWalletIntroductionSeen: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/components/wallet/wallet-sharing", () => ({ WalletSharing: () => <section>Card recipients</section> }));
vi.mock("@/lib/services/wallet-card-artwork-service", () => ({ loadWalletCardArtwork: vi.fn().mockResolvedValue("<svg></svg>") }));

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/wallet",
  search: "",
  replace: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  user: { uid: "user_1" } as { uid: string; displayName?: string } | null,
}));
const trackEventMock = vi.hoisted(() => vi.fn());
const nativeBeaconMock = vi.hoisted(() => vi.fn());
const vaultMock = vi.hoisted(() => ({ locked: false, tokenReady: true, token: "owner_token" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({ replace: navigationMock.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigationMock.search),
}));

vi.mock("@/hooks/use-effective-avatar-url", () => ({ useEffectiveAvatarUrl: () => null }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => { publishValidatedAuthSessionOwner(authMock.user?.uid ?? null); return { user: authMock.user, loading: false }; },
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: trackEventMock,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () =>
    vaultMock.locked
      ? { vaultKey: null, vaultOwnerToken: null, getVaultOwnerToken: () => null }
      : { vaultKey: "vault_key", vaultOwnerToken: vaultMock.tokenReady ? vaultMock.token : null, getVaultOwnerToken: () => vaultMock.tokenReady ? vaultMock.token : null },
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="vault-unlock-dialog" /> : null,
}));

vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: (props: { dataState: string }) => {
    nativeBeaconMock(props);
    return null;
  },
}));

const serviceMock = vi.hoisted(() => ({
  listCardSummaries: vi.fn(),
  recoverCardArtworks: vi.fn(),
  deleteCard: vi.fn(),
  getCard: vi.fn(),
  addCard: vi.fn(),
}));
const profileMock = vi.hoisted(() => ({ getCard: vi.fn().mockResolvedValue({ card: null, shareUrl: null }) }));
vi.mock("@/lib/services/wallet-card-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/wallet-card-service")>("@/lib/services/wallet-card-service");
  return { ...actual, WalletCardService: class extends actual.WalletCardService { static getCard = profileMock.getCard; } };
});

// Keep the real dropdown and limit its catalog to the regions used by this suite.
vi.mock("@/lib/constants/country-phone-options", () => ({ COUNTRY_PHONE_OPTIONS: [
  { value: "US", label: "United States" }, { value: "IN", label: "India" },
] }));

vi.mock("@/lib/services/wallet-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/wallet-service")>(
    "@/lib/services/wallet-service",
  );
  return {
    ...actual,
    WalletService: {
      ...actual.WalletService,
      isEnabled: () => true,
      supportedCardNetworks: vi.fn().mockResolvedValue(["visa", "mastercard", "amex", "discover", "jcb", "diners", "unionpay", "maestro", "rupay", "elo", "mir", "other"]),
      resolveCardNetwork: vi.fn().mockResolvedValue({ network: "visa", source: "prefix", candidates: [] }),
      resolveCardArtwork: vi.fn().mockResolvedValue({ catalogVersion: "empty-1", match: "unknown", provider: "unconfigured", issuerId: null, variants: [] }),
      listCardPresentations: async (...args: unknown[]) => {
        const rows = (await serviceMock.listCardSummaries(...args)).map((summary: unknown) => ({ summary, cardholderName: "Test Cardholder" }));
        if ((args[1] as { recoverArtwork?: boolean } | undefined)?.recoverArtwork) {
          const recovered = await serviceMock.recoverCardArtworks(...args);
          return recovered.length ? recovered : rows;
        }
        return rows;
      },
      deleteCard: serviceMock.deleteCard,
      getCard: serviceMock.getCard,
      listCardShareReceipts: vi.fn().mockResolvedValue([]),
      addCard: async (...args: unknown[]) => { const saved = await serviceMock.addCard(...args); bumpPkmInvalidationEpoch("user_1", "wallet"); return saved; },
      matchesQuery: actual.WalletService.matchesQuery,
    },
  };
});

import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { WalletWorkspace } from "@/components/wallet/wallet-workspace";
import { stageReservedOfferPrefill } from "@/lib/pkm/reserved-offer";
import { WalletCardService, type WalletCardRecord } from "@/lib/services/wallet-card-service";
import { WalletService, type WalletCardPresentation } from "@/lib/services/wallet-service";
import * as walletCardArtwork from "@/lib/services/wallet-card-artwork-service";
import { decodePayload } from "@/components/wallet-card/__tests__/qr-code-test-decoder";

function makeCards(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    cardId: `card_${i}`,
    nickname: i === 3 ? "Travel Amex" : `Card ${i}`,
    brand: i === 3 ? "amex" : "visa",
    last4: String(1000 + i),
    expiryMonth: 4,
    expiryYear: 2030,
    issuingRegion: i % 2 ? "IN" : "US",
    createdAt: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z`,
  }));
}

describe("WalletWorkspace at scale", () => {
  it("conceals profile artwork across owner replacement, return and lock", async () => {
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValue(true);
    serviceMock.listCardSummaries.mockResolvedValue([]);
    authMock.user = { uid: "user_1", displayName: "Public owner A" };
    const completions: Array<(value: { card: { cardPayload: { full_name: string } }; shareUrl: null }) => void> = [];
    profileMock.getCard.mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    vi.spyOn(walletCardArtwork, "loadWalletCardArtwork").mockImplementation(async (kind) =>
      readFileSync(join(process.cwd(), `public/wallet/artwork/${kind}-v1.svg`), "utf8"));
    const images = new Map<string, Blob>();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { const url = `blob:owner-${images.size}`; images.set(url, blob); return url; });
      static revokeObjectURL = vi.fn();
    });
    const workspace = render(<WalletWorkspace />);
    const renderedName = async () => {
      const img = workspace.container.querySelector<HTMLImageElement>('[data-agent-card="profile"] img');
      const blob = img && images.get(img.getAttribute("src")!);
      if (!blob) return "";
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(new DOMParser().parseFromString(String(reader.result), "image/svg+xml").querySelector("[data-wallet-identity]")?.textContent?.trim() || "");
        reader.onerror = reject; reader.readAsText(blob);
      });
    };
    await waitFor(() => expect(completions).toHaveLength(1));
    await act(async () => { completions[0]!({ card: { cardPayload: { full_name: "Saved owner A" } }, shareUrl: null }); });
    await waitFor(async () => expect(await renderedName()).toContain("Saved owner A"));
    authMock.user = { uid: "owner_b", displayName: "Public owner B" };
    workspace.rerender(<WalletWorkspace />);
    await waitFor(() => expect(completions).toHaveLength(2));
    expect(await renderedName()).not.toContain("Saved owner A");
    authMock.user = { uid: "user_1", displayName: "Public owner A" };
    workspace.rerender(<WalletWorkspace />);
    await waitFor(() => expect(completions).toHaveLength(3));
    await act(async () => { completions[1]!({ card: { cardPayload: { full_name: "Late owner B" } }, shareUrl: null }); });
    expect(await renderedName()).not.toContain("Late owner B");
    expect(await renderedName()).not.toContain("Saved owner A");
    vaultMock.locked = true; workspace.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    await act(async () => { completions[2]!({ card: { cardPayload: { full_name: "Late owner A" } }, shareUrl: null }); });
    vaultMock.locked = false; workspace.rerender(<WalletWorkspace />);
    await waitFor(() => expect(completions).toHaveLength(4));
    expect(await renderedName()).not.toContain("Late owner A");
  });

  it.each([0, 60_001])("keeps a current display approval during resume, expires it fail-closed, and applies revocation (elapsed %d)", async elapsed => {
    let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const row: WalletCardPresentation = { summary: { ...makeCards(1)[0]!, brand: "visa" }, cardholderName: "Synthetic Owner", artwork: { source: "catalog", version: 1, assetId: "owned", issuerId: "owned", productId: "test", variantId: "blue", catalogVersion: "owned-1", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: false, evidence: "owner_selected" } };
    let finish!: (rows: WalletCardPresentation[]) => void;
    const pending = new Promise<WalletCardPresentation[]>(resolve => { finish = resolve; });
    const load = vi.spyOn(WalletService, "listCardPresentations").mockResolvedValueOnce([row]).mockReturnValue(pending);
    const view = render(<WalletWorkspace />);
    await waitFor(() => expect(view.container.querySelector('[data-card-artwork="catalog"]')).not.toBeNull());
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenNthCalledWith(1, expect.any(Object), expect.objectContaining({ recoverArtwork: true }));
    now += elapsed; fireEvent.focus(window);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(Boolean(view.container.querySelector('[data-card-artwork="catalog"]'))).toBe(elapsed < 60_000);
    expect(Boolean(view.container.querySelector('[data-card-artwork="pending"]'))).toBe(elapsed >= 60_000);
    expect(view.container.querySelector('[data-card-artwork="neutral"]')).toBeNull();
    if (elapsed === 0) {
      // The displayed cleaned target has a different digest from its persisted
      // source. A source denial must hide it before another image settles.
      await act(async () => { load.mock.calls[1]![1]!.onArtworkRejected?.([{ cardId: row.summary.cardId, assetId: "legacy-source", digest: "b".repeat(64) }]); });
      expect(view.container.querySelector('[data-card-artwork="catalog"]')).toBeNull();
    }
    await act(async () => { finish([{ ...row, artwork: { source: "neutral", version: 1 } }]); });
    expect(view.container.querySelector('[data-card-artwork="catalog"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Card 0", exact: true })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  });
  it("loads cards when the owner token arrives after the vault key", async () => {
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    vaultMock.tokenReady = false;
    serviceMock.listCardSummaries.mockResolvedValue([]);
    const view = render(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(serviceMock.listCardSummaries).not.toHaveBeenCalled();
    vaultMock.tokenReady = true;
    view.rerender(<WalletWorkspace />);
    await waitFor(() => expect(serviceMock.listCardSummaries).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add", exact: true })).toBeEnabled());
  });
  it("expires artwork even after a card is added while the focus recheck is stalled", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const row: WalletCardPresentation = { summary: makeCards(1)[0]!, cardholderName: "Synthetic Owner", artwork: { source: "catalog", version: 1, assetId: "owned", issuerId: "owned", productId: "test", variantId: "blue", catalogVersion: "owned-1", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: false, evidence: "owner_selected" } };
      let finish!: (rows: WalletCardPresentation[]) => void;
      const pending = new Promise<WalletCardPresentation[]>(resolve => { finish = resolve; });
      vi.spyOn(WalletService, "listCardPresentations").mockResolvedValueOnce([row]).mockReturnValue(pending);
      serviceMock.addCard.mockResolvedValueOnce({ cardId: "saved", summary: { ...makeCards(1)[0]!, cardId: "saved", nickname: "New card" }, cardholderName: "NEW CARD", artwork: row.artwork });
      const view = render(<WalletWorkspace />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(view.container.querySelector('[data-card-artwork="catalog"]')).not.toBeNull();
      fireEvent.focus(window);
      fireEvent.click(screen.getByRole("tab", { name: "Add", exact: true })); fillCard();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      fireEvent.click(screen.getByTestId("secure-card-save"));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.getByRole("button", { name: "Open New card, ending 1000" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
      expect(view.container.querySelector('[data-card-artwork="catalog"]')).toBeNull();
      await act(async () => { finish([row]); });
      expect(view.container.querySelector('[data-card-artwork="catalog"]')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("gives a new save fresh artwork after expiry without reviving expired cards", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const artwork = { source: "catalog", version: 1, assetId: "owned", issuerId: "owned", productId: "test", variantId: "blue", catalogVersion: "owned-1", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: false, evidence: "owner_selected" } as const;
      const row: WalletCardPresentation = { summary: makeCards(1)[0]!, cardholderName: "Synthetic Owner", artwork };
      let finish!: (rows: WalletCardPresentation[]) => void;
      const pending = new Promise<WalletCardPresentation[]>(resolve => { finish = resolve; });
      vi.spyOn(WalletService, "listCardPresentations").mockResolvedValueOnce([row]).mockReturnValueOnce(pending).mockReturnValue(new Promise(() => {}));
      serviceMock.addCard.mockResolvedValueOnce({ cardId: "saved", summary: { ...row.summary, cardId: "saved", nickname: "New card" }, cardholderName: "NEW CARD", artwork: { ...artwork, assetId: "fresh", digest: "b".repeat(64) } });
      const view = render(<WalletWorkspace />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
      expect(view.container.querySelector('[data-card-artwork="catalog"]')).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: "Add", exact: true })); fillCard();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      fireEvent.click(screen.getByTestId("secure-card-save"));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(view.container.querySelector('[data-artwork-asset-id="fresh"]')).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
      expect(view.container.querySelector('[data-card-artwork="catalog"]')).toBeNull();
      await act(async () => { finish([row]); });
      fireEvent.click(screen.getByRole("button", { name: "Open New card, ending 1000" }));
      expect(view.container.querySelector('[data-artwork-asset-id="fresh"]')).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("refreshes the profile QR after a remote rotation without reopening Wallet", async () => {
    const card = { status: "active", displayName: "Ada", cardPayload: { full_name: "Ada" }, shareTokenVersion: 1 } as WalletCardRecord;
    const rotated = { ...card, shareTokenVersion: 2 };
    let changed: (() => void) | undefined;
    let recovered = false;
    const getCard = vi.spyOn(WalletCardService, "getCard")
      .mockResolvedValueOnce({ enabled: true, exists: true, card, shareUrl: "https://one.hushh.ai/c/original" })
      .mockResolvedValue({ enabled: true, exists: true, card: rotated, shareUrl: null });
    vi.spyOn(WalletCardService, "subscribe").mockImplementation((_owner, listener) => { changed = listener; return () => { changed = undefined; }; });
    vi.spyOn(WalletCardService, "readShareLink").mockImplementation((_owner, current) => current?.shareTokenVersion === 1
      ? { shareToken: "original", shareUrl: "https://one.hushh.ai/c/original", version: 1 }
      : recovered ? { shareToken: "rotated", shareUrl: "https://one.hushh.ai/c/rotated", version: 2 } : null);
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const ensure = vi.spyOn(WalletCardService, "ensureCard").mockImplementation(async () => {
      await recovery;
      recovered = true;
      changed?.();
      return { card: rotated, shareToken: "rotated", shareUrl: "https://one.hushh.ai/c/rotated", passUrl: null };
    });
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    serviceMock.listCardSummaries.mockResolvedValue([]);
    // Exercise the real cohesive SVG renderer; only public asset I/O and the
    // browser object-URL boundary are replaced in JSDOM.
    vi.spyOn(walletCardArtwork, "loadWalletCardArtwork").mockImplementation(async (kind) =>
      readFileSync(join(process.cwd(), `public/wallet/artwork/${kind}-v3.svg`), "utf8"));
    const images = new Map<string, Blob>();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        const url = `blob:wallet-rotation-${images.size + 1}`;
        images.set(url, blob);
        return url;
      });
      static revokeObjectURL = vi.fn();
    });
    const { container } = render(<WalletWorkspace />);
    const profileImage = () => container.querySelector<HTMLImageElement>('[data-agent-card="profile"] img');
    const renderedQr = async () => {
      const image = profileImage();
      expect(image).not.toBeNull();
      const blob = images.get(image!.getAttribute("src")!);
      expect(blob).toBeDefined();
      const svg = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsText(blob!);
      });
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(document.querySelector("image")).not.toBeNull();
      const qr = document.querySelector("[data-wallet-qr]");
      expect(qr).not.toBeNull();
      const size = Number(qr!.getAttribute("viewBox")!.split(" ")[2]) - 8;
      const modules = new Uint8Array(size * size);
      for (const run of qr!.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+) (\d+)h(\d+)v1H\d+z/g)) {
        for (let x = Number(run[1]) - 4; x < Number(run[1]) - 4 + Number(run[3]); x += 1) modules[(Number(run[2]) - 4) * size + x] = 1;
      }
      return decodePayload({ size, modules });
    };
    await waitFor(async () => expect(await renderedQr()).toBe("https://one.hushh.ai/c/original"), { timeout: 5000 });
    const originalImage = profileImage()!;
    const originalSource = originalImage.getAttribute("src");
    await act(async () => { fireEvent.load(originalImage); });
    expect(screen.getByRole("img", { name: "Agent One Profile", exact: true })).toBeVisible();

    await act(async () => { changed?.(); });
    await waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    // The revoked link must disappear while its replacement is being recovered.
    expect(originalImage).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(originalSource);
    await act(async () => { finishRecovery(); });
    await waitFor(async () => expect(await renderedQr()).toBe("https://one.hushh.ai/c/rotated"), { timeout: 5000 });
    expect(profileImage()).not.toHaveAttribute("src", originalSource);
    await act(async () => { fireEvent.load(profileImage()!); });
    expect(screen.getByRole("img", { name: "Agent One Profile", exact: true })).toBeVisible();
    expect(ensure).toHaveBeenCalledOnce();
    expect(getCard).toHaveBeenCalledTimes(2);
  });

  it("skips the introduction for an account that has continued before", async () => {
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    serviceMock.listCardSummaries.mockResolvedValue([]);
    render(<WalletWorkspace />);
    expect(await screen.findByRole("tab", { name: "Cards", exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue", exact: true })).toBeNull();
  });
  it("preserves the Cards scroll position during owner-token renewal and resets on tab entry", async () => {
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    serviceMock.listCardSummaries.mockResolvedValue([]);
    const root = document.createElement("div");
    root.dataset.appScrollRoot = "true";
    const scroll = vi.fn();
    root.scrollTo = scroll;
    document.body.append(root);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
    const flush = async () => {
      await act(async () => {
        while (frames.length) frames.splice(0).forEach(callback => callback(0));
      });
    };
    const workspace = render(<WalletWorkspace />);
    try {
      await screen.findByRole("tab", { name: "Cards", exact: true });
      await flush();
      expect(scroll).toHaveBeenCalledTimes(1);
      vaultMock.token = "renewed_owner_token";
      workspace.rerender(<WalletWorkspace />);
      await flush();
      expect(scroll).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("tab", { name: "Sharing", exact: true }));
      fireEvent.click(screen.getByRole("tab", { name: "Cards", exact: true }));
      await flush();
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      vaultMock.token = "owner_token";
      root.remove();
    }
  });
  it("checks a different owner's introduction preference separately", async () => {
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    serviceMock.listCardSummaries.mockResolvedValue([]);
    const view = render(<WalletWorkspace />);
    await screen.findByRole("tab", { name: "Cards", exact: true });
    authMock.user = { uid: "other_owner" };
    view.rerender(<WalletWorkspace />);
    expect(await screen.findByRole("button", { name: "Continue", exact: true })).toBeVisible();
    expect(OnboardingLocalService.hasSeenWalletIntroduction).toHaveBeenCalledWith("other_owner");
  });
  it("fences pending introduction writes across owner replacement and return", async () => {
    const completions: Array<() => void> = [];
    vi.mocked(OnboardingLocalService.markWalletIntroductionSeen).mockImplementation(
      () => new Promise<void>((resolve) => { completions.push(resolve); }),
    );
    serviceMock.listCardSummaries.mockResolvedValue([]);
    const workspace = render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue", exact: true }));
    expect(completions).toHaveLength(1);

    authMock.user = { uid: "other_owner" };
    workspace.rerender(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-empty-action")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
    expect(completions).toHaveLength(2);

    authMock.user = { uid: "user_1" };
    workspace.rerender(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-empty-action")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
    expect(completions).toHaveLength(3);

    // The earlier write for this same owner must not complete the new visit.
    await act(async () => { completions[0](); });
    expect(screen.getByTestId("one-wallet-empty-action")).toBeDisabled();
    expect(screen.queryByRole("tab", { name: "Cards", exact: true })).toBeNull();
    await act(async () => { completions[1](); });
    expect(screen.getByTestId("one-wallet-empty-action")).toBeDisabled();
    await act(async () => { completions[2](); });
    expect(screen.getByRole("tab", { name: "Cards", exact: true })).toBeVisible();
    expect(vi.mocked(OnboardingLocalService.markWalletIntroductionSeen).mock.calls.map(([owner]) => owner))
      .toEqual(["user_1", "other_owner", "user_1"]);
  });
  it("keeps route readiness loading until the owner's introduction preference settles", async () => {
    let finishPreference!: (seen: boolean) => void;
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { finishPreference = resolve; }),
    );
    serviceMock.listCardSummaries.mockResolvedValue([]);
    render(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-workspace")).toHaveAttribute("data-view", "list"));
    expect(screen.getByRole("status")).toHaveTextContent("Opening your wallet…");
    expect(nativeBeaconMock.mock.lastCall?.[0].dataState).toBe("loading");
    await act(async () => { finishPreference(true); });
    expect(screen.getByRole("tab", { name: "Cards", exact: true })).toBeVisible();
    expect(nativeBeaconMock.mock.lastCall?.[0].dataState).toBe("empty-valid");
  });
  const fillCard = () => {
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "New card" } });
    fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "04/30" } });
    fireEvent.change(screen.getByLabelText("Issuing region"), { target: { value: "IN" } });
  };

  it("saves an owner card with an optional masked code", async () => {
    const summary = { ...makeCards(1)[0], cardId: "saved", nickname: "New card", last4: "4242" };
    serviceMock.addCard.mockResolvedValue({ cardId: "saved", summary });
    render(<WalletWorkspace />);
    const button = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(button); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fillCard();
    expect(screen.queryByLabelText("PIN (optional)")).toBeNull();
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "007" } });
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await screen.findByTestId("wallet-selected-card");
    const submitted = serviceMock.addCard.mock.calls[0][0].card;
    expect(submitted).not.toHaveProperty("pin");
    expect(submitted).not.toHaveProperty("cvv");
    expect(submitted.securityCode).toBe("007");
    expect(screen.queryByTestId("secure-card-errors")).toBeNull();
  });

  it("inserts the real saved summary, selects it in Cards, and preserves Cards ordering", async () => {
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(2));
    const summary = { ...makeCards(1)[0], cardId: "saved", nickname: "New card", last4: "4242" };
    serviceMock.addCard.mockResolvedValue({ cardId: "saved", summary });
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fillCard();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByTestId("secure-card-save")); });
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("New card");
    expect(screen.getByRole("button", { name: "Copy card number" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
    expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(2);
    expect(serviceMock.recoverCardArtworks).toHaveBeenCalled();
    // Await the user interactions so the save-to-Cards lifecycle commits
    // before returning to the deck; its complete storage order stays asserted.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back", exact: true })); });
    await waitFor(() => expect(screen.getAllByTestId(/^wallet-add-layer-/).map((el) => el.getAttribute("data-testid"))).toEqual(["wallet-add-layer-agent-one-profile", "wallet-add-layer-agent-one-referral", "wallet-add-layer-agent-one-nws", "wallet-add-layer-1000", "wallet-add-layer-1001", "wallet-add-layer-4242"]));
    expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(2);
  });

  it.each(["Card 0", "Agent One Profile"])("Back restores %s after Add and Sharing without leaving Wallet", async (name) => {
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(1));
    const workspace = render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("button", { name, exact: true }));
    await screen.findByTestId("wallet-selected-card");
    fireEvent.click(screen.getByRole("tab", { name: "Add", exact: true }));
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Unsaved draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Sharing", exact: true }));
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(screen.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Name on card")).toHaveValue("UNSAVED DRAFT");
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(screen.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByLabelText("Name on card")).toHaveValue("");
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(screen.getByTestId("wallet-add-collection")).toBeVisible();
    expect(unwindBackLayer("/one/wallet")).toBe(false);
    workspace.unmount();
  });

  it("returns to the overview after leaving a saved card and switching tabs", async () => {
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(1));
    render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("button", { name: "Card 0" }));
    await screen.findByTestId("wallet-selected-card");
    fireEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
    const browser = screen.getByTestId("wallet-card-browser");
    const deck = screen.getByTestId("wallet-add-collection");
    for (const tab of ["Add", "Sharing"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
      await screen.findByTestId("wallet-add-collection");
      expect(screen.queryByTestId("wallet-selected-card")).toBeNull();
      expect(screen.getByTestId("wallet-card-browser")).toBe(browser);
      expect(screen.getByTestId("wallet-add-collection")).toBe(deck);
    }
  });

  it("retains a failed save draft and rejects a late save after vault lock", async () => {
    serviceMock.addCard.mockRejectedValueOnce(new Error("Could not save"));
    const workspace = render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add", exact: true }));
    fillCard();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await waitFor(() => expect(serviceMock.addCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    expect(screen.getByLabelText("Name on card")).toHaveValue("NEW CARD");
    let finish!: (value: unknown) => void;
    serviceMock.addCard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByTestId("secure-card-save"));
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(screen.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Name on card")).toHaveValue("NEW CARD");
    vaultMock.locked = true;
    workspace.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    await act(async () => finish({ cardId: "saved", summary: makeCards(1)[0] }));
    expect(screen.queryByTestId("wallet-add-collection")).toBeNull();
    expect(screen.queryByTestId("secure-card-add-form")).toBeNull();
  });

  it("keeps a confirmed save when an older post-delete read finishes later", async () => {
    const existing = makeCards(2);
    serviceMock.listCardSummaries.mockResolvedValueOnce(existing);
    let finishRead!: (cards: ReturnType<typeof makeCards>) => void;
    serviceMock.listCardSummaries.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    let finishSave!: (value: unknown) => void;
    serviceMock.addCard.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fillCard();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(finishRead).toBeTypeOf("function"));
    const summary = { ...existing[0], cardId: "saved", nickname: "Visa", last4: "4242" };
    await act(async () => finishSave({ cardId: "saved", summary, cardholderName: "New card" }));
    await act(async () => finishRead([existing[1]]));
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("New card");
    expect(screen.getByRole("button", { name: "Open Visa, ending 4242" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Card 0, ending 1000" })).toBeNull();
  }, 10000);

  it("links all three tabs to their panels and supports keyboard selection", async () => {
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    for (const name of ["Cards", "Add", "Sharing"]) {
      const tab = screen.getByRole("tab", { name });
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
    }
    fireEvent.keyDown(screen.getByRole("tab", { name: "Cards" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("secure-card-add-form")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Add" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps a draft across tabs and drops it on vault lock", async () => {
    const workspace = render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Travel" } });
    fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242424242424242" } });
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByLabelText("Name on card")).toHaveValue("TRAVEL");
    expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242");
    expect(screen.getByLabelText("CVV")).toHaveValue("");
    vaultMock.locked = true;
    workspace.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("secure-card-add-form")).toBeNull();
  });

  it("rejects a number copy that completes after leaving Cards", async () => {
    let finish!: (value: unknown) => void;
    serviceMock.getCard.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    await act(async () => finish({
      summary: makeCards(1)[0],
      secrets: { pan: "4242424242421000", cvv: "123", pin: "", cardholderName: "Test" },
    }));
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(screen.queryByTestId("secure-card-reveal")).toBeNull();
  });

  it("keeps post-mutation refresh outside Wallet outcome catches", () => {
    const source = readFileSync(
      join(process.cwd(), "components/wallet/wallet-workspace.tsx"),
      "utf8",
    );
    const deleteSuccess = source.indexOf('action: "card_deleted", result: "success"');
    const deleteCatch = source.indexOf("} catch (error) {", deleteSuccess);
    const deleteError = source.indexOf('action: "card_deleted", result: "error"', deleteCatch);
    const deleteRefresh = source.indexOf("await refresh(", deleteError);
    expect(deleteSuccess).toBeGreaterThan(-1);
    expect(deleteCatch).toBeGreaterThan(deleteSuccess);
    expect(deleteError).toBeGreaterThan(deleteCatch);
    expect(deleteRefresh).toBeGreaterThan(deleteError);

    const addSuccess = source.indexOf('action: "card_added", result: "success"');
    const addCatch = source.indexOf("} catch (error) {", addSuccess);
    const addError = source.indexOf('action: "card_added", result: "error"', addCatch);
    expect(addSuccess).toBeGreaterThan(-1);
    expect(addCatch).toBeGreaterThan(addSuccess);
    expect(addError).toBeGreaterThan(addCatch);
    expect(source.indexOf("await refresh(", addError)).toBe(-1);
    expect(source).toContain("activeOwnerIdRef.current = null");
  });

  beforeEach(() => {
    profileMock.getCard.mockReset().mockResolvedValue({ card: null, shareUrl: null });
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockReset().mockResolvedValue(false);
    vi.mocked(OnboardingLocalService.markWalletIntroductionSeen).mockReset().mockResolvedValue(undefined);
    authMock.user = { uid: "user_1" };
    vaultMock.locked = false;
    vaultMock.tokenReady = true;
    navigationMock.search = "";
    navigationMock.replace.mockReset();
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(4));
    serviceMock.recoverCardArtworks.mockReset().mockResolvedValue([]);
    serviceMock.deleteCard.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders every saved card in storage order for scroll unfolding", async () => {
    serviceMock.listCardSummaries.mockResolvedValueOnce(makeCards(25));
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    expect(screen.getAllByTestId(/^wallet-add-layer-/)).toHaveLength(28);
    expect(screen.getAllByTestId(/^wallet-add-layer-/).map(node => node.dataset.gestureCard)).toEqual(
      ["agent-one-profile", "agent-one-referral", "agent-one-nws", ...Array.from({ length:25 }, (_, index) => `card_${index}`)],
    );
    expect(screen.getByTestId("wallet-add-stack")).toHaveAttribute("data-expanded", "true");
  });

  it("opens Add card from a chat offer without asking for a nickname", async () => {
    stageReservedOfferPrefill({
      ownerUserId: "user_1",
      ownerFeature: "wallet",
      prefill: { kind: "wallet_card", nickname: "Amex Gold" },
    });
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByLabelText("Nickname")).toBeNull();
    expect(screen.getByLabelText("Name on card")).toHaveValue("");
    expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true");
    // Only the label: every card detail is still the owner's to type here.
    expect((screen.getByLabelText(/card number/i) as HTMLInputElement).value).toBe("");
    expect(navigationMock.replace).not.toHaveBeenCalledWith(expect.stringMatching(/Amex/), expect.anything());
  });

  it("opens the list, not Add card, when no offer is waiting (negative control)", async () => {
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByTestId("wallet-add-collection")).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
  });

  it.each([0, 1])("keeps introduction visible when a delayed request resolves with %i cards", async (count) => {
    let finish!: (cards: ReturnType<typeof makeCards>) => void;
    serviceMock.listCardSummaries.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<WalletWorkspace />);
    const art = (await screen.findByTestId("one-wallet-empty-art")).querySelector("img");
    expect(art).toHaveAttribute("loading", "eager");
    expect(art).toHaveAttribute("fetchpriority", "high");
    expect(screen.queryByRole("heading", { name: "Wallet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    await waitFor(() => expect(serviceMock.listCardSummaries).toHaveBeenCalled());
    await act(async () => { finish(makeCards(count)); });
    expect(screen.getByTestId("one-wallet-empty-art").querySelector("img")).toBe(art);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    expect(screen.queryByRole("heading", { name: "Wallet" })).toBeNull();
    expect(screen.getByTestId("wallet-card-browser")).toBeTruthy();
  });

  it("search narrows metadata and reports no match", async () => {
    navigationMock.search = "q=amex";
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByRole("textbox", { name: "Search cards" });
    expect(screen.queryByRole("button", { name: "Search cards" })).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByTestId("one-wallet-search"), { target: { value: "amex" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Card search results" }).querySelectorAll("li")).toHaveLength(1),
    );
    expect(screen.getByRole("button", { name: /Travel Amex/ })).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByTestId("one-wallet-search"), { target: { value: "nothing-here" } });
    });
    await waitFor(() => expect(screen.getByTestId("one-wallet-no-match")).toBeTruthy());
    expect(screen.queryByTestId("one-wallet-card-actions")).toBeNull();
  });

  it("does not attribute a late card deletion to a replacement owner", async () => {
    let finishDelete!: () => void;
    serviceMock.deleteCard.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
    const view = render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByTestId("wallet-add-collection")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(finishDelete).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: "Add a card", exact: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "All (7)" })).toBeDisabled();
    authMock.user = { uid: "user_2" };
    view.rerender(<WalletWorkspace />);
    await act(async () => finishDelete());

    expect(trackEventMock).not.toHaveBeenCalledWith(
      "one_wallet_action",
      expect.objectContaining({ action: "card_deleted" }),
    );
  });

  it("asks before removing a card, and removes nothing until confirmed", async () => {
    // Regression: Remove once deleted the card from the vault on a single tap.
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByTestId("wallet-add-collection")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    expect(await screen.findByTestId("one-wallet-remove-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("one-wallet-remove-cancel"));
    await waitFor(() => expect(screen.queryByTestId("one-wallet-remove-confirm")).toBeNull());
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();

    // Negative control: confirming does remove it.
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() =>
      expect(serviceMock.deleteCard).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: "card_0" }),
      ),
    );
  });

  it("offers Unlock on a locked vault and never decrypts a card", async () => {
    vaultMock.locked = true;
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    const unlock = await screen.findByTestId("one-wallet-unlock");
    expect(screen.queryByTestId("wallet-add-collection")).toBeNull();
    expect(serviceMock.listCardSummaries).not.toHaveBeenCalled();
    fireEvent.click(unlock);
    expect(screen.getByTestId("vault-unlock-dialog")).toBeTruthy();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    expect(screen.queryByTestId("secure-card-reveal")).toBeNull();
  });

  it("keeps owner details masked and decrypts the full number only on copy", async () => {
    serviceMock.getCard.mockResolvedValue({
      summary: makeCards(1)[0],
      secrets: { pan: "4242424242421000", cvv: "123", pin: "", cardholderName: "Alex Rivera" },
    });
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByTestId("wallet-add-collection")).toBeTruthy());
    expect(screen.getByTestId("wallet-add-collection").textContent).not.toContain("4242 4242 4242 1000");
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000"));
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    await waitFor(() => expect(serviceMock.getCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("4242424242421000"));
    expect(document.body).not.toHaveTextContent("4242 4242 4242 1000");
    expect(screen.queryByTestId("secure-card-reveal")).toBeNull();
    expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000");
  });
});

beforeEach(() => CacheService.getInstance().clear());
