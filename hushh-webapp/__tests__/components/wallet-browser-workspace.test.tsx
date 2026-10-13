vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenWalletSwipeHint: vi.fn().mockResolvedValue(true),
    markWalletSwipeHintSeen: vi.fn().mockResolvedValue(undefined),
    hasSeenWalletIntroduction: vi.fn().mockResolvedValue(false),
    markWalletIntroductionSeen: vi.fn().mockResolvedValue(undefined),
  },
}));
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/wallet/wallet-sharing", () => ({ WalletSharing: ({ cardDetails }: { cardDetails?: boolean }) => <section>{cardDetails ? "Card recipients" : "Sharing overview"}</section> }));
vi.mock("@/components/wallet-card/wallet-card-workspace", () => ({
  WalletCardWorkspace: () => <section>Live profile controls</section>,
}));

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/wallet",
  search: "",
  replace: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  user: { uid: "user_1" } as { uid: string; getIdToken?: () => Promise<string> } | null,
}));
const trackEventMock = vi.hoisted(() => vi.fn());
const vaultMock = vi.hoisted(() => ({ locked: false, token: "owner_token" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({ replace: navigationMock.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigationMock.search),
}));

vi.mock("@/hooks/use-effective-avatar-url", () => ({ useEffectiveAvatarUrl: () => null }));

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
      : { vaultKey: "vault_key", vaultOwnerToken: vaultMock.token, getVaultOwnerToken: () => vaultMock.token },
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
const referralMock = vi.hoisted(() => ({ getSummary: vi.fn(), rotateShareLink: vi.fn() }));
vi.mock("@/lib/services/referral-service", () => ({ ReferralService: referralMock }));
vi.mock("@/lib/referral/use-referral-stream", () => ({ useReferralStream: () => ({ connected: true }) }));
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
      listCardPresentations: async (...args: unknown[]) => (await serviceMock.listCardSummaries(...args)).map((summary: unknown) => ({ summary, cardholderName: "Test Cardholder" })),
      deleteCard: serviceMock.deleteCard,
      getCard: serviceMock.getCard,
      listCardShareReceipts: vi.fn().mockResolvedValue([]),
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
    vaultMock.token = "owner_token";
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
  it("opens the full owner number and keeps security codes and financial placeholders hidden", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal saved details" })).toBeNull();
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Card number");
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Name on card");
    expect(screen.queryByText("Card balance")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove card" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("4242 4242 4242 4242"));
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true");
    fireEvent.click(screen.getByRole("button", { name: "All (5)" }));
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove card" })).toBeNull();
  });
  it("confirms removal after token renewal and preserves the card when cancelled", async () => {
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    expect(await screen.findByTestId("one-wallet-remove-confirm")).toBeVisible();
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("one-wallet-remove-cancel"));
    await waitFor(() => expect(screen.queryByTestId("one-wallet-remove-confirm")).toBeNull());
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Card 0");
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    await screen.findByTestId("one-wallet-remove-confirm-action");
    vaultMock.token = "renewed_owner_token";
    view.rerender(<WalletWorkspace />);
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(serviceMock.deleteCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", cardId: "card_0", vaultOwnerToken: "renewed_owner_token" })));
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
  it.each(["current", "owner roundtrip", "lock", "tab", "overview"])("fences delayed referral revocation after %s", async boundary => {
    referralMock.getSummary.mockResolvedValue({ slug: "fixture", link: "https://example.test/r/fixture", link_open_count: 3, referrals: [], qualified_count: 0, in_progress_count: 0, under_review_count: 0 });
    referralMock.rotateShareLink.mockResolvedValue({ slug: "replacement", link: "https://example.test/r/replacement", link_open_count: 0, referrals: [], qualified_count: 0, in_progress_count: 0, under_review_count: 0 });
    const getIdToken = vi.fn().mockResolvedValue("identity");
    const owner = { uid: "user_1", getIdToken };
    authMock.user = owner;
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Agent One Referral" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke access", exact: true }));
    let resolveToken!: (token: string) => void;
    getIdToken.mockImplementationOnce(() => new Promise(resolve => { resolveToken = resolve; }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke access", exact: true }));
    if (boundary === "owner roundtrip") { authMock.user = { uid: "user_2" }; view.rerender(<WalletWorkspace />); authMock.user = owner; view.rerender(<WalletWorkspace />); }
    if (boundary === "lock") { vaultMock.locked = true; view.rerender(<WalletWorkspace />); vaultMock.locked = false; view.rerender(<WalletWorkspace />); }
    if (boundary === "tab") fireEvent.click(document.getElementById("top-shell-wallet-tab-add")!);
    if (boundary === "overview") fireEvent.click(screen.getByText("All cards").closest("button")!);
    await act(async () => { resolveToken("identity"); });
    if (boundary === "current") { expect(referralMock.rotateShareLink).toHaveBeenCalledWith({ idToken: "identity", slug: "fixture" }); expect(screen.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", "https://example.test/r/replacement"); expect(screen.getByTestId("wallet-referral-opens")).toHaveTextContent("0"); }
    else expect(referralMock.rotateShareLink).not.toHaveBeenCalled();
  });
  it("copies only on request while keeping security codes and telemetry private", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy name on card" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Test Cardholder"));
    expect(serviceMock.getCard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("4242424242424242"));
    expect(serviceMock.getCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", cardId: "card_0" }));
    expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("4242 4242 4242 4242");
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.getByText("Hidden")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Copy CVV" })).toBeNull();
    expect(trackEventMock.mock.calls.flatMap((call) => call).map(String).join(" ")).not.toContain("4242424242424242");
  });
  it.each(["owner", "lock", "tab", "card", "overview"])("rejects a late number copy after changing %s", async (change) => {
    let resolveCopy!: (result: unknown) => void;
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("4242 4242 4242 4242"));
    serviceMock.getCard.mockImplementationOnce(() => new Promise((resolve) => { resolveCopy = resolve; }));
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
    let suppliedData: Promise<Blob> | undefined;
    vi.stubGlobal("ClipboardItem", class {
      constructor(data: Record<string, Promise<Blob>>) { suppliedData = data["text/plain"]; }
    });
    const write = vi.fn(async () => { await suppliedData; });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    try {
      const view = await open();
      fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
      await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("4242 4242 4242 4242"));
      serviceMock.getCard.mockImplementationOnce(() => new Promise(resolve => { resolveCopy = resolve; }));
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
      if (ownerChanges) expect(document.body).not.toHaveTextContent("4242424242424242");
      else expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("4242 4242 4242 4242");
    } finally { vi.unstubAllGlobals(); }
  });
  it("opens the existing Add form from a selected card", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a card", exact: true }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("secure-card-add-form")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
    expect(serviceMock.getCard).toHaveBeenCalledTimes(1);
  });
  it("removes the browser when the vault locks", async () => {
    const view = await open();
    vaultMock.locked = true;
    view.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("wallet-card-browser")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
  });
  it.each(["owner", "lock", "tab", "visibility"])("discards a pending owner number when %s changes", async boundary => {
    let finish!: (value: unknown) => void;
    serviceMock.getCard.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "owner") { authMock.user = { uid: "user_2" }; view.rerender(<WalletWorkspace />); }
    if (boundary === "lock") { vaultMock.locked = true; view.rerender(<WalletWorkspace />); }
    if (boundary === "tab") fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    if (boundary === "visibility") { vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange")); }
    await act(async () => finish({ secrets: { pan: "4000000000000002", cvv: "999", pin: "9876" } }));
    expect(document.body).not.toHaveTextContent("4000000000000002");
    expect(document.body).not.toHaveTextContent("4000 0000 0000 0002");
    expect(trackEventMock.mock.calls.flat().join()).not.toContain("4000000000000002");
    vi.restoreAllMocks();
  });
  it("opens the matching card after selecting a search result", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Search cards" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search cards" }), { target: { value: "1001" } });
    const result = await screen.findByRole("button", { name: "Card 1 · Visa ending 1001" });
    fireEvent.click(result);
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByTestId("wallet-card-face")).toHaveTextContent("Card 1");
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByTestId("one-wallet-reveal-1001")).toBeNull();
    expect(serviceMock.getCard).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("4242 4242 4242 4242"));
  });

  it("returns the profile card to the collection without replacing the retained Cards panel", async () => {
    serviceMock.listCardSummaries.mockResolvedValue([]);
    await open();
    const browser = screen.getByTestId("wallet-card-browser");
    fireEvent.click(screen.getByRole("button", { name: "Agent One Profile", exact: true }));
    await waitFor(() => expect(screen.getByTestId("wallet-selected-card")).toBeVisible());
    fireEvent.click(screen.getByRole("tab", { name: "Add", exact: true }));
    fireEvent.click(screen.getByRole("tab", { name: "Cards", exact: true }));
    await waitFor(() => expect(browser).toHaveAttribute("data-mode", "all"));
    expect(screen.getByTestId("wallet-card-browser")).toBe(browser);
    expect(screen.queryByTestId("wallet-selected-card")).toBeNull();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
  });

});
vi.mock("@/lib/services/wallet-card-artwork-service", () => ({ loadWalletCardArtwork: vi.fn().mockResolvedValue("<svg></svg>") }));
