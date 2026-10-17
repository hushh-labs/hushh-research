import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), approve: vi.fn(), begin: vi.fn(), auth: vi.fn(), popup: vi.fn() }));
vi.mock("@/lib/services/account-cloud-cleanup", () => ({ cloudCleanupErrorMessage: () => "Cleanup paused", readCloudCleanup: mocks.read, approveCloudCleanup: mocks.approve, beginCloudCleanup: mocks.begin }));
vi.mock("@/lib/flows/delete-account", () => ({ resolveDeleteAccountAuth: mocks.auth }));
vi.mock("@/lib/one/azure-sign-in", () => ({ isAzureSignInAvailable: () => true, openSignInPopup: mocks.popup }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: vi.fn() }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: (p: Promise<unknown>) => ({ unwrap: () => p }) } }));
// Actual forms/callbacks; shared overlay/Back/layout has its own browser owner.
vi.mock("@/components/ui/alert-dialog", () => ({ AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, AlertDialogAction: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props}>{children}</button> }));
import { AccountCloudCleanup } from "@/components/profile/account-cloud-cleanup";
const group = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/test-owner";
const plan = { operationId: "attempt-1", planDigest: "a".repeat(64), resources: [{ id: group, scope: "whole_group" }], removed: 0, total: 1, canFinalize: false, approvalRequired: true, needsAttention: false };
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ kind: "ready", token: "synthetic-memory-only" });
  mocks.read.mockResolvedValue(plan); mocks.approve.mockResolvedValue({ ...plan, approvalRequired: false });
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
