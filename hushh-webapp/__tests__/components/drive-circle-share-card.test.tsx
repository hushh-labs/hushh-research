import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  unlocked: true,
  epoch: 1,
  getToken: vi.fn(),
  invalidate: vi.fn(),
  service: { prepareTrustedShare: vi.fn(), shareOwnerFiles: vi.fn() },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "owner" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: state.unlocked, getVaultOwnerToken: state.getToken }),
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
import { DriveCircleShareCard } from "@/components/consent/drive-circle-share-card";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

const clientRequestId = "22222222-2222-4222-8222-222222222222";
const bo = "33333333-3333-4333-8333-333333333333";
const di = "44444444-4444-4444-8444-444444444444";
const ready = {
  status: "ready" as const,
  files: [{ ref: "f1", name: "Chris onboarding.mp4", modifiedTime: null }],
  recipients: [
    { requestId: bo, name: "Bo", status: "ready" as const, shareRequestId: null },
    { requestId: di, name: "Di", status: "ready" as const, shareRequestId: null },
  ],
  excluded: [{ name: "Cy", reason: "contacts" as const }],
  message: null,
};

describe("DriveCircleShareCard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.unlocked = true;
    state.getToken.mockReturnValue("owner-token");
  });
  afterEach(cleanup);

  it("shows who can receive and who cannot, then shares one person at a time", async () => {
    state.service.prepareTrustedShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles.mockResolvedValueOnce({}).mockRejectedValueOnce(
      new DriveSharingError("recipient_google_identity_required", 409),
    );
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    expect(state.service.prepareTrustedShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding.mp4");
    expect(screen.getByText("Cy — connected through contacts, not a request")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    await waitFor(() => expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(2));
    expect(state.service.shareOwnerFiles.mock.calls.map((call) => call[1])).toEqual([bo, di]);
    expect(state.service.shareOwnerFiles.mock.calls[0][2]).toEqual(["f1"]);
    await screen.findByText("Some people didn't get the files. Try again for them.");
    expect(screen.getByText(/· not shared/)).toBeTruthy();
  });

  it("shares nothing with a person the owner unticks", async () => {
    state.service.prepareTrustedShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles.mockResolvedValue({});
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding.mp4");
    fireEvent.click(screen.getByRole("checkbox", { name: /Di/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 1 person" }));
    await waitFor(() => expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(1));
    expect(state.service.shareOwnerFiles.mock.calls[0][1]).toBe(bo);
  });

  it("offers Find files again when the search expired", async () => {
    state.service.prepareTrustedShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles.mockRejectedValue(
      new DriveSharingError("owner_share_expired", 409),
    );
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    await screen.findByText("This search expired. Find the files again.");
    expect(screen.getByRole("button", { name: "Find files" })).toBeTruthy();
  });

  it("says so when no one in the circle can receive yet", async () => {
    state.service.prepareTrustedShare.mockResolvedValue({
      ...ready, status: "no_recipients", files: [], recipients: [],
    });
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("No one in your Trusted circle can receive files yet.");
    expect(state.service.shareOwnerFiles).not.toHaveBeenCalled();
  });
});
