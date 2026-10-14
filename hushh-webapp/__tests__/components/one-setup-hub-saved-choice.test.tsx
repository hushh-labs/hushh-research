import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";

const state = vi.hoisted(() => ({
  saved: false,
  unlocked: false,
  pendingContactsWelcome: false,
  completionOrder: [] as string[],
  listener: null as null | ((event: { type: string; key: string }) => void),
  unsubscribe: vi.fn(),
  replace: vi.fn(),
  queueEntryWelcome: vi.fn(),
  updatePreferences: vi.fn(),
  acknowledgeSetupExit: vi.fn(),
}));
vi.mock("@/lib/services/initial-contacts-onboarding-service", () => {
  const snapshot = { ownerId: null, status: "idle", source: "none" };
  return {
    InitialContactsOnboardingService: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getServerSnapshot: () => snapshot,
      wasDismissed: () => false,
      startSource: vi.fn(),
    },
  };
});
vi.mock("@/lib/services/kai-profile-service", () => ({ resolveKaiOnboardingCompletion: () => false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace, push: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: { uid: "owner" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: state.unlocked, vaultKey: "vault-key", vaultOwnerToken: "vault-token" }) }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Set a lock</div> : null }));
vi.mock("@/lib/services/cache-service", () => ({ CACHE_KEYS: { PRE_VAULT_BOOTSTRAP: (id: string) => `bootstrap:${id}` }, CacheService: { getInstance: () => ({ subscribe: (listener: typeof state.listener) => { state.listener = listener; return state.unsubscribe; } }) } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { getCachedBootstrapState: () => ({ saved: state.saved, initialContactsWelcomeAcknowledged: !state.pendingContactsWelcome }), hasOneRuntimeChoice: (value: { saved: boolean }) => value.saved } }));
vi.mock("@/lib/services/one-setup-exit-service", () => ({ acknowledgeOneSetupExit: state.acknowledgeSetupExit }));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({ PreVaultSensitiveDraftService: { finalizeForVault: vi.fn().mockResolvedValue(undefined), hasFinanceIntent: () => false } }));
vi.mock("@/lib/services/finance-setup-draft-service", () => ({ FinanceSetupDraftService: { finalizeForVault: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/lib/services/post-unlock-sync-service", () => ({ PostUnlockSyncService: { run: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/lib/services/world-model-research-service", () => ({ WorldModelResearchService: { updatePreferences: state.updatePreferences } }));
vi.mock("@/lib/connections/gemini-runtime-configuration", () => ({ notifyGeminiRuntimeConfigurationChanged: vi.fn() }));
vi.mock("@/lib/agent/one-conversation-session", () => ({ useOneConversationSession: () => state.queueEntryWelcome }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: vi.fn() }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: vi.fn() }));

beforeEach(() => {
  state.saved = false;
  state.unlocked = false;
  state.pendingContactsWelcome = false;
  state.completionOrder.length = 0;
  state.listener = null;
  state.unsubscribe.mockClear();
  state.replace.mockClear();
  state.queueEntryWelcome.mockClear();
  state.updatePreferences.mockReset().mockImplementation(async () => {
    state.completionOrder.push("pwm-preferences");
  });
  state.acknowledgeSetupExit.mockReset().mockImplementation(async () => {
    state.completionOrder.push("setup-acknowledgement");
  });
});
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

  it.each([false, true])(
    "finishes with pending Contacts welcome and PWM consent %s",
    async (consent) => {
      state.saved = true;
      state.unlocked = true;
      state.pendingContactsWelcome = true;
      render(<OneSetupHub />);

      if (consent) {
        fireEvent.click(screen.getByRole("checkbox", { name: /Prepare my Personal World Model/i }));
        expect(screen.getByRole("checkbox", { name: /Prepare my Personal World Model/i })).toBeChecked();
      }
      fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));

      await waitFor(() => expect(state.replace).toHaveBeenCalledWith("/one/welcome?return_to=%2F"));
      expect(state.acknowledgeSetupExit).toHaveBeenCalledOnce();
      expect(state.queueEntryWelcome).not.toHaveBeenCalled();
      if (consent) {
        expect(state.updatePreferences).toHaveBeenCalledExactlyOnceWith(
          { vaultKey: "vault-key", vaultOwnerToken: "vault-token" },
          { enabled: true, email_enabled: false },
        );
        expect(state.completionOrder).toEqual(["pwm-preferences", "setup-acknowledgement"]);
      } else {
        expect(state.updatePreferences).not.toHaveBeenCalled();
        expect(state.completionOrder).toEqual(["setup-acknowledgement"]);
      }
    },
  );
});
