import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard, useGeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";

const {
  selectManagedGeminiRuntimeMock,
  validateGeminiRuntimeCredentialMock,
  validateOpenAiRuntimeCredentialMock,
  loadRuntimeSecretMock,
  removeRuntimeSecretMock,
  storeRuntimeSecretMock,
  toastErrorMock,
  toastSuccessMock,
  getPersonalAgentStatusMock,
  ownerPodRequestMock,
  routerPushMock,
} = vi.hoisted(() => ({
  selectManagedGeminiRuntimeMock: vi.fn(),
  validateGeminiRuntimeCredentialMock: vi.fn(),
  validateOpenAiRuntimeCredentialMock: vi.fn(),
  loadRuntimeSecretMock: vi.fn(),
  removeRuntimeSecretMock: vi.fn(),
  storeRuntimeSecretMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  getPersonalAgentStatusMock: vi.fn(),
  ownerPodRequestMock: vi.fn(),
  routerPushMock: vi.fn(),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { error: toastErrorMock, success: toastSuccessMock },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  usePathname: () => "/one/profile/ai",
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    validateGeminiRuntimeCredential: (...args: unknown[]) =>
      validateGeminiRuntimeCredentialMock(...args),
    validateOpenAiRuntimeCredential: (...args: unknown[]) =>
      validateOpenAiRuntimeCredentialMock(...args),
    selectManagedGeminiRuntime: (...args: unknown[]) =>
      selectManagedGeminiRuntimeMock(...args),
    getPersonalAgentStatus: (...args: unknown[]) =>
      getPersonalAgentStatusMock(...args),
    ownerPodRequest: (...args: unknown[]) => ownerPodRequestMock(...args),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "pkm:runtime_secrets.llm.gemini_api_key",
  OPENAI_RUNTIME_CREDENTIAL_REF: "pkm:runtime_secrets.llm.openai_api_key",
  GEMINI_RUNTIME_TRANSPORT_REF: "pkm:runtime_secrets.llm.gemini_transport",
  GEMINI_VERTEX_LOCATION_REF: "pkm:runtime_secrets.llm.gemini_vertex_location",
  GEMINI_VERTEX_PROJECT_REF: "pkm:runtime_secrets.llm.gemini_vertex_project",
  RUNTIME_CREDENTIAL_MODE_REF: "pkm:runtime_secrets.llm.credential_mode",
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: (...args: unknown[]) => loadRuntimeSecretMock(...args),
    storeRuntimeSecret: (...args: unknown[]) => storeRuntimeSecretMock(...args),
    removeRuntimeSecret: (...args: unknown[]) =>
      removeRuntimeSecretMock(...args),
  },
}));

function runtimeChoice(id: string) {
  const row = screen.getByTestId(id);
  return row.matches("button") ? row : row.querySelector("button")!;
}

beforeEach(() => {
  vi.resetAllMocks();
  PreVaultSensitiveDraftService.clearForUser("fresh-user");
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("fresh-user");
  getPersonalAgentStatusMock.mockResolvedValue({ hostingMode: "shared" });
  loadRuntimeSecretMock.mockResolvedValue(null);
  storeRuntimeSecretMock.mockResolvedValue({ success: true });
  removeRuntimeSecretMock.mockResolvedValue({ success: true });
  validateGeminiRuntimeCredentialMock.mockResolvedValue({ status: "ready" });
  validateOpenAiRuntimeCredentialMock.mockResolvedValue({ status: "ready" });
  selectManagedGeminiRuntimeMock.mockResolvedValue({
    status: "ready",
    model: "gemini-3-pro",
    location: "global",
    agentScheduled: false,
    agentReason: "",
  });
});

describe("GeminiRuntimeSettingsCard setup choice", () => {
  it("on first-run sandbox setup enables built-in AI automatically without Use Hussh AI or Azure AI key", async () => {
    const onCanContinueChange = vi.fn();
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "connecting",
    });

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
        onCanContinueChange={onCanContinueChange}
        onSelectionReadyChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(onCanContinueChange).toHaveBeenLastCalledWith(true));
    expect(screen.queryByText(/Use Hussh AI/i)).toBeNull();
    expect(screen.queryByText(/Azure AI key/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Bring your own AI" })).toBeTruthy();
    expect(screen.getByTestId("profile-byok-runtime")).toHaveTextContent("Gemini");
    expect(screen.getByTestId("profile-openai-key-row")).toHaveTextContent("OpenAI");
    expect(ownerPodRequestMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Coming soon" })).toBeNull();
    expect(screen.queryByTestId("profile-coming-soon-openai")).toBeNull();
  });

  it("in the settings context lists the coming-soon models without OpenAI or decorative badges", () => {
    getPersonalAgentStatusMock.mockReturnValue(new Promise(() => {}));
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
    expect(runtimeChoice("profile-byok-runtime")).toBeDisabled();
    expect(runtimeChoice("profile-openai-key-row")).toBeDisabled();
    expect(screen.queryByTestId("profile-coming-soon-openai")).toBeNull();
    for (const provider of [
      ["anthropic", "Claude"],
      ["grok", "Grok"],
      ["meta_muse_spark", "Meta Muse Spark"],
    ] as const) {
      const row = screen.getByTestId(`profile-coming-soon-${provider[0]}`);
      expect(row).toHaveTextContent(provider[1]);
      expect(row).not.toHaveTextContent("Coming soon");
      expect(row).toHaveClass("cursor-not-allowed");
      expect(screen.queryByRole("button", { name: provider[1] })).toBeNull();
    }
  });

  it("keeps own-key editing available and blocks Continue when saved-key loading fails", async () => {
    loadRuntimeSecretMock.mockRejectedValue(new Error("Fixture load failure"));
    const onCanContinueChange = vi.fn();
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture"
        vaultOwnerToken="fixture"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        requiresExplicitSelection
        initiallyConfigured
        initialSetupChoice="byok_pending_vault"
        onCanContinueChange={onCanContinueChange}
      />,
    );
    await waitFor(() =>
      expect(onCanContinueChange).toHaveBeenLastCalledWith(false),
    );
    expect(screen.getByLabelText("Gemini API key")).toBeTruthy();
  });

  it.each(["gemini", "openai"])("resumes a saved BYOK setup choice only after reading its selected encrypted key (%s)", async (provider) => {
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }) =>
      credentialRef.endsWith("credential_mode")
        ? "byok"
        : credentialRef.endsWith("selected_provider")
          ? provider
          : credentialRef.endsWith(`${provider}_api_key`)
            ? "fixture-key"
            : null,
    );
    const onCanContinueChange = vi.fn();
    const card = (unlocked: boolean) => (
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey={unlocked ? "fixture" : null}
        vaultOwnerToken={unlocked ? "fixture" : null}
        needsVaultCreation={false}
        needsUnlock={!unlocked}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        requiresExplicitSelection
        initiallyConfigured={false}
        initialSetupChoice="byok_pending_vault"
        onCanContinueChange={onCanContinueChange}
      />
    );
    const view = render(card(false));
    expect(onCanContinueChange).toHaveBeenLastCalledWith(false);
    expect(loadRuntimeSecretMock).not.toHaveBeenCalled();
    view.rerender(card(true));
    await waitFor(() => expect(onCanContinueChange).toHaveBeenLastCalledWith(true));
  });

  it("falls back cleanly to built-in sandbox AI when legacy azure_openai selection exists in Vault", async () => {
    const store = new Map<string, string>([
      ["pkm:runtime_secrets.llm.credential_mode", "byok"],
      ["pkm:runtime_secrets.llm.selected_provider", "azure_openai"],
    ]);
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }: { credentialRef: string }) =>
      store.get(credentialRef) ?? null,
    );
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture"
        vaultOwnerToken="fixture"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/Built-in sandbox AI is active automatically/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Azure AI/i)).toBeNull();
  });

  it("saves multiple Gemini and OpenAI configurations, switches cleanly without re-typing, and turns off custom AI without wiping keys", async () => {
    const store = new Map<string, string>();
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }: { credentialRef: string }) =>
      store.get(credentialRef) ?? null,
    );
    storeRuntimeSecretMock.mockImplementation(async ({ credentialRef, secret }: { credentialRef: string; secret: string }) => {
      store.set(credentialRef, secret);
      return { success: true };
    });
    removeRuntimeSecretMock.mockImplementation(async ({ credentialRef }: { credentialRef: string }) => {
      store.delete(credentialRef);
      return { success: true };
    });
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
      aiSelection: { version: 1, providers: ["gemini", "openai"], defaultVerification: true },
    });
    ownerPodRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json({ configured: true, provider: "openai" });
      if (path === "ai-selection/activate") return Response.json({}, { status: 404 });
      if (path === "ai-selection/deactivate") return Response.json({}, { status: 404 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body || "{}"));
        return Response.json({ status: "active", provider: body.provider, model: "model-x", checkedAtMs: 1 });
      }
      if (init?.method === "DELETE") return Response.json({ status: "cleared" });
      return Response.json({});
    });

    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture-key"
        vaultOwnerToken="fixture-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    // 1. Add Gemini configuration
    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini configuration name"), { target: { value: "Work Gemini" } });
    fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "gemini-key-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and save" }));
    await screen.findByText("Work Gemini");

    // 2. Add OpenAI configuration simultaneously (preserves Work Gemini)
    fireEvent.click(runtimeChoice("profile-openai-key-row"));
    fireEvent.change(screen.getByLabelText("OpenAI configuration name"), { target: { value: "Personal OpenAI" } });
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "openai-key-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and use" }));
    await screen.findByText("Personal OpenAI");
    expect(screen.getByText("Work Gemini")).toBeInTheDocument();

    // 3. Switch back to Work Gemini in 1 click without re-typing keys
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Using Work Gemini."));
    expect(screen.getByText("Personal OpenAI")).toBeInTheDocument();

    // 4. Turn off custom AI without wiping saved keys
    fireEvent.click(screen.getByTestId("turn-off-custom-ai"));
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith("Using built-in sandbox AI. Your saved keys are kept."),
    );
    expect(screen.getByText("Work Gemini")).toBeInTheDocument();
    expect(screen.getByText("Personal OpenAI")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Switch" })).toHaveLength(2);
  });

  it("stages validated Gemini and OpenAI setup keys in pre-vault memory without durable Vault writes", async () => {
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

    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "test-gemini-key" } });
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

    // Can also stage an OpenAI key on top of staged Gemini in Setup > Cloud
    fireEvent.click(runtimeChoice("profile-openai-key-row"));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-pre-vault" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and use" }));
    await waitFor(() => expect(validateOpenAiRuntimeCredentialMock).toHaveBeenCalledWith({ credential: "sk-pre-vault" }));
    await waitFor(() =>
      expect(PreVaultSensitiveDraftService.getStagedAiConfigurations("fresh-user")?.configurations).toHaveLength(2),
    );
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThanOrEqual(2);
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("invalidates a successful Gemini check when the key changes", async () => {
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

    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(await screen.findByRole("button", { name: "Confirm and save" })).toBeTruthy();

    fireEvent.change(keyInput, { target: { value: "second-key" } });
    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Validate key" })).toBeTruthy();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  const ownerProps = (userId: string, onSelectionReadyChange = vi.fn()) => ({
    userId,
    vaultKey: null,
    vaultOwnerToken: null,
    needsVaultCreation: true,
    needsUnlock: false,
    onRequestVaultUnlock: vi.fn(),
    onRequestVaultCreation: vi.fn(),
    requiresExplicitSelection: true,
    initiallyConfigured: false,
    onSelectionReadyChange,
  });

  it("recovers pending and unavailable hosting without inferring a ready connection", async () => {
    getPersonalAgentStatusMock.mockResolvedValueOnce({ hostingMode: "pending" });
    getPersonalAgentStatusMock.mockResolvedValue({ hostingMode: "shared" });
    render(<GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />);
    const retry = await screen.findByRole("button", { name: "Check connection" });
    expect(runtimeChoice("profile-byok-runtime")).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
  });

  it("never publishes an old owner's delayed project lookup on BYOC", async () => {
    const pending = deferred<{ hostingMode: string; state: string; deploymentTarget: string; cloudProject: string }>();
    getPersonalAgentStatusMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        hostingMode: "byoc",
        state: "active",
        deploymentTarget: "user_gcp",
        cloudProject: "synthetic-project-b",
      });
    const view = render(<GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />);
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await screen.findByText("Use existing cloud");
    await act(async () => {
      pending.resolve({
        hostingMode: "byoc",
        state: "active",
        deploymentTarget: "user_gcp",
        cloudProject: "synthetic-project-a",
      });
    });
    expect(screen.queryByText(/synthetic-project-a/)).toBeNull();
    expect(screen.getByText("Use existing cloud")).toBeTruthy();
  });

  it("refuses reads and provider requests when the validated owner differs", async () => {
    publishValidatedAuthSessionOwner("owner-b");
    render(
      <GeminiRuntimeSettingsCard
        {...ownerProps("fresh-user")}
        vaultKey="synthetic-key-a"
        vaultOwnerToken="synthetic-token-a"
      />,
    );
    expect(getPersonalAgentStatusMock).not.toHaveBeenCalled();
    expect(loadRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("clears a prior owner's draft and ignores delayed BYOK validation", async () => {
    const pending = deferred<{ status: string }>();
    validateGeminiRuntimeCredentialMock.mockReturnValueOnce(pending.promise);
    const view = render(<GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />);
    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "synthetic-owner-a-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await act(async () => { pending.resolve({ status: "ready" }); });
    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    expect(screen.getByLabelText("Gemini API key")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("stops the remaining credential removals after an account switch", async () => {
    const pending = deferred<{ success: boolean }>();
    loadRuntimeSecretMock.mockImplementation(({ credentialRef }: { credentialRef: string }) =>
      Promise.resolve(
        credentialRef.includes("selected_provider")
          ? "gemini"
          : credentialRef.includes("credential_mode")
            ? "byok"
            : "synthetic-saved-value",
      ),
    );
    storeRuntimeSecretMock.mockResolvedValue({ success: true });
    removeRuntimeSecretMock.mockReturnValueOnce(pending.promise);
    const view = render(
      <GeminiRuntimeSettingsCard
        {...ownerProps("fresh-user")}
        requiresExplicitSelection={false}
        vaultKey="synthetic-key-a"
        vaultOwnerToken="synthetic-token-a"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove Gemini" }));
    await waitFor(() => expect(removeRuntimeSecretMock).toHaveBeenCalledTimes(1));
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await act(async () => { pending.resolve({ success: true }); });
    expect(removeRuntimeSecretMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("shows key validation errors inline and pauses Continue while editing an unsaved draft", async () => {
    const readiness = vi.fn();
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        needsVaultCreation
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
        requiresExplicitSelection
        initiallyConfigured={false}
        onSelectionReadyChange={vi.fn().mockResolvedValue(undefined)}
        onPreVaultDraftStaged={vi.fn()}
        onCanContinueChange={readiness}
      />,
    );
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    expect(readiness).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your Gemini API key.");
    const key = screen.getByLabelText("Gemini API key");
    expect(key).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(key, { target: { value: "fixture-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and save" }));
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
  });
});

it("presents Azure BYOC cloud default without manufacturing a Vertex identity", async () => {
  getPersonalAgentStatusMock.mockResolvedValue({
    hostingMode: "byoc",
    deploymentTarget: "user_azure",
    state: "active",
  });
  render(
    <GeminiRuntimeSettingsCard
      userId="fresh-user"
      vaultKey={null}
      vaultOwnerToken={null}
      needsVaultCreation
      needsUnlock={false}
      onRequestVaultUnlock={vi.fn()}
      onRequestVaultCreation={vi.fn()}
    />,
  );
  await screen.findByText("Use existing cloud");
  expect(screen.queryByText(/Use your agent’s Vertex AI/)).toBeNull();
  expect(screen.getByText("Azure AI · Check connection")).toBeTruthy();
  expect(selectManagedGeminiRuntimeMock).not.toHaveBeenCalled();
});

it.each([false, true])(
  "checks Gemini privately on Azure before backup (%s)",
  async (accepted) => {
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("fresh-user");
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "byoc",
      deploymentTarget: "user_azure",
      state: "active",
    });
    loadRuntimeSecretMock.mockResolvedValue(null);
    storeRuntimeSecretMock.mockResolvedValue({ success: true });
    ownerPodRequestMock.mockImplementation(async (_path, init) =>
      init?.method === "GET"
        ? Response.json({ configured: false })
        : accepted
          ? Response.json({
              status: "active",
              provider: "gemini",
              model: "fixture",
              checkedAtMs: 1,
            })
          : Response.json({ code: "KEY_REFUSED" }, { status: 422 }),
    );
    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture-key"
        vaultOwnerToken="fixture-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );
    await screen.findByText("Use existing cloud");
    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: "synthetic-gemini-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and use" }));
    await waitFor(() =>
      expect(ownerPodRequestMock.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1),
    );
    expect(ownerPodRequestMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[0]).toBe("ai-selection");
    expect(validateGeminiRuntimeCredentialMock).not.toHaveBeenCalled();
    if (accepted) {
      await waitFor(() => expect(storeRuntimeSecretMock).toHaveBeenCalled());
    } else {
      await screen.findByText("Gemini did not accept this key. Check it and try again.");
      expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
    }
  },
);

it("confirms a verified Azure default concisely and cancels AI editing through authored Back", async () => {
  const ready = vi.fn();
  const { unwindBackLayer } = await import("@/lib/navigation/back-layers");
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("fresh-user");
  getPersonalAgentStatusMock.mockResolvedValue({
    hostingMode: "byoc",
    deploymentTarget: "user_azure",
    state: "active",
    aiSelection: {
      version: 1,
      providers: ["gemini"],
      defaultVerification: true,
    },
  });
  loadRuntimeSecretMock.mockResolvedValue(null);
  let finishMetadata!: (response: Response) => void;
  const metadata = new Promise<Response>((resolve) => { finishMetadata = resolve; });
  ownerPodRequestMock.mockImplementation(async (_path, init) =>
    init?.method === "GET"
      ? metadata
      : Response.json({
          status: "cleared",
          defaultProvider: "azure_openai",
          defaultModel: "synthetic-deployment",
          checkedAtMs: 1,
        }),
  );
  render(
    <GeminiRuntimeSettingsCard
      userId="fresh-user"
      vaultKey="fixture-key"
      vaultOwnerToken="fixture-token"
      needsVaultCreation={false}
      needsUnlock={false}
      onRequestVaultUnlock={vi.fn()}
      onRequestVaultCreation={vi.fn()}
      requiresExplicitSelection
      onCanContinueChange={ready}
      onSelectionReadyChange={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  await waitFor(() => expect(runtimeChoice("profile-managed-runtime")).toBeEnabled());
  fireEvent.click(runtimeChoice("profile-managed-runtime"));
  await screen.findByRole("button", { name: "Change AI" });
  finishMetadata(
    Response.json({
      configured: false,
      effectiveConnection: {
        provider: "azure_openai",
        model: "stale-deployment",
        source: "cloud_default",
        state: "configured",
        verification: "unverified",
      },
    }),
  );
  await act(async () => { await metadata; });
  expect(screen.getByRole("button", { name: "Change AI" })).toBeTruthy();
  expect(screen.queryByText(/stale-deployment/)).toBeNull();
  expect(screen.queryByTestId("profile-byok-runtime")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change AI" }));
  fireEvent.click(runtimeChoice("profile-byok-runtime"));
  fireEvent.change(screen.getByLabelText("Gemini API key"), {
    target: { value: "synthetic-unapproved-key" },
  });
  await act(async () => {
    expect(unwindBackLayer("/one/profile/ai")).toBe(true);
  });
  expect(screen.queryByLabelText("Gemini API key")).toBeNull();
  expect(screen.getByRole("button", { name: "Change AI" })).toBeVisible();
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(ownerPodRequestMock.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(1);
  expect(ownerPodRequestMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
});

it("retires the private key draft and pending validation when its owner changes", async () => {
  publishValidatedAuthSessionOwner("owner-a");
  let finish!: () => void;
  validateGeminiRuntimeCredentialMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const props = { needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() };
  const view = render(<GeminiRuntimeSettingsCard {...props} userId="owner-a" vaultKey="fixture-key-a" vaultOwnerToken="fixture-token-a" />);
  await act(async () => undefined);
  fireEvent.click(screen.getByTestId("profile-byok-runtime").querySelector("button")!);
  fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "synthetic-owner-a-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
  view.rerender(<GeminiRuntimeSettingsCard {...props} userId="owner-a" vaultKey="fixture-key-a" vaultOwnerToken="fixture-token-b" />);
  await act(async () => undefined);
  fireEvent.click(screen.getByTestId("profile-byok-runtime").querySelector("button")!);
  expect(screen.getByLabelText("Gemini API key")).toHaveValue("");
  await act(async () => { finish(); });
  expect(screen.queryByRole("button", { name: "Confirm and save" })).toBeNull();
  expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
});

it("does not continue a multi-write save or publish its outcome after its owner retires", async () => {
  publishValidatedAuthSessionOwner("owner-a");
  let finish!: (value: { success: boolean }) => void;
  storeRuntimeSecretMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const props = { needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() };
  const view = render(<GeminiRuntimeSettingsCard {...props} userId="owner-a" vaultKey="fixture-key-a" vaultOwnerToken="fixture-token-a" />);
  await act(async () => undefined);
  fireEvent.click(screen.getByTestId("profile-byok-runtime").querySelector("button")!);
  fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "synthetic-owner-a-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm and save" }));
  await waitFor(() => expect(storeRuntimeSecretMock).toHaveBeenCalledTimes(1));
  view.rerender(<GeminiRuntimeSettingsCard {...props} userId="owner-b" vaultKey="fixture-key-b" vaultOwnerToken="fixture-token-b" />);
  await act(async () => { finish({ success: true }); });
  expect(storeRuntimeSecretMock).toHaveBeenCalledTimes(1);
  expect(removeRuntimeSecretMock).not.toHaveBeenCalled();
  expect(toastSuccessMock).not.toHaveBeenCalled();
});

it("keeps a delayed saved configuration from changing the tuple that was just validated", async () => {
  publishValidatedAuthSessionOwner("owner-a");
  const props = {
    userId: "owner-a",
    vaultKey: "fixture-key",
    vaultOwnerToken: "fixture-token",
    needsVaultCreation: false,
    needsUnlock: false,
    onRequestVaultUnlock: vi.fn(),
    onRequestVaultCreation: vi.fn(),
  };
  const hook = renderHook(() => useGeminiRuntimeSettingsModel(props));
  await act(async () => undefined);
  await act(async () => { await hook.result.current.selectByok(); });
  act(() => hook.result.current.setDraftKey("synthetic-current-key"));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }) => {
    await pending;
    return credentialRef.endsWith("credential_mode") ? "byok" : credentialRef.endsWith("gemini_transport") ? "vertex_api_key" : "stale-saved-value";
  });
  let read!: Promise<void>;
  act(() => { read = hook.result.current.refresh(); });
  await act(async () => { expect(await hook.result.current.validateByok()).toBe(true); });
  await act(async () => { finish(); await read; });
  expect(hook.result.current.transport).toBe("developer_api");
  expect(hook.result.current.credentialValidation.status).toBe("ready");
  expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
});

it("reconciles final native input only into its unchanged original draft", async () => {
  publishValidatedAuthSessionOwner("owner-a");
  const props = {
    userId: "owner-a",
    vaultKey: "fixture-key",
    needsVaultCreation: false,
    needsUnlock: false,
    onRequestVaultUnlock: vi.fn(),
    onRequestVaultCreation: vi.fn(),
  };
  const hook = renderHook(({ token }) => useGeminiRuntimeSettingsModel({ ...props, vaultOwnerToken: token }), { initialProps: { token: "token-a" } });
  await act(async () => undefined);
  act(() => hook.result.current.setDraftKey("synthetic-original-key"));
  const revision = hook.result.current.inputRevision();
  const final = { credential: "synthetic-final-key", transport: "developer_api" as const, project: "", location: "global" };
  act(() => { expect(hook.result.current.reconcileFinalDraft(final, revision)).toBe(true); });
  expect(hook.result.current.draftKey).toBe(final.credential);
  act(() => hook.result.current.setDraftKey("synthetic-newer-key"));
  act(() => { expect(hook.result.current.reconcileFinalDraft(final, revision)).toBe(false); });
  expect(hook.result.current.draftKey).toBe("synthetic-newer-key");
  const retired = hook.result.current;
  hook.rerender({ token: "token-b" });
  act(() => { expect(retired.reconcileFinalDraft(final, retired.inputRevision())).toBe(false); });
  expect(hook.result.current.draftKey).toBe("");
  expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  expect(validateGeminiRuntimeCredentialMock).not.toHaveBeenCalled();
});

it("cancels a nonmutating key check without allowing its late result to restore readiness", async () => {
  publishValidatedAuthSessionOwner("owner-a");
  let finish!: () => void;
  validateGeminiRuntimeCredentialMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const hook = renderHook(() =>
    useGeminiRuntimeSettingsModel({
      userId: "owner-a",
      vaultKey: "fixture-key",
      vaultOwnerToken: "fixture-token",
      needsVaultCreation: false,
      needsUnlock: false,
      onRequestVaultUnlock: vi.fn(),
      onRequestVaultCreation: vi.fn(),
    }),
  );
  await act(async () => undefined);
  act(() => hook.result.current.setDraftKey("synthetic-key"));
  let validation!: Promise<boolean>;
  act(() => { validation = hook.result.current.validateByok(); });
  expect(hook.result.current.mutationPending()).toBe(false);
  act(() => hook.result.current.cancelEdit());
  expect(hook.result.current.draftKey).toBe("");
  await act(async () => { finish(); expect(await validation).toBe(false); });
  expect(hook.result.current.credentialValidation.status).toBe("idle");
  expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
});

it("retires an unsaved credential across reauthentication of the same owner", async () => {
  const hook = renderHook(() =>
    useGeminiRuntimeSettingsModel({
      userId: "fresh-user",
      vaultKey: "fixture-key",
      vaultOwnerToken: "fixture-token",
      needsVaultCreation: false,
      needsUnlock: false,
      onRequestVaultUnlock: vi.fn(),
      onRequestVaultCreation: vi.fn(),
    }),
  );
  await act(async () => undefined);
  act(() => hook.result.current.setDraftKey("synthetic-private-key"));
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("fresh-user");
  await act(async () => { expect(await hook.result.current.saveByok()).toBe(false); });
  expect(ownerPodRequestMock).not.toHaveBeenCalled();
  expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  hook.rerender();
  expect(hook.result.current.draftKey).toBe("");
});

describe("Iteration 3 multi-config, refusal, toast, and cold-pod remediation", () => {
  it("aborts Gemini switch on ace when pod refuses with KEY_REFUSED and preserves active config", async () => {
    const store = new Map<string, string>([
      [
        "pkm:runtime_secrets.llm.byok_configurations",
        JSON.stringify([
          {
            id: "cfg-openai",
            provider: "openai",
            label: "Work OpenAI",
            apiKey: "sk-openai-1",
            model: "gpt-5",
            transport: null,
            vertexProject: null,
            vertexLocation: null,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
          {
            id: "cfg-gemini",
            provider: "gemini",
            label: "Work Gemini",
            apiKey: "AIza-gemini-bad",
            model: null,
            transport: "developer_api",
            vertexProject: null,
            vertexLocation: null,
            createdAtMs: 2,
            updatedAtMs: 2,
          },
        ]),
      ],
      ["pkm:runtime_secrets.llm.active_configuration_id", "cfg-openai"],
      ["pkm:runtime_secrets.llm.credential_mode", "byok"],
      ["pkm:runtime_secrets.llm.selected_provider", "openai"],
    ]);
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }: { credentialRef: string }) =>
      store.get(credentialRef) ?? null,
    );
    storeRuntimeSecretMock.mockImplementation(async ({ credentialRef, secret }: { credentialRef: string; secret: string }) => {
      store.set(credentialRef, secret);
      return { success: true };
    });
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
      aiSelection: { version: 1, providers: ["gemini", "openai"] },
    });
    ownerPodRequestMock.mockImplementation(async (path: string) => {
      if (path === "ai-selection/activate") {
        return Response.json({ detail: { code: "KEY_REFUSED" } }, { status: 422 });
      }
      return Response.json({});
    });

    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture-key"
        vaultOwnerToken="fixture-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await screen.findByText("Work Gemini");
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(store.get("pkm:runtime_secrets.llm.active_configuration_id")).toBe("cfg-openai");
  });

  it("seals via PUT ai-selection when switching among multiple configs of the same provider and preserves active slot on inactive delete", async () => {
    const store = new Map<string, string>([
      [
        "pkm:runtime_secrets.llm.byok_configurations",
        JSON.stringify([
          {
            id: "cfg-gem-1",
            provider: "gemini",
            label: "Work Gemini",
            apiKey: "AIza-gem-1",
            model: null,
            transport: "developer_api",
            vertexProject: null,
            vertexLocation: null,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
          {
            id: "cfg-gem-2",
            provider: "gemini",
            label: "Personal Gemini",
            apiKey: "AIza-gem-2",
            model: null,
            transport: "developer_api",
            vertexProject: null,
            vertexLocation: null,
            createdAtMs: 2,
            updatedAtMs: 2,
          },
        ]),
      ],
      ["pkm:runtime_secrets.llm.active_configuration_id", "cfg-gem-1"],
      ["pkm:runtime_secrets.llm.credential_mode", "byok"],
      ["pkm:runtime_secrets.llm.selected_provider", "gemini"],
    ]);
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }: { credentialRef: string }) =>
      store.get(credentialRef) ?? null,
    );
    storeRuntimeSecretMock.mockImplementation(async ({ credentialRef, secret }: { credentialRef: string; secret: string }) => {
      store.set(credentialRef, secret);
      return { success: true };
    });
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
      aiSelection: { version: 1, providers: ["gemini", "openai"] },
    });
    ownerPodRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json({ configured: true, provider: "gemini" });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body || "{}"));
        return Response.json({ status: "active", provider: body.provider, model: "gemini-3-pro", checkedAtMs: 1 });
      }
      if (init?.method === "DELETE") return Response.json({ status: "cleared" });
      return Response.json({});
    });

    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture-key"
        vaultOwnerToken="fixture-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await screen.findByText("Personal Gemini");
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Using Personal Gemini."));
    expect(ownerPodRequestMock.mock.calls.some(([path]) => path === "ai-selection/activate")).toBe(false);
    const putCall = ownerPodRequestMock.mock.calls.find(([path, init]) => path === "ai-selection" && init?.method === "PUT");
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({ provider: "gemini", apiKey: "AIza-gem-2" });

    fireEvent.click(screen.getByRole("button", { name: "Remove Work Gemini" }));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Work Gemini removed."));
    expect(
      ownerPodRequestMock.mock.calls.some(
        ([path, init]) => path === "ai-selection?provider=gemini" && init?.method === "DELETE",
      ),
    ).toBe(false);
    expect(store.get("pkm:runtime_secrets.llm.active_configuration_id")).toBe("cfg-gem-2");
  });

  it("clears inactive provider pod slot when deleting an inactive config while another provider is active", async () => {
    const store = new Map<string, string>([
      [
        "pkm:runtime_secrets.llm.byok_configurations",
        JSON.stringify([
          {
            id: "cfg-openai",
            provider: "openai",
            label: "Work OpenAI",
            apiKey: "sk-openai-work",
            model: null,
            transport: null,
            vertexProject: null,
            vertexLocation: null,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
          {
            id: "cfg-old-gem",
            provider: "gemini",
            label: "Old Gemini",
            apiKey: "AIza-old",
            model: null,
            transport: "developer_api",
            vertexProject: null,
            vertexLocation: null,
            createdAtMs: 2,
            updatedAtMs: 2,
          },
        ]),
      ],
      ["pkm:runtime_secrets.llm.active_configuration_id", "cfg-openai"],
      ["pkm:runtime_secrets.llm.credential_mode", "byok"],
      ["pkm:runtime_secrets.llm.selected_provider", "openai"],
    ]);
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }: { credentialRef: string }) =>
      store.get(credentialRef) ?? null,
    );
    storeRuntimeSecretMock.mockImplementation(async ({ credentialRef, secret }: { credentialRef: string; secret: string }) => {
      store.set(credentialRef, secret);
      return { success: true };
    });
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
      aiSelection: { version: 1, providers: ["gemini", "openai"] },
    });
    ownerPodRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json({ configured: true, provider: "openai" });
      if (init?.method === "DELETE") return Response.json({ status: "deleted", provider: "gemini" });
      return Response.json({});
    });

    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture-key"
        vaultOwnerToken="fixture-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await screen.findByText("Old Gemini");
    fireEvent.click(screen.getByRole("button", { name: "Remove Old Gemini" }));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Old Gemini removed."));
    expect(
      ownerPodRequestMock.mock.calls.some(
        ([path, init]) => path === "ai-selection?provider=gemini" && init?.method === "DELETE",
      ),
    ).toBe(true);
    expect(store.get("pkm:runtime_secrets.llm.active_configuration_id")).toBe("cfg-openai");
  });

  it("emits a single coherent error toast without toast.success when saveByok pod sync fails", async () => {
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
      aiSelection: { version: 1, providers: ["gemini", "openai"] },
    });
    ownerPodRequestMock.mockRejectedValue(new Error("NETWORK_DOWN"));

    render(
      <GeminiRuntimeSettingsCard
        userId="fresh-user"
        vaultKey="fixture-key"
        vaultOwnerToken="fixture-token"
        needsVaultCreation={false}
        needsUnlock={false}
        onRequestVaultUnlock={vi.fn()}
        onRequestVaultCreation={vi.fn()}
      />,
    );

    await waitFor(() => expect(runtimeChoice("profile-byok-runtime")).toBeEnabled());
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "AIza-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and save" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("allows Setup > Cloud Turn off from byok_pending_vault even when sleeping ace returns 503", async () => {
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);
    PreVaultSensitiveDraftService.stageAiConfigurations("fresh-user", {
      configurations: [
        {
          id: "staged-gem",
          provider: "gemini",
          label: "Staged Gemini",
          apiKey: "AIza-staged",
          model: null,
          transport: "developer_api",
          vertexProject: null,
          vertexLocation: null,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
      activeConfigId: "staged-gem",
    });
    getPersonalAgentStatusMock.mockResolvedValue({
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      state: "active",
      aiSelection: { version: 1, providers: ["gemini", "openai"] },
    });
    ownerPodRequestMock.mockResolvedValue(
      new Response("unavailable", { status: 503, headers: { "x-hussh-pod-state": "unavailable" } }),
    );

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
        initiallyConfigured
        initialSetupChoice="byok_pending_vault"
        onSelectionReadyChange={onSelectionReadyChange}
      />,
    );

    const turnOff = await screen.findByTestId("turn-off-custom-ai");
    fireEvent.click(turnOff);
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith("Using built-in sandbox AI. Your saved keys are kept."),
    );
    expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledTimes(1);
    expect(onSelectionReadyChange).toHaveBeenCalledWith("hushh_managed_vertex");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
