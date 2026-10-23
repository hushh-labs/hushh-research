import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), approve: vi.fn(), begin: vi.fn(), finishCloud: vi.fn(), auth: vi.fn(), popup: vi.fn() }));
vi.mock("@/lib/services/account-cloud-cleanup", () => ({ cloudCleanupErrorMessage: () => "Cleanup paused", cloudCleanupAttentionMessage: () => "Cleanup paused", cloudCleanupNotStarted: (error: unknown) => error === "no-reservation", readCloudCleanup: mocks.read, approveCloudCleanup: mocks.approve, beginCloudCleanup: mocks.begin, finishCloudRemoval: mocks.finishCloud }));
vi.mock("@/lib/flows/delete-account", () => ({ resolveDeleteAccountAuth: mocks.auth }));
vi.mock("@/lib/one/azure-sign-in", () => ({ AZURE_SIGN_IN_CHANNEL: "hussh-azure-sign-in", ANNOUNCE_WAIT_MS: 8000, isAzureSignInAvailable: () => true, openSignInPopup: mocks.popup, captureSignInPopupOwner: () => () => true }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: vi.fn() }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn(), promise: (p: Promise<unknown>) => ({ unwrap: () => p }) } }));
// Actual forms/callbacks; shared overlay/Back/layout has its own browser owner.
vi.mock("@/components/ui/alert-dialog", () => ({ AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, AlertDialogAction: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props}>{children}</button> }));
import { AccountCloudCleanup } from "@/components/profile/account-cloud-cleanup";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { announceAzureCleanupReturn } from "@/lib/one/azure-cleanup-return";
import { CLEANUP_FOLLOW_CEILING_MS, CLEANUP_RECHECK_MS } from "@/components/profile/use-cloud-cleanup-observation";
const group = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/test-owner";
const plan = { operationId: "attempt-1", planDigest: "a".repeat(64), resources: [{ id: group, scope: "whole_group" }], removed: 0, total: 1, canFinalize: false, approvalRequired: true, needsAttention: false };
beforeEach(() => {
  publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner("synthetic-owner");
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ kind: "ready", token: "synthetic-memory-only" });
  mocks.read.mockResolvedValue(plan); mocks.approve.mockResolvedValue({ ...plan, approvalRequired: false });
});
afterEach(() => { publishValidatedAuthSessionOwner(null); vi.restoreAllMocks(); vi.useRealTimers(); });
it("loads retained progress while unlocked and never starts inspection or deletion automatically", async () => {
  mocks.read.mockResolvedValue({ ...plan, canFinalize: true, approvalRequired: false });
  const finish = vi.fn();
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" onUnlock={vi.fn()} onFinish={finish} />);
  expect(await screen.findByRole("button", { name: "Finish account deletion" })).toBeEnabled();
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.begin).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
});
it("finishes a separately approved cloud removal while keeping account deletion out of the flow", async () => {
  const view = { ...plan, canFinalize: true, approvalRequired: false, keepAccount: true, provider: "azure" };
  mocks.read.mockResolvedValue(view); mocks.finishCloud.mockResolvedValue(undefined);
  const onFinish = vi.fn();
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" purpose="remove_cloud" provider="azure" onUnlock={vi.fn()} onFinish={onFinish} />);
  expect(await screen.findByText(/Your Hussh account and vault stay/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Finish account deletion" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Finish cloud removal" }));
  await waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
  expect(mocks.finishCloud).toHaveBeenCalledWith("synthetic-memory-only", view);
  expect(mocks.begin).not.toHaveBeenCalled();
});
it("inspects a GCP removal without opening a Microsoft popup or changing accounts", async () => {
  mocks.read.mockRejectedValue("no-reservation");
  mocks.begin.mockResolvedValue({ kind: "view", view: { ...plan, provider: "gcp", confirmation: "owner-project" } });
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" purpose="remove_cloud" provider="gcp" onUnlock={vi.fn()} onFinish={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review cloud cleanup" }));
  expect(await screen.findByRole("button", { name: "Approve cleanup" })).toBeDisabled();
  expect(mocks.popup).not.toHaveBeenCalled();
  expect(mocks.begin).toHaveBeenCalledWith("synthetic-memory-only", "inspect", "remove_cloud", null);
});
it("refreshes the same operation after Microsoft returns, without approving or executing it", async () => {
  mocks.read.mockRejectedValueOnce("no-reservation").mockResolvedValue(plan);
  mocks.begin.mockResolvedValue({ operationId: plan.operationId, authorizationUrl: "https://login.microsoftonline.com/owner/oauth2/v2.0/authorize" });
  const popup = { close: vi.fn(), closed: false, location: { assign: vi.fn() } }; mocks.popup.mockReturnValue(popup);
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" onUnlock={vi.fn()} onFinish={vi.fn()} />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Review cloud cleanup" }));
  await waitFor(() => expect(popup.location.assign).toHaveBeenCalledOnce());
  await act(async () => {
    expect(await announceAzureCleanupReturn({ ownerId: "synthetic-owner", operationId: plan.operationId, phase: "inspect" }, new AbortController().signal, 1000)).toBe(true);
  });
  expect(await screen.findByRole("button", { name: "Approve cleanup" })).toBeDisabled();
  expect(mocks.begin).toHaveBeenCalledTimes(1); expect(mocks.approve).not.toHaveBeenCalled();
});
it("fences a late read after the owner leaves and returns or the vault retires", async () => {
  let resolve!: (value: unknown) => void;
  mocks.read.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" onUnlock={vi.fn()} onFinish={vi.fn()} />);
  act(() => {
    publishValidatedAuthSessionOwner("other-owner"); publishValidatedAuthSessionOwner("synthetic-owner");
    advanceVaultSessionEpoch();
  });
  await act(async () => resolve({ ...plan, canFinalize: true, approvalRequired: false }));
  expect(screen.queryByRole("button", { name: "Finish account deletion" })).toBeNull();
});
it("stops status reads while hidden, at its deadline and after unmount", async () => {
  vi.useFakeTimers();
  mocks.read.mockResolvedValue({ ...plan, approvalRequired: false, inProgress: true });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { unmount } = render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" onUnlock={vi.fn()} onFinish={vi.fn()} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(CLEANUP_RECHECK_MS); });
  const beforeHidden = mocks.read.mock.calls.length; expect(beforeHidden).toBeGreaterThan(1);
  visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  await act(async () => { await vi.advanceTimersByTimeAsync(CLEANUP_RECHECK_MS * 2); });
  expect(mocks.read).toHaveBeenCalledTimes(beforeHidden);
  vi.setSystemTime(Date.now() + CLEANUP_FOLLOW_CEILING_MS);
  visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await act(async () => {}); expect(mocks.read).toHaveBeenCalledTimes(beforeHidden);
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(CLEANUP_RECHECK_MS); });
  expect(mocks.read).toHaveBeenCalledTimes(beforeHidden);
});
it("requires exact terms and group, resets for changed plans and never auto-executes", async () => {
  render(<AccountCloudCleanup userId="synthetic-owner" token={null} onUnlock={vi.fn()} onFinish={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  const approve = await screen.findByRole("button", { name: "Approve cleanup" });
  expect(approve).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "test-owner" } });
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  expect(approve).toBeEnabled();
  mocks.read.mockResolvedValue({ ...plan, planDigest: "b".repeat(64) });
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
  expect(screen.getByRole("button", { name: "Approve cleanup" })).toBeDisabled();
  expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.begin).not.toHaveBeenCalled();
});
it("starts one final deletion while its acknowledgement is pending", async () => {
  mocks.read.mockResolvedValue({ ...plan, canFinalize: true, approvalRequired: false });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const onFinish = vi.fn(() => done);
  render(<AccountCloudCleanup userId="synthetic-owner" token={null} onUnlock={vi.fn()} onFinish={onFinish} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  const button = await screen.findByRole("button", { name: "Finish account deletion" });
  fireEvent.click(button); fireEvent.click(button);
  expect(onFinish).toHaveBeenCalledTimes(1); expect(button).toBeDisabled();
  await act(async () => finish());
});
it("closes its own blank popup when the dialog closes during authentication", async () => {
  let resolve!: (value: unknown) => void;
  mocks.auth.mockReturnValue(new Promise((r) => { resolve = r; }));
  const popup = { close: vi.fn(), closed: false, location: { assign: vi.fn() } };
  mocks.popup.mockReturnValue(popup);
  const { unmount } = render(<AccountCloudCleanup userId="synthetic-owner" token={null} onUnlock={vi.fn()} onFinish={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review cloud cleanup" })); unmount();
  await act(async () => resolve({ kind: "ready", token: "synthetic-memory-only" }));
  expect(popup.close).toHaveBeenCalledTimes(1); expect(mocks.begin).not.toHaveBeenCalled();
});

it.each(["canFinalize", "needsAttention"] as const)("settles %s progress and does not read again after hiding and returning", async (terminal) => {
  vi.useFakeTimers();
  mocks.read.mockResolvedValueOnce({ ...plan, approvalRequired: false, inProgress: true })
    .mockResolvedValue({ ...plan, approvalRequired: false, inProgress: false, [terminal]: true });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" onUnlock={vi.fn()} onFinish={vi.fn()} />);
  await act(async () => {});
  const settled = mocks.read.mock.calls.length;
  visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await act(async () => { await vi.advanceTimersByTimeAsync(CLEANUP_FOLLOW_CEILING_MS); });
  expect(mocks.read).toHaveBeenCalledTimes(settled);
});
it("keeps refresh available without offering another execution while cleanup is running", async () => {
  mocks.read.mockResolvedValue({ ...plan, approvalRequired: false, inProgress: true });
  render(<AccountCloudCleanup userId="synthetic-owner" token="synthetic-memory-only" onUnlock={vi.fn()} onFinish={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Cleanup in progress" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cleanup in progress" }));
  expect(mocks.begin).not.toHaveBeenCalled();
});
