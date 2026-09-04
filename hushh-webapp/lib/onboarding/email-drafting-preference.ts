import { OneKycService } from "@/lib/services/one-kyc-service";

/**
 * Account-scoped preference for whether One may process KYC requests sent to
 * one@hushh.ai. The backend is authoritative because Gmail intake can happen
 * while no web or native client is running. Missing state is disabled.
 */
export async function loadEmailDraftingEnabled({
  userId,
  idToken,
}: {
  userId: string;
  idToken: string;
}): Promise<boolean> {
  if (!userId || !idToken) return false;
  const preference = await OneKycService.getAutomaticResponsePreparationPreference({
    userId,
    idToken,
  });
  return preference.automatic_response_preparation_enabled === true;
}

export async function saveEmailDraftingEnabled(
  {
    userId,
    idToken,
    enabled,
  }: {
    userId: string;
    idToken: string;
    enabled: boolean;
  },
): Promise<boolean> {
  if (!userId || !idToken) return false;
  try {
    const preference = await OneKycService.setAutomaticResponsePreparationPreference({
      userId,
      idToken,
      enabled,
    });
    return preference.automatic_response_preparation_enabled === enabled;
  } catch {
    return false;
  }
}
