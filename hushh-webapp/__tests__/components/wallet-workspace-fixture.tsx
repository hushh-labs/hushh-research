import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenWalletSwipeHint: vi.fn().mockResolvedValue(true),
    markWalletSwipeHintSeen: vi.fn().mockResolvedValue(undefined),
    hasSeenWalletIntroduction: vi.fn().mockResolvedValue(false),
    markWalletIntroductionSeen: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/components/wallet/wallet-sharing-history", () => ({ WalletSharingHistory: () => <section>Received cards</section> }));
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

export function makeCards(count: number) {
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

export const fillCard = () => {
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "New card" } });
    fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "04/30" } });
    fireEvent.change(screen.getByLabelText("Issuing region"), { target: { value: "IN" } });
  };

beforeEach(() => CacheService.getInstance().clear());
  beforeEach(() => {
    profileMock.getCard.mockReset().mockResolvedValue({ card: null, shareUrl: null });
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockReset().mockResolvedValue(false);
    vi.mocked(OnboardingLocalService.markWalletIntroductionSeen).mockReset().mockResolvedValue(undefined);
    authMock.user = { uid: "user_1" };
    vaultMock.locked = false;
    vaultMock.tokenReady = true;
    navigationMock.search = "";
    navigationMock.replace.mockReset();
    serviceMock.listCardSummaries.mockReset().mockResolvedValue(makeCards(4));
    serviceMock.addCard.mockReset();
    serviceMock.recoverCardArtworks.mockReset().mockResolvedValue([]);
    serviceMock.deleteCard.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

export { navigationMock, authMock, trackEventMock, nativeBeaconMock, vaultMock, serviceMock, profileMock };
