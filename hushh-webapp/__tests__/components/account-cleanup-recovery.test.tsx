import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
const mocks = vi.hoisted(() => ({ getIdToken: vi.fn(), status: vi.fn(), continue: vi.fn() }));
const owner = { uid: "synthetic-owner", getIdToken: mocks.getIdToken };
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: owner }) }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  getAccountCleanupStatus: mocks.status, continueAccountCleanup: mocks.continue,
} }));
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
const operation = {
  id: "11111111-1111-4111-8111-111111111111", state: "action_required",
  credential_count: 1, local_erasure_confirmation_required: true,
  external_validity_unconfirmed_count: 1, inventory_sha256: "a".repeat(64), retry_after_seconds: null,
};
describe("sealed account cleanup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks(); publishValidatedAuthSessionOwner(owner.uid);
    mocks.getIdToken.mockResolvedValue("synthetic-token");
  });
  it("requires explicit local-erasure review and submits the exact observed inventory", async () => {
    mocks.status.mockResolvedValue(Response.json({ operation }));
    mocks.continue.mockResolvedValue(Response.json({ operation: { ...operation, state: "cleaning_up", local_erasure_confirmation_required: false } }));
    render(<SessionVerificationRecovery onRetry={vi.fn()} onSignOut={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Remove Hussh’s copy" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
    await screen.findByText("Cleaning up your account");
    expect(mocks.continue).toHaveBeenCalledTimes(1);
    expect(mocks.continue).toHaveBeenCalledWith("synthetic-token", operation, true, expect.any(Function), expect.any(AbortSignal));
  });
  it("does not publish another owner's late cleanup response", async () => {
    let settle!: (response: Response) => void;
    mocks.status.mockReturnValue(new Promise<Response>(resolve => { settle = resolve; }));
    render(<SessionVerificationRecovery onRetry={vi.fn()} onSignOut={vi.fn()} />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
    publishValidatedAuthSessionOwner("another-owner"); settle(Response.json({ operation }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText("Finish account cleanup")).not.toBeInTheDocument();
    expect(mocks.continue).not.toHaveBeenCalled();
  });
});
