import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ epoch: 1, shares: vi.fn(), files: vi.fn(), memory: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: { listSharedWithMe: state.memory },
}));
vi.mock("@/lib/services/drive-sharing-service", () => ({
  DriveSharingService: { receivedBulkShares: state.shares, receivedBulkFiles: state.files },
}));

import { SharedWithYouGroup } from "@/components/profile/shared-with-you-group";

beforeEach(() => {
  vi.resetAllMocks(); state.epoch = 1;
  state.memory.mockResolvedValue([]);
  state.shares.mockResolvedValue([{ shareId: "11111111-1111-4111-8111-111111111111",
    status: "running", sharedCount: 2, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z" }]);
  state.files.mockResolvedValue({ shareId: "11111111-1111-4111-8111-111111111111", sharedCount: 2,
    files: [{ name: "Statement", openUrl: "https://drive.google.com/file/d/test/view", modifiedTime: null }],
    nextCursor: null });
});
afterEach(() => cleanup());

describe("received bulk Drive collection", () => {
  it("shows confirmed links without a Drive connector and clears them on vault change", async () => {
    const view = render(<SharedWithYouGroup vaultOwnerToken="owner-a" />);
    fireEvent.click(await screen.findByRole("button", { name: /2 files/ }));
    expect(await screen.findByRole("link", { name: "Statement" })).toHaveAttribute(
      "href", "https://drive.google.com/file/d/test/view",
    );
    expect(state.files).toHaveBeenCalledWith("owner-a", expect.any(String), expect.any(Function), null);
    state.epoch = 2;
    view.rerender(<SharedWithYouGroup vaultOwnerToken="owner-b" />);
    expect(screen.queryByRole("link", { name: "Statement" })).toBeNull();
  });
});
