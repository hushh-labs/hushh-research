import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiRuntimeSettingsCard, useGeminiRuntimeSettingsModel, type GeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { useNativeRuntimeSettings } from "@/components/profile/use-native-runtime-settings";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useAiPlacement } from "@/lib/connections/use-ai-placement";

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

describe("Gemini runtime admission", () => {

  it.each([
    { needsVaultCreation: false, needsUnlock: true, action: "unlock" },
    { needsVaultCreation: true, needsUnlock: false, action: "create" },
    { needsVaultCreation: false, needsUnlock: false, action: "reconnect" },
  ])("does not change managed AI before the settings visit can $action the vault", async ({ needsVaultCreation, needsUnlock, action }) => {
    const unlock = vi.fn();
    const create = vi.fn();
    const hook = renderHook(() => useGeminiRuntimeSettingsModel({
      userId: "fresh-user", vaultKey: null, vaultOwnerToken: null,
      needsVaultCreation, needsUnlock, onRequestVaultUnlock: unlock, onRequestVaultCreation: create,
    }));
    await waitFor(() => expect(hook.result.current.placement).toBe("shared"));
    let selected: boolean | undefined;
    await act(async () => { selected = await hook.result.current.selectManaged(); });
    expect(selected).toBe(false);
    expect(selectManagedGeminiRuntimeMock).not.toHaveBeenCalled();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
    if (action === "reconnect") {
      expect(unlock).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledWith("Your vault is reconnecting. Try again.");
    } else {
      expect(action === "unlock" ? unlock : create).toHaveBeenCalledOnce();
    }
  });

  it("does not show a native AI selection until saved settings are known", () => {
    const model = {
      current: () => true, isSaving: false, isRemoving: false,
      credentialValidation: { status: "idle" }, mode: "hushh_managed_vertex",
    } as unknown as GeminiRuntimeSettingsModel;
    const hook = renderHook(({ hasSavedKey, loadFailed }) => useNativeRuntimeSettings(
      { ...model, hasSavedKey, loadFailed }, "synthetic-owner", true,
    ), { initialProps: { hasSavedKey: null as boolean | null, loadFailed: false } });
    const managed = () => hook.result.current.page.sections[0].rows.find(row => row.id === "runtime-managed");
    expect(managed()?.selected).toBe(false);
    hook.rerender({ hasSavedKey: false, loadFailed: false });
    expect(managed()?.selected).toBe(true);
    hook.rerender({ hasSavedKey: false, loadFailed: true });
    expect(managed()?.selected).toBe(false);
  });

  it("does not present or save managed AI while existing settings are unread", async () => {
    loadRuntimeSecretMock.mockReturnValue(new Promise(() => {}));
    render(<GeminiRuntimeSettingsCard userId="fresh-user" vaultKey="fixture-key" vaultOwnerToken="fixture-token"
      needsVaultCreation={false} needsUnlock={false} onRequestVaultUnlock={vi.fn()} onRequestVaultCreation={vi.fn()} />);
    await waitFor(() => expect(getPersonalAgentStatusMock).toHaveBeenCalled());
    const managed = runtimeChoice("profile-managed-runtime");
    expect(managed).toBeDisabled();
    expect(managed).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Selected")).toBeNull();
    expect(selectManagedGeminiRuntimeMock).not.toHaveBeenCalled();
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("keeps BYOK from invalidating an unfinished settings read", async () => {
    let finish!: (value: null) => void;
    loadRuntimeSecretMock.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => useGeminiRuntimeSettingsModel({
      userId: "fresh-user", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
      needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.placement).toBe("shared"));
    await act(async () => { await hook.result.current.selectByok(); });
    expect(hook.result.current.mode).toBe("hushh_managed_vertex");
    await act(async () => { finish(null); });
    await waitFor(() => expect(hook.result.current.hasSavedKey).toBe(false));
    await act(async () => { await hook.result.current.selectByok(); });
    expect(hook.result.current.mode).toBe("byok");
  });

  it("withdraws a managed selection guard when the Vault token expires without a render", async () => {
    let liveToken: string | null = "fixture-token";
    let finish!: (value: { status: string; model: string; location: string; agentScheduled: boolean; agentReason: string }) => void;
    selectManagedGeminiRuntimeMock.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => useGeminiRuntimeSettingsModel({
      userId: "fresh-user", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
      getCurrentVaultOwnerToken: () => liveToken,
      needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.hasSavedKey).toBe(false));
    let pending!: Promise<boolean>;
    act(() => { pending = hook.result.current.selectManaged(); });
    await waitFor(() => expect(selectManagedGeminiRuntimeMock).toHaveBeenCalledOnce());
    liveToken = null;
    const isCurrent = selectManagedGeminiRuntimeMock.mock.calls[0][0] as () => boolean;
    expect(isCurrent()).toBe(false);
    await act(async () => {
      finish({ status: "ready", model: "fixture", location: "global", agentScheduled: false, agentReason: "" });
      expect(await pending).toBe(false);
    });
    expect(storeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("does not clear the agent during key removal after the Vault token expires", async () => {
    let liveToken: string | null = "fixture-token";
    const hook = renderHook(() => useGeminiRuntimeSettingsModel({
      userId: "fresh-user", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
      getCurrentVaultOwnerToken: () => liveToken,
      needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.placement).toBe("shared"));
    let finish!: (value: unknown) => void;
    getPersonalAgentStatusMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<boolean>;
    act(() => { pending = hook.result.current.removeByok(); });
    await waitFor(() => expect(getPersonalAgentStatusMock).toHaveBeenCalledTimes(2));
    liveToken = null;
    await act(async () => {
      finish({ hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp", aiSelection: { version: 1, providers: ["gemini"] } });
      expect(await pending).toBe(false);
    });
    expect(ownerPodRequestMock).not.toHaveBeenCalled();
    expect(removeRuntimeSecretMock).not.toHaveBeenCalled();
  });

  it("keeps native AI selection unresolved while a failed read is retried", async () => {
    loadRuntimeSecretMock.mockRejectedValue(new Error("Synthetic read failure"));
    const hook = renderHook(() => {
      const model = useGeminiRuntimeSettingsModel({ userId: "fresh-user", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
        needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() });
      return { model, native: useNativeRuntimeSettings(model, "fresh-user", true) };
    });
    await waitFor(() => expect(hook.result.current.model.loadFailed).toBe(true));
    expect(hook.result.current.model.hasSavedKey).toBeNull();
    const failedRows = hook.result.current.native.page.sections[0].rows.map(row => row.id);
    expect(failedRows).toContain("runtime-outcome");
    expect(failedRows).toContain("runtime-retry");
    expect(failedRows).not.toContain("runtime-loading");
    let finish!: (value: null) => void;
    loadRuntimeSecretMock.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    act(() => { void hook.result.current.model.refresh(); });
    expect(hook.result.current.model.loadFailed).toBe(false);
    const managed = hook.result.current.native.page.sections[0].rows.find(row => row.id === "runtime-managed");
    expect(managed?.selected).toBe(false);
    expect(managed?.enabled).toBe(false);
    await act(async () => { finish(null); });
    await waitFor(() => expect(hook.result.current.model.hasSavedKey).toBe(false));
  });

  it.each([
    { status: { hostingMode: "shared" }, placement: "shared" },
    { status: { hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp", cloudProject: "old-project" }, placement: "gcp" },
  ])("never renders a previous $placement hosting observation for a replacement owner", async ({ status, placement }) => {
    let resolveReplacement!: (value: unknown) => void;
    getPersonalAgentStatusMock
      .mockResolvedValueOnce(status)
      .mockReturnValueOnce(new Promise(resolve => { resolveReplacement = resolve; }));
    const firstGuard = () => () => true;
    const replacementGuard = () => () => true;
    const reset = vi.fn();
    const renders: Array<{ placement: string; project: string | null }> = [];
    const { result, rerender } = renderHook(({ guard }) => {
      const state = useAiPlacement(guard, reset);
      renders.push({ placement: state.placement, project: state.ownCloudProject });
      return state;
    }, { initialProps: { guard: firstGuard } });

    await waitFor(() => expect(result.current.placement).toBe(placement));
    const replacementRender = renders.length;
    rerender({ guard: replacementGuard });
    expect(renders[replacementRender]).toEqual({ placement: "loading", project: null });

    await act(async () => {
      resolveReplacement({ hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp", cloudProject: "synthetic-project" });
    });
    await waitFor(() => expect(result.current.placement).toBe("gcp"));
  });

  it("fences the real settings visit and ignores an old owner's late placement read", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    getPersonalAgentStatusMock
      .mockResolvedValueOnce({ hostingMode: "shared" })
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
    const renders: string[] = [];
    const hook = renderHook(({ userId }) => {
      const model = useGeminiRuntimeSettingsModel({ userId, vaultKey: "fixture-key", vaultOwnerToken: "fixture-token",
        needsVaultCreation: false, needsUnlock: false, onRequestVaultUnlock: vi.fn(), onRequestVaultCreation: vi.fn() });
      renders.push(model.placement);
      return model;
    }, { initialProps: { userId: "owner-a" } });

    await waitFor(() => expect(hook.result.current.placement).toBe("shared"));
    const refreshRender = renders.length;
    act(() => hook.result.current.refreshPlacement());
    expect(renders[refreshRender]).toBe("loading");
    await waitFor(() => expect(getPersonalAgentStatusMock).toHaveBeenCalledTimes(2));
    publishValidatedAuthSessionOwner("owner-b");
    const replacementRender = renders.length;
    hook.rerender({ userId: "owner-b" });
    expect(renders[replacementRender]).toBe("loading");
    await waitFor(() => expect(getPersonalAgentStatusMock).toHaveBeenCalledTimes(3));
    await act(async () => { finishNew({ hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp" }); });
    await waitFor(() => expect(hook.result.current.placement).toBe("gcp"));
    await act(async () => { finishOld({ hostingMode: "shared" }); });
    expect(hook.result.current.placement).toBe("gcp");
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

});
