import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiRuntimeConfigurationPage } from "@/components/connections/gemini-runtime-configuration-page";

const state = vi.hoisted(() => ({
  user: { uid: "recipient" },
  router: { replace: vi.fn() },
  finalize: vi.fn(),
  acknowledge: vi.fn(),
  sync: vi.fn(),
  finance: vi.fn(),
  welcome: vi.fn(),
  hasFinanceIntent: false,
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
  }: {
    onCanContinueChange: (ready: boolean) => void;
  }) => <button onClick={() => onCanContinueChange(true)}>Choose AI</button>,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => ({ oneRuntimeSetupChoice: "managed" }),
    hasOneRuntimeChoice: () => true,
  },
}));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({
  PreVaultSensitiveDraftService: {
    hasFinanceIntent: () => state.hasFinanceIntent,
    finalizeForVault: state.finalize,
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
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
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
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
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
    expect(state.welcome).not.toHaveBeenCalled();
  });
});
