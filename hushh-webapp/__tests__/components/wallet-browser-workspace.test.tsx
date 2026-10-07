vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenWalletIntroduction: vi.fn().mockResolvedValue(false),
    markWalletIntroductionSeen: vi.fn().mockResolvedValue(undefined),
  },
}));
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      ? { vaultKey: null, getVaultOwnerToken: () => null }
      : { vaultKey: "vault_key", getVaultOwnerToken: () => "owner_token" },
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
      listCardSummaries: serviceMock.listCardSummaries,
      deleteCard: serviceMock.deleteCard,
      getCard: serviceMock.getCard,
      addCard: serviceMock.addCard,
      matchesQuery: actual.WalletService.matchesQuery,
    },
  };
});

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

describe("Wallet video browser workspace", () => {
  beforeEach(() => {
    authMock.user = { uid: "user_1" };
    vaultMock.locked = false;
    navigationMock.search = "";
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(2));
    serviceMock.deleteCard.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());
  const open = async () => {
    const view = render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-card-browser");
    return view;
  };
  it("requires explicit reveal after selecting a real thumbnail and clears it on All", async () => {
    serviceMock.getCard.mockResolvedValue({ summary: makeCards(1)[0], secrets: { pan: "4242424242421000", cvv: "123", pin: "", cardholderName: "Test" } });
    await open();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("one-wallet-reveal-1000"));
    await screen.findByTestId("secure-card-reveal");
    fireEvent.click(screen.getByRole("button", { name: "All (2)" }));
    expect(screen.queryByTestId("secure-card-reveal")).toBeNull();
  });
  it("drops a late reveal on workspace tab departure", async () => {
    let finish!: (value: unknown) => void;
    serviceMock.getCard.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByTestId("one-wallet-reveal-1000"));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    await act(async () => finish({ summary: makeCards(1)[0], secrets: { pan: "4242424242421000", cvv: "123", pin: "", cardholderName: "Test" } }));
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(screen.queryByTestId("secure-card-reveal")).toBeNull();
  });
  it("opens the existing Add form from plus and clears a revealed card", async () => {
    serviceMock.getCard.mockResolvedValue({ summary: makeCards(1)[0], secrets: { pan: "4242424242421000", cvv: "123", pin: "", cardholderName: "Test" } });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByTestId("one-wallet-reveal-1000"));
    await screen.findByTestId("secure-card-reveal");
    fireEvent.click(screen.getByRole("button", { name: "Add a card", exact: true }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByTestId("secure-card-reveal")).toBeNull();
    expect(screen.getByTestId("secure-card-add-form")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
  });
  it("removes the browser and its thumbnail portal when the vault locks", async () => {
    const view = await open();
    vaultMock.locked = true;
    view.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("wallet-card-browser")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
  });
  it("opens the matching card after selecting a search result", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Search cards" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search cards" }), { target: { value: "1001" } });
    const result = await screen.findByRole("button", { name: "Card 1 · Visa ending 1001" });
    fireEvent.click(result);
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByTestId("wallet-card-face")).toHaveTextContent("Card 1");
    expect(screen.getByTestId("one-wallet-reveal-1001")).toBeVisible();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
  });

});
