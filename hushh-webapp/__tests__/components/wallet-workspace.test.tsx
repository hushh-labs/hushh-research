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

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/wallet",
  search: "",
  replace: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  user: { uid: "user_1" } as { uid: string } | null,
}));
const trackEventMock = vi.hoisted(() => vi.fn());
const nativeBeaconMock = vi.hoisted(() => vi.fn());
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
  NativeTestBeacon: (props: { dataState: string }) => {
    nativeBeaconMock(props);
    return null;
  },
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

import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { WalletWorkspace } from "@/components/wallet/wallet-workspace";
import { stageReservedOfferPrefill } from "@/lib/pkm/reserved-offer";

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
  it("skips the introduction for an account that has continued before", async () => {
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockResolvedValueOnce(true);
    serviceMock.listCardSummaries.mockResolvedValue([]);
    render(<WalletWorkspace />);
    expect(await screen.findByRole("tab", { name: "Cards", exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue", exact: true })).toBeNull();
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
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "New card" } });
    fireEvent.change(screen.getByLabelText(/Card number/), { target: { value: "4242424242424242" } });
    fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "04/30" } });
    fireEvent.change(screen.getByLabelText("Issuing region"), { target: { value: "IN" } });
  };

  it.each(["", "   "])("saves a card without an optional PIN (%j)", async (pin) => {
    const summary = { ...makeCards(1)[0], cardId: "saved", nickname: "New card", last4: "4242" };
    serviceMock.addCard.mockResolvedValue({ cardId: "saved", summary });
    render(<WalletWorkspace />);
    const button = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(button); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fillCard();
    fireEvent.change(screen.getByLabelText("PIN (optional)"), { target: { value: pin } });
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await screen.findByTestId("wallet-selected-card");
    expect(serviceMock.addCard).toHaveBeenCalledWith(expect.objectContaining({ card: expect.objectContaining({ pin: undefined }) }));
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
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await screen.findByTestId("wallet-selected-card");
    expect(screen.getByRole("button", { name: "Open New card, ending 4242" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
    expect(serviceMock.listCardSummaries).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "All (3)" }));
    expect(screen.getAllByTestId(/^wallet-add-layer-/).map((el) => el.getAttribute("data-testid"))).toEqual(["wallet-add-layer-1000", "wallet-add-layer-1001", "wallet-add-layer-4242"]);
  });

  it("retains a failed save draft and rejects a late save after vault lock", async () => {
    serviceMock.addCard.mockRejectedValueOnce(new Error("Could not save"));
    const workspace = render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByTestId("one-wallet-add"));
    fillCard();
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await screen.findByText("Could not save");
    expect(screen.getByLabelText("Nickname")).toHaveValue("New card");
    let finish!: (value: unknown) => void;
    serviceMock.addCard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByTestId("secure-card-save"));
    vaultMock.locked = true;
    workspace.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    await act(async () => finish({ cardId: "saved", summary: makeCards(1)[0] }));
    expect(screen.queryByTestId("wallet-add-collection")).toBeNull();
    expect(screen.queryByTestId("secure-card-add-form")).toBeNull();
  });

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
    expect(screen.getByTestId("wallet-add-collection")).toBeTruthy();
    expect(screen.getByTestId("secure-card-add-form")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Add" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Cards" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps a draft across tabs, masks it on departure, and drops it on vault lock", async () => {
    const workspace = render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "Travel" } });
    fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Show CVV and PIN" }));
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("tab", { name: "Cards" }));
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(screen.getByLabelText("Nickname")).toHaveValue("Travel");
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "password");
    vaultMock.locked = true;
    workspace.rerender(<WalletWorkspace />);
    await screen.findByTestId("one-wallet-locked");
    expect(screen.queryByTestId("secure-card-add-form")).toBeNull();
  });

  it("rejects a reveal that completes after leaving Cards", async () => {
    let finish!: (value: unknown) => void;
    serviceMock.getCard.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByTestId("one-wallet-reveal-1000"));
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
    vi.mocked(OnboardingLocalService.hasSeenWalletIntroduction).mockReset().mockResolvedValue(false);
    vi.mocked(OnboardingLocalService.markWalletIntroductionSeen).mockReset().mockResolvedValue(undefined);
    authMock.user = { uid: "user_1" };
    vaultMock.locked = false;
    navigationMock.search = "";
    navigationMock.replace.mockReset();
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(25));
    serviceMock.deleteCard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders every saved card in storage order for scroll unfolding", async () => {
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await screen.findByTestId("wallet-add-collection");
    expect(screen.getAllByTestId(/^wallet-add-layer-/)).toHaveLength(25);
    expect(screen.getAllByTestId(/^wallet-add-layer-/).map(node => node.dataset.gestureCard)).toEqual(
      Array.from({ length:25 }, (_, index) => `card_${index}`),
    );
    expect(screen.getByTestId("wallet-add-stack")).toHaveAttribute("data-expanded", "true");
  });

  it("opens Add card with the nickname a chat offer handed over in memory", async () => {
    stageReservedOfferPrefill({
      ownerUserId: "user_1",
      ownerFeature: "wallet",
      prefill: { kind: "wallet_card", nickname: "Amex Gold" },
    });
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByLabelText("Nickname")).toHaveValue("Amex Gold"));
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
    expect(screen.getByRole("heading", { name: "Wallet" })).toBeTruthy();
    expect(screen.getByTestId("wallet-card-browser")).toBeTruthy();
  });

  it("search narrows metadata and reports no match", async () => {
    render(<WalletWorkspace />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await act(async () => { fireEvent.click(continueButton); });
    await waitFor(() => expect(screen.getByTestId("wallet-add-collection")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Search cards" }));
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
    fireEvent.click(screen.getByTestId("one-wallet-remove"));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(finishDelete).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: "Add a card", exact: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "All (25)" })).toBeDisabled();
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
    fireEvent.click(screen.getByTestId("one-wallet-remove"));
    expect(await screen.findByTestId("one-wallet-remove-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("one-wallet-remove-cancel"));
    await waitFor(() => expect(screen.queryByTestId("one-wallet-remove-confirm")).toBeNull());
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();

    // Negative control: confirming does remove it.
    fireEvent.click(screen.getByRole("button", { name: "Open Card 0, ending 1000" }));
    fireEvent.click(screen.getByTestId("one-wallet-remove"));
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

  it("reveals a focused card only through Show card details", async () => {
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
    fireEvent.click(screen.getByTestId("one-wallet-reveal-1000"));
    expect(await screen.findByTestId("secure-card-reveal")).toBeTruthy();
    expect(serviceMock.getCard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("secure-card-hide"));
    await waitFor(() => expect(screen.queryByTestId("secure-card-reveal")).toBeNull());
    expect(document.body.textContent).not.toContain("4242 4242 4242 1000");
  });
});
