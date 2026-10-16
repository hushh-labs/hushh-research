import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
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
    // Mounted-effect poll for a previously-recorded BYOC project; a neutral
    // (non-"recorded") status keeps the card in its default managed-first state.
    getPersonalAgentStatus: (...args: unknown[]) =>
      getPersonalAgentStatusMock(...args),
    ownerPodRequest: (...args: unknown[]) => ownerPodRequestMock(...args),
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
    removeRuntimeSecret: (...args: unknown[]) =>
      removeRuntimeSecretMock(...args),
  },
}));

function runtimeChoice(id: string) {
  const row = screen.getByTestId(id);
  return row.matches("button") ? row : row.querySelector("button")!;
}

describe("GeminiRuntimeSettingsCard setup choice", () => {
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

  it("on the first-run step keeps Gemini selectable and defers the coming-soon models", async () => {
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

    expect(screen.getByText("Use Hussh's Gemini")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AI connection" })).toBeTruthy();
    // Restraint Charter: the mandatory first-run step lets the person choose only
    // Gemini, so the future-providers list is deferred to the settings context
    // rather than competing with the one decision here.
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

  // -- the managed path finally reaches the server -------------------------------
  //
  // Choosing managed used to be entirely client-side: the mode went into the user's
  // own PKM vault and no server route was called at all. Managed is the DEFAULT, so
  // for most people the server never learned an AI connection existed -- and
  // provisioning a private agent hangs off exactly that event.

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

  it("tells the server about the managed choice", async () => {
    renderSetupCard();
    await clickManaged();
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
    await screen.findByText(/Use your agent’s Vertex AI/);
    await act(async () => {
      pending.resolve({
        hostingMode: "byoc",
        state: "active",
        deploymentTarget: "user_gcp",
        cloudProject: "synthetic-project-a",
      });
    });
    expect(screen.queryByText(/synthetic-project-a/)).toBeNull();
    expect(screen.getByText(/Use your agent’s Vertex AI/)).toBeTruthy();
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
          credentialRef.includes("credential_mode")
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
    const managed = screen.getByRole("radio", { name: /Use Hussh's Gemini/ });
    const own = screen.getByRole("radio", { name: /Use your own Gemini key/ });
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
  await screen.findByText("Use your Azure AI");
  expect(screen.queryByText(/Use your agent’s Vertex AI/)).toBeNull();
  expect(
    screen.getByText(/Check AI connection.*your Azure deployment/),
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
    ownerPodRequestMock.mockResolvedValue(
      accepted
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
    await screen.findByText("Use your Azure AI");
    await waitFor(() =>
      expect(runtimeChoice("profile-byok-runtime")).toBeEnabled(),
    );
    fireEvent.click(runtimeChoice("profile-byok-runtime"));
    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: "synthetic-gemini-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and use" }));
    await waitFor(() => expect(ownerPodRequestMock).toHaveBeenCalledOnce());
    expect(ownerPodRequestMock.mock.calls[0][0]).toBe("ai-selection");
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
  ownerPodRequestMock.mockResolvedValue(
    Response.json({
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
      onSelectionReadyChange={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  await waitFor(() =>
    expect(runtimeChoice("profile-managed-runtime")).toBeEnabled(),
  );
  fireEvent.click(runtimeChoice("profile-managed-runtime"));
  await screen.findByRole("button", { name: "Change AI" });
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
  expect(ownerPodRequestMock).toHaveBeenCalledOnce();
  expect(ownerPodRequestMock.mock.calls[0][1].method).toBe("PATCH");
});
