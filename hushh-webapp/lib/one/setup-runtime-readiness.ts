import { hasSavedAzureKey, hasSavedOpenAiKey, loadSelectedAiProvider } from "@/lib/one/ai-selection-vault";
import { PreVaultUserStateService, type PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

export function immediateRuntimeChoiceReadiness(
  _userId: string,
  state: PreVaultUserState | null | undefined,
  canReadVault: boolean,
): boolean | null {
  if (!PreVaultUserStateService.hasOneRuntimeChoice(state)) return false;
  // A durable BYOK marker or staged Gemini key is not processing eligibility.
  // Read the selected encrypted provider before accepting any saved key.
  if (state?.oneRuntimeSetupChoice !== "byok_pending_vault") return true;
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
    return false;
  } catch {
    return false;
  }
}
