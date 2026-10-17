import { hasSavedAzureKey, hasSavedOpenAiKey, loadSelectedAiProvider } from "@/lib/one/ai-selection-vault";
import { PreVaultUserStateService, type PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { GEMINI_RUNTIME_CREDENTIAL_REF, PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export function immediateRuntimeChoiceReadiness(
  userId: string,
  state: PreVaultUserState | null | undefined,
  canReadVault: boolean,
): boolean | null {
  if (!PreVaultUserStateService.hasOneRuntimeChoice(state)) return false;
  // The BYOK marker is durable, but its credential is deliberately only in
  // process memory until vault finalization. A reload can leave the marker
  // behind without a key. An unlocked vault may also hold a saved key.
  if (state?.oneRuntimeSetupChoice !== "byok_pending_vault") return true;
  if (PreVaultSensitiveDraftService.hasGeminiRuntime(userId)) return true;
  return canReadVault ? null : false;
}

export async function hasReadyRuntimeChoice(params: {
  userId: string;
  state: PreVaultUserState | null | undefined;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
}): Promise<boolean> {
  const immediate = immediateRuntimeChoiceReadiness(
    params.userId,
    params.state,
    Boolean(params.vaultKey && params.vaultOwnerToken),
  );
  if (immediate !== null) return immediate;
  return hasStoredAiKey(params.userId, params.vaultKey, params.vaultOwnerToken);
}

export async function hasStoredGeminiKey(
  userId: string,
  vaultKey: string | null,
  vaultOwnerToken: string | null,
): Promise<boolean> {
  if (!vaultKey || !vaultOwnerToken) return false;
  try {
    const credential = await PersonalKnowledgeModelService.loadRuntimeSecret({
      userId,
      vaultKey,
      vaultOwnerToken,
      credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
    });
    return Boolean(credential);
  } catch {
    return false;
  }
}

/** Read only the selected provider; another provider's key is not a substitute. */
export async function hasStoredAiKey(
  userId: string,
  vaultKey: string | null,
  vaultOwnerToken: string | null,
  selectedProvider?: string | null,
): Promise<boolean> {
  if (!vaultKey || !vaultOwnerToken) return false;
  const vault = { userId, vaultKey, vaultOwnerToken };
  try {
    const provider = selectedProvider === undefined
      ? await loadSelectedAiProvider(vault, { requireReadable: true }) : selectedProvider;
    if (provider === "openai") return hasSavedOpenAiKey(vault);
    if (provider === "azure_openai") return hasSavedAzureKey(vault);
    if (provider && provider !== "gemini") return false;
    return hasStoredGeminiKey(userId, vaultKey, vaultOwnerToken);
  } catch {
    return false;
  }
}
