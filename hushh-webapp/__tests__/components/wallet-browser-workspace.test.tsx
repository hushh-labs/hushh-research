vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenWalletSwipeHint: vi.fn().mockResolvedValue(true),
    markWalletSwipeHintSeen: vi.fn().mockResolvedValue(undefined),
    hasSeenWalletIntroduction: vi.fn().mockResolvedValue(false),
    markWalletIntroductionSeen: vi.fn().mockResolvedValue(undefined),
  },
}));
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/wallet/wallet-sharing", () => ({ WalletSharing: () => <section>Card recipients</section> }));
vi.mock("@/components/wallet-card/wallet-card-workspace", () => ({
  WalletCardWorkspace: () => <section>Live profile controls</section>,
}));

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
      listCardPresentations: async (...args: unknown[]) => (await serviceMock.listCardSummaries(...args)).map((summary: unknown) => ({ summary, cardholderName: "Test Cardholder" })),
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
    serviceMock.getCard.mockReset().mockResolvedValue({ summary: makeCards(1)[0], secrets: { pan: "4242424242424242", cvv: "123", pin: "9876" } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => vi.clearAllMocks());
  const open = async () => {
    const view = render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-card-browser");
    return view;
  };
  it("shows saved card actions without revealing secrets or financial placeholders", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    expect(screen.getByText("Card recipients")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reveal saved details" })).toBeNull();
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Card number");
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Name on card");
    expect(screen.queryByText("Card balance")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove card" })).toBeVisible();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "All (5)" }));
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove card" })).toBeNull();
  });
  it("confirms removal and preserves the card when cancelled", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    expect(await screen.findByTestId("one-wallet-remove-confirm")).toBeVisible();
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("one-wallet-remove-cancel"));
    await waitFor(() => expect(screen.queryByTestId("one-wallet-remove-confirm")).toBeNull());
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("1000");
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(serviceMock.deleteCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", cardId: "card_0" })));
  });
  it.each(["owner", "lock"])("cancels a pending removal after a %s change", async (change) => {
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    expect(await screen.findByTestId("one-wallet-remove-confirm")).toBeVisible();
    if (change === "owner") authMock.user = { uid: "user_2" };
    else vaultMock.locked = true;
    view.rerender(<WalletWorkspace />);
    await waitFor(() => expect(screen.queryByTestId("one-wallet-remove-confirm")).toBeNull());
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();
  });
  it("copies only on request while keeping card secrets out of the page", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy name on card" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Test Cardholder"));
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("4242424242424242"));
    expect(serviceMock.getCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", cardId: "card_0" }));
    expect(document.body).not.toHaveTextContent("4242424242424242");
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.getByText("Hidden")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Copy CVV" })).toBeNull();
    expect(trackEventMock.mock.calls.flatMap((call) => call).map(String).join(" ")).not.toContain("4242424242424242");
  });
  it.each(["owner", "lock", "tab", "card", "overview"])("rejects a late number copy after changing %s", async (change) => {
    let resolveCopy!: (result: unknown) => void;
    serviceMock.getCard.mockImplementation(() => new Promise((resolve) => { resolveCopy = resolve; }));
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    if (change === "owner") { authMock.user = { uid: "user_2" }; view.rerender(<WalletWorkspace />); }
    if (change === "lock") { vaultMock.locked = true; view.rerender(<WalletWorkspace />); }
    if (change === "tab") fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    if (change === "overview") fireEvent.click(screen.getByRole("button", { name: "All (5)" }));
    if (change === "card") {
      fireEvent.click(screen.getByRole("button", { name: "All (5)" }));
      fireEvent.click(screen.getByRole("button", { name: "Open Card 1, ending 1001" }));
    }
    await act(async () => { resolveCopy({ secrets: { pan: "4242424242424242" } }); });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
  it.each([false, true])("starts clipboard item copying inside the click and guards its delayed data (owner changes: %s)", async (ownerChanges) => {
    let resolveCopy!: (result: unknown) => void;
    serviceMock.getCard.mockImplementation(() => new Promise(resolve => { resolveCopy = resolve; }));
    let suppliedData: Promise<Blob> | undefined;
    vi.stubGlobal("ClipboardItem", class {
      constructor(data: Record<string, Promise<Blob>>) { suppliedData = data["text/plain"]; }
    });
    const write = vi.fn(async () => { await suppliedData; });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    try {
      const view = await open();
      fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
      fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
      expect(write).toHaveBeenCalledTimes(1);
      expect(suppliedData).toBeInstanceOf(Promise);
      if (ownerChanges) { authMock.user = { uid: "user_2" }; view.rerender(<WalletWorkspace />); }
      await act(async () => { resolveCopy({ secrets: { pan: "4242424242424242" } }); });
      if (ownerChanges) await expect(suppliedData).rejects.toThrow("Card copy unavailable");
      else {
        const blob = await suppliedData!;
        const text = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
        expect(text).toBe("4242424242424242");
      }
      expect(document.body).not.toHaveTextContent("4242424242424242");
    } finally { vi.unstubAllGlobals(); }
  });
  it("opens the existing Add form from a selected card", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a card", exact: true }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("secure-card-add-form")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
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
    expect(screen.getByText("Card recipients")).toBeVisible();
    expect(screen.queryByTestId("one-wallet-reveal-1001")).toBeNull();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
  });

});
