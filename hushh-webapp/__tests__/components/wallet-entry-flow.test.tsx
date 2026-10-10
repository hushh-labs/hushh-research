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
  useAuth: () => ({ user: authMock.user, loading: false }),
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

vi.mock("@/lib/services/wallet-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/wallet-service")>(
    "@/lib/services/wallet-service",
  );
  return {
    ...actual,
    WalletService: {
      ...actual.WalletService,
      isEnabled: () => true,
      listCardPresentations: async (...args: unknown[]) => (await serviceMock.listCardSummaries(...args)).map((summary: unknown) => ({ summary, cardholderName: "Test Cardholder" })),
      listCardShareReceipts: vi.fn().mockResolvedValue([]),
      deleteCard: serviceMock.deleteCard,
      getCard: serviceMock.getCard,
      addCard: serviceMock.addCard,
      matchesQuery: actual.WalletService.matchesQuery,
    },
  };
});

vi.mock("@/components/wallet/wallet-referral-card-details", () => ({
  WalletReferralCardDetails: () => <section>Live referral controls</section>,
}));

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
    await screen.findByRole("tab", { name: "Cards" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).not.toBeDisabled());
  };
  it("shows the illustration once, then opens Cards on later visits", async () => {
    const page = render(<WalletWorkspace />);
    expect(await screen.findByTestId("one-wallet-empty-art")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Cards" })).toBeNull();
    await enter();
    expect(screen.getByTestId("wallet-add-collection")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Agent One Profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Agent One NWS" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Agent One Referral" }));
    expect(screen.getByText("Live referral controls")).toBeVisible();
    expect(screen.queryByTestId("wallet-demo-activity")).toBeNull();
    expect(serviceMock.addCard).not.toHaveBeenCalled();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByTestId("secure-card-add-form")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    page.unmount();
    render(<WalletWorkspace />);
    expect(await screen.findByRole("tab", { name: "Cards" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
  it("opens entry directly in Add, retains masked drafts across tabs, and clears a cancelled draft", async () => {
    render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Travel" } });
    fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Show CVV and PIN" }));
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByLabelText("Name on card")).toHaveValue("Travel");
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
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
    expect(screen.getByTestId("wallet-add-layer-1000")).toBeTruthy();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    const details = within(screen.getByRole("region", { name: "Saved card details" }));
    expect(await details.findByText("4242 4242 4242 1000")).toBeVisible();
    expect(details.getByText("Test Cardholder")).toBeVisible();
    expect(details.getByText("Visa")).toBeVisible();
    expect(await screen.findByText("No active shares")).toBeVisible();
    expect(screen.getByRole("button", { name: /Share card/ })).toBeEnabled();
    expect(screen.queryByText(/origin must be verified/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show card details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal saved details" })).toBeNull();
    expect(serviceMock.getCard).toHaveBeenCalledWith({ userId: "user_1", vaultOwnerToken: "owner_token", vaultKey: "vault_key", cardId: "card_0" });
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
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "New card" } });
    fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "04/30" } });
    fireEvent.change(screen.getByLabelText("Issuing region (optional)"), { target: { value: "IN" } });
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true"));
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByRole("button", { name: "Open New card, ending 4242" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open Agent One Profile" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "All (4)" })).toBeEnabled();
    expect(screen.queryByTestId("wallet-preview-collection")).toBeNull();
    expect(await within(screen.getByRole("region", { name: "Saved card details" })).findByText("4242 4242 4242 4242")).toBeVisible();
    expect(await screen.findByText("No active shares")).toBeVisible();
    expect(serviceMock.getCard).toHaveBeenCalledWith({ userId: "user_1", vaultOwnerToken: "owner_token", vaultKey: "vault_key", cardId: "saved" });
  });
  it("removes the form and card details when the vault locks", async () => {
    const page = render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
    vaultMock.locked = true;
    page.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("secure-card-add-form")).toBeNull();
    expect(screen.queryByTestId("wallet-add-collection")).toBeNull();
  });

});
