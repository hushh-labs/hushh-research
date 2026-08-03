import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";

const {
  validateGeminiRuntimeCredentialMock,
  loadRuntimeSecretMock,
  removeRuntimeSecretMock,
  storeRuntimeSecretMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  validateGeminiRuntimeCredentialMock: vi.fn(),
  loadRuntimeSecretMock: vi.fn(),
  removeRuntimeSecretMock: vi.fn(),
  storeRuntimeSecretMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { error: toastErrorMock, success: toastSuccessMock },
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
    removeRuntimeSecret: (...args: unknown[]) => removeRuntimeSecretMock(...args),
  },
}));

describe("GeminiRuntimeSettingsCard setup choice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadRuntimeSecretMock.mockResolvedValue(null);
    storeRuntimeSecretMock.mockResolvedValue({ success: true });
    removeRuntimeSecretMock.mockResolvedValue({ success: true });
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

  it("keeps Gemini selectable and labels the other models as coming soon", () => {
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

    expect(screen.getByText("Hushh managed Gemini")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gemini" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Coming soon" })).toBeTruthy();
    for (const provider of [
      ["openai", "OpenAI"],
      ["anthropic", "Claude"],
      ["grok", "Grok"],
      ["meta_muse_spark", "Meta Muse Spark"],
    ] as const) {
      const row = screen.getByTestId(`profile-coming-soon-${provider[0]}`);
      expect(row).toHaveTextContent(provider[1]);
      expect(row).toHaveTextContent("Coming soon");
      expect(row).toHaveClass("cursor-not-allowed");
      expect(screen.queryByRole("button", { name: provider[1] })).toBeNull();
    }
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
    expect(onSelectionReadyChange).toHaveBeenCalledWith("hushh_managed_vertex");
  });

  it("keeps BYOK unselected until a key is validated and staged in memory during setup", async () => {
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);
    const onRequestVaultCreation = vi.fn();
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey={null}
        vaultOwnerToken={null}
        needsVaultCreation
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={onRequestVaultCreation}
        requiresExplicitSelection
        initiallyConfigured={false}
        onSelectionReadyChange={onSelectionReadyChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Use my Gemini access/i }));

    expect(onSelectionReadyChange).not.toHaveBeenCalled();
    expect(onRequestVaultCreation).not.toHaveBeenCalled();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Gemini API key")).toBeTruthy();
  });

  it("stages a validated setup key without any durable runtime-secret write", async () => {
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);
    const onPreVaultDraftStaged = vi.fn();
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
        onPreVaultDraftStaged={onPreVaultDraftStaged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Use my Gemini access/i }));
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: "test-gemini-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    await screen.findByText("Key is responding and ready to save.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));

    await waitFor(() =>
      expect(onPreVaultDraftStaged).toHaveBeenCalledWith({
        transport: "developer_api",
        credential: "test-gemini-key",
        vertexProject: null,
        vertexLocation: null,
      }),
    );
    expect(onSelectionReadyChange).toHaveBeenCalledWith("byok_pending_vault");
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("keeps the active provider when the encrypted mode write is rejected", async () => {
    loadRuntimeSecretMock.mockImplementation(
      ({ credentialRef }: { credentialRef: string }) =>
        Promise.resolve(
          credentialRef.includes("credential_mode") ? "byok" : null,
        ),
    );
    storeRuntimeSecretMock.mockResolvedValue({ success: false, conflict: true });

    render(
      <GeminiRuntimeSettingsCard
        userId="existing-user"
        vaultKey="memory-only-vault-key"
        vaultOwnerToken="memory-only-owner-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Use my Gemini access/i }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Hushh managed Gemini/i }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "This setting changed on another device. Refresh and try again.",
      ),
    );
    expect(
      screen.getByRole("button", { name: /Use my Gemini access/i }),
    ).toHaveAttribute("aria-pressed", "true");
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

    fireEvent.click(screen.getByRole("button", { name: /Use my Gemini access/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /Use my Gemini access/i }));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(await screen.findByRole("button", { name: "Confirm and save" })).toBeTruthy();

    fireEvent.change(keyInput, { target: { value: "second-key" } });

    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Validate key" })).toBeTruthy();
  });
});
