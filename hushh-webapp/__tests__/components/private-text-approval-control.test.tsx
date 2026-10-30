import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateTextApprovalControl } from "@/components/agent/private-text-approval-control";
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), back: undefined as undefined | (() => boolean) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one" }));
vi.mock("@/lib/services/private-text-approval-service", () => ({ PrivateTextApprovalService: { get: mocks.get, set: mocks.set } }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: (_path: string, depth: number, back: () => boolean) => { mocks.back = depth ? back : undefined; } }));
const policy = { enabled: true, provider: "azure_openai", basis: "uat_policy", scope: "one_text_chat_and_drive_requests", version: "uat-managed-text-azure-primary-v2", generation: "22222222-2222-4222-8222-222222222222" };
const owner = (uid = "arbitrary-owner") => ({ uid, getIdToken: vi.fn().mockResolvedValue(`${uid}-token`) });
describe("administrator-managed UAT processing information", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat"); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
  it.each(["missing", "approved", "revoked"])("does not require or create a personal approval for %s history", async history => {
    mocks.get.mockResolvedValue({ enabled: history === "approved", processing_policy: policy });
    render(<PrivateTextApprovalControl user={owner()} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI processing in UAT/ }));
    expect(screen.getByText(/This is not a personal approval/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Revoke|Turn off/ })).not.toBeInTheDocument();
    expect(mocks.set).not.toHaveBeenCalled();
    act(() => { mocks.back?.(); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not request UAT information in production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production"); render(<PrivateTextApprovalControl user={owner()} />);
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it.each([
    ["azure_openai", "Microsoft Azure AI is the primary processor for One text chat and document requests.", "Google Gemini is a fallback"],
    ["gemini", "Google Gemini is the primary processor for One text chat and document requests.", "Microsoft Azure AI is a fallback"],
    [undefined, "One text chat and document requests follow the managed UAT AI policy.", "The other provider is a fallback"],
  ])("discloses the %s policy without guessing from the historical pilot", async (provider, description, fallback) => {
    mocks.get.mockResolvedValue({ provider: "azure_openai", processing_policy: { ...policy, provider } });
    render(<PrivateTextApprovalControl user={owner()} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI processing in UAT/ }));
    expect(screen.getByText(description!)).toBeInTheDocument();
    expect(screen.getByText(text => text.startsWith(fallback!))).toBeInTheDocument();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("does not carry a delayed response into a different owner's session", async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(null);
    const view = render(<PrivateTextApprovalControl user={owner()} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    view.rerender(<PrivateTextApprovalControl user={owner("other-owner")} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await act(async () => finish({ processing_policy: policy }));
    expect(screen.queryByRole("button", { name: /AI processing in UAT/ })).not.toBeInTheDocument();
  });
});
