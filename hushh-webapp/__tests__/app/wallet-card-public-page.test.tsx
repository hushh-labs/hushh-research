import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePublicCard: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: SHARE_TOKEN }),
}));

vi.mock("@/lib/services/wallet-card-service", () => ({
  WalletCardService: {
    resolvePublicCard: mocks.resolvePublicCard,
  },
}));

const SHARE_TOKEN = "wallet-card-test-token-not-a-real-secret";

import PublicWalletCardPageClient from "@/app/c/[token]/page-client";

/**
 * Regression coverage for a real integration defect.
 *
 * `WalletCardService.resolvePublicCard` *resolves* terminal states rather than
 * throwing. The page originally only handled thrown `ApiError`s, so a revoked or
 * expired card took the success path, produced no renderable card, and fell
 * through to the generic "isn't available" message — silently hiding the honest
 * copy the contract requires. These tests fail against that version.
 */
describe("PublicWalletCardPageClient terminal states", () => {
  beforeEach(() => {
    mocks.resolvePublicCard.mockReset();
  });

  it("shows the revoked copy when the owner has stopped sharing", async () => {
    mocks.resolvePublicCard.mockResolvedValue({
      state: "revoked",
      message: "This profile is no longer shared.",
    });

    render(<PublicWalletCardPageClient />);

    await waitFor(() =>
      expect(
        screen.getByText("This profile is no longer shared."),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("This profile isn't available."),
    ).not.toBeInTheDocument();
  });

  it("shows the expired copy when the link has lapsed", async () => {
    mocks.resolvePublicCard.mockResolvedValue({
      state: "expired",
      message: "This profile link has expired.",
    });

    render(<PublicWalletCardPageClient />);

    await waitFor(() =>
      expect(
        screen.getByText("This profile link has expired."),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("This profile is no longer shared."),
    ).not.toBeInTheDocument();
  });

  it("renders an unknown and a paused card identically", async () => {
    // The backend serves a paused card as the same generic 404 as an unknown
    // token, so the page must not be able to tell them apart (contract §6).
    mocks.resolvePublicCard.mockResolvedValue({
      state: "not_found",
      message: "This profile is not available.",
    });

    const unknown = render(<PublicWalletCardPageClient />);
    await waitFor(() =>
      expect(screen.getByText("This profile isn't available.")).toBeInTheDocument(),
    );
    const unknownMarkup = unknown.container.innerHTML;
    unknown.unmount();

    mocks.resolvePublicCard.mockResolvedValue({
      state: "not_found",
      message: "This profile is not available.",
    });

    const paused = render(<PublicWalletCardPageClient />);
    await waitFor(() =>
      expect(screen.getByText("This profile isn't available.")).toBeInTheDocument(),
    );

    expect(paused.container.innerHTML).toBe(unknownMarkup);
  });

  it("renders the profile when the card is available", async () => {
    mocks.resolvePublicCard.mockResolvedValue({
      state: "available",
      card: {
        full_name: "Ada Lovelace",
        headline: "Founder, Hussh",
      },
    });

    render(<PublicWalletCardPageClient />);

    await waitFor(() =>
      expect(screen.getByText("Ada Lovelace")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("This profile isn't available."),
    ).not.toBeInTheDocument();
  });
});
