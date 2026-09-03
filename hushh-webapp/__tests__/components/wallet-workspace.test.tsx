import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/wallet",
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({ replace: navigationMock.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigationMock.search),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user_1" }, loading: false }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: "vault_key", getVaultOwnerToken: () => "owner_token" }),
}));

vi.mock("@/components/profile/pkm-settings-shell", () => ({
  PkmSettingsShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));

const serviceMock = vi.hoisted(() => ({
  listCardSummaries: vi.fn(),
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
  beforeEach(() => {
    navigationMock.search = "";
    navigationMock.replace.mockReset();
    serviceMock.listCardSummaries.mockResolvedValue(makeCards(25));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("paginates 25 cards ten at a time with a Page x of y footer", async () => {
    render(<WalletWorkspace />);
    await waitFor(() => expect(screen.getByTestId("one-wallet-list")).toBeTruthy());
    expect(screen.getByTestId("one-wallet-list").querySelectorAll("li")).toHaveLength(10);
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
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
});
