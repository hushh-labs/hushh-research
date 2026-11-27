/**
 * The person's "Bring your own AI" choice, recorded in their encrypted Vault
 * (PKM `runtime_secrets.llm`), beside the Gemini key the Gemini card keeps.
 *
 * Every write names a catalogued writer (`contracts/pkm/reserved-branches.v1.json`,
 * feature `runtime_credentials`). Only the paths named here are touched; a
 * value saved by a newer app for a provider this build does not know is kept
 * as it is, because each write is a load-modify-commit of the whole domain.
 */
import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  GEMINI_RUNTIME_TRANSPORT_REF,
  GEMINI_VERTEX_LOCATION_REF,
  GEMINI_VERTEX_PROJECT_REF,
  OPENAI_RUNTIME_CREDENTIAL_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
  type GeminiRuntimeTransport,
  type RuntimeCredentialMode,
} from "@/lib/services/personal-knowledge-model-service";

export const AI_SELECTED_PROVIDER_REF =
  "pkm:runtime_secrets.llm.selected_provider";
export const AI_SELECTED_MODEL_REF = "pkm:runtime_secrets.llm.selected_model";
export const AI_BYOK_CONFIGS_REF = "pkm:runtime_secrets.llm.byok_configurations";
export const AI_ACTIVE_CONFIG_ID_REF = "pkm:runtime_secrets.llm.active_configuration_id";

export type SupportedByokProvider = "gemini" | "openai";

export type SavedAiConfiguration = {
  id: string;
  provider: SupportedByokProvider;
  label: string;
  apiKey: string;
  model: string | null;
  transport: GeminiRuntimeTransport | null;
  vertexProject: string | null;
  vertexLocation: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type LoadedAiConfigurations = {
  configurations: SavedAiConfiguration[];
  activeConfigId: string | null;
  mode: RuntimeCredentialMode;
  selectedProvider: string | null;
};

const MAX_SAVED_AI_CONFIGS = 10;

export function defaultAiConfigurationLabel(
  provider: SupportedByokProvider,
  transport?: GeminiRuntimeTransport | null,
): string {
  if (provider === "openai") return "OpenAI";
  return transport === "vertex_api_key" ? "Gemini (Vertex)" : "Gemini";
}

function normalizeSavedConfiguration(raw: unknown): SavedAiConfiguration | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const provider = item.provider;
  if (provider !== "gemini" && provider !== "openai") return null;
  const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
  const apiKey = typeof item.apiKey === "string" && item.apiKey.trim() ? item.apiKey.trim() : "";
  if (!id || !apiKey) return null;
  const transport: GeminiRuntimeTransport | null =
    provider === "gemini"
      ? item.transport === "vertex_api_key"
        ? "vertex_api_key"
        : "developer_api"
      : null;
  const label =
    typeof item.label === "string" && item.label.trim()
      ? item.label.trim().slice(0, 64)
      : defaultAiConfigurationLabel(provider, transport);
  const model =
    typeof item.model === "string" && item.model.trim()
      ? item.model.trim().slice(0, 128)
      : null;
  const vertexProject =
    provider === "gemini" && transport === "vertex_api_key" && typeof item.vertexProject === "string" && item.vertexProject.trim()
      ? item.vertexProject.trim().slice(0, 64)
      : null;
  const vertexLocation =
    provider === "gemini" && transport === "vertex_api_key" && typeof item.vertexLocation === "string" && item.vertexLocation.trim()
      ? item.vertexLocation.trim().slice(0, 64)
      : null;
  const createdAtMs = typeof item.createdAtMs === "number" && Number.isFinite(item.createdAtMs) ? item.createdAtMs : 0;
  const updatedAtMs = typeof item.updatedAtMs === "number" && Number.isFinite(item.updatedAtMs) ? item.updatedAtMs : createdAtMs;
  return {
    id,
    provider,
    label,
    apiKey,
    model,
    transport,
    vertexProject,
    vertexLocation,
    createdAtMs,
    updatedAtMs,
  };
}

export function parseSavedAiConfigurations(raw: string | null | undefined): SavedAiConfiguration[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: SavedAiConfiguration[] = [];
    for (const item of parsed) {
      const normalized = normalizeSavedConfiguration(item);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      result.push(normalized);
      if (result.length >= MAX_SAVED_AI_CONFIGS) break;
    }
    return result;
  } catch {
    return [];
  }
}

export type AiSelectionVault = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
};

function assertStored(result: { success: boolean; conflict?: boolean }): void {
  if (!result.success)
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
}

async function readRef(
  vault: AiSelectionVault,
  credentialRef: string,
): Promise<string | null> {
  try {
    return await PersonalKnowledgeModelService.loadRuntimeSecret({
      ...vault,
      credentialRef,
    });
  } catch {
    return null;
  }
}

/** The recorded provider id (including one a newer app wrote), or null. */
export async function loadSelectedAiProvider(
  vault: AiSelectionVault,
  options: { requireReadable?: boolean } = {},
): Promise<string | null> {
  const value = options.requireReadable
    ? await PersonalKnowledgeModelService.loadRuntimeSecret({ ...vault, credentialRef: AI_SELECTED_PROVIDER_REF })
    : await readRef(vault, AI_SELECTED_PROVIDER_REF);
  if (value === null) return null;
  if (value && /^[a-z0-9_]{1,64}$/.test(value)) return value;
  if (options.requireReadable) throw new Error("AI_SELECTION_INVALID");
  return null;
}

export async function hasSavedOpenAiKey(
  vault: AiSelectionVault,
): Promise<boolean> {
  return Boolean(await readRef(vault, OPENAI_RUNTIME_CREDENTIAL_REF));
}

/** Record the selection the agent just accepted. Credential mode flips last. */
export async function recordOpenAiSelection(
  vault: AiSelectionVault & { apiKey: string; model: string | null },
): Promise<void> {
  const { apiKey, model, ...access } = vault;
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...access,
      credentialRef: OPENAI_RUNTIME_CREDENTIAL_REF,
      secret: apiKey,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_openai_api_key",
      },
    }),
  );
  await recordSelectedAiProvider(access, "openai", model);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...access,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: "byok",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection",
      },
    }),
  );
}

/** `model` null means the agent's default model; the stored value is cleared. */
export async function recordSelectedAiProvider(
  vault: AiSelectionVault,
  provider: "openai" | "gemini" | "azure_openai",
  model: string | null = null,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const access = {
    userId: vault.userId,
    vaultKey: vault.vaultKey,
    vaultOwnerToken: vault.vaultOwnerToken,
  };
  if (!isCurrent()) throw new Error("OWNER_CHANGED");
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...access,
      credentialRef: AI_SELECTED_PROVIDER_REF,
      secret: provider,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection",
      },
    }),
  );
  if (!isCurrent()) throw new Error("OWNER_CHANGED");
  assertStored(
    model
      ? await PersonalKnowledgeModelService.storeRuntimeSecret({
          ...access,
          credentialRef: AI_SELECTED_MODEL_REF,
          secret: model,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_ai_selection",
          },
        })
      : await PersonalKnowledgeModelService.removeRuntimeSecret({
          ...access,
          credentialRef: AI_SELECTED_MODEL_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_ai_selection_clear",
          },
        }),
  );
}

/**
 * Remove the saved OpenAI key. When OpenAI was the selection, the choice and
 * model are cleared and the credential mode returns to Hussh's AI, matching
 * what the agent does once its selection is deleted.
 */
export async function removeOpenAiSelection(
  vault: AiSelectionVault,
): Promise<void> {
  const access = {
    userId: vault.userId,
    vaultKey: vault.vaultKey,
    vaultOwnerToken: vault.vaultOwnerToken,
  };
  const selected = await loadSelectedAiProvider(access);
  assertStored(
    await PersonalKnowledgeModelService.removeRuntimeSecret({
      ...access,
      credentialRef: OPENAI_RUNTIME_CREDENTIAL_REF,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_openai_api_key_remove",
      },
    }),
  );
  if (selected !== "openai") return;
  for (const credentialRef of [
    AI_SELECTED_PROVIDER_REF,
    AI_SELECTED_MODEL_REF,
  ]) {
    assertStored(
      await PersonalKnowledgeModelService.removeRuntimeSecret({
        ...access,
        credentialRef,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_ai_selection_clear",
        },
      }),
    );
  }
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...access,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: "hushh_managed_vertex",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection",
      },
    }),
  );
}

const AZURE_CONFIGURATION_REF =
  "pkm:runtime_secrets.llm.azure_openai_configuration";

/** One encrypted value keeps endpoint, deployment and key from separate revisions. */
export async function recordAzureSelection(
  vault: AiSelectionVault & { apiKey: string; endpoint: string; model: string },
): Promise<void> {
  const { apiKey, endpoint, model, ...access } = vault;
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...access,
      credentialRef: AZURE_CONFIGURATION_REF,
      secret: JSON.stringify({ apiKey, endpoint, model }),
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection",
      },
    }),
  );
  await recordSelectedAiProvider(access, "azure_openai", model);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...access,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: "byok",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection",
      },
    }),
  );
}

export async function hasSavedAzureKey(
  vault: AiSelectionVault,
): Promise<boolean> {
  return Boolean(await readRef(vault, AZURE_CONFIGURATION_REF));
}

export async function removeAzureSelection(
  vault: AiSelectionVault,
): Promise<void> {
  assertStored(
    await PersonalKnowledgeModelService.removeRuntimeSecret({
      ...vault,
      credentialRef: AZURE_CONFIGURATION_REF,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection_clear",
      },
    }),
  );
  if ((await loadSelectedAiProvider(vault)) !== "azure_openai") return;
  for (const credentialRef of [
    AI_SELECTED_PROVIDER_REF,
    AI_SELECTED_MODEL_REF,
  ]) {
    assertStored(
      await PersonalKnowledgeModelService.removeRuntimeSecret({
        ...vault,
        credentialRef,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_ai_selection_clear",
        },
      }),
    );
  }
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...vault,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: "hushh_managed_vertex",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_ai_selection",
      },
    }),
  );
}

async function readRefRequired(
  vault: AiSelectionVault,
  credentialRef: string,
): Promise<string | null> {
  return await PersonalKnowledgeModelService.loadRuntimeSecret({
    ...vault,
    credentialRef,
  });
}

function assertOwnerCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new Error("OWNER_CHANGED");
  }
}

async function mirrorLegacyProviderRefs(
  vault: AiSelectionVault,
  config: SavedAiConfiguration,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const confirmation = {
    confirmedByUser: true as const,
    surface: "web" as const,
    source: "profile_ai_selection",
  };
  if (config.provider === "gemini") {
    const transport: GeminiRuntimeTransport = config.transport === "vertex_api_key" ? "vertex_api_key" : "developer_api";
    assertOwnerCurrent(isCurrent);
    assertStored(
      await PersonalKnowledgeModelService.storeRuntimeSecret({
        ...vault,
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
        secret: config.apiKey,
        confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_api_key" },
      }),
    );
    assertOwnerCurrent(isCurrent);
    assertStored(
      await PersonalKnowledgeModelService.storeRuntimeSecret({
        ...vault,
        credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
        secret: transport,
        confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_transport" },
      }),
    );
    if (transport === "vertex_api_key" && config.vertexProject && config.vertexLocation) {
      assertOwnerCurrent(isCurrent);
      assertStored(
        await PersonalKnowledgeModelService.storeRuntimeSecret({
          ...vault,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          secret: config.vertexProject,
          confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_project" },
        }),
      );
      assertOwnerCurrent(isCurrent);
      assertStored(
        await PersonalKnowledgeModelService.storeRuntimeSecret({
          ...vault,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
          secret: config.vertexLocation,
          confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_location" },
        }),
      );
    } else {
      assertOwnerCurrent(isCurrent);
      assertStored(
        await PersonalKnowledgeModelService.removeRuntimeSecret({
          ...vault,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_project_clear" },
        }),
      );
      assertOwnerCurrent(isCurrent);
      assertStored(
        await PersonalKnowledgeModelService.removeRuntimeSecret({
          ...vault,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
          confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_location_clear" },
        }),
      );
    }
    return;
  }
  assertOwnerCurrent(isCurrent);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...vault,
      credentialRef: OPENAI_RUNTIME_CREDENTIAL_REF,
      secret: config.apiKey,
      confirmation: { ...confirmation, source: "profile_openai_api_key" },
    }),
  );
}

async function clearLegacyProviderRefs(
  vault: AiSelectionVault,
  provider: SupportedByokProvider,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (provider === "gemini") {
    const refs: Array<[string, string]> = [
      [GEMINI_RUNTIME_CREDENTIAL_REF, "profile_gemini_api_key_remove"],
      [GEMINI_RUNTIME_TRANSPORT_REF, "profile_gemini_transport_remove"],
      [GEMINI_VERTEX_PROJECT_REF, "profile_gemini_vertex_project_remove"],
      [GEMINI_VERTEX_LOCATION_REF, "profile_gemini_vertex_location_remove"],
    ];
    for (const [credentialRef, source] of refs) {
      assertOwnerCurrent(isCurrent);
      assertStored(
        await PersonalKnowledgeModelService.removeRuntimeSecret({
          ...vault,
          credentialRef,
          confirmation: { confirmedByUser: true, surface: "web", source },
        }),
      );
    }
    return;
  }
  assertOwnerCurrent(isCurrent);
  assertStored(
    await PersonalKnowledgeModelService.removeRuntimeSecret({
      ...vault,
      credentialRef: OPENAI_RUNTIME_CREDENTIAL_REF,
      confirmation: { confirmedByUser: true, surface: "web", source: "profile_openai_api_key_remove" },
    }),
  );
}

export async function loadSavedAiConfigurations(
  vault: AiSelectionVault,
): Promise<LoadedAiConfigurations> {
  const [
    rawConfigs,
    storedActiveId,
    savedMode,
    savedProvider,
    savedModel,
    geminiKey,
    geminiTransport,
    geminiProject,
    geminiLocation,
    openaiKey,
  ] = await Promise.all([
    readRefRequired(vault, AI_BYOK_CONFIGS_REF),
    readRefRequired(vault, AI_ACTIVE_CONFIG_ID_REF),
    readRefRequired(vault, RUNTIME_CREDENTIAL_MODE_REF),
    loadSelectedAiProvider(vault, { requireReadable: true }),
    readRefRequired(vault, AI_SELECTED_MODEL_REF),
    readRefRequired(vault, GEMINI_RUNTIME_CREDENTIAL_REF),
    readRefRequired(vault, GEMINI_RUNTIME_TRANSPORT_REF),
    readRefRequired(vault, GEMINI_VERTEX_PROJECT_REF),
    readRefRequired(vault, GEMINI_VERTEX_LOCATION_REF),
    readRefRequired(vault, OPENAI_RUNTIME_CREDENTIAL_REF),
  ]);

  const configurations = parseSavedAiConfigurations(rawConfigs);
  if (configurations.length === 0) {
    if (geminiKey && geminiKey.trim()) {
      const transport: GeminiRuntimeTransport =
        geminiTransport === "vertex_api_key" ? "vertex_api_key" : "developer_api";
      configurations.push({
        id: "legacy-gemini",
        provider: "gemini",
        label: defaultAiConfigurationLabel("gemini", transport),
        apiKey: geminiKey.trim(),
        model: null,
        transport,
        vertexProject: transport === "vertex_api_key" ? geminiProject?.trim() || null : null,
        vertexLocation: transport === "vertex_api_key" ? geminiLocation?.trim() || null : null,
        createdAtMs: 0,
        updatedAtMs: 0,
      });
    }
    if (openaiKey && openaiKey.trim()) {
      configurations.push({
        id: "legacy-openai",
        provider: "openai",
        label: "OpenAI",
        apiKey: openaiKey.trim(),
        model: savedProvider === "openai" ? savedModel?.trim() || null : null,
        transport: null,
        vertexProject: null,
        vertexLocation: null,
        createdAtMs: 0,
        updatedAtMs: 0,
      });
    }
  }

  // Legacy azure_openai falls back cleanly to built-in sandbox AI without crashing.
  if (savedProvider === "azure_openai") {
    return {
      configurations,
      activeConfigId: null,
      mode: "hushh_managed_vertex",
      selectedProvider: null,
    };
  }

  const mode: RuntimeCredentialMode =
    savedMode === "byok" ? "byok" : "hushh_managed_vertex";
  let activeConfigId: string | null = null;
  if (mode === "byok") {
    if (storedActiveId && configurations.some((entry) => entry.id === storedActiveId)) {
      activeConfigId = storedActiveId;
    } else if (savedProvider === "gemini" || savedProvider === "openai") {
      activeConfigId = configurations.find((entry) => entry.provider === savedProvider)?.id ?? null;
    } else if (!savedProvider) {
      activeConfigId = configurations.find((entry) => entry.provider === "gemini")?.id ?? null;
    }
  }

  return {
    configurations,
    activeConfigId,
    mode,
    selectedProvider: savedProvider,
  };
}

async function activateConfigInVault(
  vault: AiSelectionVault,
  config: SavedAiConfiguration,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await mirrorLegacyProviderRefs(vault, config, isCurrent);
  assertOwnerCurrent(isCurrent);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...vault,
      credentialRef: AI_ACTIVE_CONFIG_ID_REF,
      secret: config.id,
      confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection" },
    }),
  );
  assertOwnerCurrent(isCurrent);
  await recordSelectedAiProvider(vault, config.provider, config.model, isCurrent);
  assertOwnerCurrent(isCurrent);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...vault,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: "byok",
      confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection" },
    }),
  );
}

export async function saveAiConfiguration(
  vault: AiSelectionVault,
  input: {
    id?: string;
    provider: SupportedByokProvider;
    label?: string | null;
    apiKey: string;
    model?: string | null;
    transport?: GeminiRuntimeTransport | null;
    vertexProject?: string | null;
    vertexLocation?: string | null;
  },
  options: { activate?: boolean; isCurrent?: () => boolean } = {},
): Promise<{ configurations: SavedAiConfiguration[]; saved: SavedAiConfiguration }> {
  const isCurrent = options.isCurrent ?? (() => true);
  assertOwnerCurrent(isCurrent);
  const existing = (await loadSavedAiConfigurations(vault)).configurations;
  assertOwnerCurrent(isCurrent);
  const now = Date.now();
  const id = input.id?.trim() || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `cfg_${now}`);
  const prior = existing.find((entry) => entry.id === id);
  const transport: GeminiRuntimeTransport | null =
    input.provider === "gemini"
      ? input.transport === "vertex_api_key"
        ? "vertex_api_key"
        : "developer_api"
      : null;
  const saved: SavedAiConfiguration = {
    id,
    provider: input.provider,
    label: (input.label ?? "").trim().slice(0, 64) || defaultAiConfigurationLabel(input.provider, transport),
    apiKey: input.apiKey.trim(),
    model: input.model?.trim() || null,
    transport,
    vertexProject: transport === "vertex_api_key" ? input.vertexProject?.trim() || null : null,
    vertexLocation: transport === "vertex_api_key" ? input.vertexLocation?.trim() || null : null,
    createdAtMs: prior?.createdAtMs ?? now,
    updatedAtMs: now,
  };
  const next = [...existing.filter((entry) => entry.id !== id), saved].slice(-MAX_SAVED_AI_CONFIGS);
  assertOwnerCurrent(isCurrent);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...vault,
      credentialRef: AI_BYOK_CONFIGS_REF,
      secret: JSON.stringify(next),
      confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection" },
    }),
  );
  assertOwnerCurrent(isCurrent);
  if (options.activate !== false) {
    await activateConfigInVault(vault, saved, isCurrent);
  }
  return { configurations: next, saved };
}

export async function activateSavedAiConfiguration(
  vault: AiSelectionVault,
  configId: string,
  isCurrent: () => boolean = () => true,
): Promise<SavedAiConfiguration> {
  assertOwnerCurrent(isCurrent);
  const loaded = await loadSavedAiConfigurations(vault);
  assertOwnerCurrent(isCurrent);
  const target = loaded.configurations.find((entry) => entry.id === configId);
  if (!target) {
    throw new Error("AI_CONFIGURATION_NOT_FOUND");
  }
  await activateConfigInVault(vault, target, isCurrent);
  return target;
}

export async function deactivateCustomAiSelection(
  vault: AiSelectionVault,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  for (const credentialRef of [
    AI_ACTIVE_CONFIG_ID_REF,
    AI_SELECTED_PROVIDER_REF,
    AI_SELECTED_MODEL_REF,
  ]) {
    assertOwnerCurrent(isCurrent);
    assertStored(
      await PersonalKnowledgeModelService.removeRuntimeSecret({
        ...vault,
        credentialRef,
        confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection_clear" },
      }),
    );
  }
  assertOwnerCurrent(isCurrent);
  assertStored(
    await PersonalKnowledgeModelService.storeRuntimeSecret({
      ...vault,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: "hushh_managed_vertex",
      confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection" },
    }),
  );
}

export async function deleteSavedAiConfiguration(
  vault: AiSelectionVault,
  configId: string,
  isCurrent: () => boolean = () => true,
): Promise<{ configurations: SavedAiConfiguration[]; wasActive: boolean }> {
  assertOwnerCurrent(isCurrent);
  const loaded = await loadSavedAiConfigurations(vault);
  assertOwnerCurrent(isCurrent);
  const removed = loaded.configurations.find((entry) => entry.id === configId) ?? null;
  const next = loaded.configurations.filter((entry) => entry.id !== configId);
  const wasActive = loaded.activeConfigId === configId;

  assertOwnerCurrent(isCurrent);
  if (next.length > 0) {
    assertStored(
      await PersonalKnowledgeModelService.storeRuntimeSecret({
        ...vault,
        credentialRef: AI_BYOK_CONFIGS_REF,
        secret: JSON.stringify(next),
        confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection_clear" },
      }),
    );
  } else {
    assertStored(
      await PersonalKnowledgeModelService.removeRuntimeSecret({
        ...vault,
        credentialRef: AI_BYOK_CONFIGS_REF,
        confirmation: { confirmedByUser: true, surface: "web", source: "profile_ai_selection_clear" },
      }),
    );
  }
  assertOwnerCurrent(isCurrent);

  if (wasActive) {
    await deactivateCustomAiSelection(vault, isCurrent);
  }
  assertOwnerCurrent(isCurrent);

  if (removed) {
    const remainingSameProvider = next.find((entry) => entry.provider === removed.provider);
    if (remainingSameProvider) {
      await mirrorLegacyProviderRefs(vault, remainingSameProvider, isCurrent);
    } else {
      await clearLegacyProviderRefs(vault, removed.provider, isCurrent);
    }
  }

  return { configurations: next, wasActive };
}
