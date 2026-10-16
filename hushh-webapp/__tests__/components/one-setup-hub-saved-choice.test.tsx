import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";

const state = vi.hoisted(() => ({
  saved: false,
  choice: "hushh_managed_vertex" as "hushh_managed_vertex" | "byok_pending_vault",
  stagedGeminiKey: false,
  savedGeminiKey: false,
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
vi.mock("@/lib/services/pre-vault-user-state-service", () => {
  const currentState = () => ({
    saved: state.saved,
    oneRuntimeSetupChoice: state.choice,
    initialContactsWelcomeAcknowledged: !state.pendingContactsWelcome,
  });
  return { PreVaultUserStateService: {
    getCachedBootstrapState: currentState,
    bootstrapState: async () => currentState(),
    hasOneRuntimeChoice: (value: { saved: boolean }) => value.saved,
  } };
});
vi.mock("@/lib/services/one-setup-exit-service", () => ({ acknowledgeOneSetupExit: state.acknowledgeSetupExit }));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({ PreVaultSensitiveDraftService: { finalizeForVault: vi.fn().mockResolvedValue(undefined), hasFinanceIntent: () => false, hasGeminiRuntime: () => state.stagedGeminiKey } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "gemini-key",
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: async () => state.savedGeminiKey ? "saved-gemini-key" : null,
  },
}));
vi.mock("@/lib/services/finance-setup-draft-service", () => ({ FinanceSetupDraftService: { finalizeForVault: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/lib/services/post-unlock-sync-service", () => ({ PostUnlockSyncService: { run: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/lib/services/world-model-research-service", () => ({ WorldModelResearchService: { updatePreferences: state.updatePreferences } }));
vi.mock("@/lib/connections/gemini-runtime-configuration", () => ({ notifyGeminiRuntimeConfigurationChanged: vi.fn() }));
vi.mock("@/lib/agent/one-conversation-session", () => ({ useOneConversationSession: () => state.queueEntryWelcome }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: vi.fn() }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: vi.fn() }));

beforeEach(() => {
  state.saved = false;
  state.choice = "hushh_managed_vertex";
  state.stagedGeminiKey = false;
  state.savedGeminiKey = false;
  state.unlocked = false;
  state.pendingContactsWelcome = false;
  state.completionOrder.length = 0;
  state.listener = null;
  state.unsubscribe.mockClear();
  state.replace.mockClear();
  state.queueEntryWelcome.mockReset();
  state.updatePreferences.mockReset().mockImplementation(async () => {
    state.completionOrder.push("pwm-preferences");
  });
  state.acknowledgeSetupExit.mockReset().mockImplementation(async () => {
    state.completionOrder.push("setup-acknowledgement");
  });
});
describe("Setup saved AI choice", () => {
  it("requires a BYOK key again after a reload loses its process-memory draft", async () => {
    state.saved = true;
    state.choice = "byok_pending_vault";
    const view = render(<OneSetupHub />);
    const finish = await screen.findByRole("button", { name: "Finish setup" });
    expect(finish).toBeDisabled();
    expect(screen.getByTestId("one-setup-ai-choice")).toHaveTextContent("Required");

    state.stagedGeminiKey = true;
    act(() => state.listener?.({ type: "set", key: "bootstrap:owner" }));
    await waitFor(() => expect(finish).toBeEnabled());

    // A stale enabled button must still re-check the volatile credential.
    state.stagedGeminiKey = false;
    fireEvent.click(finish);
    await waitFor(() => expect(finish).toBeDisabled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.acknowledgeSetupExit).not.toHaveBeenCalled();
    view.unmount();
  });

  it("accepts a BYOK choice backed by an existing encrypted key", async () => {
    state.saved = true;
    state.choice = "byok_pending_vault";
    state.unlocked = true;
    state.savedGeminiKey = true;
    render(<OneSetupHub />);

    const finish = await screen.findByRole("button", { name: "Finish setup" });
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);
    await waitFor(() => expect(state.acknowledgeSetupExit).toHaveBeenCalledOnce());
    expect(state.replace).toHaveBeenCalledWith("/");
  });

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
    expect(screen.getByTestId("one-setup-ai-choice")).toHaveTextContent("Selected");
    fireEvent.click(finish);
    await screen.findByRole("dialog");
    view.unmount();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  it("finishes with pending Contacts welcome and discloses default-on research without a choice", async () => {
    state.saved = true;
    state.unlocked = true;
    state.pendingContactsWelcome = true;
    render(<OneSetupHub />);

    // Research is disclosed, not asked: no checkbox and no preferences write.
    expect(screen.getByTestId("pwm-research-disclosure")).toHaveTextContent(
      "One uses public info for your Personal World Model and emails you when ready. Review before saving; turn either off anytime.",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(state.replace).toHaveBeenCalledWith("/one/welcome?return_to=%2F"));
    expect(state.acknowledgeSetupExit).toHaveBeenCalledOnce();
    expect(state.queueEntryWelcome).not.toHaveBeenCalled();
    expect(state.updatePreferences).not.toHaveBeenCalled();
    expect(state.completionOrder).toEqual(["setup-acknowledgement"]);
  });

  it("queues the first Chat greeting before setup acknowledgement settles", async () => {
    state.saved = true;
    state.unlocked = true;
    let releaseAcknowledgement: (() => void) | undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    state.acknowledgeSetupExit.mockImplementation(() => {
      state.completionOrder.push("acknowledgement-started");
      return acknowledgement;
    });
    state.queueEntryWelcome.mockImplementation(() => {
      state.completionOrder.push("greeting-queued");
    });

    render(<OneSetupHub />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(state.queueEntryWelcome).toHaveBeenCalledWith("owner"));
    expect(state.completionOrder).toEqual([
      "acknowledgement-started",
      "greeting-queued",
    ]);
    expect(state.replace).not.toHaveBeenCalled();

    await act(async () => {
      releaseAcknowledgement?.();
      await acknowledgement;
    });
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith("/"));
  });
});
