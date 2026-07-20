import { OneKycService } from "@/lib/services/one-kyc-service";

/**
 * Account-scoped preference for whether One may process KYC requests sent to
 * one@hushh.ai. The backend is authoritative because Gmail intake can happen
 * while no web or native client is running. Missing state is disabled.
 */
export async function loadEmailDraftingEnabled({
  userId,
  vaultOwnerToken,
}: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<boolean> {
  if (!userId || !vaultOwnerToken) return false;
  const preference = await OneKycService.getAutomaticResponsePreparationPreference({
    userId,
    vaultOwnerToken,
  });
  return preference.automatic_response_preparation_enabled === true;
}

export async function saveEmailDraftingEnabled(
  {
    userId,
    vaultOwnerToken,
    enabled,
  }: {
    userId: string;
    vaultOwnerToken: string;
    enabled: boolean;
  },
): Promise<boolean> {
  if (!userId || !vaultOwnerToken) return false;
  try {
    const preference = await OneKycService.setAutomaticResponsePreparationPreference({
      userId,
      vaultOwnerToken,
      enabled,
    });
    return preference.automatic_response_preparation_enabled === enabled;
  } catch {
    return false;
  }
}
