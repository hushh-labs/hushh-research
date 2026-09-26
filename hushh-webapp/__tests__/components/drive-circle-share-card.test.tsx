import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";

const clientRequestId = "22222222-2222-4222-8222-222222222222";
const bo = "33333333-3333-4333-8333-333333333333";
const di = "44444444-4444-4444-8444-444444444444";
const shareRequestId = "55555555-5555-4555-8555-555555555555";
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
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows who can receive and who cannot, then shares one person at a time", async () => {
    state.service.prepareTrustedShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles.mockResolvedValueOnce({ shareRequestId }).mockRejectedValueOnce(
      new DriveSharingError("recipient_google_identity_required", 409),
    );
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    expect(state.service.prepareTrustedShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding.mp4");
    expect(screen.getByText(/Search took \d+\.\ds\./).getAttribute("data-operation")).toBe("drive_search");
    expect(screen.getByText("Cy — connected through contacts, not a request")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    await waitFor(() => expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(2));
    expect(state.service.shareOwnerFiles.mock.calls.map((call) => call[1])).toEqual([bo, di]);
    expect(state.service.shareOwnerFiles.mock.calls[0][2]).toEqual(["f1"]);
    await screen.findByText("Couldn't start sharing with everyone. Retry the people marked below.");
    expect(screen.getByText(/sharing requested/)).toBeTruthy();
    expect(screen.getByText(/Their Google sign-in needs attention in One/)).toBeTruthy();
    expect(screen.queryByText(/· shared/)).toBeNull();
    expect(screen.getByRole("link", { name: "Sharing status and links for Bo" }).getAttribute("href"))
      .toContain(`document_share_request%3A${shareRequestId}`);
    expect(screen.getByText(/Share took \d+\.\ds\./).getAttribute("data-outcome")).toBe("partial");
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

  it.each(["owner_share_expired", "request_changed"])(
    "keeps an accepted receipt when a later recipient returns %s and retries only the remaining person",
    async (code) => {
      const dispatch = vi.spyOn(window, "dispatchEvent");
      const freshDi = "66666666-6666-4666-8666-666666666666";
      const diShare = "77777777-7777-4777-8777-777777777777";
      state.service.prepareTrustedShare.mockResolvedValueOnce(ready).mockResolvedValueOnce({
        ...ready,
        recipients: [
          { ...ready.recipients[0], status: "shared", shareRequestId },
          { ...ready.recipients[1], requestId: freshDi },
        ],
      });
      state.service.shareOwnerFiles
        .mockResolvedValueOnce({ shareRequestId })
        .mockRejectedValueOnce(new DriveSharingError(code, 409))
        .mockResolvedValueOnce({ shareRequestId: diShare });
      render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
      fireEvent.click(screen.getByRole("button", { name: "Find files" }));
      await screen.findByText("Chris onboarding.mp4");
      fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));

      await screen.findByText("Some remaining shares need a fresh review.");
      expect(screen.getByRole("link", { name: "Sharing status and links for Bo" }).getAttribute("href"))
        .toContain(`document_share_request%3A${shareRequestId}`);
      expect(state.invalidate).toHaveBeenCalledExactlyOnceWith("owner");
      const reconciliations = () => dispatch.mock.calls.filter(([event]) => event.type === CONSENT_ACTION_COMPLETE_EVENT);
      expect(reconciliations()).toHaveLength(1);
      expect((reconciliations()[0][0] as CustomEvent).detail).toEqual({ reconcile: true });
      const retryShare = screen.getByRole("button", { name: "Share 1 file with 1 person" });
      expect(retryShare.hasAttribute("disabled")).toBe(true);
      fireEvent.click(retryShare);
      expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole("button", { name: "Review remaining shares" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Review remaining shares" })).toBeNull());
      expect(screen.getByRole("link", { name: "Sharing status and links for Bo" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 1 person" }));
      await screen.findByRole("link", { name: "Sharing status and links for Di" });
      expect(state.service.shareOwnerFiles.mock.calls.map((call) => call[1])).toEqual([bo, di, freshDi]);
      expect(state.invalidate).toHaveBeenCalledTimes(2);
      expect(reconciliations()).toHaveLength(2);
    },
  );

  it("announces recipient progress and reconciles accepted work while the next share is still pending", async () => {
    let finishFirst!: (value: { shareRequestId: string }) => void;
    let finishSecond!: (value: { shareRequestId: string }) => void;
    state.service.prepareTrustedShare.mockResolvedValue(ready);
    state.service.shareOwnerFiles
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve; }));
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Sharing with 1 of 2 people…");
    expect(screen.getByRole("status").closest('[aria-busy="true"]')).toBeNull();
    expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(1);
    expect(state.invalidate).not.toHaveBeenCalled();

    await act(async () => { finishFirst({ shareRequestId }); });
    expect(screen.getByRole("status").textContent).toBe("Sharing with 2 of 2 people…");
    expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(2);
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith("owner");
    expect(screen.getByRole("link", { name: "Sharing status and links for Bo" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sharing status and links for Di" })).toBeNull();

    await act(async () => { finishSecond({ shareRequestId: "77777777-7777-4777-8777-777777777777" }); });
    expect(screen.getByRole("status").textContent).toBe("Sharing requested for 2 people.");
    expect(state.invalidate).toHaveBeenCalledTimes(2);
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
    await screen.findByText("No eligible people yet.");
    expect(screen.getByText(/See why below/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check people again" })).toBeTruthy();
    expect(screen.getByText(/People check took \d+\.\ds\./).getAttribute("data-outcome")).toBe("no_recipients");
    expect(state.service.shareOwnerFiles).not.toHaveBeenCalled();
  });

  it("guides setup without pointing to a missing exclusion list", async () => {
    state.service.prepareTrustedShare.mockResolvedValueOnce({
      ...ready, status: "no_recipients", files: [], recipients: [], excluded: [],
    }).mockResolvedValueOnce(ready);
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Explain For Product" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Connect with someone by request, then check again.");
    expect(screen.queryByText("Not included:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Search again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check people again" }));
    await screen.findByText("Chris onboarding.mp4");
    expect(state.service.prepareTrustedShare).toHaveBeenCalledTimes(2);
  });

  it("retries an ambiguous failure with the original files while skipping accepted recipients", async () => {
    state.service.prepareTrustedShare.mockResolvedValue({
      ...ready, files: [...ready.files, { ref: "f2", name: "Second recording.mp4", modifiedTime: null }],
    });
    state.service.shareOwnerFiles
      .mockResolvedValueOnce({ shareRequestId })
      .mockRejectedValueOnce(new TypeError("Connection lost"))
      .mockResolvedValueOnce({ shareRequestId: "77777777-7777-4777-8777-777777777777" });
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Second recording.mp4");
    fireEvent.click(screen.getByRole("checkbox", { name: "Second recording.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    await screen.findByText("Couldn't start sharing with everyone. Retry the people marked below.");
    const second = screen.getByRole("checkbox", { name: "Second recording.mp4" }) as HTMLInputElement;
    expect(second.checked).toBe(false);
    expect(second.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 1 person" }));
    await screen.findByRole("link", { name: "Sharing status and links for Di" });
    expect(state.service.shareOwnerFiles.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [bo, ["f1"]], [di, ["f1"]], [di, ["f1"]],
    ]);
  });

  it("restores one recipient's reservation as the circle's fixed file selection", async () => {
    state.service.prepareTrustedShare.mockResolvedValue({
      ...ready,
      files: [...ready.files, { ref: "f2", name: "Second recording.mp4", modifiedTime: null }],
      recipients: [ready.recipients[0], { ...ready.recipients[1], selectedFileRefs: ["f2"] }],
    });
    state.service.shareOwnerFiles.mockResolvedValue({ shareRequestId });
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Second recording.mp4");
    const second = screen.getByRole("checkbox", { name: "Second recording.mp4" }) as HTMLInputElement;
    expect(second.checked).toBe(true);
    expect(second.closest("fieldset")?.disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Chris onboarding.mp4" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    await screen.findByText("Sharing requested for 2 people.");
    expect(state.service.shareOwnerFiles.mock.calls.map((call) => call[2])).toEqual([["f2"], ["f2"]]);
  });

  it("requires a new share when reopened recipients have different reserved selections", async () => {
    state.service.prepareTrustedShare.mockResolvedValue({
      ...ready,
      files: [...ready.files, { ref: "f2", name: "Second recording.mp4", modifiedTime: null }],
      recipients: [
        { ...ready.recipients[0], selectedFileRefs: ["f1"] },
        { ...ready.recipients[1], selectedFileRefs: ["f2"] },
      ],
    });
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("These attempts use different files. Ask One to start a new share.");
    const share = screen.getByRole("button", { name: "Share 1 file with 2 people" });
    expect(share.hasAttribute("disabled")).toBe(true);
    fireEvent.click(share);
    expect(state.service.shareOwnerFiles).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Find files|Search again|Review remaining/ })).toBeNull();
  });

  it("preserves receipts and excludes expired reserved recipients after refreshing a partial attempt", async () => {
    state.service.prepareTrustedShare.mockResolvedValueOnce(ready).mockResolvedValueOnce({
      ...ready,
      recipients: [
        { ...ready.recipients[0], status: "shared", shareRequestId },
        { ...ready.recipients[1], selectedFileRefs: ["f1"], selectionExpired: true },
      ],
    });
    state.service.shareOwnerFiles.mockResolvedValueOnce({ shareRequestId })
      .mockRejectedValueOnce(new DriveSharingError("owner_share_expired", 409));
    render(<DriveCircleShareCard clientRequestId={clientRequestId} filesRequest="Chris recordings" />);
    fireEvent.click(screen.getByRole("button", { name: "Find files" }));
    await screen.findByText("Chris onboarding.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Share 1 file with 2 people" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review remaining shares" }));
    await screen.findByText(/This sharing attempt expired\. Ask One to start a new share\./);
    expect(screen.getByRole("link", { name: "Sharing status and links for Bo" })).toBeTruthy();
    const expired = screen.getByRole("checkbox", { name: /Di/ }) as HTMLInputElement;
    expect(expired.disabled).toBe(true);
    expect(expired.checked).toBe(false);
    expect(screen.queryByRole("button", { name: /Share \d|Review remaining|Search again|Find files/ })).toBeNull();
    expect(state.service.shareOwnerFiles).toHaveBeenCalledTimes(2);
  });
});
