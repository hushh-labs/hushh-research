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
  OPENAI_RUNTIME_CREDENTIAL_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
} from "@/lib/services/personal-knowledge-model-service";

export const AI_SELECTED_PROVIDER_REF =
  "pkm:runtime_secrets.llm.selected_provider";
export const AI_SELECTED_MODEL_REF = "pkm:runtime_secrets.llm.selected_model";

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
