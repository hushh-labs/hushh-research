import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiRuntimeConfigurationPage } from "@/components/connections/gemini-runtime-configuration-page";
import {
  PwmResearchDisclosure,
  PWM_AZURE_RESEARCH_DISCLOSURE_COMPACT,
} from "@/components/onboarding/setup/pwm-research-disclosure";

const state = vi.hoisted(() => ({
  user: { uid: "recipient" },
  router: { replace: vi.fn(), push: vi.fn() },
  finalize: vi.fn(),
  acknowledge: vi.fn(),
  sync: vi.fn(),
  finance: vi.fn(),
  welcome: vi.fn(),
  hasFinanceIntent: false,
  runtimeChoiceSaved: true,
  setupChoice: "managed",
  hasGeminiRuntimeDraft: false,
  savedGeminiKey: false,
  vaultUnlocked: true,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => state.router,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: () => false,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.user, loading: false }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.vaultUnlocked,
    vaultKey: state.vaultUnlocked ? "test-key" : null,
    vaultOwnerToken: state.vaultUnlocked ? "test-token" : null,
  }),
}));
vi.mock("@/components/connections/gemini-runtime-settings-card", () => ({
  GeminiRuntimeSettingsCard: ({
    onCanContinueChange,
    initiallyConfigured,
    onRequestVaultUnlock,
  }: {
    onCanContinueChange: (ready: boolean) => void;
    initiallyConfigured: boolean;
    onRequestVaultUnlock: () => void;
  }) => <><button data-initially-configured={initiallyConfigured} onClick={() => onCanContinueChange(true)}>Choose AI</button><button onClick={onRequestVaultUnlock}>Open vault for AI</button></>,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <div role="dialog"><button onClick={() => onOpenChange(false)}>Cancel unlock</button></div> : null,
}));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => ({ oneRuntimeSetupChoice: state.setupChoice }),
    hasOneRuntimeChoice: () => state.runtimeChoiceSaved,
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
  state.runtimeChoiceSaved = true;
  state.setupChoice = "managed";
  state.hasGeminiRuntimeDraft = false;
  state.savedGeminiKey = false;
  state.vaultUnlocked = true;
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
  it.each([false, true])("shows vault unlock during setup, including embedded=%s", (embedded) => {
    state.vaultUnlocked = false;
    state.runtimeChoiceSaved = false;
    const ready = vi.fn();
    render(<GeminiRuntimeConfigurationPage setupMode embeddedInCloudSetup={embedded} onSetupReadyChange={ready} />);
    fireEvent.click(screen.getByRole("button", { name: "Open vault for AI" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel unlock" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ready).not.toHaveBeenCalledWith(true);
    expect(state.router.replace).not.toHaveBeenCalled();
  });
  it("offers unlock for a saved Shared key after refresh without trusting its marker", async () => {
    state.setupChoice = "byok_pending_vault";
    state.vaultUnlocked = false;
    const ready = vi.fn();
    render(<GeminiRuntimeConfigurationPage setupMode embeddedInCloudSetup onSetupReadyChange={ready} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock saved AI connection" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(ready).not.toHaveBeenCalledWith(true);
  });
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

  it.each([false, true])("embedded readiness requires the durable AI choice (%s)", (saved) => {
    state.runtimeChoiceSaved = saved;
    const ready = vi.fn();
    render(<GeminiRuntimeConfigurationPage setupMode embeddedInCloudSetup onSetupReadyChange={ready} />);
    expect(screen.getByRole("region", { name: "AI access" })).toBeVisible();
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    expect(ready).toHaveBeenLastCalledWith(saved);
    if (!saved) expect(ready).not.toHaveBeenCalledWith(true);
    expect(state.router.replace).not.toHaveBeenCalled();
  });

  it("returns to the setup hub with the invitation preserved", () => {
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(state.router.replace).toHaveBeenCalledOnce();
    const href = state.router.replace.mock.calls[0][0] as string;
    const route = new URL(href, "https://one.example");
    expect(route.pathname).toBe("/one/setup");
    expect(route.searchParams.get("return_to")).toBe(destination);
  });

  it("does not carry an external return target into setup", () => {
    window.history.replaceState(null, "", "/one/setup/connections?return_to=https%3A%2F%2Fother.example");
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose AI" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const route = new URL(state.router.replace.mock.calls[0][0] as string, "https://one.example");
    expect(route.pathname).toBe("/one/setup");
    expect(route.searchParams.has("return_to")).toBe(false);
  });
});
