import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";

const {
  selectManagedGeminiRuntimeMock,
  validateGeminiRuntimeCredentialMock,
  loadRuntimeSecretMock,
  removeRuntimeSecretMock,
  storeRuntimeSecretMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  selectManagedGeminiRuntimeMock: vi.fn(),
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

// The card calls useRouter() to route to the cloud/authorization step on a revoked
// grant; the test harness mounts no Next.js App Router, so provide a stub push.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    validateGeminiRuntimeCredential: (...args: unknown[]) =>
      validateGeminiRuntimeCredentialMock(...args),
    selectManagedGeminiRuntime: (...args: unknown[]) =>
      selectManagedGeminiRuntimeMock(...args),
    // Mounted-effect poll for a previously-recorded BYOC project; a neutral
    // (non-"recorded") status keeps the card in its default managed-first state.
    getByocSetupStatus: () =>
      Promise.resolve({ status: "not_started", projectId: null }),
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
    selectManagedGeminiRuntimeMock.mockResolvedValue({
      status: "ready",
      model: "gemini-3-pro",
      location: "global",
      agentScheduled: false,
      agentReason: "",
    });
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

  it("on the first-run step keeps Gemini selectable and defers the coming-soon models", () => {
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

    expect(screen.getByText("Use Hussh's AI")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gemini" })).toBeTruthy();
    // Restraint Charter: the mandatory first-run step lets the person choose only
    // Gemini, so the future-providers list is deferred to the settings context
    // rather than competing with the one decision here.
    expect(screen.queryByRole("heading", { name: "Coming soon" })).toBeNull();
    expect(screen.queryByTestId("profile-coming-soon-openai")).toBeNull();
  });

  it("in the settings context lists the coming-soon models without a decorative badge", () => {
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey={null}
        vaultOwnerToken={null}
        needsVaultCreation
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        initiallyConfigured={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Coming soon" })).toBeTruthy();
    for (const provider of [
      ["openai", "OpenAI"],
      ["anthropic", "Claude"],
      ["grok", "Grok"],
      ["meta_muse_spark", "Meta Muse Spark"],
    ] as const) {
      const row = screen.getByTestId(`profile-coming-soon-${provider[0]}`);
      expect(row).toHaveTextContent(provider[1]);
      // Law 5: the per-row "Coming soon" badge only restated the group heading and
      // the disabled state, so it is gone; the heading and styling carry it.
      expect(row).not.toHaveTextContent("Coming soon");
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
      screen.getByRole("button", { name: /Use Hussh's AI/i }),
    );

    await waitFor(() => expect(onSelectionReadyChange).toHaveBeenCalledTimes(1));
    expect(onSelectionReadyChange).toHaveBeenCalledWith("hushh_managed_vertex");
  });

  // -- the managed path finally reaches the server -------------------------------
  //
  // Choosing managed used to be entirely client-side: the mode went into the user's
  // own PKM vault and no server route was called at all. Managed is the DEFAULT, so
  // for most people the server never learned an AI connection existed -- and
  // provisioning a private agent hangs off exactly that event.

  const renderSetupCard = (onSelectionReadyChange = vi.fn().mockResolvedValue(undefined)) => {
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
    return onSelectionReadyChange;
  };

  const clickManaged = () =>
    fireEvent.click(screen.getByRole("button", { name: /Use Hussh's AI/i }));

  it("tells the server about the managed choice", async () => {
    renderSetupCard();
    clickManaged();
    await waitFor(() =>
      expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledTimes(1),
    );
  });

  it("verifies the managed runtime BEFORE committing the choice", async () => {
    // Ordering, not merely both-happened. Persisting first and probing second means
    // a person can be told "selected" about a runtime that cannot generate -- and
    // the BYOK path already validates first, so this is parity, not preference.
    const order: string[] = [];
    selectManagedGeminiRuntimeMock.mockImplementation(async () => {
      order.push("verify");
      return {
        status: "ready",
        model: "gemini-3-pro",
        location: "global",
        agentScheduled: true,
        agentReason: "ai connection verified",
      };
    });
    const onSelectionReadyChange = vi.fn().mockImplementation(async () => {
      order.push("commit");
    });

    renderSetupCard(onSelectionReadyChange);
    clickManaged();

    await waitFor(() => expect(onSelectionReadyChange).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["verify", "commit"]);
  });

  it("does not commit the choice when the managed runtime cannot answer", async () => {
    selectManagedGeminiRuntimeMock.mockRejectedValue(
      new Error("MANAGED_RUNTIME_NOT_READY"),
    );
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);

    renderSetupCard(onSelectionReadyChange);
    clickManaged();

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(onSelectionReadyChange).not.toHaveBeenCalled();
    expect(String(toastErrorMock.mock.calls[0][0])).toContain("isn\u2019t responding");
  });

  it("says the agent is being built only when one actually was", async () => {
    // "We are building your private agent" and "you are on the shared runtime" are
    // different promises. One cheerful string for both is how a product starts lying.
    selectManagedGeminiRuntimeMock.mockResolvedValue({
      status: "ready",
      model: "gemini-3-pro",
      location: "global",
      agentScheduled: true,
      agentReason: "ai connection verified",
    });
    renderSetupCard();
    clickManaged();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(String(toastSuccessMock.mock.calls[0][0])).toContain(
      "private agent is being built",
    );
  });

  it("does not promise an agent when none was scheduled", async () => {
    renderSetupCard();
    clickManaged();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(String(toastSuccessMock.mock.calls[0][0])).not.toContain("private agent");
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

    fireEvent.click(screen.getByRole("button", { name: /Use your own key/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /Use your own key/i }));
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
        screen.getByRole("button", { name: /Use your own key/i }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Use Hussh's AI/i }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "This setting changed on another device. Refresh and try again.",
      ),
    );
    expect(
      screen.getByRole("button", { name: /Use your own key/i }),
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

    fireEvent.click(screen.getByRole("button", { name: /Use your own key/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /Use your own key/i }));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(await screen.findByRole("button", { name: "Confirm and save" })).toBeTruthy();

    fireEvent.change(keyInput, { target: { value: "second-key" } });

    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Validate key" })).toBeTruthy();
  });
});
