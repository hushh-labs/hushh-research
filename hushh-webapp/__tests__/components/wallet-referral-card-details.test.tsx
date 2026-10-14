import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WalletReferralCardDetails } from "@/components/wallet/wallet-referral-card-details";
import { WalletCardService } from "@/lib/services/wallet-card-service";
import { copyWalletCardLink } from "@/components/wallet-card/wallet-card-share";
import { createWalletCardImageFile } from "@/lib/wallet/wallet-card-image";
import { shareFile } from "@/lib/share/share-file";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { ReferralSummary } from "@/lib/services/referral-service";

vi.mock("@/components/wallet-card/wallet-card-share", () => ({
  copyWalletCardLink: vi.fn().mockResolvedValue(true),
  isShareAbortError: () => false,
}));

vi.mock("@/lib/wallet/wallet-card-image", () => ({ createWalletCardImageFile: vi.fn(async () => new File(["png"], "referral.png", { type: "image/png" })) }));
vi.mock("@/lib/share/share-file", () => ({ shareFile: vi.fn(async () => "web-share") }));
const profile = { ownerId: "owner", displayName: "Ada", shareUrl: "https://example.test/c/profile", referralUrl: "https://example.test/r/stale" };

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

  it("shares a card image using the current referral URL and requests the referral pass variant", async () => {
    const addPass = vi.spyOn(WalletCardService, "addToAppleWallet").mockResolvedValue({ state: "opened", url: "https://example.com/pass" });
    render(<WalletReferralCardDetails summary={summary} shareToken="test-wallet-token" profile={profile} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share card" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Share card" }));
    await waitFor(() => expect(shareFile).toHaveBeenCalledWith(expect.objectContaining({ file: expect.any(File) })));
    expect(createWalletCardImageFile).toHaveBeenCalledWith(expect.objectContaining({ kind: "referral", profile: expect.objectContaining({ referralUrl: summary.link }) }));
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

  it.each(["unmount", "owner", "callback"])("suppresses a retired revoke settlement after %s", async boundary => {
    let finish!: () => void;
    const revoke = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const toast = vi.spyOn(morphyToast, "success");
    const view = render(<WalletReferralCardDetails summary={summary} shareToken={null} profile={profile} onRevoke={revoke} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke access", exact: true }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke access", exact: true }));
    if (boundary === "unmount") view.unmount();
    else view.rerender(<WalletReferralCardDetails summary={summary} shareToken={null} profile={boundary === "owner" ? { ...profile, ownerId: "other-owner" } : profile} onRevoke={boundary === "callback" ? vi.fn() : revoke} />);
    if (boundary !== "unmount") { expect(screen.queryByRole("alertdialog")).toBeNull(); expect(screen.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled(); }
    await act(async () => { finish(); });
    expect(toast).not.toHaveBeenCalled();
  });
  it("does not let a retired pass handoff clear a newer revoke", async () => {
    let finishPass!: (result: { state: "opened"; url: string }) => void;
    vi.spyOn(WalletCardService, "addToAppleWallet").mockImplementation(() => new Promise(resolve => { finishPass = resolve; }));
    const view = render(<WalletReferralCardDetails summary={summary} shareToken="test-wallet-token" profile={profile} onRevoke={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to Apple Wallet" }));
    let finishRevoke!: () => void;
    view.rerender(<WalletReferralCardDetails summary={summary} shareToken="test-wallet-token" profile={profile} onRevoke={() => new Promise(resolve => { finishRevoke = resolve; })} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke access", exact: true }));
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke access", exact: true });
    fireEvent.click(confirm);
    await act(async () => { finishPass({ state: "opened", url: "https://example.test/pass" }); });
    expect(confirm).toBeDisabled();
    await act(async () => { finishRevoke(); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("retains confirmed referral counts after a failed revoke", async () => {
    const revoke = vi.fn().mockRejectedValue(new Error("Storage unavailable"));
    render(<WalletReferralCardDetails summary={summary} shareToken={null} onRevoke={revoke} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke access", exact: true }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access", exact: true }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(summary.slug));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled());
    expect(screen.getByTestId("wallet-referral-opens")).toHaveTextContent("17");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel", exact: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", summary.link);
  });
});
