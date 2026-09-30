import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("WalletWorkspace at scale", () => {
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
    const addRefresh = source.indexOf("await refresh(", addError);
    expect(addSuccess).toBeGreaterThan(-1);
    expect(addCatch).toBeGreaterThan(addSuccess);
    expect(addError).toBeGreaterThan(addCatch);
    expect(addRefresh).toBeGreaterThan(addError);
    expect(source).toContain("activeOwnerIdRef.current = null");
  });

  beforeEach(() => {
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

  it("paginates 25 cards ten at a time with a Page x of y footer", async () => {
    render(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-list")).toBeTruthy());
    expect(screen.getByTestId("one-wallet-list").querySelectorAll("li")).toHaveLength(10);
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Go to next page"));
    expect(navigationMock.replace).toHaveBeenCalledWith("/one/wallet?page=2", { scroll: false });
  });

  it("renders the requested page from the URL", async () => {
    navigationMock.search = "page=3";
    render(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByText("Page 3 of 3")).toBeTruthy());
    expect(screen.getByTestId("one-wallet-list").querySelectorAll("li")).toHaveLength(5);
  });

  it("search narrows the list and reports no match", async () => {
    render(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-list")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("one-wallet-search"), { target: { value: "amex" } });
    });
    await waitFor(() =>
      expect(screen.getByTestId("one-wallet-list").querySelectorAll("li")).toHaveLength(1),
    );
    expect(screen.getByText("Travel Amex")).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByTestId("one-wallet-search"), { target: { value: "nothing-here" } });
    });
    await waitFor(() => expect(screen.getByTestId("one-wallet-no-match")).toBeTruthy());
  });

  it("does not attribute a late card deletion to a replacement owner", async () => {
    let finishDelete!: () => void;
    serviceMock.deleteCard.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
    const view = render(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-list")).toBeTruthy());

    fireEvent.click(screen.getByTestId("one-wallet-card-1000"));
    fireEvent.click(screen.getByTestId("one-wallet-remove"));
    fireEvent.click(await screen.findByTestId("one-wallet-remove-confirm-action"));
    await waitFor(() => expect(finishDelete).toBeTypeOf("function"));
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
    await waitFor(() => expect(screen.getByTestId("one-wallet-list")).toBeTruthy());
    fireEvent.click(screen.getByTestId("one-wallet-card-1000"));
    fireEvent.click(screen.getByTestId("one-wallet-remove"));
    expect(await screen.findByTestId("one-wallet-remove-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("one-wallet-remove-cancel"));
    await waitFor(() => expect(screen.queryByTestId("one-wallet-remove-confirm")).toBeNull());
    expect(serviceMock.deleteCard).not.toHaveBeenCalled();

    // Negative control: confirming does remove it.
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
    const unlock = await screen.findByTestId("one-wallet-unlock");
    expect(screen.queryByTestId("one-wallet-list")).toBeNull();
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
    await waitFor(() => expect(screen.getByTestId("one-wallet-list")).toBeTruthy());
    expect(screen.getByTestId("one-wallet-list").textContent).not.toContain("4242 4242 4242 1000");
    fireEvent.click(screen.getByTestId("one-wallet-card-1000"));
    expect(serviceMock.getCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("one-wallet-reveal-1000"));
    expect(await screen.findByTestId("secure-card-reveal")).toBeTruthy();
    expect(serviceMock.getCard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("secure-card-hide"));
    await waitFor(() => expect(screen.queryByTestId("secure-card-reveal")).toBeNull());
    expect(document.body.textContent).not.toContain("4242 4242 4242 1000");
  });
});
