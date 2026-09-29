import { fireEvent, render, screen } from "@testing-library/react";
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
