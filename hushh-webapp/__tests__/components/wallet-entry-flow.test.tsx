import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Wallet visit introduction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { uid: "user_1" };
    vaultMock.locked = false;
    serviceMock.listCardSummaries.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());
  const enter = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("tab", { name: "Cards" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).not.toBeDisabled());
  };
  it("shows the illustration every visit, and demo Cards after Continue without saving them", async () => {
    const page = render(<WalletWorkspace />);
    expect(screen.getByTestId("one-wallet-empty-art")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Cards" })).toBeNull();
    await enter();
    expect(screen.getByTestId("wallet-add-preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Travel - Demo" }));
    expect(serviceMock.addCard).not.toHaveBeenCalled();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByTestId("secure-card-add-form")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    page.unmount();
    render(<WalletWorkspace />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });
  it("opens entry directly in Add, retains masked drafts across tabs, and clears a cancelled draft", async () => {
    render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "Travel" } });
    fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Show CVV and PIN" }));
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByLabelText("Nickname")).toHaveValue("Travel");
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByLabelText("Nickname")).toHaveValue("");
  });
  it("keeps real cards behind Continue and retains explicit secure reveal", async () => {
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(2));
    render(<WalletWorkspace />);
    await enter();
    expect(screen.queryByTestId("wallet-add-preview")).toBeNull();
    expect(screen.getByTestId("wallet-add-layer-1000")).toBeTruthy();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show card details" })).toBeTruthy();
  });
  it("returns a saved real card to Cards without mixing in demos", async () => {
    const summary = { ...makeCards(1)[0], cardId: "saved", nickname: "New card", last4: "4242" };
    serviceMock.addCard.mockResolvedValue({ cardId: "saved", summary });
    render(<WalletWorkspace />);
    await enter();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "New card" } });
    fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "04/30" } });
    fireEvent.change(screen.getByLabelText("Issuing region"), { target: { value: "IN" } });
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("wallet-add-layer-4242")).toHaveAttribute("data-selected", "true");
    expect(screen.queryByTestId("wallet-add-preview")).toBeNull();
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
