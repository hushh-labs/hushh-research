import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WalletReferralCardDetails } from "@/components/wallet/wallet-referral-card-details";
import { WalletCardService } from "@/lib/services/wallet-card-service";
import { copyWalletCardLink, shareWalletCardLink } from "@/components/wallet-card/wallet-card-share";
import type { ReferralSummary } from "@/lib/services/referral-service";

vi.mock("@/components/wallet-card/wallet-card-share", () => ({
  copyWalletCardLink: vi.fn().mockResolvedValue(true),
  shareWalletCardLink: vi.fn().mockResolvedValue("web-share"),
  isShareAbortError: () => false,
}));

const summary: ReferralSummary = {
  slug: "ada-1234",
  link: "https://uat.one.hushh.ai/r/ada-1234",
  link_open_count: 17,
  last_opened_at: null,
  qualified_count: 3,
  in_progress_count: 2,
  under_review_count: 1,
  required_active_minutes: 15,
  new_users_only: true,
  referrals: [],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Wallet referral card details", () => {
  it("offers retry after a failed first load and returns to loading while retrying", () => {
    const retry = vi.fn();
    const view = render(<WalletReferralCardDetails summary={null} shareToken={null} failed onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<WalletReferralCardDetails summary={null} shareToken={null} onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("is loading");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("labels real link opens separately from qualified referrals", () => {
    render(<WalletReferralCardDetails summary={summary} shareToken="test-wallet-token" />);
    expect(screen.getByText("Link opens")).toBeTruthy();
    expect(screen.getByText("17")).toBeTruthy();
    expect(screen.getByText("Qualified referrals")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("Scans")).toBeNull();
    expect(screen.getByRole("link", { name: "Preview referral page" }).getAttribute("href")).toBe(summary.link);
  });

  it("shares the referral link and requests the referral pass variant", async () => {
    const addPass = vi.spyOn(WalletCardService, "addToAppleWallet").mockResolvedValue({ state: "opened", url: "https://example.com/pass" });
    render(<WalletReferralCardDetails summary={summary} shareToken="test-wallet-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Share card" }));
    await waitFor(() => expect(shareWalletCardLink).toHaveBeenCalledWith(expect.objectContaining({ url: summary.link })));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(copyWalletCardLink).toHaveBeenCalledWith(summary.link));
    fireEvent.click(screen.getByRole("button", { name: "Add to Apple Wallet" }));
    await waitFor(() => expect(addPass).toHaveBeenCalledWith("test-wallet-token", { variant: "referral" }));
  });

  it("does not invent zero activity before the summary is available", () => {
    render(<WalletReferralCardDetails summary={null} shareToken={null} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});
