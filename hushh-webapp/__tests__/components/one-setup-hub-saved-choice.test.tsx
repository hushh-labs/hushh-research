import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";

const state = vi.hoisted(() => ({
  saved: false,
  choice: "hushh_managed_vertex" as "hushh_managed_vertex" | "byok_pending_vault",
  stagedGeminiKey: false,
  savedGeminiKey: false,
  selectedProvider: null as string | null,
  savedProviderKey: false,
  providerReadError: false,
  user: { uid: "owner" },
  unlocked: false,
  pendingContactsWelcome: false,
  completionOrder: [] as string[],
  listener: null as null | ((event: { type: string; key: string }) => void),
  unsubscribe: vi.fn(),
  replace: vi.fn(),
  queueEntryWelcome: vi.fn(),
  updatePreferences: vi.fn(),
  acknowledgeSetupExit: vi.fn(),
  emailStatus: "loading" as "loading" | "saving" | "failed",
}));
vi.mock("@/components/account/use-marketing-preference", () => ({ useMarketingPreference: () => ({
  value: state.emailStatus === "saving" ? { enabled: false, frequency: "weekly" } : null,
  enabledDraft: false, frequencyDraft: "weekly", loading: state.emailStatus === "loading",
  busy: state.emailStatus === "saving", error: state.emailStatus === "failed" ? "Unavailable" : null,
  saved: false, save: vi.fn(), edit: vi.fn(), refresh: vi.fn(),
}) }));
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
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: state.unlocked, vaultKey: "vault-key", vaultOwnerToken: "vault-token" }) }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Set a lock</div> : null }));
vi.mock("@/lib/services/cache-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/cache-service")>(),
  CACHE_KEYS: { PRE_VAULT_BOOTSTRAP: (id: string) => `bootstrap:${id}` },
  CacheService: { getInstance: () => ({ subscribe: (listener: typeof state.listener) => {
    state.listener = listener;
    return state.unsubscribe;
  } }) },
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: {
  getCachedBootstrapState: () => ({ saved: state.saved, oneRuntimeSetupChoice: state.choice, initialContactsWelcomeAcknowledged: !state.pendingContactsWelcome }),
  bootstrapState: async () => ({ saved: state.saved, oneRuntimeSetupChoice: state.choice, initialContactsWelcomeAcknowledged: !state.pendingContactsWelcome }),
  hasOneCloudProject: () => true,
  hasOneRuntimeChoice: (value: { saved: boolean }) => value.saved,
} }));
vi.mock("@/lib/services/account-identity-service", () => ({ AccountIdentityService: {
  peekCachedIdentity: () => ({ data: { phoneVerified: true } }),
  refreshCurrentUserIdentity: async () => ({ phoneVerified: true }),
  hasVerifiedPhone: () => true,
} }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getByocSetupStatus: async () => ({ status: "idle" }) } }));
vi.mock("@/lib/onboarding/use-capability-setup-states", () => ({ useCapabilitySetupStates: () => ({ byId: {}, isLoading: false, isEnriching: false }) }));
vi.mock("@/components/dashboard/one-agent-presence", () => ({ OneAgentPresence: () => null }));
vi.mock("@/components/profile/public-profile-discovery-card", () => ({ PublicProfileDiscoveryCard: () => null }));

vi.mock("@/lib/services/one-setup-exit-service", () => ({ acknowledgeOneSetupExit: state.acknowledgeSetupExit }));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({ PreVaultSensitiveDraftService: { finalizeForVault: vi.fn().mockResolvedValue(undefined), hasFinanceIntent: () => false, hasGeminiRuntime: () => state.stagedGeminiKey } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "gemini-key",
  OPENAI_RUNTIME_CREDENTIAL_REF: "openai-key",
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: async ({ credentialRef }: { credentialRef: string }) => {
      if (credentialRef.endsWith("selected_provider")) {
        if (state.providerReadError) throw new Error("selected provider unavailable");
        return state.selectedProvider;
      }
      if (credentialRef === "gemini-key") return state.savedGeminiKey ? "saved-gemini-key" : null;
      return state.savedProviderKey ? "saved-provider-key" : null;
    },
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
  state.emailStatus = "loading";
  state.choice = "hushh_managed_vertex";
  state.stagedGeminiKey = false;
  state.savedGeminiKey = false;
  state.selectedProvider = null;
  state.savedProviderKey = false;
  state.providerReadError = false;
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
  it.each(["loading", "saving", "failed"] as const)("finishes independently of optional email state: %s", async (status) => {
    state.saved = true; state.unlocked = true; state.emailStatus = status;
    render(<OneSetupHub />);
    const finish = await screen.findByRole("button", { name: "Finish setup" });
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);
    await waitFor(() => expect(state.acknowledgeSetupExit).toHaveBeenCalledOnce());
    expect(state.replace).toHaveBeenCalledWith("/");
  });
  it("requires a BYOK key again after a reload loses its process-memory draft", async () => {
    state.saved = true;
    state.choice = "byok_pending_vault";
    const view = render(<OneSetupHub />);
    const finish = await screen.findByRole("button", { name: "Finish setup" });
    expect(finish).toBeDisabled();
    expect(screen.getByTestId("one-setup-foundation")).toHaveTextContent("Finish choosing AI access");

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

  it.each([null, "gemini", "openai", "azure_openai"])("accepts a BYOK choice backed by its selected encrypted key (%s)", async provider => {
    state.saved = true;
    state.choice = "byok_pending_vault";
    state.unlocked = true;
    state.selectedProvider = provider;
    state.savedGeminiKey = provider === null || provider === "gemini";
    state.savedProviderKey = provider === "openai" || provider === "azure_openai";
    render(<OneSetupHub />);

    const finish = await screen.findByRole("button", { name: "Finish setup" });
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);
    await waitFor(() => expect(state.acknowledgeSetupExit).toHaveBeenCalledOnce());
    expect(state.replace).toHaveBeenCalledWith("/");
  });

  it.each(["openai", "azure_openai", "unknown_provider", "INVALID!", "", "unreadable"])("refuses a selected provider without its usable stored key (%s)", async provider => {
    state.saved = true;
    state.choice = "byok_pending_vault";
    state.unlocked = true;
    state.selectedProvider = provider === "unreadable" ? null : provider;
    state.providerReadError = provider === "unreadable";
    state.savedGeminiKey = true; // An unrelated key must not repair the selection.
    render(<OneSetupHub />);
    const finish = await screen.findByRole("button", { name: "Finish setup" });
    await act(async () => {});
    expect(finish).toBeDisabled();
    expect(state.acknowledgeSetupExit).not.toHaveBeenCalled();
  });

  it("removes redundant progress and disables Finish until the current owner's saved choice arrives", async () => {
    const view = render(<OneSetupHub />);
    const finish = await screen.findByRole("button", { name: "Finish setup" });
    expect(finish).toBeDisabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("Set up the rest later.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Choose your AI/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Set up your private agent: Continue" })).toBeVisible();
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
    expect(screen.getByRole("button", { name: "Agent home: Connected" })).toBeVisible();
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
      /public information about you/,
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
