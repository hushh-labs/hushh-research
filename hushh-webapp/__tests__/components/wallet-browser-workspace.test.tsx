import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService } from "@/lib/services/cache-service";
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

const historyProbe = vi.hoisted(() => ({ getContext: null as null | ((id: string) => { isCurrent: () => boolean } | null) }));
vi.mock("@/components/wallet/wallet-sharing", () => ({ WalletSharing: ({ cardDetails, getHistoryContext }: { cardDetails?: boolean; getHistoryContext: typeof historyProbe.getContext }) => {
  historyProbe.getContext = getHistoryContext;
  return <section>{cardDetails ? "Card recipients" : "Sharing overview"}</section>;
} }));
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
  useAuth: () => { publishValidatedAuthSessionOwner(authMock.user?.uid ?? null); return { user: authMock.user, loading: false }; },
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
  getCardSecurityCode: vi.fn(),
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
      getCardSecurityCode: serviceMock.getCardSecurityCode,
      listCardShareReceipts: vi.fn().mockResolvedValue([]),
      addCard: async (...args: unknown[]) => { const saved = await serviceMock.addCard(...args); bumpPkmInvalidationEpoch("user_1", "wallet"); return saved; },
      matchesQuery: actual.WalletService.matchesQuery,
    },
  };
});

import { WalletPresentationResource } from "@/lib/services/wallet-presentation-resource";
import { dispatchPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import { WalletWorkspace } from "@/components/wallet/wallet-workspace";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

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
    serviceMock.listCardSummaries.mockReset().mockResolvedValue(makeCards(2));
    serviceMock.deleteCard.mockResolvedValue(undefined);
    serviceMock.getCardSecurityCode.mockReset().mockResolvedValue("007");
    serviceMock.getCard.mockReset().mockResolvedValue({ summary: makeCards(1)[0], secrets: { pan: "4242424242424242", cvv: "123", pin: "9876" } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => vi.clearAllMocks());
  const open = async () => {
    const view = render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-card-browser");
    await act(async () => {});
    return view;
  };
  it("retries artwork on resume even when every card initially has a neutral face", async () => {
    const view = await open();
    serviceMock.listCardSummaries.mockClear();
    fireEvent.focus(window);
    await waitFor(() => expect(serviceMock.listCardSummaries).toHaveBeenCalledOnce());
    await act(async () => {});
    vaultMock.locked = true;
    view.rerender(<WalletWorkspace />);
    serviceMock.listCardSummaries.mockClear();
    fireEvent.focus(window);
    expect(serviceMock.listCardSummaries).not.toHaveBeenCalled();
  });
  it("recovers a newly saved fallback without closing a newer Add draft", async () => {
    const view = await open();
    const summary = makeCards(3)[2]!;
    serviceMock.addCard.mockResolvedValueOnce({ cardId: summary.cardId, summary, cardholderName: "Synthetic owner" });
    let finish!: (cards: unknown[]) => void;
    serviceMock.listCardSummaries.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Card number", { exact: true }), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("Name on card", { exact: true }), { target: { value: "Synthetic owner" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)", { exact: true }), { target: { value: "12/30" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to Wallet", exact: true })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add to Wallet", exact: true }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name on card", { exact: true }), { target: { value: "New draft" } });
    await act(async () => finish(makeCards(3)));
    expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Name on card", { exact: true })).toHaveValue("NEW DRAFT");
    expect(screen.queryByText("Your cards could not be loaded. Please try again.")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Cards", exact: true }));
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(3));
    act(() => { vaultMock.token = "renewed_after_recovery"; advanceVaultSessionEpoch(); view.rerender(<WalletWorkspace />); });
    await waitFor(() => expect(serviceMock.listCardSummaries.mock.calls.some(([context]) => context.vaultOwnerToken === "renewed_after_recovery")).toBe(true));
    expect(await screen.findByTestId("wallet-card-browser")).toBeVisible();
  });
  it("uses preloaded cards on entry and remount without another private read", async () => {
    publishValidatedAuthSessionOwner("user_1");
    await WalletPresentationResource.load({ userId: "user_1", vaultKey: "vault_key", vaultOwnerToken: vaultMock.token });
    const view = await open();
    expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(1);
    view.unmount();
    await open();
    expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(1);
  });
  it("keeps visible cards during a quiet mutation refresh and publishes changed rows", async () => {
    await open();
    let finish!: (cards: ReturnType<typeof makeCards>) => void;
    serviceMock.listCardSummaries.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => { bumpPkmInvalidationEpoch("user_1", "wallet"); dispatchPkmDomainChanged({ userId: "user_1", domain: "wallet", operation: "stored", dataVersion: null, updatedAt: null }); });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.getByTestId("wallet-card-browser")).toBeVisible();
    await act(async () => finish([{ ...makeCards(1)[0]!, nickname: "Changed card" }]));
    expect(await screen.findByRole("button", { name: "Open Changed card, ending 1000" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Card 1, ending 1001" })).toBeNull();
  });
  it("publishes the initial cards after the single artwork-aware read", async () => {
    let finish!: (cards: unknown[]) => void;
    serviceMock.listCardSummaries.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.queryByTestId("wallet-card-browser")).toBeNull();
    await act(async () => finish(makeCards(2)));
    expect(await screen.findByTestId("wallet-card-browser")).toBeVisible();
    expect(document.querySelector('[data-card-artwork="pending"]')).toBeNull();
    expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(1);
    expect(serviceMock.listCardSummaries).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ recoverArtwork: true }));
  });
  it("shows a retry after the initial private read fails", async () => {
    let fail!: (reason: Error) => void;
    serviceMock.listCardSummaries.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(fail).toBeTypeOf("function"));
    await act(async () => fail(new Error("Artwork unavailable")));
    expect(await screen.findByText("Your cards could not be loaded. Please try again.")).toBeVisible();
    expect(screen.queryByTestId("wallet-card-browser")).toBeNull();
  });
  it("keeps a post-delete reload authoritative when focus starts artwork recovery", async () => {
    await open();
    let finishReload!: (cards: ReturnType<typeof makeCards>) => void;
    serviceMock.listCardSummaries.mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(finishReload).toBeTypeOf("function"));
    const readsBeforeFocus = serviceMock.listCardSummaries.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(readsBeforeFocus));
    expect(serviceMock.listCardSummaries.mock.calls.at(-1)?.[1]).toMatchObject({ recoverArtwork: true });
    await act(async () => {});
    await act(async () => finishReload([{ ...makeCards(2)[1]!, nickname: "Updated card" }]));
    expect(await screen.findByRole("button", { name: "Open Updated card, ending 1001" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Card 0, ending 1000" })).toBeNull();
  });
  it("preloads history with a session context that survives tab changes but never lock or epoch changes", async () => {
    const view = await open();
    const context = historyProbe.getContext?.("");
    expect(context?.isCurrent()).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(context?.isCurrent()).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Sharing" }));
    expect(context?.isCurrent()).toBe(true);
    act(() => advanceVaultSessionEpoch());
    expect(context?.isCurrent()).toBe(false);
    const next = historyProbe.getContext?.("");
    expect(next?.isCurrent()).toBe(true);
    vaultMock.locked = true;
    view.rerender(<WalletWorkspace />);
    expect(next?.isCurrent()).toBe(false);
  });
  it("keeps owner numbers masked and security codes and financial placeholders hidden", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal saved details" })).toBeNull();
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Card number");
    expect(screen.getByTestId("wallet-selected-card")).toHaveTextContent("Name on card");
    expect(screen.queryByText("Card balance")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove card" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000"));
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
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
  it("returns to the overview after removal and opens the remaining card with working number access", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000"));
    fireEvent.click(screen.getByRole("button", { name: "Remove card", exact: true }));
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(2).slice(1));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(screen.queryByTestId("wallet-selected-card")).toBeNull());
    const remaining = await screen.findByRole("button", { name: "Open Card 1, ending 1001" });
    await waitFor(() => expect(remaining).not.toBeDisabled());
    serviceMock.getCard.mockClear();
    fireEvent.click(remaining);
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1001");
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    await waitFor(() => expect(serviceMock.getCard).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card_1" })));
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
    if (boundary === "overview") {
      act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
      expect(screen.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
    }
    await act(async () => { resolveToken("identity"); });
    if (boundary === "current") { expect(referralMock.rotateShareLink).toHaveBeenCalledWith({ idToken: "identity", slug: "fixture" }); expect(screen.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", "https://example.test/r/replacement"); expect(screen.getByTestId("wallet-referral-opens")).toHaveTextContent("0"); }
    else expect(referralMock.rotateShareLink).not.toHaveBeenCalled();
  });
  it("copies only on request while keeping security codes and telemetry private", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy name on card" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Test Cardholder"));
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    const copyNumber = screen.getByRole("button", { name: "Copy card number" });
    await waitFor(() => expect(copyNumber).toBeEnabled());
    fireEvent.click(copyNumber);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("4242424242424242"));
    expect(serviceMock.getCard).toHaveBeenCalledTimes(1);
    expect(serviceMock.getCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", cardId: "card_0" }));
    expect(document.body).not.toHaveTextContent("4242424242424242");
    expect(document.body).not.toHaveTextContent("4242 4242 4242 4242");
    expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000");
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.getByTestId("wallet-owner-cvv")).toHaveTextContent("•••");
    expect(serviceMock.getCardSecurityCode).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Saved card details" })).not.toHaveTextContent(/\b(?:CVC|PIN)\b/);
    expect(screen.queryByRole("button", { name: "Copy CVV" })).toBeNull();
    expect(trackEventMock.mock.calls.flatMap((call) => call).map(String).join(" ")).not.toContain("4242424242424242");
  });
  it("reveals a code only on request and hides it after backgrounding or timeout", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    expect(serviceMock.getCardSecurityCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show CVV" }));
    await waitFor(() => expect(screen.getByTestId("wallet-owner-cvv")).toHaveTextContent("007"));
    expect(serviceMock.getCardSecurityCode).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", cardId: "card_0" }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByTestId("wallet-owner-cvv")).toHaveTextContent("•••");
    visibility.mockRestore();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show CVV" })); });
      expect(screen.getByTestId("wallet-owner-cvv")).toHaveTextContent("007");
      act(() => { vi.advanceTimersByTime(45_001); });
    }
    finally { vi.useRealTimers(); }
    expect(screen.getByTestId("wallet-owner-cvv")).toHaveTextContent("•••");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(trackEventMock.mock.calls.flat().join()).not.toContain("007");
  });
  it.each(["owner", "lock", "tab", "card", "visibility", "epoch"])("drops a delayed CVV read after %s changes", async boundary => {
    let finish!: (value: string) => void;
    serviceMock.getCardSecurityCode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Show CVV" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "owner") { authMock.user = { uid: "user_2" }; view.rerender(<WalletWorkspace />); }
    if (boundary === "lock") { vaultMock.locked = true; view.rerender(<WalletWorkspace />); }
    if (boundary === "tab") fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    if (boundary === "card") { fireEvent.click(screen.getByRole("button", { name: "All (5)" })); fireEvent.click(screen.getByRole("button", { name: "Open Card 1, ending 1001" })); }
    if (boundary === "epoch") act(() => advanceVaultSessionEpoch());
    const visibility = boundary === "visibility" ? vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden") : null;
    if (visibility) fireEvent(document, new Event("visibilitychange"));
    await act(async () => finish("007"));
    expect(document.body).not.toHaveTextContent("007");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    visibility?.mockRestore();
  });
  it.each(["owner", "lock", "tab", "card", "overview"])("rejects a late number copy after changing %s", async (change) => {
    let resolveCopy!: (result: unknown) => void;
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000"));
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
      await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000"));
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
      else expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1000");
    } finally { vi.unstubAllGlobals(); }
  });
  it("opens the existing Add form from a selected card", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a card", exact: true }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("secure-card-add-form")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Take photo" })).toBeNull();
    const photos = screen.getByRole("button", { name: "Choose from photos", exact: true });
    expect(photos).toBeVisible();
    const choosePhoto = vi.spyOn(screen.getByLabelText("Choose a card photo", { exact: true }), "click");
    fireEvent.click(photos);
    expect(choosePhoto).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Scan card" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
  });
  it("removes the browser when the vault locks", async () => {
    const view = await open();
    vaultMock.locked = true;
    view.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("wallet-card-browser")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Wallet card switcher" })).toBeNull();
  });
  it.each(["owner", "lock", "tab", "visibility"])("rejects a pending number copy when %s changes", async boundary => {
    let finish!: (value: unknown) => void;
    serviceMock.getCard.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy card number" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (boundary === "owner") { authMock.user = { uid: "user_2" }; view.rerender(<WalletWorkspace />); }
    if (boundary === "lock") { vaultMock.locked = true; view.rerender(<WalletWorkspace />); }
    if (boundary === "tab") fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    if (boundary === "visibility") { vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange")); }
    await act(async () => finish({ secrets: { pan: "4000000000000002", cvv: "999", pin: "9876" } }));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("4000000000000002");
    expect(document.body).not.toHaveTextContent("4000 0000 0000 0002");
    expect(trackEventMock.mock.calls.flat().join()).not.toContain("4000000000000002");
    vi.restoreAllMocks();
  });
  it("opens the matching card after selecting a search result", async () => {
    const view = await open();
    navigationMock.search = "q=1001";
    view.rerender(<WalletWorkspace />);
    expect(screen.queryByRole("button", { name: "Search cards" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search cards" }), { target: { value: "1001" } });
    const result = await screen.findByRole("button", { name: "Card 1 · Visa ending 1001" });
    fireEvent.click(result);
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByTestId("wallet-card-face")).toHaveTextContent("Card 1");
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByTestId("one-wallet-reveal-1001")).toBeNull();
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved card details" })).toHaveTextContent("•••• •••• •••• 1001"));
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

beforeEach(() => CacheService.getInstance().clear());
