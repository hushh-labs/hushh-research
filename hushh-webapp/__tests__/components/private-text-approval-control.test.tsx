import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateTextApprovalControl } from "@/components/agent/private-text-approval-control";
import { ApiError } from "@/lib/services/api-client";
import type { PrivateTextApproval } from "@/lib/services/private-text-approval-service";
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), back: undefined as undefined | (() => boolean), promise: vi.fn(), dismiss: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one" }));
vi.mock("@/lib/services/private-text-approval-service", async original => ({
  ...await original<typeof import("@/lib/services/private-text-approval-service")>(),
  PrivateTextApprovalService: { get: mocks.get, set: mocks.set },
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: mocks.promise, dismiss: mocks.dismiss } }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: (_path: string, depth: number, back: () => boolean) => { mocks.back = depth ? back : undefined; } }));
const denied: PrivateTextApproval = { provider: "azure_openai", disclosure_version: "one-private-azure-text-v1", enabled: false, generation: null, accepted_at: null, revoked_at: null };
const approved: PrivateTextApproval = { ...denied, enabled: true, generation: "11111111-1111-4111-8111-111111111111", accepted_at: "2026-10-19T08:00:00Z" };
const owner = (uid = "owner-a") => ({ uid, getIdToken: vi.fn().mockResolvedValue(`${uid}-token`) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function review() { fireEvent.click(await screen.findByRole("button", { name: "Review Azure text pilot" })); }
const accept = () => fireEvent.click(screen.getByRole("checkbox"));
const approve = () => fireEvent.click(screen.getByRole("button", { name: "Approve private text processing" }));
describe("owner-scoped private Azure acknowledgment", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue(denied); mocks.promise.mockImplementation((operation: Promise<unknown>) => { void operation.catch(() => {}); return "notice"; }); });
  afterEach(cleanup);
  it("requires acknowledgment and waits for persistence for approval and revocation", async () => {
    const saving = deferred<PrivateTextApproval>(); mocks.set.mockReturnValueOnce(saving.promise);
    render(<PrivateTextApprovalControl user={owner()} />); await review();
    expect(screen.getByRole("button", { name: "Approve private text processing" })).toBeDisabled();
    accept(); approve();
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("owner-a-token", true, null));
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await act(async () => saving.resolve(approved));
    expect(await screen.findByText("Approved")).toBeInTheDocument(); await review();
    const revoking = deferred<PrivateTextApproval>(); mocks.set.mockReturnValueOnce(revoking.promise);
    fireEvent.click(screen.getByRole("button", { name: "Revoke approval" }));
    await waitFor(() => expect(mocks.set).toHaveBeenLastCalledWith("owner-a-token", false, approved.generation));
    expect(screen.getByText("Approved")).toBeInTheDocument();
    await act(async () => revoking.resolve({ ...approved, enabled: false, revoked_at: "2026-10-19T08:01:00Z" }));
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });
  it("does not approve failed writes, clears acknowledgment on Back, and reloads server receipts on remount", async () => {
    mocks.set.mockRejectedValueOnce(new Error("store unavailable"));
    const view = render(<PrivateTextApprovalControl user={owner()} />); await review(); accept(); approve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve private text processing" })).toBeEnabled());
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    act(() => { mocks.back?.(); }); await review();
    expect(screen.getByRole("checkbox")).not.toBeChecked(); view.unmount();
    mocks.get.mockResolvedValueOnce(approved); render(<PrivateTextApprovalControl user={owner()} />);
    expect(await screen.findByText("Approved")).toBeInTheDocument();
  });
  it("never carries another owner's delayed receipt or toast into the next account", async () => {
    const saving = deferred<PrivateTextApproval>(); mocks.set.mockReturnValueOnce(saving.promise);
    const view = render(<PrivateTextApprovalControl user={owner()} />); await review(); accept(); approve();
    await waitFor(() => expect(mocks.set).toHaveBeenCalled()); const notice = mocks.promise.mock.lastCall![1];
    view.rerender(<PrivateTextApprovalControl user={owner("owner-b")} />);
    await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith("owner-b-token"));
    await act(async () => saving.resolve(approved));
    expect(notice.isCurrent()).toBe(false); expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(mocks.dismiss).toHaveBeenCalledWith("notice");
  });
  it("refreshes a concurrent revocation without replaying the stale Approve", async () => {
    const revoked = { ...approved, enabled: false, generation: "22222222-2222-4222-8222-222222222222", revoked_at: "2026-10-19T08:01:00Z" };
    mocks.get.mockResolvedValueOnce(denied).mockResolvedValueOnce(revoked);
    mocks.set.mockRejectedValueOnce(new ApiError("changed", 409, { detail: { code: "PRIVATE_AZURE_TEXT_APPROVAL_CHANGED" } }));
    render(<PrivateTextApprovalControl user={owner()} />); await review(); accept(); approve();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.set).toHaveBeenCalledTimes(1);
    await review();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    mocks.set.mockResolvedValueOnce({ ...approved, generation: revoked.generation });
    accept(); approve();
    await waitFor(() => expect(mocks.set).toHaveBeenLastCalledWith("owner-a-token", true, revoked.generation));
  });
  it("hides the pilot when the server declines availability", async () => {
    mocks.get.mockResolvedValueOnce(null); render(<PrivateTextApprovalControl user={owner()} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Review Azure text pilot" })).not.toBeInTheDocument();
  });
});
