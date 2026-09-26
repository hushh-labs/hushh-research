import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "owner",
  unlocked: true,
  epoch: 1,
  getToken: vi.fn(),
  invalidate: vi.fn(),
  service: {
    prepareOwnerShare: vi.fn(),
    shareOwnerFiles: vi.fn(),
  },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.unlocked,
    getVaultOwnerToken: state.getToken,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: state.invalidate },
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: state.service,
}));
vi.mock("@/components/consent/document-share-review", () => ({
  DocumentShareReview: ({ requestId }: { requestId: string }) => (
    <div data-testid="share-review">{requestId}</div>
  ),
}));
import { DriveOwnerShareCard } from "@/components/consent/drive-owner-share-card";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

const personRef = "11111111-1111-4111-8111-111111111111";
const clientRequestId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const shareRequestId = "44444444-4444-4444-8444-444444444444";

const ready = {
  requestId,
  status: "ready" as const,
  recipientName: "Rahul",
  files: [
    { ref: "f1", name: "Chris onboarding 1.mp4", modifiedTime: "2026-09-24T18:00:00Z" },
    { ref: "f2", name: "Chris onboarding 2.mp4", modifiedTime: null },
  ],
  shareRequestId: null,
  message: null,
};

function renderCard() {
  return render(
    <DriveOwnerShareCard
      personRef={personRef}
      personName="Rahul"
      clientRequestId={clientRequestId}
      filesRequest="the Chris onboarding recordings"
    />,
  );
}

describe("DriveOwnerShareCard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.unlocked = true;
    state.getToken.mockReturnValue("owner-token");
  });
  afterEach(cleanup);

  it("searches nothing until the owner taps Find files", () => {
    renderCard();
    expect(screen.getByText("“the Chris onboarding recordings”")).toBeTruthy();
    expect(state.service.prepareOwnerShare).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Find files" })).toBeTruthy();
  });

  it("shares only the files the owner keeps ticked", async () => {
    state.service.prepareOwnerShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles.mockResolvedValue({
      ...ready,
      status: "shared",
      shareRequestId,
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding 1.mp4");
    expect(state.service.prepareOwnerShare).toHaveBeenCalledWith(
      "owner-token",
      expect.objectContaining({
        recipientPersonRef: personRef,
        clientRequestId,
        query: "the Chris onboarding recordings",
      }),
      expect.any(Function),
    );
    // Every found file starts selected; the owner unticks the second.
    fireEvent.click(screen.getByRole("checkbox", { name: /Chris onboarding 2\.mp4/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file" }));
    await screen.findByText("Sharing requested for Rahul.");
    expect(state.service.shareOwnerFiles).toHaveBeenCalledWith(
      "owner-token",
      requestId,
      ["f1"],
      expect.any(Function),
    );
    expect(screen.getByTestId("share-review").textContent).toBe(shareRequestId);
    expect(state.invalidate).toHaveBeenCalledWith("owner");
  });

  it("says plainly when nothing matched and lets the owner search again", async () => {
    state.service.prepareOwnerShare.mockResolvedValue({
      requestId: null,
      status: "no_match",
      recipientName: null,
      files: [],
      shareRequestId: null,
      message: "Which file do you mean?",
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("No matching files found.");
    expect(screen.getByText("Which file do you mean?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search again" })).toBeTruthy();
    expect(state.service.shareOwnerFiles).not.toHaveBeenCalled();
  });

  it("explains a recipient without a Google account and shares nothing", async () => {
    state.service.prepareOwnerShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles.mockRejectedValue(
      new DriveSharingError("recipient_google_identity_required", 409),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding 1.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Share 2 files" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Rahul's Google sign-in needs attention in One.",
      ),
    );
    expect(screen.queryByTestId("share-review")).toBeNull();
  });

  it("offers the search again when Drive didn't answer or the search expired", async () => {
    state.service.prepareOwnerShare
      .mockRejectedValueOnce(new DriveSharingError("drive_query_unavailable", 503))
      .mockResolvedValue(ready);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Drive didn't answer. Try again."),
    );
    // Never "No matching files found" for a failed search.
    expect(screen.queryByText("No matching files found.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding 1.mp4");
    state.service.shareOwnerFiles.mockRejectedValue(
      new DriveSharingError("owner_share_expired", 409),
    );
    fireEvent.click(screen.getByRole("button", { name: "Share 2 files" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "This search expired. Find the files again.",
      ),
    );
    expect(screen.getByRole("button", { name: "Find files" })).toBeTruthy();
  });

  it("asks for the vault before anything else", () => {
    state.unlocked = false;
    renderCard();
    expect(screen.getByText("Unlock your vault to share Drive files.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
