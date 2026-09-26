import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";

const state = vi.hoisted(() => ({
  saved: false,
  listener: null as null | ((event: { type: string; key: string }) => void),
  unsubscribe: vi.fn(),
}));
vi.mock("@/lib/services/kai-profile-service", () => ({ resolveKaiOnboardingCompletion: () => false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: { uid: "owner" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: false }) }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Set a lock</div> : null }));
vi.mock("@/lib/services/cache-service", () => ({ CACHE_KEYS: { PRE_VAULT_BOOTSTRAP: (id: string) => `bootstrap:${id}` }, CacheService: { getInstance: () => ({ subscribe: (listener: typeof state.listener) => { state.listener = listener; return state.unsubscribe; } }) } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { getCachedBootstrapState: () => ({ saved: state.saved }), hasOneRuntimeChoice: (value: { saved: boolean }) => value.saved } }));
vi.mock("@/lib/services/one-setup-exit-service", () => ({ acknowledgeOneSetupExit: vi.fn() }));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({ PreVaultSensitiveDraftService: {} }));
vi.mock("@/lib/services/finance-setup-draft-service", () => ({ FinanceSetupDraftService: {} }));
vi.mock("@/lib/services/post-unlock-sync-service", () => ({ PostUnlockSyncService: {} }));
vi.mock("@/lib/connections/gemini-runtime-configuration", () => ({ notifyGeminiRuntimeConfigurationChanged: vi.fn() }));
vi.mock("@/lib/agent/one-conversation-session", () => ({ useOneConversationSession: () => vi.fn() }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: vi.fn() }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: vi.fn() }));

beforeEach(() => { state.saved = false; state.listener = null; state.unsubscribe.mockClear(); });
describe("Setup saved AI choice", () => {
  it("removes redundant progress and disables Finish until the current owner's saved choice arrives", async () => {
    const view = render(<OneSetupHub />);
    const finish = await screen.findByRole("button", { name: "Finish setup" });
    expect(finish).toBeDisabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("Remaining")).toBeNull();
    expect(screen.queryByText("Set up the rest later.")).toBeNull();
    fireEvent.click(finish);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Pending or rejected saves do not publish a successful cache write.
    act(() => state.listener?.({ type: "set", key: "bootstrap:owner" }));
    expect(finish).toBeDisabled();
    state.saved = true;
    act(() => state.listener?.({ type: "set", key: "bootstrap:other-owner" }));
    expect(finish).toBeDisabled();
    act(() => state.listener?.({ type: "set", key: "bootstrap:owner" }));
    await waitFor(() => expect(finish).toBeEnabled());
    expect(screen.getByRole("button", { name: "Choose your AI: Selected" })).toBeVisible();
    fireEvent.click(finish);
    await screen.findByRole("dialog");
    view.unmount();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });
});
