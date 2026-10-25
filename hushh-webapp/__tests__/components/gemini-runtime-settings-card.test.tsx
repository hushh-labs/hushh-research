import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard, useGeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const {
  selectManagedGeminiRuntimeMock,
  validateGeminiRuntimeCredentialMock,
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

// The card calls useRouter() to route to the cloud/authorization step on a revoked
// grant; the test harness mounts no Next.js App Router, so provide a stub push.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  usePathname: () => "/one/profile/ai",
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    validateGeminiRuntimeCredential: (...args: unknown[]) =>
      validateGeminiRuntimeCredentialMock(...args),
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
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("fresh-user");
    getPersonalAgentStatusMock.mockResolvedValue({ hostingMode: "shared" });
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

describe("GeminiRuntimeSettingsCard setup choice", () => {

  it("does not manufacture a selected choice before the fresh user confirms one", () => {
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
        requiresExplicitSelection
        initiallyConfigured={false}
        onSelectionReadyChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("Selected")).toBeNull();
    expect(runtimeChoice("profile-managed-runtime")).toBeDisabled();
  });

  it("on the first-run step offers the managed runtime without assuming its provider", async () => {
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

    expect(screen.getByText("Use Hussh AI")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bring your own AI" })).toBeTruthy();
    // Unavailable providers stay out of the first-run choice.
    expect(screen.queryByRole("heading", { name: "Coming soon" })).toBeNull();
    expect(screen.queryByTestId("profile-coming-soon-openai")).toBeNull();
  });

  it("in the settings context lists the coming-soon models without a decorative badge", () => {
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
    expect(runtimeChoice("profile-managed-runtime")).toBeDisabled();
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
    expect(screen.getAllByRole("radio")[1].getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByLabelText("Gemini API key")).toBeTruthy();
  });

  it.each(["gemini", "openai", "azure_openai"])("resumes a saved BYOK setup choice only after reading its selected encrypted key (%s)", async provider => {
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }) =>
      credentialRef.endsWith("credential_mode") ? "byok" :
      credentialRef.endsWith("selected_provider") ? provider :
      credentialRef.endsWith(provider === "azure_openai" ? "azure_openai_configuration" : `${provider}_api_key`) ? "fixture-key" : null);
    const onCanContinueChange = vi.fn();
    const card = (unlocked: boolean) => <GeminiRuntimeSettingsCard userId="fresh-user" vaultKey={unlocked ? "fixture" : null}
      vaultOwnerToken={unlocked ? "fixture" : null} needsVaultCreation={false} needsUnlock={!unlocked}
      onRequestVaultUnlock={vi.fn()} onRequestVaultCreation={vi.fn()}
      requiresExplicitSelection initiallyConfigured={false} initialSetupChoice="byok_pending_vault"
      onCanContinueChange={onCanContinueChange} />;
    const view = render(card(false));
    expect(onCanContinueChange).toHaveBeenLastCalledWith(false);
    expect(loadRuntimeSecretMock).not.toHaveBeenCalled();
    view.rerender(card(true));
    await waitFor(() => expect(onCanContinueChange).toHaveBeenLastCalledWith(true));
    if (provider === "gemini") expect(screen.getAllByRole("radio")[1]).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the radio selection aligned after removing a saved key", async () => {
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }) =>
      credentialRef.endsWith("credential_mode")
        ? "byok"
        : credentialRef.endsWith("gemini_api_key")
          ? "fixture-key"
          : null,
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
        requiresExplicitSelection
        initiallyConfigured
        initialSetupChoice="byok_pending_vault"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() =>
      expect(screen.getAllByRole("radio")[0].getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getAllByRole("radio")[1].getAttribute("aria-checked")).toBe(
      "false",
    );
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(screen.getByLabelText("Gemini API key")).toBeTruthy();
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

    await waitFor(() =>
      expect(runtimeChoice("profile-managed-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-managed-runtime"));

    await waitFor(() =>
      expect(onSelectionReadyChange).toHaveBeenCalledTimes(1),
    );
    expect(onSelectionReadyChange).toHaveBeenCalledWith("hushh_managed_vertex");
  });


  const renderSetupCard = (
    onSelectionReadyChange = vi.fn().mockResolvedValue(undefined),
  ) => {
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

  const clickManaged = async () => {
    await waitFor(() =>
      expect(runtimeChoice("profile-managed-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-managed-runtime"));
  };

  it("verifies the managed runtime BEFORE committing the choice", async () => {
    // Verify before publishing a saved choice.
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
    await clickManaged();

    await waitFor(() =>
      expect(onSelectionReadyChange).toHaveBeenCalledTimes(1),
    );
    expect(order).toEqual(["verify", "commit"]);
  });

  it("does not commit the choice when the managed runtime cannot answer", async () => {
    selectManagedGeminiRuntimeMock.mockRejectedValue(
      new Error("MANAGED_RUNTIME_NOT_READY"),
    );
    const onSelectionReadyChange = vi.fn().mockResolvedValue(undefined);

    renderSetupCard(onSelectionReadyChange);
    await clickManaged();

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(onSelectionReadyChange).not.toHaveBeenCalled();
    expect(String(toastErrorMock.mock.calls[0][0])).toContain(
      "isn\u2019t responding",
    );
  });

  it("says the agent is being built only when one actually was", async () => {
    selectManagedGeminiRuntimeMock.mockResolvedValue({
      status: "ready",
      model: "gemini-3-pro",
      location: "global",
      agentScheduled: true,
      agentReason: "ai connection verified",
    });
    renderSetupCard();
    await clickManaged();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent(
      "private agent is being built",
    );
    expect(toastSuccessMock.mock.calls[0][1]?.description).toBeUndefined();
  });

  it("does not promise an agent when none was scheduled", async () => {
    renderSetupCard();
    await clickManaged();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(String(toastSuccessMock.mock.calls[0][0])).not.toContain(
      "private agent",
    );
    expect(toastSuccessMock.mock.calls[0][1]?.description).toBeUndefined();
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

    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));

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

    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
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
    storeRuntimeSecretMock.mockResolvedValue({
      success: false,
      conflict: true,
    });

    publishValidatedAuthSessionOwner("existing-user");
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
      expect(runtimeChoice("profile-byok-runtime")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() =>
      expect(runtimeChoice("profile-managed-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-managed-runtime"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "This setting changed on another device. Refresh and try again.",
      ),
    );
    expect(runtimeChoice("profile-byok-runtime")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "test-gemini-key" } });

    expect(
      screen.queryByRole("button", { name: "Confirm and save" }),
    ).toBeNull();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));

    expect(
      await screen.findByText("Key is responding and ready to save."),
    ).toBeTruthy();
    expect(validateGeminiRuntimeCredentialMock).toHaveBeenCalledWith({
      credential: "test-gemini-key",
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    });
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));

    await waitFor(() =>
      expect(onSelectionReadyChange).toHaveBeenCalledTimes(1),
    );
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

    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    const keyInput = screen.getByLabelText("Gemini API key");
    fireEvent.change(keyInput, { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(
      await screen.findByRole("button", { name: "Confirm and save" }),
    ).toBeTruthy();

    fireEvent.change(keyInput, { target: { value: "second-key" } });

    expect(
      screen.queryByRole("button", { name: "Confirm and save" }),
    ).toBeNull();
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
  const selectionResult = {
    status: "ready",
    model: "synthetic-model",
    location: "global",
    agentScheduled: false,
    agentReason: "synthetic prior-owner outcome",
  };

  it.each(["pending", "unavailable"])("recovers %s hosting without inferring a ready connection", async (initial) => {
    if (initial === "unavailable") getPersonalAgentStatusMock.mockRejectedValueOnce(new Error("offline"));
    else getPersonalAgentStatusMock.mockResolvedValueOnce({ hostingMode: "pending" });
    getPersonalAgentStatusMock.mockResolvedValue({ hostingMode: "shared" });
    render(<GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />);
    const retry = await screen.findByRole("button", { name: "Check connection" });
    expect(runtimeChoice("profile-managed-runtime")).toBeDisabled();
    expect(selectManagedGeminiRuntimeMock).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(runtimeChoice("profile-managed-runtime")).toBeEnabled());
    expect(selectManagedGeminiRuntimeMock).not.toHaveBeenCalled();
    fireEvent.click(runtimeChoice("profile-managed-runtime"));
    await waitFor(() => expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledOnce());
  });

  it.each([false, true])(
    "discards a pending prior-owner selection, including return to A=%s",
    async (returnToA) => {
      const pending = deferred<typeof selectionResult>();
      selectManagedGeminiRuntimeMock.mockReturnValueOnce(pending.promise);
      const committed = vi.fn();
      const view = render(
        <GeminiRuntimeSettingsCard {...ownerProps("fresh-user", committed)} />,
      );
      await clickManaged();
      publishValidatedAuthSessionOwner("owner-b");
      view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
      if (returnToA) {
        publishValidatedAuthSessionOwner("fresh-user");
        view.rerender(
          <GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />,
        );
      }
      await act(async () => {
        pending.resolve(selectionResult);
      });
      expect(committed).not.toHaveBeenCalled();
      expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(screen.queryByText(/synthetic prior-owner outcome/)).toBeNull();
      expect(screen.queryByText("Selected")).toBeNull();
    },
  );

  it("does not start an old-owner vault write after the managed provider response", async () => {
    const pending = deferred<typeof selectionResult>();
    selectManagedGeminiRuntimeMock.mockReturnValueOnce(pending.promise);
    const view = render(
      <GeminiRuntimeSettingsCard
        {...ownerProps("fresh-user")}
        requiresExplicitSelection={false}
        vaultKey="synthetic-key-a"
        vaultOwnerToken="synthetic-token-a"
      />,
    );
    await clickManaged();
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await act(async () => {
      pending.resolve(selectionResult);
    });
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("does not route or toast a stale cloud-recovery failure", async () => {
    const pending = deferred<typeof selectionResult>();
    selectManagedGeminiRuntimeMock.mockReturnValueOnce(pending.promise);
    const view = render(
      <GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />,
    );
    await clickManaged();
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await act(async () => {
      pending.reject(new Error("CLOUD_GRANT_REVOKED"));
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("does not let A's finally release B's pending selection", async () => {
    const first = deferred<typeof selectionResult>();
    const second = deferred<typeof selectionResult>();
    selectManagedGeminiRuntimeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const completedB = vi.fn(), view = render(
      <GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />,
    );
    await clickManaged();
    await waitFor(() => expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledTimes(1));
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(
      <GeminiRuntimeSettingsCard {...ownerProps("owner-b", completedB)} />,
    );
    await clickManaged();
    await waitFor(() => expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      first.resolve(selectionResult);
    });
    expect(runtimeChoice("profile-managed-runtime")).toBeDisabled();
    fireEvent.click(runtimeChoice("profile-managed-runtime"));
    expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(selectionResult);
    });
    expect(completedB).toHaveBeenCalledOnce();
  });
  it("never publishes an old owner's delayed project lookup", async () => {
    const pending = deferred<{
      hostingMode: string;
      state: string;
      deploymentTarget: string;
      cloudProject: string;
    }>();
    getPersonalAgentStatusMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        hostingMode: "byoc",
        state: "active",
        deploymentTarget: "user_gcp",
        cloudProject: "synthetic-project-b",
      });
    const view = render(
      <GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />,
    );
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
    fireEvent.click(runtimeChoice("profile-managed-runtime"));
    expect(getPersonalAgentStatusMock).not.toHaveBeenCalled();
    expect(loadRuntimeSecretMock).not.toHaveBeenCalled();
    expect(selectManagedGeminiRuntimeMock).not.toHaveBeenCalled();
  });

  it("rejects the old session generation even without an intermediate React render", async () => {
    const pending = deferred<typeof selectionResult>();
    selectManagedGeminiRuntimeMock.mockReturnValueOnce(pending.promise);
    const committed = vi.fn(); render(
      <GeminiRuntimeSettingsCard {...ownerProps("fresh-user", committed)} />,
    );
    await clickManaged();
    await waitFor(() => expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledTimes(1));
    publishValidatedAuthSessionOwner("owner-b");
    publishValidatedAuthSessionOwner("fresh-user");
    await act(async () => {
      pending.resolve(selectionResult);
    });
    expect(committed).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/synthetic prior-owner outcome/)).toBeNull();
    await clickManaged();
    await waitFor(() => expect(committed).toHaveBeenCalledOnce());
  });
  it("clears a prior owner's draft and ignores delayed BYOK validation", async () => {
    const pending = deferred<{ status: string }>();
    validateGeminiRuntimeCredentialMock.mockReturnValueOnce(pending.promise);
    const view = render(
      <GeminiRuntimeSettingsCard {...ownerProps("fresh-user")} />,
    );
    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: "synthetic-owner-a-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await act(async () => {
      pending.resolve({ status: "ready" });
    });
    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    expect(screen.getByLabelText("Gemini API key")).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Confirm and save" }),
    ).toBeNull();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("stops the remaining credential removals after an account switch", async () => {
    const pending = deferred<{ success: boolean }>();
    loadRuntimeSecretMock.mockImplementation(
      ({ credentialRef }: { credentialRef: string }) =>
        Promise.resolve(
          credentialRef.includes("selected_provider") ? "gemini" : credentialRef.includes("credential_mode")
            ? "byok"
            : "synthetic-saved-value",
        ),
    );
    removeRuntimeSecretMock.mockReturnValueOnce(pending.promise);
    const view = render(
      <GeminiRuntimeSettingsCard
        {...ownerProps("fresh-user")}
        requiresExplicitSelection={false}
        vaultKey="synthetic-key-a"
        vaultOwnerToken="synthetic-token-a"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() =>
      expect(removeRuntimeSecretMock).toHaveBeenCalledTimes(1),
    ); // after the agent is asked to stop
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<GeminiRuntimeSettingsCard {...ownerProps("owner-b")} />);
    await act(async () => {
      pending.resolve({ success: true });
    });
    expect(removeRuntimeSecretMock).toHaveBeenCalledTimes(1);
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
  it("keeps readiness tied to the current saved radio choice and shows key errors inline", async () => {
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
    const managed = screen.getByRole("radio", { name: /Use Hussh AI/ });
    const own = runtimeChoice("profile-byok-runtime");
    expect(managed).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(managed).toBeEnabled());
    fireEvent.click(managed);
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    expect(managed).toHaveAttribute("aria-checked", "true");
    fireEvent.click(own);
    expect(managed).toHaveAttribute("aria-checked", "false");
    expect(own).toHaveAttribute("aria-checked", "true");
    expect(readiness).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter your Gemini API key.",
    );
    const key = screen.getByLabelText("Gemini API key");
    expect(key).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(key, { target: { value: "fixture-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm and save" }),
    );
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    fireEvent.change(key, { target: { value: "changed-key" } });
    expect(readiness).toHaveBeenLastCalledWith(false);
  });
});

it("presents Azure's connection without manufacturing a Vertex identity", async () => {
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
  expect(
    screen.getByText("Azure AI · Check connection"),
  ).toBeTruthy();
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
      init?.method === "GET" ? Response.json({ configured: false }) : accepted
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
    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: "synthetic-gemini-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and use" }));
    await waitFor(() => expect(ownerPodRequestMock.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1));
    expect(ownerPodRequestMock.mock.calls.find((call) => call[1]?.method === "PUT")?.[0]).toBe("ai-selection");
    expect(validateGeminiRuntimeCredentialMock).not.toHaveBeenCalled();
    if (accepted)
      await waitFor(() => expect(storeRuntimeSecretMock).toHaveBeenCalled());
    else {
      await screen.findByText(
        "Gemini did not accept this key. Check it and try again.",
      );
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
      providers: ["gemini", "azure_openai"],
      defaultVerification: true,
    },
  });
  loadRuntimeSecretMock.mockResolvedValue(null);
  let finishMetadata!: (response: Response) => void;
  const metadata = new Promise<Response>((resolve) => { finishMetadata = resolve; });
  ownerPodRequestMock.mockImplementation(async (_path, init) =>
    init?.method === "GET" ? metadata : Response.json({
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
  await waitFor(() =>
    expect(runtimeChoice("profile-managed-runtime")).toBeEnabled(),
  );
  fireEvent.click(runtimeChoice("profile-managed-runtime"));
  await screen.findByRole("button", { name: "Change AI" });
  finishMetadata(Response.json({ configured: false, effectiveConnection: {
    provider: "azure_openai", model: "stale-deployment", source: "cloud_default",
    state: "configured", verification: "unverified",
  } }));
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
    validateGeminiRuntimeCredentialMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
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
    storeRuntimeSecretMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const props = { needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() };
    const view = render(<GeminiRuntimeSettingsCard {...props} userId="owner-a" vaultKey="fixture-key-a" vaultOwnerToken="fixture-token-a" />);
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId("profile-byok-runtime").querySelector("button")!);
    fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "synthetic-owner-a-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and save" }));
    expect(storeRuntimeSecretMock).toHaveBeenCalledTimes(1);
    view.rerender(<GeminiRuntimeSettingsCard {...props} userId="owner-b" vaultKey="fixture-key-b" vaultOwnerToken="fixture-token-b" />);
    await act(async () => { finish({ success: true }); });
    expect(storeRuntimeSecretMock).toHaveBeenCalledTimes(1);
    expect(removeRuntimeSecretMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("keeps a delayed saved configuration from changing the tuple that was just validated", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    const props = { userId: "owner-a", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token", needsVaultCreation: false,
      needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() };
    const hook = renderHook(() => useGeminiRuntimeSettingsModel(props));
    await act(async () => undefined);
    await act(async () => { await hook.result.current.selectByok(); });
    act(() => hook.result.current.setDraftKey("synthetic-current-key"));
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    loadRuntimeSecretMock.mockImplementation(async ({ credentialRef }) => { await pending;
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
    const props = { userId: "owner-a", vaultKey: "fixture-key", needsVaultCreation: false, needsUnlock: false,
      onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() };
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
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled(); expect(validateGeminiRuntimeCredentialMock).not.toHaveBeenCalled();
  });

  it("cancels a nonmutating key check without allowing its late result to restore readiness", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let finish!: () => void;
    validateGeminiRuntimeCredentialMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const hook = renderHook(() => useGeminiRuntimeSettingsModel({ userId: "owner-a", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
      needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() }));
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
  const hook = renderHook(() => useGeminiRuntimeSettingsModel({ userId: "fresh-user", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
    needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() }));
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
