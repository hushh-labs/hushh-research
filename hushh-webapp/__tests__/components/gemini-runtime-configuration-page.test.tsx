import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiRuntimeConfigurationPage } from "@/components/connections/gemini-runtime-configuration-page";
import {
  PwmResearchDisclosure,
  PWM_AZURE_RESEARCH_DISCLOSURE_COMPACT,
  PWM_RESEARCH_DISCLOSURE_COMPACT,
} from "@/components/onboarding/setup/pwm-research-disclosure";
import { buildInitialContactsWelcomeRoute } from "@/lib/navigation/routes";

const state = vi.hoisted(() => ({
  user: { uid: "recipient" },
  router: { replace: vi.fn(), push: vi.fn() },
  finalize: vi.fn(),
  acknowledge: vi.fn(),
  sync: vi.fn(),
  finance: vi.fn(),
  welcome: vi.fn(),
  hasFinanceIntent: false,
  setupChoice: "managed",
  hasGeminiRuntimeDraft: false,
  savedGeminiKey: false,
  pendingContactsWelcome: false,
}));
vi.mock("next/navigation", () => ({ useRouter: () => state.router }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.user, loading: false }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultKey: "test-key",
    vaultOwnerToken: "test-token",
  }),
}));
vi.mock("@/components/connections/gemini-runtime-settings-card", () => ({
  GeminiRuntimeSettingsCard: ({
    onCanContinueChange,
    initiallyConfigured,
  }: {
    onCanContinueChange: (ready: boolean) => void;
    initiallyConfigured: boolean;
  }) => <button data-initially-configured={initiallyConfigured} onClick={() => onCanContinueChange(true)}>Choose AI</button>,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => ({
      oneRuntimeSetupChoice: state.setupChoice,
      initialContactsWelcomeAcknowledged: !state.pendingContactsWelcome,
    }),
    hasOneRuntimeChoice: () => true,
  },
}));
vi.mock("@/lib/services/initial-contacts-onboarding-service", () => ({
  InitialContactsOnboardingService: {
    getSnapshot: () => ({ ownerId: null }),
  },
}));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({
  PreVaultSensitiveDraftService: {
    hasFinanceIntent: () => state.hasFinanceIntent,
    hasGeminiRuntime: () => state.hasGeminiRuntimeDraft,
    finalizeForVault: state.finalize,
  },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "pkm:runtime_secrets.llm.gemini_api_key",
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: () => state.savedGeminiKey ? "fixture-key" : null,
  },
}));
vi.mock("@/lib/services/post-unlock-sync-service", () => ({
  PostUnlockSyncService: { run: state.sync },
}));
vi.mock("@/lib/services/finance-setup-draft-service", () => ({
  FinanceSetupDraftService: { finalizeForVault: state.finance },
}));
vi.mock("@/lib/services/one-setup-exit-service", () => ({
  acknowledgeOneSetupExit: state.acknowledge,
}));
vi.mock("@/lib/connections/gemini-runtime-configuration", () => ({
  notifyGeminiRuntimeConfigurationChanged: vi.fn(),
}));
vi.mock("@/lib/agent/one-conversation-session", () => ({
  useOneConversationSession: () => state.welcome,
}));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: vi.fn(),
}));

const destination = "/circle/join?code=23456789ABCD";
beforeEach(() => {
  vi.resetAllMocks();
  state.user = { uid: "recipient" };
  state.hasFinanceIntent = false;
  state.setupChoice = "managed";
  state.hasGeminiRuntimeDraft = false;
  state.savedGeminiKey = false;
  state.pendingContactsWelcome = false;
  state.finalize.mockResolvedValue(undefined);
  state.sync.mockResolvedValue(undefined);
  state.finance.mockResolvedValue(undefined);
  state.acknowledge.mockResolvedValue(undefined);
  window.history.replaceState(
    null,
    "",
    "/one/setup/connections?return_to=" + encodeURIComponent(destination),
  );
});

describe("AI-choice setup invitation continuation", () => {
  it("requires a distinct Azure/Bing opt-in disclosure in the UAT setup", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    try {
      render(<PwmResearchDisclosure compact />);
      expect(screen.getByTestId("pwm-research-disclosure")).toHaveTextContent(
        PWM_AZURE_RESEARCH_DISCLOSURE_COMPACT,
      );
      expect(screen.getByTestId("pwm-research-disclosure")).toHaveTextContent(
        "off until you turn it on",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])(
    "requires a live BYOK draft even with an unlocked vault (draft: %s)",
    async (hasDraft) => {
      state.setupChoice = "byok_pending_vault";
      state.hasGeminiRuntimeDraft = hasDraft;
      render(<GeminiRuntimeConfigurationPage setupMode />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Choose AI" })).toHaveAttribute(
          "data-initially-configured",
          String(hasDraft),
        ),
      );
    },
  );

  it("does not acknowledge BYOK setup when the encrypted key is missing", async () => {
    state.setupChoice = "byok_pending_vault";
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    fireEvent.click(screen.getByTestId("one-setup-connections-terminal"));
    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent("Your Gemini key was not saved"));
    expect(state.acknowledge).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the invite captured across completion (pending Finance: %s)", async (hasFinanceIntent) => {
    state.hasFinanceIntent = hasFinanceIntent;
    let complete!: () => void;
    state.acknowledge.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(<GeminiRuntimeConfigurationPage setupMode />);
    // Show the disclosure at the actionable decision, before Continue is enabled.
    expect(screen.queryByTestId("pwm-research-disclosure")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    expect(screen.getByTestId("pwm-research-disclosure")).toHaveTextContent(
      PWM_RESEARCH_DISCLOSURE_COMPACT,
    );
    fireEvent.click(screen.getByTestId("one-setup-connections-terminal"));
    await waitFor(() => expect(state.acknowledge).toHaveBeenCalledOnce());
    expect(state.router.replace).not.toHaveBeenCalled();
    // Completion publishes a cache change. The guard can settle this route
    // while the component's finalization promise is still resuming.
    window.history.replaceState(null, "", destination);
    await act(async () => complete());
    expect(state.router.replace).toHaveBeenCalledWith(
      hasFinanceIntent
        ? "/one/setup/finance/import?return_to=" + encodeURIComponent(destination)
        : destination,
    );
    expect(state.router.replace).not.toHaveBeenCalledWith("/");
    expect(state.finalize).toHaveBeenCalledOnce();
    expect(state.sync).toHaveBeenCalledOnce();
    expect(state.finance).toHaveBeenCalledOnce();
  });

  it("keeps the invitation destination when returning to the setup hub", () => {
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(state.router.replace).toHaveBeenCalledWith(
      "/one/setup?return_to=" + encodeURIComponent(destination),
    );
  });

  it("offers a real account action that keeps the invitation destination", () => {
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Account actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));
    expect(state.router.replace).toHaveBeenCalledWith(
      "/one/setup?return_to=" + encodeURIComponent(destination),
    );
  });

  it("shows the pending Contacts welcome before an invitation and withholds the chat greeting", async () => {
    state.pendingContactsWelcome = true;
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    fireEvent.click(screen.getByTestId("one-setup-connections-terminal"));
    await waitFor(() => expect(state.router.replace).toHaveBeenCalledWith(
      buildInitialContactsWelcomeRoute(destination),
    ));
    expect(state.welcome).not.toHaveBeenCalled();
  });

  it("does not navigate an old invitation after the setup component unmounts", async () => {
    let complete!: () => void;
    state.acknowledge.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    fireEvent.click(screen.getByTestId("one-setup-connections-terminal"));
    await waitFor(() => expect(state.acknowledge).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => complete());
    expect(state.router.replace).not.toHaveBeenCalled();
    expect(state.welcome).toHaveBeenCalledWith("recipient");
  });
});
