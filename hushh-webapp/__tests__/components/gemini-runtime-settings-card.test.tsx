import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";

const validateGeminiRuntimeCredentialMock = vi.fn();
const loadRuntimeSecretMock = vi.fn();
const storeRuntimeSecretMock = vi.fn();

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    validateGeminiRuntimeCredential: (...args: unknown[]) =>
      validateGeminiRuntimeCredentialMock(...args),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "pkm:runtime_secrets.llm.gemini_api_key",
  GEMINI_RUNTIME_TRANSPORT_REF: "pkm:runtime_secrets.llm.gemini_transport",
  GEMINI_VERTEX_LOCATION_REF: "pkm:runtime_secrets.llm.gemini_vertex_location",
  GEMINI_VERTEX_PROJECT_REF: "pkm:runtime_secrets.llm.gemini_vertex_project",
  RUNTIME_CREDENTIAL_MODE_REF: "pkm:runtime_secrets.llm.credential_mode",
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: (...args: unknown[]) => loadRuntimeSecretMock(...args),
    storeRuntimeSecret: (...args: unknown[]) => storeRuntimeSecretMock(...args),
    removeRuntimeSecret: vi.fn(),
  },
}));

describe("GeminiRuntimeSettingsCard setup choice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadRuntimeSecretMock.mockResolvedValue(null);
    storeRuntimeSecretMock.mockResolvedValue(undefined);
    validateGeminiRuntimeCredentialMock.mockResolvedValue({ status: "ready" });
  });

  it("does not manufacture a selected choice before the fresh user confirms one", () => {
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey={null}
        vaultOwnerToken={null}
        needsVaultCreation
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        requiresExplicitSelection
        initiallyConfigured={false}
        onSelectionReadyChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("Selected")).toBeNull();
  });

  it("commits the managed choice before reporting setup completion", async () => {
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey={null}
        vaultOwnerToken={null}
        needsVaultCreation
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        requiresExplicitSelection
        initiallyConfigured={false}
        onSelectionReadyChange={onSelectionReadyChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Hushh managed Gemini/i }),
    );

    await waitFor(() => expect(onSelectionReadyChange).toHaveBeenCalledTimes(1));
  });

  it("requires a responding Gemini key before confirmation and encrypted storage", async () => {
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="memory-only-vault-key"
        vaultOwnerToken="memory-only-owner-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        requiresExplicitSelection
        initiallyConfigured={false}
        onSelectionReadyChange={onSelectionReadyChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Use my Gemini API key/i }));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "test-gemini-key" } });

    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));

    expect(await screen.findByText("Key is responding and ready to save.")).toBeTruthy();
    expect(validateGeminiRuntimeCredentialMock).toHaveBeenCalledWith({
      credential: "test-gemini-key",
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));

    await waitFor(() => expect(onSelectionReadyChange).toHaveBeenCalledTimes(1));
    expect(storeRuntimeSecretMock).toHaveBeenCalled();
  });

  it("invalidates a successful check when the key changes", async () => {
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="memory-only-vault-key"
        vaultOwnerToken="memory-only-owner-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Use my Gemini API key/i }));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(await screen.findByRole("button", { name: "Confirm and save" })).toBeTruthy();

    fireEvent.change(keyInput, { target: { value: "second-key" } });

    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Validate key" })).toBeTruthy();
  });
});
