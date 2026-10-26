import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";
import { Preferences } from "@capacitor/preferences";
import { removeLocalItem } from "@/lib/utils/session-storage";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/wallet",
  search: "",
  replace: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  user: { uid: "user_1" } as { uid: string } | null,
}));
const trackEventMock = vi.hoisted(() => vi.fn());
const vaultMock = vi.hoisted(() => ({ locked: false }));

vi.mock("@/lib/services/wallet-card-access-service", () => ({
  WalletCardAccessService: {
    state: vi.fn().mockResolvedValue({ eligible: false, grants: [] }),
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({ replace: navigationMock.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigationMock.search),
}));

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
      : { vaultKey: "vault_key", vaultOwnerToken: "owner_token", getVaultOwnerToken: () => "owner_token" },
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="vault-unlock-dialog" /> : null,
}));

vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));

const serviceMock = vi.hoisted(() => ({
  listCardSummaries: vi.fn(),
  deleteCard: vi.fn(),
  getCard: vi.fn(),
  addCard: vi.fn(),
}));
vi.mock("@/lib/services/wallet-card-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/wallet-card-service")>("@/lib/services/wallet-card-service");
  return { ...actual, WalletCardService: class extends actual.WalletCardService {
    static getCard = vi.fn().mockResolvedValue({ card: null, shareUrl: null });
  } };
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
      listCardPresentations: async (...args: unknown[]) => (await serviceMock.listCardSummaries(...args)).map((summary: unknown) => ({ summary, cardholderName: "Test Cardholder" })),
      listCardShareReceipts: vi.fn().mockResolvedValue([]),
      deleteCard: serviceMock.deleteCard,
      getCard: serviceMock.getCard,
      addCard: async (...args: unknown[]) => { const saved = await serviceMock.addCard(...args); bumpPkmInvalidationEpoch("user_1", "wallet"); return saved; },
      matchesQuery: actual.WalletService.matchesQuery,
    },
  };
});

vi.mock("@/components/wallet/wallet-referral-card-details", () => ({
  WalletReferralCardDetails: () => <section>Live referral controls</section>,
}));

vi.mock("@/components/wallet/wallet-sharing-history", () => ({ WalletSharingHistory: () => <section>Received cards</section> }));
vi.mock("@/components/wallet/wallet-sharing", () => ({
  WalletSharing: () => <section>Card recipients</section>,
}));

import { WalletWorkspace } from "@/components/wallet/wallet-workspace";

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

describe("Wallet visit introduction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    removeLocalItem("wallet_introduction_seen_v1:user_1");
    await Preferences.remove({ key: "wallet_introduction_seen_v1:user_1" });
    authMock.user = { uid: "user_1" };
    vaultMock.locked = false;
    serviceMock.listCardSummaries.mockResolvedValue([]);
    serviceMock.getCard.mockReset();
  });
  afterEach(() => vi.clearAllMocks());
  const enter = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("tab", { name: "My cards", hidden: true });
    await waitFor(() => expect(screen.getByTestId("one-wallet-add")).not.toBeDisabled());
  };
  it("shows the illustration once, then opens Cards on later visits", async () => {
    const page = render(<WalletWorkspace />);
    expect(await screen.findByTestId("one-wallet-empty-art")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "My cards", hidden: true })).toBeNull();
    await enter();
    expect(screen.getByTestId("wallet-card-browser")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Agent One Profile", hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Agent One NWS", hidden: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Agent One Referral", hidden: true }));
    expect(screen.getByText("Live referral controls")).toBeVisible();
    expect(screen.queryByTestId("wallet-demo-activity")).toBeNull();
    expect(serviceMock.addCard).not.toHaveBeenCalled();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    expect(screen.getByTestId("secure-card-add-form")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "My cards", hidden: true }));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    page.unmount();
    render(<WalletWorkspace />);
    expect(await screen.findByRole("tab", { name: "My cards", hidden: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
  it("opens entry directly in Add, retains drafts across tabs, and clears a cancelled draft", async () => {
    render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Travel" } });
    fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242424242424242" } });
    fireEvent.click(screen.getByRole("tab", { name: "My cards", hidden: true }));
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    expect(screen.getByLabelText("Name on card")).toHaveValue("TRAVEL");
    expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242");
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "My cards", hidden: true })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    expect(screen.getByLabelText("Name on card")).toHaveValue("");
  });
  it("keeps real cards behind Continue and opens unlocked saved details with recipients", async () => {
    const cards = makeCards(2);
    serviceMock.listCardSummaries.mockResolvedValue(cards);
    serviceMock.getCard.mockResolvedValue({
      summary: cards[0],
      secrets: { pan: "4242424242421000", cardholderName: "Test Cardholder" },
    });
    render(<WalletWorkspace />);
    await enter();
    expect(screen.queryByTestId("wallet-preview-collection")).toBeNull();
    expect(screen.getByRole("button", { name: "Card 0", exact: true })).toBeVisible();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000", hidden: true }));
    const details = within(screen.getByRole("region", { name: "Saved card details" }));
    expect(await details.findByText("•••• •••• •••• 1000")).toBeVisible();
    expect(document.body).not.toHaveTextContent("4242 4242 4242 1000");
    expect(details.getByText("Test Cardholder")).toBeVisible();
    expect(details.getByText("Visa")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /Manage access/ }));
    expect(await screen.findByText("No active shares")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close detail panel", exact: true }));
    expect(screen.getByRole("button", { name: /Share card/, hidden: true })).toBeEnabled();
    expect(screen.queryByText(/origin must be verified/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show card details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal saved details" })).toBeNull();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
  });
  it("returns a saved payment card to Cards while retaining the three system cards", async () => {
    const summary = { ...makeCards(1)[0], cardId: "saved", nickname: "New card", last4: "4242" };
    serviceMock.addCard.mockResolvedValue({ cardId: "saved", summary });
    serviceMock.getCard.mockResolvedValue({
      summary,
      secrets: { pan: "4242424242424242", cardholderName: "New card" },
    });
    render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "New card" } });
    fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "04/30" } });
    fireEvent.change(screen.getByLabelText("Issuing region"), { target: { value: "IN" } });
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "My cards", hidden: true })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await screen.findByRole("button", { name: "New card", exact: true }));
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByRole("button", { name: "Open New card, ending 4242", hidden: true })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open Agent One Profile", hidden: true })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "All (4)", hidden: true })).toBeEnabled();
    expect(screen.queryByTestId("wallet-preview-collection")).toBeNull();
    expect(await within(screen.getByRole("region", { name: "Saved card details" })).findByText("•••• •••• •••• 4242")).toBeVisible();
    expect(document.body).not.toHaveTextContent("4242 4242 4242 4242");
    fireEvent.click(await screen.findByRole("button", { name: /Manage access/ }));
    expect(await screen.findByText("No active shares")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close detail panel", exact: true }));
    expect(serviceMock.getCard).not.toHaveBeenCalled();
  });
  it("removes the form and card details when the vault locks", async () => {
    const page = render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242424242424242" } });
    vaultMock.locked = true;
    page.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("secure-card-add-form")).toBeNull();
    expect(screen.queryByTestId("wallet-card-browser")).toBeNull();
  });

});
vi.mock("@/lib/services/wallet-card-artwork-service", () => ({ loadWalletCardArtwork: vi.fn().mockResolvedValue("<svg></svg>") }));

beforeEach(() => CacheService.getInstance().clear());
