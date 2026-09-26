import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiRuntimeConfigurationPage } from "@/components/connections/gemini-runtime-configuration-page";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const { state, markChoice, navigate, replace, clearDraft } = vi.hoisted(() => ({
  state: { uid: "owner-a" },
  markChoice: vi.fn(),
  navigate: vi.fn(() => true),
  replace: vi.fn(),
  clearDraft: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid }, loading: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: null, vaultOwnerToken: null, isVaultUnlocked: false }),
}));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: vi.fn() }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: vi.fn() }));
vi.mock("@/lib/utils/browser-navigation", () => ({ requestInternalAppNavigation: navigate }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => ({ oneRuntimeSetupChoice: null }),
    hasOneRuntimeChoice: () => false,
    markOneRuntimeChoice: (...args: unknown[]) => markChoice(...args),
  },
}));
vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({
  PreVaultSensitiveDraftService: { clearGeminiRuntime: clearDraft },
}));
vi.mock("@/components/connections/private-agent-card", () => ({ PrivateAgentCard: () => null }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/components/connections/gemini-runtime-settings-card", () => ({
  GeminiRuntimeSettingsCard: ({ onSelectionReadyChange }: {
    onSelectionReadyChange?: (choice: "hushh_managed_vertex") => Promise<void>;
  }) => <button onClick={() => void onSelectionReadyChange?.("hushh_managed_vertex")}>Choose managed</button>,
}));
vi.mock("@/components/onboarding/setup/setup-completion-footer", () => ({
  SetupCompletionFooter: ({ disabled }: { disabled: boolean }) => <button disabled={disabled}>Continue</button>,
}));

describe("runtime setup owner settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.uid = "owner-a";
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner(state.uid);
  });

  function pendingChoice() {
    let resolve!: (value: { oneRuntimeSetupChoice: string }) => void;
    markChoice.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    return () => resolve({ oneRuntimeSetupChoice: "hushh_managed_vertex" });
  }

  it("does not finish B's setup when A's persistence settles", async () => {
    const settle = pendingChoice();
    const view = render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose managed" }));
    expect(markChoice).toHaveBeenCalledWith("owner-a", "hushh_managed_vertex");
    state.uid = "owner-b";
    publishValidatedAuthSessionOwner(state.uid);
    view.rerender(<GeminiRuntimeConfigurationPage setupMode />);
    await act(async () => { settle(); });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("does not navigate after the initiating setup screen unmounts", async () => {
    const settle = pendingChoice();
    const view = render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose managed" }));
    view.unmount();
    await act(async () => { settle(); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses a callback after the validated session has changed", () => {
    render(<GeminiRuntimeConfigurationPage setupMode />);
    publishValidatedAuthSessionOwner("owner-b");
    fireEvent.click(screen.getByRole("button", { name: "Choose managed" }));
    expect(markChoice).not.toHaveBeenCalled();
  });

  it("still finishes the current owner's persisted selection", async () => {
    const settle = pendingChoice();
    render(<GeminiRuntimeConfigurationPage setupMode />);
    fireEvent.click(screen.getByRole("button", { name: "Choose managed" }));
    await act(async () => { settle(); });
    expect(navigate).toHaveBeenCalledOnce();
    expect(clearDraft).toHaveBeenCalledWith("owner-a");
    expect(clearDraft.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });
});
